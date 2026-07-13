export const AGENT_PROFILES = {
  kiro: {
    id: "kiro",
    label: "kiro",
    defaultProfile: "developer",
    commandForProfile(profileName = "developer") {
      return ["kiro-cli", "chat", "--agent", profileName];
    },
    herdrAgentHint: "kiro",
    promptPreamble:
      "You are a Kiro CLI worker managed by Drover. Work only on the assigned task, report blockers clearly, and finish with a concise status summary.",
    // Headless (non-interactive) invocation. The Drover wrapper pipes the prompt
    // on stdin, so no prompt goes in the argv. `--no-interactive` runs without
    // expecting user input, `--trust-all-tools` bypasses tool-approval prompts,
    // and `--agent <AGENT>` selects the profile.
    //
    // NOTE (issue #2): `kiro-cli chat` accepts an optional [INPUT] positional as
    // its prompt. In --no-interactive mode kiro-cli also reads from stdin, so the
    // Drover stdin wrapper works. If a future kiro-cli build ignores stdin and
    // requires the [INPUT] positional, Drover will need a per-agent argv-prompt
    // mode (the wrapper currently always feeds the prompt on stdin).
    headlessCommand(profileName = "developer") {
      return ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools", "--agent", profileName];
    },
    // Headless resume: continue the most recent conversation in the worker's cwd
    // (verified live). Prompt still arrives on stdin via the Drover wrapper.
    headlessResumeCommand(profileName = "developer") {
      return ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools", "--resume", "--agent", profileName];
    },
  },
  codex: {
    id: "codex",
    label: "codex",
    defaultCommand: ["codex"],
    herdrAgentHint: "codex",
    promptPreamble:
      "You are a Codex worker managed by Drover. Work only on the assigned task, avoid reverting unrelated changes, and finish with checks performed.",
    // Headless (non-interactive) invocation. `codex exec` runs a single turn
    // non-interactively; the prompt is piped on stdin by the Drover wrapper (no
    // prompt in argv). `--dangerously-bypass-approvals-and-sandbox` runs without
    // approval prompts or sandbox gating so the worker can act unattended.
    //
    // UNVERIFIED (issue #2): codex is NOT installed in this environment, so this
    // argv could not be validated against a live CLI. Flag names/behavior should
    // be confirmed on a machine with codex before relying on it.
    headlessCommand() {
      return ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "-"];
    },
    // UNVERIFIED (issue #2): codex not installed; resume argv is best-effort.
    headlessResumeCommand() {
      return ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "resume", "-"];
    },
  },
  claude: {
    id: "claude",
    label: "claude",
    defaultCommand: ["claude"],
    herdrAgentHint: "claude",
    promptPreamble:
      "You are a Claude Code worker managed by Drover. Work only on the assigned task, avoid reverting unrelated changes, and finish with a concise status summary.",
    // Headless (non-interactive) invocation. The prompt is fed on stdin by the
    // Drover wrapper, so no prompt goes in the argv. `-p` prints the response
    // and exits; `--dangerously-skip-permissions` bypasses tool prompts. This
    // avoids the interactive TUI's folder-trust gate and submit handling.
    headlessCommand() {
      return ["claude", "-p", "--dangerously-skip-permissions"];
    },
    // Headless resume: `-c` continues the most recent conversation in the cwd
    // (verified live). Prompt arrives on stdin.
    headlessResumeCommand() {
      return ["claude", "-p", "-c", "--dangerously-skip-permissions"];
    },
  },
};

export function getAgentProfile(agentId) {
  const profile = AGENT_PROFILES[agentId];
  if (!profile) {
    const known = Object.keys(AGENT_PROFILES).join(", ");
    throw new Error(`Unknown agent "${agentId}". Known agents: ${known}`);
  }
  return profile;
}

export function commandForAgent(profile, overrideCommand, profileName) {
  if (overrideCommand?.length) return overrideCommand;
  if (profile.commandForProfile) return profile.commandForProfile(profileName || profile.defaultProfile);
  return profile.defaultCommand;
}

// The bare headless (non-interactive) agent argv. The prompt is delivered on
// stdin by the Drover headless wrapper, never in the argv. Throws for agents
// that do not yet define a headless invocation.
export function headlessCommandForAgent(profile, overrideCommand, profileName) {
  if (overrideCommand?.length) return overrideCommand;
  if (profile.headlessCommand) return profile.headlessCommand(profileName || profile.defaultProfile);
  throw new Error(`Agent "${profile.id}" has no headless command; use interactive mode or pass agentCommand.`);
}

// The bare headless resume (continue-most-recent-conversation) agent argv. The
// prompt is delivered on stdin by the Drover headless wrapper, never in the
// argv. Throws for agents that do not yet define a headless resume invocation.
export function headlessResumeCommandForAgent(profile, overrideCommand, profileName) {
  if (overrideCommand?.length) return overrideCommand;
  if (profile.headlessResumeCommand) return profile.headlessResumeCommand(profileName || profile.defaultProfile);
  throw new Error(`Agent "${profile.id}" has no headless resume command.`);
}
