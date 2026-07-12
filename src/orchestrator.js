import { createDroverRuntime } from "./runtime.js";

export async function runDelegation({ herdr, tasks, options = {} }) {
  if (!tasks.length) throw new Error("No tasks to delegate.");

  const namePrefix = options.namePrefix || "drover";
  const workspaceLabel = options.workspaceLabel || `${namePrefix}-${Date.now()}`;

  const runtime = createDroverRuntime({
    herdr,
    cwd: options.cwd,
    workspaceId: options.workspaceId,
    workspaceLabel,
    namePrefix,
    goal: options.goal,
    splitDirection: options.splitDirection || "right",
    waitTimeoutMs: options.waitTimeoutMs,
    defaultAgent: options.defaultAgent,
    agentProfile: options.agentProfile,
    agentCommand: options.agentCommand,
  });

  const result = await runtime.delegateMany(tasks, { wait: Boolean(options.wait) });

  if (options.notify) {
    await herdr.notify("Drover delegation started", `${result.launched.length} worker(s) in ${workspaceLabel}`);
  }

  return {
    workspace: result.workspace,
    launched: result.launched,
    waits: result.waits,
    commands: result.commands,
  };
}
