// Placeholder token in a resume argv that the session wrapper replaces with the
// session id captured from turn 1's output (see codex below). Kept as a plain
// string so profile argvs stay deep-equal-comparable in tests.
export const SESSION_ID_SENTINEL = "__DROVER_SID__";

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
    // kiro has no launch-time session id; resume continues the most-recent
    // conversation in the cwd. Give a multi-turn kiro worker its own cwd
    // (isolation: "worktree") so concurrent workers don't cross-contaminate.
    sessionCommands(sessionId, profileName = "developer") {
      return {
        first: ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools", "--agent", profileName],
        resume: ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools", "--resume", "--agent", profileName],
      };
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
    // Verified live against codex-cli 0.144.2 (issue #2).
    headlessCommand() {
      return ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "-"];
    },
    // Session mode: pin the EXPLICIT session id captured from turn 1's banner
    // rather than `codex exec resume --last`. `--last` picks the newest session
    // in the cwd, so two codex workers sharing a cwd would cross-resume each
    // other (the same wrong-session hazard that makes claude pin its id). Turn 1
    // prints `session id: <uuid>`; the wrapper greps it and substitutes it for
    // SESSION_ID_SENTINEL on every resume. `codex exec resume <UUID> -` reads the
    // follow-up prompt on stdin. Verified live against codex-cli 0.144.2.
    sessionCommands() {
      return {
        first: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "-"],
        resume: [
          "codex", "exec", "resume", "--dangerously-bypass-approvals-and-sandbox",
          SESSION_ID_SENTINEL, "-",
        ],
        // How the wrapper extracts turn 1's session id: the first output line
        // matching `line`, then the first substring matching `pattern`.
        captureSessionId: { line: "session id:", pattern: "[0-9a-f-]{36}" },
      };
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
    // Session mode: pin a caller-provided session id so multi-turn resume is
    // deterministic regardless of other conversations in the cwd (verified live).
    sessionCommands(sessionId, profileName = "developer") {
      return {
        first: ["claude", "-p", "--session-id", sessionId, "--dangerously-skip-permissions"],
        resume: ["claude", "-p", "--resume", sessionId, "--dangerously-skip-permissions"],
      };
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

// Session-mode command pair for a multi-turn worker: { first, resume, [captureSessionId] }.
// Deterministic resume comes in two flavors: claude accepts a caller-pinned
// session id; codex pins the id printed at turn 1 (the wrapper greps it via
// captureSessionId and substitutes it for SESSION_ID_SENTINEL). kiro alone
// resumes the most-recent conversation in the cwd. Throws for agents that do
// not yet define session commands.
export function sessionCommandsForAgent(profile, sessionId, profileName) {
  if (!profile.sessionCommands) throw new Error(`Agent "${profile.id}" has no session commands.`);
  return profile.sessionCommands(sessionId, profileName || profile.defaultProfile);
}
