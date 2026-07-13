import { writeFile, readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  HerdrCli,
  extractWorkspaceId,
  extractWorktreePath,
  extractRootPaneId,
  extractAgentPaneId,
} from "./herdr.js";
import { commandForAgent, headlessCommandForAgent, sessionCommandsForAgent, getAgentProfile, SESSION_ID_SENTINEL } from "./agents.js";
import { buildWorkerPrompt, normalizeTask } from "./planner.js";

export function createDroverRuntime(config = {}) {
  const {
    herdr = new HerdrCli({ session: config.session, dryRun: config.dryRun }),
    cwd,
    namePrefix = "drover",
    goal,
    splitDirection = "right",
    cleanup = "keep",
    waitTimeoutMs = 1_800_000,
    defaultAgent = "kiro",
    agentProfile,
    agentCommand,
    agentResumeCommand,
    workspaceId,
    workspaceLabel,
    execMode = "interactive",
  } = config;

  const registry = new Map();
  let workspace = workspaceId ? { workspaceId, created: false } : null;
  let workspacePromise = null;
  let rootPaneId;
  let bootstrapClosed = false;
  // Where headless prompt/output files live. Overridable (config.headlessDir)
  // so tests can point at a throwaway dir; otherwise created lazily on first use.
  let headlessDir = config.headlessDir;

  async function ensureWorkspace() {
    if (workspace) return workspace;
    if (!workspacePromise) {
      const label = workspaceLabel || `${namePrefix}-ws`;
      workspacePromise = herdr
        .createWorkspace({ cwd, label, focus: false, env: { DROVER_WORKSPACE: label } })
        .then((result) => {
          rootPaneId = extractRootPaneId(result);
          workspace = {
            workspaceId: extractWorkspaceId(result) || (herdr.dryRun ? `dry-run-${label}` : undefined),
            created: true,
            result,
          };
          return workspace;
        });
    }
    return workspacePromise;
  }

  function uniqueName(base) {
    let name = base;
    let counter = 2;
    while (registry.has(name)) name = `${base}-${counter++}`;
    return name;
  }

  // Build the headless worker command: run the agent non-interactively with the
  // prompt on stdin, capture output to a file, then echo a unique completion
  // marker to the pane and keep the pane alive so the supervisor can observe
  // (via `wait output --match`), collect the output file, and release the pane.
  async function prepareHeadless({ workerName, profile, profileName, prompt }) {
    const agentArgv = headlessCommandForAgent(profile, agentCommand, profileName);
    if (!headlessDir) headlessDir = await mkdtemp(join(tmpdir(), "drover-"));
    const promptFile = join(headlessDir, `${workerName}.prompt`);
    const outFile = join(headlessDir, `${workerName}.out`);
    const doneMarker = `__DROVER_DONE_${workerName}__`;
    await writeFile(promptFile, prompt);
    const agentCmd = agentArgv.map(shellQuote).join(" ");
    const script =
      `${agentCmd} < ${shellQuote(promptFile)} > ${shellQuote(outFile)} 2>&1; ` +
      `printf '%s exit=%s\\n' ${shellQuote(doneMarker)} "$?"; sleep 86400`;
    return { command: ["bash", "-lc", script], outFile, doneMarker, promptFile };
  }

  // Build a persistent, visible turn-loop worker command. The pane waits for
  // prompt.<n> files, runs the agent (turn 1 fresh; later turns resume the same
  // session — claude pins a generated session id, codex pins the id captured
  // from turn 1's banner, kiro continues the most-recent conversation in the
  // cwd), tees output to the pane AND an output file,
  // then prints a per-turn completion marker. Prompt on stdin — no TUI driving.
  // Note: session mode builds its commands per-agent to thread the session id,
  // so the `agentCommand` / `agentResumeCommand` overrides do NOT apply here.
  async function prepareSession({ workerName, profile, profileName, prompt }) {
    const sessionId = randomUUID();
    const { first: turn1, resume, captureSessionId } = sessionCommandsForAgent(profile, sessionId, profileName);
    if (!headlessDir) headlessDir = await mkdtemp(join(tmpdir(), "drover-"));
    const ctrlDir = join(headlessDir, workerName);
    await mkdir(ctrlDir, { recursive: true });
    const outFile = join(ctrlDir, "out");
    const markerBase = `__DROVER_DONE_${workerName}__`;
    await writeFile(join(ctrlDir, "prompt.1"), prompt);
    const q = shellQuote;
    // Substitute the session-id sentinel (codex resume) with the shell var the
    // capture step fills; other tokens are shell-quoted literals.
    const renderArgv = (argv) => argv.map((t) => (t === SESSION_ID_SENTINEL ? '"$SID"' : q(t))).join(" ");
    // Agents that resume by an id printed at turn 1 (codex): grep it out of the
    // turn-1 output and stash it so later turns resume that exact session, never
    // the most-recent one in the cwd.
    const captureCmd = captureSessionId
      ? `SID=$(grep ${q(captureSessionId.line)} "$OUT" | head -1 | grep -oE ${q(captureSessionId.pattern)}); printf '%s' "$SID" > "$CTRL/sid"; `
      : "";
    const loadSid = captureSessionId ? `SID=$(cat "$CTRL/sid"); ` : "";
    const script =
      `CTRL=${q(ctrlDir)}; OUT=${q(outFile)}; n=0; ` +
      `while true; do ` +
      `while [ ! -f "$CTRL/prompt.$((n+1))" ]; do sleep 0.3; done; ` +
      `n=$((n+1)); ` +
      // Preserve the turn's exit code in rc BEFORE any capture grep clobbers PIPESTATUS.
      `if [ "$n" -eq 1 ]; then ${renderArgv(turn1)} < "$CTRL/prompt.$n" 2>&1 | tee -a "$OUT"; rc=\${PIPESTATUS[0]}; ${captureCmd}` +
      `else ${loadSid}${renderArgv(resume)} < "$CTRL/prompt.$n" 2>&1 | tee -a "$OUT"; rc=\${PIPESTATUS[0]}; fi; ` +
      `printf '\\n${markerBase} turn=%s exit=%s\\n' "$n" "$rc"; ` +
      `done`;
    return { command: ["bash", "-lc", script], ctrlDir, outFile, markerBase };
  }

  // NOTE: delegate mutates shared runtime state — the worker registry, the
  // lazily-bootstrapped workspace, and the bootstrap-pane-close latch
  // (bootstrapClosed). It MUST be awaited serially; callers must not invoke it
  // concurrently (e.g. Promise.all), or registry naming, the "first worker"
  // bootstrap, and the close latch race. Use delegateMany or sequential awaits.
  async function delegate(spec) {
    const normalized = normalizeTask(spec, { defaultAgent, index: registry.size + 1 });
    const profile = getAgentProfile(normalized.agent);
    const ws = await ensureWorkspace();
    const isFirst = registry.size === 0;
    const workerName = uniqueName(safeWorkerName(`${namePrefix}-${normalized.name}`));

    let workerCwd = normalized.cwd ?? cwd;
    let worktree;
    if (normalized.isolation === "worktree") {
      const wtResult = await herdr.createWorktree({
        cwd: workerCwd,
        branch: `drover/${workerName}`,
      });
      worktree = extractWorktreePath(wtResult, { dryRun: herdr.dryRun, name: workerName });
      workerCwd = worktree || workerCwd;
    }

    const profileName = normalized.profile || agentProfile || profile.defaultProfile;
    const mode = spec.mode || execMode;
    const env = {
      HERDR_AGENT: profile.herdrAgentHint,
      DROVER_WORKER_NAME: workerName,
      DROVER_AGENT: profile.id,
      DROVER_MODE: mode,
    };
    if (profileName) env.DROVER_AGENT_PROFILE = profileName;

    const prompt = buildWorkerPrompt({
      task: normalized.task,
      workerName,
      goal,
      preamble: profile.promptPreamble,
      constraints: normalized.constraints,
      expectedArtifacts: normalized.expectedArtifacts,
    });

    // Headless mode runs the agent non-interactively (prompt on stdin, output to
    // a file, a unique completion marker echoed to the pane) — no interactive
    // TUI to bootstrap or submit into. Interactive mode keeps the send flow.
    let command;
    let headless;
    let session;
    if (mode === "session") {
      session = await prepareSession({ workerName, profile, profileName, prompt });
      command = session.command;
    } else if (mode === "headless") {
      headless = await prepareHeadless({ workerName, profile, profileName, prompt });
      command = headless.command;
    } else {
      command = commandForAgent(profile, agentCommand, profileName);
    }

    const startResult = await herdr.startAgent({
      name: workerName,
      command,
      cwd: workerCwd,
      workspaceId: ws.workspaceId,
      split: isFirst ? undefined : splitDirection,
      env,
      focus: isFirst,
    });
    const paneId = extractAgentPaneId(startResult);

    // Close the bootstrap shell pane herdr spawns with a fresh workspace, so the
    // run leaves only real worker panes. Only when this runtime created the ws.
    if (isFirst && workspace.created && rootPaneId && !bootstrapClosed) {
      bootstrapClosed = true;
      await herdr.closePane(rootPaneId);
    }

    if (mode !== "headless" && mode !== "session") {
      await herdr.sendAgent(workerName, prompt);
    }

    registry.set(workerName, {
      id: workerName,
      workerName,
      paneId,
      agent: profile.id,
      profile: profileName,
      task: normalized.task,
      isolation: normalized.isolation,
      worktree,
      mode,
      ctrlDir: session?.ctrlDir,
      markerBase: session?.markerBase,
      outFile: headless?.outFile ?? session?.outFile,
      promptFile: headless?.promptFile,
      turn: session ? 1 : undefined,
      doneMarker: headless?.doneMarker,
      statusPolicy: normalized.statusPolicy,
      startResult,
      stopped: false,
    });

    return {
      id: workerName,
      workerName,
      paneId,
      agent: profile.id,
      task: normalized.task,
      isolation: normalized.isolation,
      startResult,
    };
  }

  async function delegateMany(specs, { wait = false } = {}) {
    const launched = [];
    for (const spec of specs) {
      const handle = await delegate(spec);
      launched.push({
        workerName: handle.workerName,
        agent: handle.agent,
        task: handle.task,
        startResult: handle.startResult,
      });
    }

    const waits = [];
    if (wait) {
      for (const item of launched) {
        const record = registry.get(item.workerName);
        const status = record?.statusPolicy?.waitFor || "done";
        const timeoutMs = record?.statusPolicy?.timeoutMs || waitTimeoutMs;
        try {
          // observe() routes headless (wait output) vs interactive (agent-status).
          const waitResult = await observe(item.workerName, { status, timeoutMs });
          waits.push({ workerName: item.workerName, status: "done", waitResult });
        } catch (error) {
          waits.push({ workerName: item.workerName, status: "not_done", error: error.message });
        }
      }
    }

    return { workspace, launched, waits, commands: herdr.commands };
  }

  function requireRecord(id) {
    const record = registry.get(id);
    if (!record) throw new Error(`Unknown worker "${id}".`);
    return record;
  }

  async function observe(id, { status = "done", timeoutMs = waitTimeoutMs } = {}) {
    const record = requireRecord(id);
    // Session workers wait on the per-turn marker; headless workers signal
    // completion by echoing a marker to their pane; interactive workers
    // transition herdr agent-status (targeted by pane id).
    if (record.mode === "session") {
      // The turn-loop wrapper prints `<markerBase> turn=<n> exit=<code>` to the
      // pane; wait output matches on the (turn-scoped) prefix. But the marker
      // fires for a crashed turn too, so we must inspect the captured exit code:
      // a non-zero exit is a failed turn, not "done".
      const result = await herdr.waitOutput(record.paneId, {
        match: `${record.markerBase} turn=${record.turn} `,
        timeoutMs,
      });
      const exitCode = parseTurnExit(result, record.markerBase, record.turn);
      if (exitCode !== undefined && exitCode !== 0) {
        const err = new Error(
          `Session worker "${id}" turn ${record.turn} exited with code ${exitCode}.`,
        );
        err.exitCode = exitCode;
        throw err;
      }
      // Preserve "done" semantics for exit=0 (or an unparseable marker, e.g. the
      // dry-run/fake path) while surfacing the code for callers that want it.
      if (result && typeof result === "object" && !Array.isArray(result)) {
        return { ...result, exitCode: exitCode ?? 0, ok: true };
      }
      return result;
    }
    if (record.mode === "headless") {
      return herdr.waitOutput(record.paneId, { match: record.doneMarker, timeoutMs });
    }
    return herdr.waitAgent(record.paneId || record.workerName, { status, timeoutMs });
  }

  async function collect(id, { source, lines } = {}) {
    const record = requireRecord(id);
    // Headless and session workers capture their output to a file (no flaky
    // TUI scraping).
    if (record.mode === "headless" || record.mode === "session") {
      let output = "";
      try {
        output = await readFile(record.outFile, "utf8");
      } catch {
        output = "";
      }
      return { id, workerName: record.workerName, agent: record.agent, output };
    }
    const result = await herdr.readAgent(record.workerName, { source, lines });
    const output = result && typeof result.stdout === "string" ? result.stdout : result;
    return { id, workerName: record.workerName, agent: record.agent, output };
  }

  async function followUp(id, prompt) {
    const record = requireRecord(id);
    if (record.mode !== "session") throw new Error(`Worker "${id}" is not a session worker.`);
    record.turn += 1;
    await writeFile(join(record.ctrlDir, `prompt.${record.turn}`), String(prompt));
    return { id, workerName: record.workerName, turn: record.turn };
  }

  // Surface a silent no-op: a live (non-dry-run) worker without a pane id can't
  // be closed via herdr.closePane. Never warn in dry-run mode (no real panes).
  function warnMissingPane(record) {
    if (herdr.dryRun === false) {
      console.warn(`Drover: worker "${record.workerName}" has no pane id; cannot close its pane.`);
    }
  }

  // Best-effort removal of a worker's on-disk control files: the session
  // control dir (holds prompt.<n> + out) or the headless prompt/out pair. Never
  // throws if the paths are already gone (force). Only touches per-worker paths,
  // never the shared headlessDir root (which may be caller-provided).
  async function cleanupWorkerFiles(record) {
    if (record.ctrlDir) await rm(record.ctrlDir, { recursive: true, force: true });
    if (record.promptFile) await rm(record.promptFile, { force: true });
    if (record.mode === "headless" && record.outFile) await rm(record.outFile, { force: true });
  }

  async function release(id) {
    const record = requireRecord(id);
    if (record.stopped) return { id, workerName: record.workerName, stopped: true };
    let result;
    if (record.paneId) result = await herdr.closePane(record.paneId);
    else warnMissingPane(record);
    await cleanupWorkerFiles(record);
    record.stopped = true;
    return { id, workerName: record.workerName, result };
  }

  async function close({ closeWorkspace } = {}) {
    // When closeWorkspace is an explicit boolean, honor it; when omitted, fall
    // back to the `cleanup` config ("close" tears down the workspace, "keep"
    // leaves it running).
    const shouldClose =
      typeof closeWorkspace === "boolean" ? closeWorkspace : cleanup === "close";
    // Closing the workspace tears down all of its panes in one call, so don't
    // also close panes individually (closing the last pane auto-closes the
    // workspace, and the follow-up `workspace close` would 404).
    if (shouldClose && workspace?.created && workspace.workspaceId) {
      for (const record of registry.values()) {
        await cleanupWorkerFiles(record);
        record.stopped = true;
      }
      let workspaceResult;
      try {
        workspaceResult = await herdr.closeWorkspace(workspace.workspaceId);
      } catch (error) {
        workspaceResult = { error: error.message };
      }
      return { closed: true, workspaceResult };
    }
    for (const record of registry.values()) {
      if (!record.stopped) {
        if (record.paneId) await herdr.closePane(record.paneId);
        else warnMissingPane(record);
        await cleanupWorkerFiles(record);
        record.stopped = true;
      }
    }
    return { closed: false };
  }

  function workers() {
    return [...registry.values()].map((record) => ({
      id: record.id,
      workerName: record.workerName,
      paneId: record.paneId,
      agent: record.agent,
      task: record.task,
      isolation: record.isolation,
      stopped: record.stopped,
    }));
  }

  return {
    delegate,
    delegateMany,
    observe,
    collect,
    followUp,
    release,
    close,
    workers,
    herdr,
    cleanup,
    get commands() {
      return herdr.commands;
    },
    get workspace() {
      return workspace;
    },
  };
}

// Pull the per-turn exit code out of a `wait output` result. The turn marker is
// `<markerBase> turn=<n> exit=<code>`; the result may be a plain string or a
// herdr JSON object (e.g. { stdout }), so search a stringified form. Returns the
// numeric code for the matched turn, or undefined when the marker/exit isn't
// present (leave "done" semantics untouched in that case).
function parseTurnExit(result, markerBase, turn) {
  const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
  const re = new RegExp(`${escapeRegExp(markerBase)} turn=${turn} exit=(\\d+)`);
  const match = text.match(re);
  return match ? Number(match[1]) : undefined;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function safeWorkerName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
