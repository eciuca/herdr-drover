import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTask, buildWorkerPrompt } from "../src/planner.js";

test("normalizeTask fills agent and name defaults", () => {
  const spec = normalizeTask({ task: "do it" }, { defaultAgent: "kiro", index: 3 });
  assert.equal(spec.agent, "kiro");
  assert.equal(spec.name, "worker-3");
  assert.equal(spec.task, "do it");
});

test("normalizeTask keeps explicit fields and passthrough metadata", () => {
  const spec = normalizeTask(
    {
      name: "builder",
      agent: "codex",
      profile: "default",
      cwd: "/repo",
      task: "  build  ",
      constraints: ["scoped"],
      expectedArtifacts: ["diff"],
      statusPolicy: { waitFor: "done", timeoutMs: 10 },
      isolation: "worktree",
    },
    { defaultAgent: "kiro", index: 1 },
  );
  assert.equal(spec.name, "builder");
  assert.equal(spec.agent, "codex");
  assert.equal(spec.profile, "default");
  assert.equal(spec.cwd, "/repo");
  assert.equal(spec.task, "build");
  assert.deepEqual(spec.constraints, ["scoped"]);
  assert.deepEqual(spec.expectedArtifacts, ["diff"]);
  assert.deepEqual(spec.statusPolicy, { waitFor: "done", timeoutMs: 10 });
  assert.equal(spec.isolation, "worktree");
});

test("normalizeTask throws on missing task", () => {
  assert.throws(() => normalizeTask({ name: "x" }, {}), /task/);
});

test("buildWorkerPrompt is unchanged when no constraints or artifacts", () => {
  const prompt = buildWorkerPrompt({
    task: "assignment text",
    workerName: "w1",
    preamble: "PREAMBLE",
  });
  assert.ok(prompt.startsWith("PREAMBLE\n\nWorker: w1"));
  assert.ok(prompt.includes("Assignment:\nassignment text"));
  assert.ok(!prompt.includes("Expected artifacts:"));
  assert.equal(prompt.split("\n").filter((l) => l === "").length, 3);
});

test("buildWorkerPrompt appends constraints and expected artifacts", () => {
  const prompt = buildWorkerPrompt({
    task: "assignment",
    workerName: "w1",
    preamble: "P",
    constraints: ["no unrelated edits"],
    expectedArtifacts: ["changed files", "status summary"],
  });
  assert.ok(prompt.includes("- no unrelated edits"));
  assert.ok(prompt.includes("Expected artifacts:\n- changed files\n- status summary"));
});

import {
  HerdrCli,
  extractWorkspaceId,
  extractWorktreePath,
  extractRootPaneId,
  extractAgentPaneId,
} from "../src/herdr.js";

test("HerdrCli teardown + worktree verbs generate expected commands (dry-run)", async () => {
  const herdr = new HerdrCli({ dryRun: true });
  await herdr.closePane("wA:p1");
  await herdr.closeWorkspace("ws-1");
  await herdr.createWorktree({ cwd: "/repo", branch: "drover/builder" });
  assert.deepEqual(herdr.commands, [
    ["herdr", "pane", "close", "wA:p1"],
    ["herdr", "workspace", "close", "ws-1"],
    ["herdr", "worktree", "create", "--cwd", "/repo", "--branch", "drover/builder", "--json"],
  ]);
});

test("createWorkspace and startAgent omit --json (herdr 0.7.2 rejects it); worktree keeps it", async () => {
  const herdr = new HerdrCli({ dryRun: true });
  await herdr.createWorkspace({ cwd: "/repo", label: "x" });
  await herdr.startAgent({ name: "w", command: ["kiro-cli", "chat"], workspaceId: "ws-1" });
  await herdr.createWorktree({ cwd: "/repo", branch: "b" });

  const [workspaceCmd, startCmd, worktreeCmd] = herdr.commands;
  assert.ok(!workspaceCmd.includes("--json"), "workspace create must not send --json");
  assert.ok(!startCmd.includes("--json"), "agent start must not send --json");
  assert.ok(worktreeCmd.includes("--json"), "worktree create keeps --json");
});

