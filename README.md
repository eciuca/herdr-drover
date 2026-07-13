# Drover for Herdr

CLI agent orchestration for Herdr.

Drover coordinates terminal-based coding agents like Kiro CLI, Claude Code, Codex, OpenCode, and other CLI workers through Herdr workspaces, panes, statuses, and notifications.

Herdr gives you the herd. Drover drives it toward done.

## Status

Early prototype. Kiro CLI is the first target; Claude Code and Codex profiles are included so they can be routed from task files.

## Install

```bash
npm install
npm link
```

## Quick Start

Dry-run the commands Drover would send to Herdr:

```bash
drover run --dry-run --workers 2 "Implement a small feature and verify it"
```

Run a Kiro-first task file:

```bash
drover run --agent kiro --task-file examples/kiro-first.plan.md
```

Use an existing Herdr named session:

```bash
drover run --session work --agent kiro "Investigate the failing tests"
```

## Task Files

Task files are Markdown lists. Each task can optionally choose an agent and stable worker name:

```md
- agent=kiro profile=developer name=planner inspect the repo and produce a short plan
- agent=kiro profile=developer name=builder implement the plan and run focused checks
- agent=codex name=reviewer review the diff for risks
```

## How It Works

Drover uses Herdr's CLI/socket-backed control surface:

- creates or reuses a Herdr workspace
- starts one visible Herdr agent pane per worker
- sends each worker a scoped prompt
- optionally waits for Herdr agent status `done`
- can notify through Herdr when delegation starts

## Commands

```bash
drover run [options] "task"
drover run --task-file plan.md [options]
drover doctor
drover profiles
```

Useful options:

```text
--agent kiro|codex|claude
--agent-profile developer
--agent-command "kiro --some-flag"
--workers 3
--cwd /path/to/repo
--workspace w1
--session work
--wait
--dry-run
--no-notify
```

## Supervisor Integration

External supervisors bind to the stable facade in `src/runtime.js`, not to
internal modules.

```js
import { createDroverRuntime } from "./src/runtime.js";

const drover = createDroverRuntime({ session: "work", cwd: "/repo", namePrefix: "sup" });

const planner = await drover.delegate({ name: "planner", agent: "kiro", profile: "developer", task: "Write a plan" });
await drover.observe(planner.id, { status: "done" });
const plan = await drover.collect(planner.id);

const builder = await drover.delegate({ name: "builder", agent: "kiro", isolation: "worktree", task: `Implement:\n${plan.output}` });
await drover.observe(builder.id, { status: "done" });

await drover.close({ closeWorkspace: true }); // cleanup is opt-in; default keeps workers
```

### Session mode (visible, multi-turn, human takeover)

`execMode: "session"` runs each worker as a persistent, **visible** agent in its
own herdr pane — output streams to the pane (not just a file), so you can watch
it, `herdr agent attach <paneId>` to take over, then hand back. Follow-up turns
resume the same conversation.

```js
const drover = createDroverRuntime({ cwd: "/repo", namePrefix: "sup", execMode: "session" });

const w = await drover.delegate({ name: "dev", agent: "claude", task: "Draft a plan" });
await drover.observe(w.id);            // waits for turn 1's completion marker
console.log(w.paneId);                 // herdr agent attach <paneId> to take over

await drover.followUp(w.id, "Now implement step 1.");
await drover.observe(w.id);            // waits for turn 2
const transcript = await drover.collect(w.id);
```

Multi-turn resume is deterministic for `claude` (a per-worker session id is
pinned, so turns resume the right conversation even when a cwd holds several).
`kiro`/`codex` resume the most recent conversation in the worker's cwd, so give a
multi-turn kiro/codex worker its own cwd (e.g. `isolation: "worktree"`) when
other workers share the base directory. Session mode builds its launch commands
per agent to thread the session id, so the `agentCommand` override does not apply
in this mode. Reliable interactive TUI driving is not supported — session mode
delivers visibility/takeover/multi-turn without it.

- Hand-off is supervisor-driven: `delegate → observe → collect → delegate`.
- Cleanup defaults to keep. Use `release(id)` / `close({ closeWorkspace })` to tear down.
- Cross-repo work: one runtime per repo, sharing a session.
- Same-repo parallel workers: pass `isolation: "worktree"` to avoid stomping.

See `examples/supervisor-adapter.mjs` for a kiro plan→build→review run.

## Design

Drover is intentionally thin. Herdr remains the actual runtime, UI, SSH-friendly surface, and status source. Drover adds a CAO-style supervisor layer on top: splitting work, launching workers, dispatching prompts, and collecting status.

See [docs/architecture.md](docs/architecture.md).

## Herdr Plugin

The repo includes a first `herdr-plugin.toml` so Drover can later be linked into Herdr:

```bash
herdr plugin link /path/to/herdr-drover
```

The initial actions are intentionally minimal: `doctor` and a Kiro-first plan launcher.
