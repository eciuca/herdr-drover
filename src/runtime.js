import {
  HerdrCli,
  extractWorkspaceId,
  extractWorktreePath,
  extractRootPaneId,
  extractAgentPaneId,
} from "./herdr.js";
import { commandForAgent, getAgentProfile } from "./agents.js";
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
    workspaceId,
    workspaceLabel,
  } = config;

  const registry = new Map();
  let workspace = workspaceId ? { workspaceId, created: false } : null;
  let workspacePromise = null;
  let rootPaneId;
  let bootstrapClosed = false;

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
    const command = commandForAgent(profile, agentCommand, profileName);
    const env = {
      HERDR_AGENT: profile.herdrAgentHint,
      DROVER_WORKER_NAME: workerName,
      DROVER_AGENT: profile.id,
    };
    if (profileName) env.DROVER_AGENT_PROFILE = profileName;

    const startResult = await herdr.startAgent({
      name: workerName,
      command,
      cwd: workerCwd,
      workspaceId: ws.workspaceId,
      split: isFirst ? undefined : splitDirection,
      env,
      focus: isFirst,
    });

    // Close the bootstrap shell pane herdr spawns with a fresh workspace, so the
    // run leaves only real worker panes. Only when this runtime created the ws.
    if (isFirst && workspace.created && rootPaneId && !bootstrapClosed) {
      bootstrapClosed = true;
      await herdr.closePane(rootPaneId);
    }

    const prompt = buildWorkerPrompt({
      task: normalized.task,
      workerName,
      goal,
      preamble: profile.promptPreamble,
      constraints: normalized.constraints,
      expectedArtifacts: normalized.expectedArtifacts,
    });
    await herdr.sendAgent(workerName, prompt);

    registry.set(workerName, {
      id: workerName,
      workerName,
      paneId: extractAgentPaneId(startResult),
      agent: profile.id,
      profile: profileName,
      task: normalized.task,
      isolation: normalized.isolation,
      worktree,
      statusPolicy: normalized.statusPolicy,
      startResult,
      stopped: false,
    });

    return {
      id: workerName,
      workerName,
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
          // `wait agent-status` targets a pane id, not an agent name (herdr 0.7.2).
          const waitResult = await herdr.waitAgent(record?.paneId || item.workerName, { status, timeoutMs });
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
    // `wait agent-status` targets a pane id, not an agent name (herdr 0.7.2).
    return herdr.waitAgent(record.paneId || record.workerName, { status, timeoutMs });
  }

  async function collect(id, { source, lines } = {}) {
    const record = requireRecord(id);
    const result = await herdr.readAgent(record.workerName, { source, lines });
    const output = result && typeof result.stdout === "string" ? result.stdout : result;
    return { id, workerName: record.workerName, agent: record.agent, output };
  }

  async function release(id) {
    const record = requireRecord(id);
    if (record.stopped) return { id, workerName: record.workerName, stopped: true };
    let result;
    if (record.paneId) result = await herdr.closePane(record.paneId);
    record.stopped = true;
    return { id, workerName: record.workerName, result };
  }

  async function close({ closeWorkspace: shouldClose = false } = {}) {
    for (const record of registry.values()) {
      if (!record.stopped) {
        if (record.paneId) await herdr.closePane(record.paneId);
        record.stopped = true;
      }
    }
    let workspaceResult;
    if (shouldClose && workspace?.created && workspace.workspaceId) {
      workspaceResult = await herdr.closeWorkspace(workspace.workspaceId);
    }
    return { closed: shouldClose, workspaceResult };
  }

  function workers() {
    return [...registry.values()].map((record) => ({
      id: record.id,
      workerName: record.workerName,
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

function safeWorkerName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