test("extractWorkspaceId reads result.workspace.workspace_id, never the command id", () => {
  // Real herdr shape: top-level `id` is the command id, not the workspace id.
  const live = { id: "cli:workspace:create", result: { workspace: { workspace_id: "wB" } } };
  assert.equal(extractWorkspaceId(live), "wB");
  assert.equal(extractWorkspaceId({}), undefined);
});

test("extractWorktreePath reads the live worktree-create shape or falls back to dry-run stub", () => {
  assert.equal(
    extractWorktreePath({ result: { workspace: { worktree: { checkout_path: "/wt/a" } } } }),
    "/wt/a",
  );
  assert.equal(extractWorktreePath({ result: { root_pane: { cwd: "/wt/b" } } }), "/wt/b");
  assert.equal(extractWorktreePath({}, { dryRun: true, name: "c" }), "dry-run-worktree/c");
  assert.equal(extractWorktreePath({}, {}), undefined);
});

test("extractRootPaneId and extractAgentPaneId read herdr result shapes", () => {
  assert.equal(extractRootPaneId({ result: { root_pane: { pane_id: "wA:p1" } } }), "wA:p1");
  assert.equal(extractRootPaneId({}), undefined);
  assert.equal(extractAgentPaneId({ result: { agent: { pane_id: "wA:p2" } } }), "wA:p2");
  assert.equal(extractAgentPaneId({}), undefined);
});

import { createDroverRuntime } from "../src/runtime.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway dir for headless tests so they don't litter the OS tmp with real
// prompt/output files; removed after the suite runs.
const HEADLESS_TMP = mkdtempSync(join(tmpdir(), "drover-test-"));
test.after(() => rmSync(HEADLESS_TMP, { recursive: true, force: true }));

function makeFakeHerdr(responses = {}) {
  return {
    dryRun: false,
    commands: [],
    calls: [],
    _paneSeq: 1,
    _push(method, args, ret) {
      this.calls.push({ method, args });
      return ret;
    },
    async createWorkspace(opts) {
      this.commands.push(["workspace", "create"]);
      return this._push(
        "createWorkspace",
        [opts],
        responses.createWorkspace ??
          { result: { workspace: { workspace_id: "ws-1" }, root_pane: { pane_id: "ws-1:p1" } } },
      );
    },
    async startAgent(opts) {
      this.commands.push(["agent", "start", opts.name]);
      const paneId = `ws-1:p${++this._paneSeq}`; // root pane is p1
      return this._push("startAgent", [opts], { result: { agent: { pane_id: paneId } } });
    },
    async closePane(paneId) {
      this.commands.push(["pane", "close", paneId]);
      return this._push("closePane", [paneId], {});
    },
    async sendAgent(target, text) {
      this.commands.push(["agent", "send", target]);
      return this._push("sendAgent", [target, text], {});
    },
    async waitAgent(target, opts) {
      return this._push("waitAgent", [target, opts], responses.waitAgent ?? { status: "done" });
    },
    async waitOutput(paneId, opts) {
      return this._push("waitOutput", [paneId, opts], responses.waitOutput ?? { matched: true });
    },
    async readAgent(target, opts) {
      return this._push("readAgent", [target, opts], responses.readAgent ?? { stdout: "worker output" });
    },
    async closeWorkspace(id) {
      return this._push("closeWorkspace", [id], {});
    },
    async createWorktree(opts) {
      return this._push(
        "createWorktree",
        [opts],
        responses.createWorktree ??
          { result: { workspace: { worktree: { checkout_path: `/wt/${opts.branch}` } } } },
      );
    },
    async notify(...args) {
      return this._push("notify", args, {});
    },
  };
}

const only = (herdr, method) => herdr.calls.filter((c) => c.method === method);

