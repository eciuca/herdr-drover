import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDroverRuntime } from "../src/runtime.js";

// A minimal fake herdr: its startAgent simply records the command it was asked
// to launch. We never actually let herdr run anything — we pull command[2] (the
// bash script) out of the recorded call and execute it ourselves under a
// controlled PATH so a stub stands in for the real kiro-cli binary.
function makeRecordingHerdr() {
  return {
    dryRun: false,
    commands: [],
    calls: [],
    _paneSeq: 1,
    async createWorkspace() {
      return { result: { workspace: { workspace_id: "ws-1" }, root_pane: { pane_id: "ws-1:p1" } } };
    },
    async startAgent(opts) {
      this.calls.push({ method: "startAgent", args: [opts] });
      return { result: { agent: { pane_id: `ws-1:p${++this._paneSeq}` } } };
    },
    async closePane() {},
    async sendAgent() {},
    async waitAgent() {},
    async waitOutput() {},
    async readAgent() {},
    async closeWorkspace() {},
  };
}

// Poll a predicate until it returns true or the deadline passes. Returns whether
// the predicate became true within the timeout (never throws / never hangs CI).
async function waitUntil(predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

const bashAvailable = spawnSync("bash", ["-c", "exit 0"]).status === 0;

test(
  "session wrapper executes the turn loop: markers, tee, resume branch, exit codes",
  { skip: bashAvailable ? false : "bash is not available" },
  async () => {
    const workDir = mkdtempSync(join(tmpdir(), "drover-session-it-"));
    const headlessDir = join(workDir, "headless");
    const stubDir = join(workDir, "bin");
    let child;
    try {
      // Stub named after the real agent binary (kiro-cli). It reads the whole
      // prompt from stdin, then prints its argv (so the test can prove which
      // branch — first vs resume — ran) plus the prompt body (so we can prove
      // the wrapper piped stdin and tee'd it to the out file). If the prompt
      // says "FAIL" the stub exits non-zero so we can assert exit propagation.
      const stub = [
        "#!/usr/bin/env bash",
        'argv="$*"',
        "input=$(cat)",
        'printf "argv: %s\\n" "$argv"',
        'printf "stdin: %s\\n" "$input"',
        'if printf "%s" "$input" | grep -q FAIL; then exit 3; fi',
        "exit 0",
        "",
      ].join("\n");
      spawnSync("mkdir", ["-p", stubDir]);
      const stubPath = join(stubDir, "kiro-cli");
      writeFileSync(stubPath, stub);
      chmodSync(stubPath, 0o755);

      // Delegate a session worker so prepareSession builds the real bash script.
      const herdr = makeRecordingHerdr();
      const drover = createDroverRuntime({
        herdr,
        cwd: workDir,
        namePrefix: "it",
        execMode: "session",
        headlessDir,
      });
      await drover.delegate({ name: "loop", agent: "kiro", task: "turn one work" });

      const startCall = herdr.calls.find((c) => c.method === "startAgent");
      const command = startCall.args[0].command;
      assert.deepEqual(command.slice(0, 2), ["bash", "-lc"]);
      const script = command[2];

      const record = drover.workers().find((w) => w.workerName === "it-loop");
      const ctrlDir = join(headlessDir, record.workerName);
      const outFile = join(ctrlDir, "out");
      const markerBase = `__DROVER_DONE_${record.workerName}__`;

      // Run the wrapper with the stub ahead of the real kiro-cli on PATH. The
      // per-turn completion marker is printed to the wrapper's stdout (the pane
      // herdr scans via `wait output` in production) — it is NOT tee'd to the
      // out file, which only receives the agent's own output. So we accumulate
      // the child's stdout to detect turn completion, and read the out file to
      // prove the agent output was tee'd there.
      child = spawn("bash", ["-lc", script], {
        env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      const childExit = new Promise((resolve) => child.on("exit", resolve));

      // prompt.1 already written by prepareSession. Wait for turn 1 marker.
      const gotTurn1 = await waitUntil(() => stdout.includes("turn=1 exit=0"));
      assert.ok(gotTurn1, "turn 1 marker (exit=0) should appear on the pane stdout");

      // Turn 2: drive the resume branch.
      writeFileSync(join(ctrlDir, "prompt.2"), "turn two work");
      const gotTurn2 = await waitUntil(() => stdout.includes("turn=2 exit=0"));
      assert.ok(gotTurn2, "turn 2 marker (exit=0) should appear on the pane stdout");

      // Turn 3: a failing prompt exercises non-zero exit propagation via PIPESTATUS.
      writeFileSync(join(ctrlDir, "prompt.3"), "please FAIL now");
      const gotTurn3 = await waitUntil(() => stdout.includes("turn=3 exit=3"));
      assert.ok(gotTurn3, "turn 3 should propagate the stub's non-zero exit (3)");

      assert.ok(existsSync(outFile), "out file should exist");
      const out = readFileSync(outFile, "utf8");

      // Stub output tee'd to the out file: the stub echoed its stdin (proving
      // the wrapper piped the prompt file in) and that landed in the out file
      // (proving the tee). The prompt is the full multi-line worker prompt, so
      // assert on the distinctive task text it carries.
      assert.ok(out.includes("stdin:"), "stub's stdin echo tee'd to out");
      assert.ok(out.includes("turn one work"), "turn 1 prompt body tee'd to out");
      assert.ok(out.includes("turn two work"), "turn 2 prompt body tee'd to out");

      // Branch selection: turn 1 = first argv (no --resume), turn 2 = resume argv.
      const argvLines = out.split("\n").filter((l) => l.startsWith("argv:"));
      assert.equal(argvLines.length, 3, "one argv line per turn");
      assert.ok(!argvLines[0].includes("--resume"), "turn 1 uses the first (fresh) argv");
      assert.ok(argvLines[1].includes("--resume"), "turn 2 uses the resume argv");
      assert.ok(argvLines[2].includes("--resume"), "turn 3 (>1) uses the resume argv");

      // Markers for every turn present on stdout with the expected exit codes.
      assert.ok(stdout.includes(`${markerBase} turn=1 exit=0`));
      assert.ok(stdout.includes(`${markerBase} turn=2 exit=0`));
      assert.ok(stdout.includes(`${markerBase} turn=3 exit=3`));

      // The wrapper loops forever; kill it and confirm it dies.
      child.kill("SIGKILL");
      await childExit;
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
