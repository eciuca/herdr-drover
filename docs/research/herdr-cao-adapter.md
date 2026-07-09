# Herdr CAO Adapter Research Note

Date: 2026-07-09

Goal: build Drover as a CAO-style supervisor/worker orchestrator, but use Herdr as the terminal runtime instead of tmux. Prioritize `kiro-cli` first; keep Claude Code and Codex provider support in the shape of the adapter.

## Useful Source Links

- Herdr concepts: https://herdr.dev/docs/concepts/
- Herdr CLI reference: https://herdr.dev/docs/cli-reference/
- Herdr socket API: https://herdr.dev/docs/socket-api/
- Herdr agents: https://herdr.dev/docs/agents/
- CAO README: https://github.com/awslabs/cli-agent-orchestrator
- CAO Herdr backend doc: https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/herdr.md
- CAO Kiro CLI provider doc: https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/kiro-cli.md
- AWS CAO announcement: https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/

## Architecture Takeaways

CAO's relevant model is simple: a supervisor delegates work to isolated worker CLI agents, then observes and routes messages using a small set of primitives: sync handoff, async assign, and send message. CAO uses tmux sessions as the runtime isolation layer and MCP/HTTP/CLI as management surfaces. Each worker remains a real CLI process, preserving auth, TUI behavior, and provider-specific features.

Herdr can replace the tmux layer more directly than a generic PTY wrapper because Herdr's first-class objects already match this shape:

- Drover project/session -> Herdr workspace.
- Drover worker lane/window -> Herdr tab or named agent pane.
- Worker process -> real Herdr pane running `kiro-cli`, `claude`, or `codex`.
- Worker lifecycle -> Herdr semantic `agent_status`: `working`, `blocked`, `done`, `idle`, `unknown`.

CAO's own Herdr doc maps CAO session to Herdr workspace and CAO terminal/window to Herdr tab. It also says the Herdr backend uses `pane.agent_status_changed` events for immediate inbox delivery instead of polling tmux output every few seconds. That is the key adapter decision for Drover: use Herdr state/events as the canonical worker readiness signal, then fall back to pane reads only for transcript extraction and debugging.

## Herdr Control Surface

Prefer the CLI wrappers for the first implementation. Herdr says the CLI and socket API share the same control surface, most commands emit JSON, and the raw socket is mainly for custom clients or long-lived event streams.

Session/runtime:

```bash
herdr --session drover
herdr session list --json
herdr session attach drover
herdr session stop drover --json
```

Workspace and tab setup:

```bash
herdr workspace create --cwd /repo --label drover-task-123 --no-focus
herdr workspace list
herdr workspace get <workspace_id>
herdr tab create --workspace <workspace_id> --cwd /repo --label agents --no-focus
herdr tab list --workspace <workspace_id>
```

Pane lifecycle and ordinary command execution:

```bash
herdr pane list --workspace <workspace_id>
herdr pane split <pane_id> --direction right --ratio 0.5 --cwd /repo --no-focus
herdr pane run <pane_id> "npm test"
herdr pane read <pane_id> --source recent-unwrapped --lines 120
herdr pane send-text <pane_id> "continue from the last result"
herdr pane send-keys <pane_id> enter
herdr pane close <pane_id>
```

Agent lifecycle:

```bash
herdr agent start reviewer --cwd /repo --split right -- kiro-cli chat --agent reviewer
herdr agent start implementer --workspace <workspace_id> --tab <tab_id> -- kiro-cli chat --agent developer
herdr agent list
herdr agent get <agent_or_pane_id>
herdr agent rename <agent_or_pane_id> reviewer
herdr agent attach reviewer
```

Status and waiting:

```bash
herdr wait agent-status <pane_id_or_agent> --status done
herdr wait agent-status <pane_id_or_agent> --status blocked
herdr pane read <pane_id> --source detection
herdr agent explain <pane_id> --json
```

State reporting from a Drover shim or hook, if Herdr's screen detection is not enough for Kiro:

```bash
herdr pane report-agent <pane_id> \
  --source drover:kiro \
  --agent kiro-cli \
  --state working \
  --custom-status "implementing"
```

Use this cautiously. `state` is semantic and affects waits, notifications, and rollups. `custom-status` is display-only.

## Raw Socket API

Use the raw API when Drover needs persistent subscriptions, lower overhead, or a single daemon process managing many panes. The transport is newline-delimited JSON over a local socket. Default Unix socket paths are:

```text
~/.config/herdr/herdr.sock
~/.config/herdr/sessions/<name>/herdr.sock
```

Resolution order is explicit `--session`, then `HERDR_SOCKET_PATH`, then `HERDR_SESSION`, then default session.

Relevant raw methods and events:

- `pane.read` for transcript snapshots.
- `pane.report_agent` for semantic lifecycle reporting from a provider shim.
- `pane.report_agent_session` for storing native provider session references.
- `pane.report_metadata` for display-only names/status labels.
- `events.subscribe` for `pane.agent_status_changed`, `pane.closed`, `pane.exited`, `workspace.closed`, and layout updates.

Example subscription shape:

```json
{
  "id": "sub_worker_1",
  "method": "events.subscribe",
  "params": {
    "subscriptions": [
      {
        "type": "pane.agent_status_changed",
        "pane_id": "w1:p1",
        "agent_status": "blocked"
      }
    ]
  }
}
```