test("delegate launches one kiro worker: workspace once, start focused, send prompt", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "sup" });
  const handle = await drover.delegate({ name: "planner", agent: "kiro", task: "make a plan" });

  assert.equal(handle.id, "sup-planner");
  assert.equal(handle.agent, "kiro");
  assert.equal(only(herdr, "createWorkspace").length, 1);

  const start = only(herdr, "startAgent")[0].args[0];
  assert.deepEqual(start.command, ["kiro-cli", "chat", "--agent", "developer"]);
  assert.equal(start.focus, true);
  assert.equal(start.cwd, "/repo");
  assert.equal(start.workspaceId, "ws-1");

  const send = only(herdr, "sendAgent")[0];
  assert.equal(send.args[0], "sup-planner");
  assert.ok(send.args[1].includes("Assignment:\nmake a plan"));
});

test("second delegate reuses workspace, splits, and de-duplicates names", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "sup" });
  await drover.delegate({ name: "dev", agent: "kiro", task: "a" });
  const second = await drover.delegate({ name: "dev", agent: "kiro", task: "b" });

  assert.equal(only(herdr, "createWorkspace").length, 1);
  assert.equal(second.id, "sup-dev-2");
  const starts = only(herdr, "startAgent");
  assert.equal(starts[0].args[0].focus, true);
  assert.equal(starts[1].args[0].focus, false);
  assert.equal(starts[1].args[0].split, "right");
});

test("delegate with worktree isolation creates worktree and starts there", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "sup" });
  await drover.delegate({ name: "builder", agent: "kiro", task: "build", isolation: "worktree" });

  const wt = only(herdr, "createWorktree")[0].args[0];
  assert.equal(wt.branch, "drover/sup-builder");
  assert.equal(wt.cwd, "/repo");
  const start = only(herdr, "startAgent")[0].args[0];
  assert.equal(start.cwd, "/wt/drover/sup-builder");
});

test("first delegate closes the workspace bootstrap pane exactly once", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "sup" });
  await drover.delegate({ name: "a", agent: "kiro", task: "x" });
  await drover.delegate({ name: "b", agent: "kiro", task: "y" });
  const closes = only(herdr, "closePane").map((c) => c.args[0]);
  assert.deepEqual(closes, ["ws-1:p1"]); // only the bootstrap pane, once
});

test("delegate does not close a bootstrap pane when reusing an existing workspace", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, workspaceId: "ext-ws", cwd: "/repo", namePrefix: "sup" });
  await drover.delegate({ name: "a", agent: "kiro", task: "x" });
  assert.equal(only(herdr, "createWorkspace").length, 0);
  assert.equal(only(herdr, "closePane").length, 0);
});

test("delegateMany returns legacy shape and waits when asked", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "run" });
  const result = await drover.delegateMany(
    [
      { name: "planner", agent: "kiro", task: "plan" },
      { name: "reviewer", agent: "codex", task: "review" },
    ],
    { wait: true },
  );

  assert.equal(result.workspace.workspaceId, "ws-1");
  assert.equal(result.launched.length, 2);
  assert.deepEqual(
    result.launched.map((l) => l.workerName),
    ["run-planner", "run-reviewer"],
  );
  assert.equal(only(herdr, "waitAgent").length, 2);
  assert.ok(result.waits.every((w) => w.status === "done"));
  assert.equal(result.commands, herdr.commands);
});

test("observe, collect, release, and close drive the right herdr methods", async () => {
  const herdr = makeFakeHerdr({ readAgent: { stdout: "final report" } });
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "sup" });
  const a = await drover.delegate({ name: "a", agent: "kiro", task: "x" });

  await drover.observe(a.id, { status: "blocked" });
  assert.equal(only(herdr, "waitAgent")[0].args[1].status, "blocked");

  const collected = await drover.collect(a.id);
  assert.equal(collected.output, "final report");
  assert.equal(collected.agent, "kiro");

  await drover.release(a.id);
  const paneCloses = only(herdr, "closePane").map((c) => c.args[0]);
  assert.ok(paneCloses.includes("ws-1:p2")); // worker a's own pane (p1 was bootstrap)

  await drover.close({ closeWorkspace: true });
  assert.equal(only(herdr, "closeWorkspace")[0].args[0], "ws-1");
});

