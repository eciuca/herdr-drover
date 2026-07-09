import { commandForAgent, getAgentProfile } from "./agents.js";
import { buildWorkerPrompt } from "./planner.js";
import { extractWorkspaceId } from "./herdr.js";

export async function runDelegation({ herdr, tasks, options }) {
  if (!tasks.length) throw new Error("No tasks to delegate.");

  const workspaceLabel = options.workspaceLabel || `drover-${Date.now()}`;
  const workspace = options.workspaceId
    ? { workspaceId: options.workspaceId, created: false }
    : await createWorkspace(herdr, {
        cwd: options.cwd,
        label: workspaceLabel,
      });

  const launched = [];
  for (const [index, task] of tasks.entries()) {
    const profile = getAgentProfile(task.agent || options.defaultAgent);
    const workerName = safeWorkerName(`${options.namePrefix}-${task.name || `worker-${index + 1}`}`);
    const prompt = buildWorkerPrompt({
      task: task.task,
      workerName,
      goal: options.goal,
      preamble: profile.promptPreamble,
    });
    const command = commandForAgent(profile, options.agentCommand, task.profile || options.agentProfile);
    const env = {
      HERDR_AGENT: profile.herdrAgentHint,
      DROVER_WORKER_NAME: workerName,
      DROVER_AGENT: profile.id,
    };
    const agentProfile = task.profile || options.agentProfile || profile.defaultProfile;
    if (agentProfile) env.DROVER_AGENT_PROFILE = agentProfile;

    const result = await herdr.startAgent({
      name: workerName,
      command,
      cwd: options.cwd,
      workspaceId: workspace.workspaceId,
      split: index === 0 ? undefined : options.splitDirection,
      env,
      focus: index === 0,
    });
    await herdr.sendAgent(workerName, prompt);
    launched.push({
      workerName,
      agent: profile.id,
      task: task.task,
      startResult: result,
    });
  }

  const waits = [];
  if (options.wait) {
    for (const worker of launched) {
      try {
        const waitResult = await herdr.waitAgent(worker.workerName, {
          status: "done",
          timeoutMs: options.waitTimeoutMs,
        });
        waits.push({ workerName: worker.workerName, status: "done", waitResult });
      } catch (error) {
        waits.push({ workerName: worker.workerName, status: "not_done", error: error.message });
      }
    }
  }

  if (options.notify) {
    await herdr.notify("Drover delegation started", `${launched.length} worker(s) in ${workspaceLabel}`);
  }

  return {
    workspace,
    launched,
    waits,
    commands: herdr.commands,
  };
}

async function createWorkspace(herdr, { cwd, label }) {
  const result = await herdr.createWorkspace({
    cwd,
    label,
    focus: false,
    env: {
      DROVER_WORKSPACE: label,
    },
  });
  return {
    workspaceId: extractWorkspaceId(result) || (herdr.dryRun ? `dry-run-${label}` : undefined),
    created: true,
    result,
  };
}

function safeWorkerName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
