---
name: herdr-drover-supervisor-onboarding
description: Use when a supervisor, orchestrator, or agentic workflow needs to delegate work through Herdr-managed agents (kiro-cli, Claude Code, Codex) with Drover. Covers the createDroverRuntime facade, task-file mode, cleanup, and worktree isolation.
---

# Herdr Drover Supervisor Onboarding

Treat Drover as the delegation substrate, not the supervisor policy.

- Herdr owns the visible runtime: sessions, workspaces, panes, agent processes, status, notifications.
- Drover owns the delegation control surface: normalize tasks, launch workers, send prompts, wait/read status, tear down.
- Supervisors own policy: how work is split, which agents are chosen, when to retry, when to ask the user, final decisions.

Keep CAO, BMAD master, or other supervisor logic out of Drover core.

## First Pass

Inspect before changing: `README.md`, `docs/architecture.md`, `src/runtime.js`,
`src/orchestrator.js`, `src/herdr.js`, `src/agents.js`, `src/planner.js`,
`src/cli.js`. Then identify what the user wants: design guidance, a supervisor
adapter, the JS facade, CLI/task-file onboarding, or a Herdr plugin action.

## Integration Modes

Choose the smallest mode that fits.

### CLI Task-File Mode

Supervisor writes a Markdown task file:

    - agent=kiro profile=developer name=planner inspect the repo and produce a scoped plan
    - agent=kiro profile=developer name=builder implement the scoped change and run checks
    - agent=codex name=reviewer review the diff for risks and missing tests

Then: `drover run --task-file plan.md --cwd /repo --wait`
Validate generated plans first with `--dry-run`.

### JavaScript Runtime Mode (facade — current API)

    import { createDroverRuntime } from "./src/runtime.js";

    const drover = createDroverRuntime({ session: "work", cwd: "/repo", namePrefix: "sup", dryRun: true });

    const planner = await drover.delegate({ name: "planner", agent: "kiro", profile: "developer", task: "Write a plan" });
    await drover.observe(planner.id, { status: "done" });
    const plan = await drover.collect(planner.id);

    const builder = await drover.delegate({ name: "builder", agent: "kiro", isolation: "worktree", task: `Implement:\n${plan.output}` });
    await drover.observe(builder.id, { status: "done" });

Supervisor sequencing (hand-off) is delegate -> observe -> collect -> delegate.
Drover does not do DAGs.

### Supervisor Adapter Mode

A named supervisor translates its native concepts into Drover task specs and
calls `delegate` / `observe` / `collect`. It must not push its planning doctrine
into Drover. See `examples/supervisor-adapter.mjs`.

## Delegation Contract

Task spec fields. Required: `name`, `agent`, `task`. Forward-compatible:
`profile`, `cwd`, `constraints`, `expectedArtifacts`, `statusPolicy`,
`isolation`.

    {
      name: "builder",
      agent: "kiro",
      profile: "developer",
      cwd: "/repo",
      task: "Implement the scoped change",
      constraints: ["do not revert unrelated edits", "run focused checks"],
      expectedArtifacts: ["changed files", "test output", "status summary"],
      statusPolicy: { waitFor: "done", timeoutMs: 1800000 },
      isolation: "worktree"
    }

## Lifecycle & Cleanup

Default is keep: nothing auto-closes. Tear down explicitly.

- `await drover.release(id)` stops one worker's agent.
- `await drover.close({ closeWorkspace: true })` stops all workers and closes the workspace.

Worker panes persist until you release/close, so a supervisor can re-read output
or resume work.

## Cross-Repo vs Same-Repo

- Cross-repo feature: one runtime per repo/workspace, sharing a Herdr session.
  Hand off across them via `collect(A)` -> `delegate(B, useOutput)`.
- Same-repo parallel workers: pass `isolation: "worktree"` so each worker gets an
  isolated dir + branch and they do not stomp each other.

Note: Drover stops a worker by closing its pane (`herdr pane close <pane_id>` —
there is no `agent stop`) and closes the workspace with `herdr workspace close`.
It also closes the bootstrap shell pane Herdr opens with a fresh workspace, so a
run leaves no orphan shell.

## Validation

1. `npm test`
2. `node ./bin/drover.mjs run --dry-run --workers 2 "Validate supervisor integration"`
3. `node examples/supervisor-adapter.mjs --dry-run`
4. If Herdr is installed: `node ./bin/drover.mjs doctor`

Do not assume `herdr`, `kiro-cli`, `codex`, or `claude` are installed. If
missing, validate command generation with `--dry-run` and state what live checks
remain.

## Design Rules

- Keep Drover thin: runtime control, not supervisor intelligence.
- Keep supervisors swappable through the same delegation surface.
- Keep agent adapters separate from supervisor adapters.
- Do not make BMAD or CAO concepts required for basic Drover operation.
- Preserve Herdr as the source of truth for visible agent state.