test("observe and collect throw on unknown worker id", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr });
  await assert.rejects(() => drover.observe("nope"), /Unknown worker/);
  await assert.rejects(() => drover.collect("nope"), /Unknown worker/);
});

import { runDelegation } from "../src/orchestrator.js";

test("runDelegation preserves legacy shape and notifies", async () => {
  const herdr = makeFakeHerdr();
  const result = await runDelegation({
    herdr,
    tasks: [
      { name: "planner", agent: "kiro", profile: "developer", task: "plan it" },
      { name: "builder", agent: "kiro", task: "build it" },
    ],
    options: {
      cwd: "/repo",
      namePrefix: "drover",
      defaultAgent: "kiro",
      goal: "ship",
      wait: true,
      notify: true,
      splitDirection: "right",
    },
  });

  assert.deepEqual(Object.keys(result).sort(), ["commands", "launched", "waits", "workspace"]);
  assert.equal(result.launched.length, 2);
  assert.equal(result.workspace.workspaceId, "ws-1");
  assert.equal(only(herdr, "notify").length, 1);
});

test("runDelegation throws on empty task list", async () => {
  await assert.rejects(() => runDelegation({ herdr: makeFakeHerdr(), tasks: [], options: {} }), /No tasks/);
});

test("headless mode launches a non-interactive wrapper and does not send a prompt", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "hl", execMode: "headless", headlessDir: HEADLESS_TMP });
  const w = await drover.delegate({ name: "worker", agent: "claude", task: "do the thing" });

  // No interactive prompt submission in headless mode.
  assert.equal(only(herdr, "sendAgent").length, 0);

  const start = only(herdr, "startAgent")[0].args[0];
  assert.deepEqual(start.command.slice(0, 2), ["bash", "-lc"]);
  const script = start.command[2];
  // agent argv tokens are shell-quoted; assert their presence, not adjacency.
  for (const tok of ["claude", "-p", "--dangerously-skip-permissions"]) assert.ok(script.includes(tok), tok);
  assert.match(script, /__DROVER_DONE_hl-worker__/);
  assert.match(script, /\.prompt/);
  assert.match(script, /\.out/);
  assert.match(script, /sleep 86400/);
  assert.equal(w.agent, "claude");
});

test("headless observe waits on the completion marker; collect reads the output file", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "hl", execMode: "headless", headlessDir: HEADLESS_TMP });
  const w = await drover.delegate({ name: "worker", agent: "claude", task: "x" });

  await drover.observe(w.id, { timeoutMs: 1000 });
  assert.equal(only(herdr, "waitAgent").length, 0, "headless must not use agent-status");
  const wo = only(herdr, "waitOutput")[0];
  assert.equal(wo.args[0], "ws-1:p2"); // the worker's own pane (p1 is the bootstrap)
  assert.equal(wo.args[1].match, "__DROVER_DONE_hl-worker__");

  // The wrapper (which would write the .out file) never runs under the fake,
  // so collect returns an empty string rather than scraping the pane.
  const collected = await drover.collect(w.id);
  assert.equal(collected.output, "");
  assert.equal(only(herdr, "readAgent").length, 0, "headless collect must not read the pane");
});

test("per-spec mode overrides the runtime default", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "mx", execMode: "interactive", headlessDir: HEADLESS_TMP });
  await drover.delegate({ name: "a", agent: "kiro", task: "interactive one" });
  await drover.delegate({ name: "b", agent: "claude", task: "headless one", mode: "headless" });

  assert.equal(only(herdr, "sendAgent").length, 1); // only the interactive worker submitted a prompt
  const starts = only(herdr, "startAgent");
  assert.deepEqual(starts[0].args[0].command, ["kiro-cli", "chat", "--agent", "developer"]);
  assert.deepEqual(starts[1].args[0].command.slice(0, 2), ["bash", "-lc"]);
});

