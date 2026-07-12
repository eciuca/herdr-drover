import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class HerdrCli {
  constructor({ bin = "herdr", session, dryRun = false, timeoutMs = 30_000 } = {}) {
    this.bin = bin;
    this.session = session;
    this.dryRun = dryRun;
    this.timeoutMs = timeoutMs;
    this.commands = [];
  }

  baseArgs() {
    return this.session ? ["--session", this.session] : [];
  }

  async run(args, { parseJson = true, input } = {}) {
    const fullArgs = [...this.baseArgs(), ...args];
    this.commands.push([this.bin, ...fullArgs]);
    if (this.dryRun) {
      return { dryRun: true, command: [this.bin, ...fullArgs] };
    }

    const { stdout, stderr } = await execFileAsync(this.bin, fullArgs, {
      input,
      timeout: this.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });

    const text = stdout.trim();
    if (!parseJson || !text) return { stdout: text, stderr: stderr.trim() };

    try {
      return JSON.parse(text);
    } catch {
      return { stdout: text, stderr: stderr.trim() };
    }
  }

  status() {
    return this.run(["status"], { parseJson: false });
  }

  createWorkspace({ cwd, label, focus = false, env = {} } = {}) {
    const args = ["workspace", "create"];
    if (cwd) args.push("--cwd", cwd);
    if (label) args.push("--label", label);
    for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
    args.push(focus ? "--focus" : "--no-focus");
    args.push("--json");
    return this.run(args);
  }

  startAgent({ name, command, cwd, workspaceId, tabId, split = "right", env = {}, focus = false }) {
    const args = ["agent", "start", name];
    if (cwd) args.push("--cwd", cwd);
    if (workspaceId) args.push("--workspace", workspaceId);
    if (tabId) args.push("--tab", tabId);
    if (split) args.push("--split", split);
    for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
    args.push(focus ? "--focus" : "--no-focus");
    args.push("--json");
    args.push("--", ...command);
    return this.run(args);
  }

  sendAgent(target, text) {
    return this.run(["agent", "send", target, text]);
  }

  readAgent(target, { source = "recent-unwrapped", lines = 120 } = {}) {
    return this.run(["agent", "read", target, "--source", source, "--lines", String(lines)], {
      parseJson: false,
    });
  }

  waitAgent(target, { status = "done", timeoutMs = 1_800_000 } = {}) {
    return this.run(["wait", "agent-status", target, "--status", status, "--timeout", String(timeoutMs)]);
  }

  notify(title, body) {
    const args = ["notification", "show", title];
    if (body) args.push("--body", body);
    args.push("--sound", "done");
    return this.run(args);
  }

  closePane(paneId) {
    return this.run(["pane", "close", paneId]);
  }

  closeWorkspace(workspaceId) {
    return this.run(["workspace", "close", workspaceId]);
  }

  createWorktree({ workspace, cwd, branch, base, path, label } = {}) {
    const args = ["worktree", "create"];
    if (workspace) args.push("--workspace", workspace);
    else if (cwd) args.push("--cwd", cwd);
    if (branch) args.push("--branch", branch);
    if (base) args.push("--base", base);
    if (path) args.push("--path", path);
    if (label) args.push("--label", label);
    args.push("--json");
    return this.run(args);
  }
}

export function extractWorkspaceId(response) {
  return (
    response?.workspace?.id ||
    response?.result?.workspace?.id ||
    response?.id ||
    response?.workspace_id ||
    undefined
  );
}

export function extractWorktreePath(response, { dryRun = false, name } = {}) {
  return (
    response?.result?.worktree?.path ||
    response?.worktree?.path ||
    response?.result?.path ||
    response?.path ||
    (dryRun ? `dry-run-worktree/${name}` : undefined)
  );
}

export function extractRootPaneId(response) {
  return response?.result?.root_pane?.pane_id || response?.root_pane?.pane_id || undefined;
}

export function extractAgentPaneId(response) {
  return response?.result?.agent?.pane_id || response?.agent?.pane_id || undefined;
}