For v0, use `herdr wait agent-status` in subprocesses. For v1 daemon mode, open the Herdr socket once, call `events.subscribe` for each worker pane, and update Drover's worker registry from pushed events.

## Minimal Kiro-First Workflow

1. Start or attach a named Herdr session:

```bash
herdr --session drover
```

2. Create one workspace per Drover run:

```bash
herdr workspace create --cwd "$REPO" --label "drover-$RUN_ID" --no-focus
```

Capture the returned workspace id. If Herdr output shape changes, parse JSON when available and otherwise call `herdr workspace list` and match by label/cwd.

3. Create an `agents` tab:

```bash
herdr tab create --workspace "$WORKSPACE_ID" --cwd "$REPO" --label agents --no-focus
```

4. Launch the supervisor in its own pane, using Kiro's required profile:

```bash
herdr agent start supervisor \
  --workspace "$WORKSPACE_ID" \
  --tab "$TAB_ID" \
  --cwd "$REPO" \
  -- kiro-cli chat --agent developer
```

5. Launch each worker pane with a specific Kiro profile and role label:

```bash
herdr agent start reviewer \
  --workspace "$WORKSPACE_ID" \
  --tab "$TAB_ID" \
  --cwd "$REPO" \
  -- kiro-cli chat --agent reviewer

herdr agent start implementer \
  --workspace "$WORKSPACE_ID" \
  --tab "$TAB_ID" \
  --cwd "$REPO" \
  -- kiro-cli chat --agent developer
```

6. Send assignments as terminal input:

```bash
herdr pane send-text "$WORKER_PANE" "$ASSIGNMENT"
herdr pane send-keys "$WORKER_PANE" enter
```

Use a strict prompt envelope so transcript parsing is easy:

```text
Drover assignment:
- role: reviewer
- run_id: drover-123
- expected output: concise findings and changed files only
- stop condition: reply DONE, BLOCKED: <reason>, or NEEDS_REVIEW: <summary>
```

7. Wait for state:

```bash
herdr wait agent-status "$WORKER_PANE" --status done
```

Also watch `blocked` in parallel. Herdr's states mean: `blocked` needs input/approval/decision, `working` is active, `done` finished and unseen, `idle` finished or waiting and seen, `unknown` cannot be classified.

8. Read final output:

```bash
herdr pane read "$WORKER_PANE" --source recent-unwrapped --lines 200
```

9. Deliver summaries back to the supervisor by sending a synthesized message into the supervisor pane, or store worker results in a Drover run file and tell the supervisor to read it.

## Provider Notes

Kiro CLI:

- CAO docs say Kiro requires an agent profile and launches with `kiro-cli chat --agent {profile_name}`.
- Built-in profiles include `developer` and `reviewer`.
- Kiro permission prompts include `Allow this action? [y/n/t]:`; treat these as `blocked`/human-input-required.
- CAO detects both legacy prompt format (`[developer] >`) and the newer TUI text (`ask a question, or describe a task`). Drover should prefer Herdr's detection, but keep a provider fallback parser for this prompt/permission text.

Claude Code and Codex:

- Herdr has screen-manifest support for both Claude Code and Codex, and official/direct integrations can improve state/session reporting for some agents.
- Keep provider config as `{name, command, args, cwd, env, status_parser?}` so adding `claude` or `codex` is not a separate runtime path.
- If available on the target box, install Herdr integrations for better state reporting:

```bash
herdr integration install claude
herdr integration status
```

## Adapter Shape

Recommended internal interfaces:

```text
HerdrRuntime
  ensureSession(name)
  createWorkspace(label, cwd) -> workspaceId
  createTab(workspaceId, label, cwd) -> tabId
  startAgent({name, command, args, cwd, workspaceId, tabId}) -> WorkerHandle
  send(worker, text)
  read(worker, lines, source)
  wait(worker, statuses, timeout) -> status
  close(worker)

Provider
  id: kiro | claude | codex
  launchCommand(profile) -> argv
  initialPromptEnvelope(task) -> text
  parseFallbackStatus(output) -> working | blocked | done | idle | unknown
```

Drover should persist `run_id`, Herdr `session`, `workspace_id`, `tab_id`, worker `pane_id`, provider id, profile, assignment, last status, and result path. This makes restart/reconnect possible and prevents orphan panes from becoming invisible.

## Implementation Bias

- Build v0 on Herdr CLI commands, parsed JSON where available.
- Use `agent start` for worker CLIs, not bare `pane run`, so workers appear in `agent list`, can be addressed by name, and can participate in agent state waits.
- Use Herdr semantic state/events as truth. Use transcript parsing only for provider-specific details and final summaries.
- Keep a raw socket client behind the same runtime interface for v1 event streaming.
- Mirror CAO's useful patterns: isolated worker terminals, supervisor/worker roles, async assign, sync wait/handoff, and attachable human inspection.
- Do not copy CAO's tmux polling model; Herdr's value is native status events and pane identity.

## Open Questions

- Exact JSON output shape of `herdr agent start` and `workspace create` should be verified against the installed Herdr binary with `herdr api schema --json`.
- Herdr docs list Kiro CLI as screen-manifest supported but with no state-authority integration. The first prototype should test whether Kiro's new TUI reliably flips `done`/`blocked`; if not, add a small Drover Kiro status shim using `pane.report-agent`.
- Decide whether Drover should create Git worktrees per worker. Herdr has `worktree create/open/remove`, but the requested first pass only needs shared-repo panes.