// Make startAgent yield no pane id (extractAgentPaneId({}) === undefined) so the
// worker record has paneId === undefined and the pane-close path is a no-op.
function makePanelessHerdr() {
  const herdr = makeFakeHerdr();
  herdr.startAgent = async function (opts) {
    this.commands.push(["agent", "start", opts.name]);
    return this._push("startAgent", [opts], {}); // no pane id
  };
  return herdr;
}

function captureWarn(fn) {
  const original = console.warn;
  const messages = [];
  console.warn = (...args) => messages.push(args.join(" "));
  try {
    return fn(messages);
  } finally {
    console.warn = original;
  }
}

test("release warns once when a live worker has no pane id", async () => {
  const herdr = makePanelessHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "np" });
  const handle = await drover.delegate({ name: "a", agent: "kiro", task: "x" });

  const messages = await captureWarn(async (msgs) => {
    await drover.release(handle.id);
    return msgs;
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /worker "np-a" has no pane id/);
});

test("close (non-workspace path) warns when a live worker has no pane id", async () => {
  const herdr = makePanelessHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "np" });
  await drover.delegate({ name: "a", agent: "kiro", task: "x" });

  const messages = await captureWarn(async (msgs) => {
    await drover.close(); // cleanup defaults to "keep" → non-workspace path
    return msgs;
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /worker "np-a" has no pane id/);
});

test("missing pane id never warns in dry-run mode", async () => {
  const herdr = makePanelessHerdr();
  herdr.dryRun = true;
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "np" });
  const handle = await drover.delegate({ name: "a", agent: "kiro", task: "x" });

  const messages = await captureWarn(async (msgs) => {
    await drover.release(handle.id);
    await drover.delegate({ name: "b", agent: "kiro", task: "y" });
    await drover.close();
    return msgs;
  });
  assert.equal(messages.length, 0);
});

import { headlessCommandForAgent, getAgentProfile, sessionCommandsForAgent } from "../src/agents.js";

test("headlessCommandForAgent returns the non-interactive kiro argv (stdin prompt)", () => {
  const argv = headlessCommandForAgent(getAgentProfile("kiro"), undefined, "developer");
  assert.deepEqual(argv, [
    "kiro-cli",
    "chat",
    "--no-interactive",
    "--trust-all-tools",
    "--agent",
    "developer",
  ]);
});

test("headlessCommandForAgent returns the codex exec argv (verified live, stdin prompt)", () => {
  const argv = headlessCommandForAgent(getAgentProfile("codex"), undefined);
  assert.deepEqual(argv, ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "-"]);
});

test("headless kiro worker wrapper contains the kiro headless tokens", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "hk", execMode: "headless", headlessDir: HEADLESS_TMP });
  await drover.delegate({ name: "worker", agent: "kiro", task: "do kiro thing" });

  assert.equal(only(herdr, "sendAgent").length, 0);
  const start = only(herdr, "startAgent")[0].args[0];
  assert.deepEqual(start.command.slice(0, 2), ["bash", "-lc"]);
  const script = start.command[2];
  for (const tok of ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools", "--agent", "developer"]) {
    assert.ok(script.includes(tok), tok);
  }
  assert.match(script, /__DROVER_DONE_hk-worker__/);
});

test("headless codex worker wrapper contains the codex headless tokens", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "hc", execMode: "headless", headlessDir: HEADLESS_TMP });
  await drover.delegate({ name: "worker", agent: "codex", task: "do codex thing" });

  assert.equal(only(herdr, "sendAgent").length, 0);
  const start = only(herdr, "startAgent")[0].args[0];
  assert.deepEqual(start.command.slice(0, 2), ["bash", "-lc"]);
  const script = start.command[2];
  for (const tok of ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"]) {
    assert.ok(script.includes(tok), tok);
  }
  assert.match(script, /__DROVER_DONE_hc-worker__/);
});

test("cleanup:'close' closes the workspace when closeWorkspace is omitted", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "cl", cleanup: "close" });
  await drover.delegate({ name: "a", agent: "kiro", task: "x" });

  const result = await drover.close();
  assert.equal(result.closed, true);
  assert.equal(only(herdr, "closeWorkspace")[0].args[0], "ws-1");
});

