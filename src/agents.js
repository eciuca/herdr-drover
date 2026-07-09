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
