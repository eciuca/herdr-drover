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
  },
  codex: {
    id: "codex",
    label: "codex",
    defaultCommand: ["codex"],
    herdrAgentHint: "codex",
    promptPreamble:
      "You are a Codex worker managed by Drover. Work only on the assigned task, avoid reverting unrelated changes, and finish with checks performed.",
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