test("default cleanup:'keep' does not close the workspace when closeWorkspace is omitted", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "cl" });
  await drover.delegate({ name: "a", agent: "kiro", task: "x" });

  const result = await drover.close();
  assert.equal(result.closed, false);
  assert.equal(only(herdr, "closeWorkspace").length, 0);
});

test("explicit closeWorkspace arg overrides the cleanup setting", async () => {
  const closeHerdr = makeFakeHerdr();
  const closeDrover = createDroverRuntime({ herdr: closeHerdr, cwd: "/repo", namePrefix: "cl", cleanup: "keep" });
  await closeDrover.delegate({ name: "a", agent: "kiro", task: "x" });
  await closeDrover.close({ closeWorkspace: true });
  assert.equal(only(closeHerdr, "closeWorkspace").length, 1, "closeWorkspace:true overrides keep");

  const keepHerdr = makeFakeHerdr();
  const keepDrover = createDroverRuntime({ herdr: keepHerdr, cwd: "/repo", namePrefix: "cl", cleanup: "close" });
  await keepDrover.delegate({ name: "a", agent: "kiro", task: "x" });
  const result = await keepDrover.close({ closeWorkspace: false });
  assert.equal(result.closed, false, "closeWorkspace:false overrides close");
  assert.equal(only(keepHerdr, "closeWorkspace").length, 0);
});

test("sessionCommandsForAgent pins a caller-provided session id for claude", () => {
  assert.deepEqual(sessionCommandsForAgent(getAgentProfile("claude"), "SID-123"), {
    first: ["claude", "-p", "--session-id", "SID-123", "--dangerously-skip-permissions"],
    resume: ["claude", "-p", "--resume", "SID-123", "--dangerously-skip-permissions"],
  });
});

test("sessionCommandsForAgent for kiro ignores the session id (most-recent resume)", () => {
  assert.deepEqual(sessionCommandsForAgent(getAgentProfile("kiro"), "SID-123", "developer"), {
    first: ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools", "--agent", "developer"],
    resume: ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools", "--resume", "--agent", "developer"],
  });
});

test("sessionCommandsForAgent for codex pins the captured session id (not --last)", () => {
  const cmds = sessionCommandsForAgent(getAgentProfile("codex"), "SID-123");
  assert.deepEqual(cmds.first, ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "-"]);
  // resume by explicit id via the sentinel; must NOT resume the most-recent (--last).
  assert.deepEqual(cmds.resume, [
    "codex", "exec", "resume", "--dangerously-bypass-approvals-and-sandbox", "__DROVER_SID__", "-",
  ]);
  assert.ok(!cmds.resume.includes("--last"), "codex must pin an explicit id, never --last");
  assert.deepEqual(cmds.captureSessionId, { line: "session id:", pattern: "[0-9a-f-]{36}" });
});

test("session mode codex wrapper captures turn-1 id and resumes that exact session", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "sc", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  await drover.delegate({ name: "cx", agent: "codex", task: "do the codex thing" });

  const script = only(herdr, "startAgent")[0].args[0].command[2];
  // turn 1 greps the printed session id and stashes it
  assert.match(script, /grep .*session id:.* head -1 .*grep -oE/);
  assert.match(script, /> "\$CTRL\/sid"/);
  // resume reads the stashed id and passes it to `codex exec resume <id> -`
  assert.match(script, /SID=\$\(cat "\$CTRL\/sid"\)/);
  assert.match(script, /'codex' 'exec' 'resume'.*"\$SID"/);
  assert.ok(!script.includes("--last"), "codex resume must use the pinned id, not --last");
});

