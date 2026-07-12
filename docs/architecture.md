# Drover Architecture

Drover is a thin supervisor over Herdr. Herdr remains the terminal/runtime surface; Drover only decides what workers to launch, what prompts to send, and what statuses to wait for.

## Runtime

Drover uses Herdr CLI commands first because Herdr documents them as the preferred automation layer for scripts. The raw socket API can replace the CLI wrapper later if long-lived subscriptions become necessary.

Current control surface:

- `herdr workspace create` opens a workspace for a delegated run.
- `herdr agent start` launches a visible agent process in a Herdr pane.
- `herdr agent send` dispatches the worker prompt.
- `herdr agent wait` waits for `done`, `blocked`, `idle`, or other state.
- `herdr agent read` captures recent output for summaries.
- `herdr notification show` surfaces completion or blocker notifications.

The implementation currently uses CLI wrappers rather than the raw socket. That keeps v0 easy to debug and matches Herdr's recommendation for simple orchestration. A future daemon mode should switch worker monitoring to raw `events.subscribe` for `pane.agent_status_changed`.

## Agent Profiles

The first profile is `kiro`, because the initial target is Kiro CLI. It launches as `kiro-cli chat --agent <profile>`, defaulting to `developer`. `codex` and `claude` profiles are present so task files can already route review or implementation slices to them.

Each profile defines:

- default launch command
- Herdr agent hint
- worker prompt preamble

## Delegation Model

Version 0.1 supports two delegation paths:

- inline goal with `--workers N`, which creates role prompts for planner, builder, and reviewers
- markdown task file, which gives explicit worker assignments

The task-file path is the more reliable orchestration mode. It avoids pretending that a deterministic CLI can infer perfect splits without an LLM planner.

## Facade

`src/runtime.js` exposes `createDroverRuntime()` as the stable public API.
`runDelegation` (used by the CLI) is a thin wrapper over it. Supervisors call
`delegate`, `delegateMany`, `observe`, `collect`, `release`, and `close`. The
runtime owns one lazy workspace and a worker registry keyed by worker name.

Cleanup defaults to `keep`; teardown is explicit. Same-repo parallelism uses
`isolation: "worktree"` (Herdr `worktree create`); cross-repo work uses one
runtime per workspace.

## Next Steps

- Add a planning phase that asks one agent to produce a task file, then launches the resulting workers.
- Add `blocked` wait handling and automatic notification.
- Add output collection with `herdr agent read` for a final supervisor summary.
- Add a Herdr plugin manifest so Drover can be invoked from inside Herdr.