test("session mode builds a persistent turn-loop wrapper, writes turn 1, sends no prompt", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  const w = await drover.delegate({ name: "worker", agent: "claude", task: "do the thing" });

  assert.equal(only(herdr, "sendAgent").length, 0);
  assert.equal(w.paneId, "ws-1:p2");

  const script = only(herdr, "startAgent")[0].args[0].command[2];
  // turn loop, tee to pane + file, per-turn marker, resume branch
  assert.match(script, /while true/);
  assert.match(script, /tee -a/);
  assert.match(script, /__DROVER_DONE_s-worker__ turn=/);
  for (const tok of ["claude", "-p", "--dangerously-skip-permissions"]) assert.ok(script.includes(tok));
  assert.ok(script.includes("--session-id"), "turn-1 branch pins a session id");
  assert.ok(script.includes("--resume"), "resume branch resumes the pinned session id");
  assert.match(script, /--dangerously-skip-permissions/g);
});

import { readFile as _readFile } from "node:fs/promises";
import { join as _join } from "node:path";

test("session delegate writes the turn-1 prompt into the control dir", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  await drover.delegate({ name: "w2", agent: "kiro", task: "assignment body here" });
  // control dir is <headlessDir>/<workerName>; turn-1 prompt is prompt.1
  const text = await _readFile(_join(HEADLESS_TMP, "s-w2", "prompt.1"), "utf8");
  assert.ok(text.includes("Assignment:\nassignment body here"));
});

test("session observe waits on the per-turn marker; collect reads the transcript file", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  const w = await drover.delegate({ name: "w3", agent: "claude", task: "t" });

  await drover.observe(w.id);
  assert.equal(only(herdr, "waitAgent").length, 0, "session must not use agent-status");
  const wo = only(herdr, "waitOutput")[0];
  assert.equal(wo.args[0], "ws-1:p2");
  assert.equal(wo.args[1].match, "__DROVER_DONE_s-w3__ turn=1 ");

  const collected = await drover.collect(w.id);
  assert.equal(typeof collected.output, "string"); // file may be empty under the fake
  assert.equal(only(herdr, "readAgent").length, 0, "session collect must not read the pane");
});

test("session observe surfaces a non-zero per-turn exit code (failed turn is not 'done')", async () => {
  // The turn-loop wrapper prints `<marker> turn=<n> exit=<code>` to the pane;
  // wait output returns that matched text. A non-zero exit must not read as done.
  const herdr = makeFakeHerdr({ waitOutput: { stdout: "__DROVER_DONE_s-fail__ turn=1 exit=3\n" } });
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  const w = await drover.delegate({ name: "fail", agent: "claude", task: "t" });

  await assert.rejects(() => drover.observe(w.id), (err) => {
    assert.match(err.message, /turn 1/);
    assert.match(err.message, /code 3/);
    assert.equal(err.exitCode, 3);
    return true;
  });
});

test("session observe resolves with exitCode 0 on a successful turn", async () => {
  const herdr = makeFakeHerdr({ waitOutput: { stdout: "__DROVER_DONE_s-ok__ turn=1 exit=0\n" } });
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  const w = await drover.delegate({ name: "ok", agent: "claude", task: "t" });

  const result = await drover.observe(w.id);
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
});

test("followUp writes the next prompt and advances the turn; observe matches it", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  const w = await drover.delegate({ name: "w4", agent: "claude", task: "first" });
  const f = await drover.followUp(w.id, "second turn please");
  assert.equal(f.turn, 2);

  const text = await _readFile(_join(HEADLESS_TMP, "s-w4", "prompt.2"), "utf8");
  assert.equal(text, "second turn please");

  await drover.observe(w.id);
  const lastWait = only(herdr, "waitOutput").at(-1);
  assert.equal(lastWait.args[1].match, "__DROVER_DONE_s-w4__ turn=2 ");
});

test("followUp rejects unknown and non-session workers", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "s", headlessDir: HEADLESS_TMP });
  await assert.rejects(() => drover.followUp("nope", "x"), /Unknown worker/);
  const w = await drover.delegate({ name: "iw", agent: "kiro", task: "interactive" }); // default interactive
  await assert.rejects(() => drover.followUp(w.id, "x"), /not a session worker/);
});

test("workers() includes paneId", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP });
  const w = await drover.delegate({ name: "w5", agent: "claude", task: "t" });
  assert.equal(drover.workers()[0].paneId, w.paneId);
});
