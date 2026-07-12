# Drover Supervisor Facade + Onboarding Skill — Design

- Date: 2026-07-12
- Status: approved
- Source proposal: `herdr-drover-supervisor-onboarding-20260710-91cb5d26d9`

## Goal

Turn the pending "Herdr Drover Supervisor Onboarding" proposal into working repo
changes: a stable JavaScript facade external supervisors bind to, opt-in worker
lifecycle cleanup, opt-in git-worktree isolation, a runnable supervisor adapter
example, tests, an installed onboarding skill, and updated docs.

Drover stays thin: it owns the delegation control surface (normalize tasks,
launch workers, send prompts, wait/read status, tear down). Herdr owns the
visible runtime. Supervisors own policy (splitting, agent choice, retries,
sequencing, final decisions). No supervisor doctrine (CAO, BMAD) enters Drover
core.

## Core decisions

1. **Stable facade** `createDroverRuntime()` in a new `src/runtime.js`. Other
   modules (`orchestrator`, `herdr`, `planner`, `agents`) become internal.
2. **Hand-off is supervisor-driven.** No `needs=`/DAG in core. A supervisor
   sequences by `delegate` → `observe` → `collect` → `delegate(next)`.
3. **Cleanup defaults to keep.** Nothing auto-closes. Teardown only via explicit
   `release(id)` / `close()`.
4. **Cross-repo = multiple runtimes** sharing one Herdr session (docs pattern, no
   new code). **Same-repo parallelism = opt-in worktree isolation.**
5. **Kiro-first.** `kiro` is the primary profile (`kiro-cli chat --agent
   <profile>`). Facade, adapter example, skill, and tests all exercise kiro.

## Facade API (`src/runtime.js`)

```js
const drover = createDroverRuntime({
  herdr,            // HerdrCli or any herdr-like object (dependency injected)
  session,          // optional; used only if herdr not supplied
  cwd,              // default working dir for workers
  namePrefix,       // default "drover"
  goal,             // optional overall-goal string injected into prompts
  dryRun,           // only used if herdr not supplied
  splitDirection,   // default "right"
  cleanup,          // "keep" (default) — reserved for future auto modes
  waitTimeoutMs,    // default observe timeout, default 1_800_000
});

await drover.delegate(spec);                       // launch ONE worker
await drover.delegate({ ...spec, isolation: "worktree" }); // isolated dir+branch
await drover.delegateMany(specs, { wait });        // batch launch
await drover.observe(id, { status, timeoutMs });   // wait for herdr agent status
await drover.collect(id, { lines, source });       // read worker output
await drover.release(id);                          // stop one worker's agent
await drover.close({ closeWorkspace });            // stop all; optionally close ws
drover.workers();                                  // array of registry snapshots
drover.herdr;                                       // escape hatch
drover.commands;                                    // herdr.commands passthrough
```

### Behaviour

- **Runtime construction.** If `herdr` is supplied, use it. Otherwise construct
  `new HerdrCli({ session, dryRun })`. This keeps the facade fully testable with
  a fake herdr and keeps a convenience path for simple callers.
- **Lazy single workspace.** The runtime owns exactly one workspace, created on
  the first `delegate`/`delegateMany`, then reused. `workspaceId` may be passed
  at construction to reuse an existing Herdr workspace (created:false).
- **Worker registry.** `Map<id, record>` where `id === workerName` (Herdr targets
  agents by name). `record = { id, workerName, agent, profile, task, isolation,
  worktree?, statusPolicy, startResult }`.
- **`delegate(spec)`**:
  1. `normalizeTask(spec, defaults)` (see planner section) — throws if `task`
     missing.
  2. Ensure workspace (lazy create).
  3. Compute `workerName = safeWorkerName(namePrefix + "-" + name)`, de-duplicate
     against the registry by appending `-2`, `-3`, … if the name is already used.
  4. If `isolation === "worktree"`: call `herdr.createWorktree(...)`, resolve the
     worktree path, use it as the worker `cwd`. Otherwise use `spec.cwd ?? cwd`.
  5. `command = commandForAgent(profile, agentCommand, profile.defaultProfile or
     spec.profile)`.
  6. `herdr.startAgent({...})` with `focus` = true only for the first worker in
     the workspace, `split` for the rest.
  7. `herdr.sendAgent(workerName, buildWorkerPrompt({...}))`.
  8. Register and return the handle
     `{ id, workerName, agent, task, isolation, startResult }`.
- **`delegateMany(specs, { wait })`** loops `delegate` in order; when `wait`,
  `observe` each launched worker with its `statusPolicy` (default status "done").
  Returns `{ workspace, launched, waits, commands }` (see compat section).
- **`observe(id, opts)`** → `herdr.waitAgent(workerName, { status, timeoutMs })`.
  Unknown id throws.
- **`collect(id, opts)`** → `herdr.readAgent(workerName, { source, lines })`;
  returns `{ id, workerName, agent, output }` where `output` is the read text
  (string) or the raw read result if non-string.
- **`release(id)`** → `herdr.stopAgent(workerName)`; leaves the record but marks
  `stopped: true`.
- **`close({ closeWorkspace = false })`** → `release` every non-stopped worker,
  then if `closeWorkspace` and the runtime created the workspace,
  `herdr.closeWorkspace(workspaceId)`.

### Notes

- `cleanup` is accepted and stored now with only `"keep"` honored. Future modes
  (`"on-collect"`, `"on-close"`) are out of scope for this spec; documenting the
  field keeps the surface forward-compatible without building unused behaviour.

## Herdr client additions (`src/herdr.js`)

Add three methods. **Verb strings are assumed** and MUST be confirmed against a
live Herdr; they are validated only structurally via dry-run tests here.

```js
stopAgent(name)                 // ["agent", "stop", name]
closeWorkspace(workspaceId)     // ["workspace", "close", workspaceId]
createWorktree({ name, cwd, branch, base }) // ["worktree", "create", name, ...]
```

`createWorktree` returns the raw run result; a `extractWorktreePath(result)`
helper (sibling to `extractWorkspaceId`) resolves the worktree directory from the
response, falling back to a deterministic dry-run stub path when `dryRun`.

## Task normalization + prompt (`src/planner.js`)

Add `normalizeTask(spec, { defaultAgent, index })`:

- Required: `task` (non-empty after trim) — throw a clear error otherwise.
- `agent` defaults to `defaultAgent`.
- `name` defaults to `worker-${index}`.
- Passthrough forward-compat fields: `profile`, `cwd`, `constraints`,
  `expectedArtifacts`, `statusPolicy`, `isolation`.

Extend `buildWorkerPrompt({ task, workerName, goal, preamble, constraints,
expectedArtifacts })`:

- When `constraints` is a non-empty array, append each under the existing
  "Rules:" block.
- When `expectedArtifacts` is a non-empty array, append an "Expected artifacts:"
  block listing them.
- Both optional; existing callers (which pass neither) produce byte-identical
  output.

## Orchestrator compatibility (`src/orchestrator.js`)

Rewrite `runDelegation({ herdr, tasks, options })` as a thin wrapper over the
facade so `cli.js` keeps working unchanged. It MUST preserve the current return
shape consumed by `cli.js` and printed as JSON:

```js
{
  workspace: { workspaceId, created, result? },
  launched: [{ workerName, agent, task, startResult }],
  waits:    [{ workerName, status: "done"|"not_done", waitResult|error }],
  commands: [[bin, ...args], ...],
}
```

Implementation: construct a runtime from the passed `herdr` and `options`
(cwd, workspaceId, workspaceLabel→ passed as label, defaultAgent, agentProfile,
namePrefix, goal, splitDirection, waitTimeoutMs, agentCommand), `delegateMany`
the tasks, run the wait loop when `options.wait`, fire `herdr.notify` when
`options.notify`, and assemble the legacy shape. Existing behaviour and the
`test/planner.test.js` suite must stay green.

## Deliverables

1. `src/runtime.js` — the facade.
2. `src/herdr.js` — `stopAgent`, `closeWorkspace`, `createWorktree`,
   `extractWorktreePath`.
3. `src/planner.js` — `normalizeTask`, extended `buildWorkerPrompt`.
4. `src/orchestrator.js` — `runDelegation` rewritten over the facade, same shape.
5. `examples/supervisor-adapter.mjs` — runnable mini-supervisor: kiro
   plan → build → review with `delegate`/`observe`/`collect` hand-off; `--dry-run`
   safe; prints the generated Herdr commands.
6. `test/runtime.test.js` — see Test plan.
7. `.claude/skills/herdr-drover-supervisor-onboarding/SKILL.md` — condensed from
   the proposal, facade described as the CURRENT API, kiro-first, with the
   cleanup + worktree + cross-repo guidance. Frontmatter `name` +
   `description` per skill conventions.
8. `README.md` + `docs/architecture.md` — supervisor integration section
   (facade, cleanup semantics, cross-repo via multiple runtimes, worktree
   isolation).

## Test plan (`test/runtime.test.js`, `node --test`)

Use a fake herdr object that records calls and returns canned values (no real
Herdr, no real agents). Assert:

- `normalizeTask` fills `agent`/`name` defaults and throws on missing `task`.
- `delegate` with kiro produces, in order: one `workspace create`, an
  `agent start` whose command is `kiro-cli chat --agent developer`, and an
  `agent send` carrying the prompt. First worker `--focus`.
- Second `delegate` reuses the same workspace (no second `workspace create`) and
  launches split, not focused; duplicate names get suffixed.
- `delegateMany` returns the legacy `{ workspace, launched, waits, commands }`
  shape; with `{ wait:true }` it calls `waitAgent` per worker.
- `delegate({ isolation:"worktree" })` calls `createWorktree` and starts the
  agent with the worktree path as cwd.
- `collect` calls `readAgent` and returns `{ output }` from the fake.
- `observe` calls `waitAgent` with the requested status.
- `release` calls `stopAgent`; `close({ closeWorkspace:true })` releases all then
  calls `closeWorkspace`.
- `buildWorkerPrompt` includes `constraints`/`expectedArtifacts` when supplied
  and is unchanged when omitted.

## Validation

- `npm test` green (existing + new).
- `node ./bin/drover.mjs run --dry-run --workers 2 "Validate supervisor integration"`
  still prints commands.
- `node examples/supervisor-adapter.mjs --dry-run` prints a plan→build→review
  command sequence.
- Do not assume `herdr`, `kiro-cli`, `codex`, or `claude` are installed. State
  that the teardown/worktree verb strings need confirmation against a live Herdr.

## Out of scope

- `cleanup` auto modes (`on-collect`, `on-close`).
- Built-in dependency/DAG sequencing.
- Per-call workspace override inside one runtime.
- Raw Herdr socket / daemon event subscription.
- A concrete CAO or BMAD supervisor implementation.

## Build order

1. Read/confirm `cli.js` contract (done).
2. `planner.js`: `normalizeTask` + prompt extension.
3. `herdr.js`: teardown + worktree methods.
4. `runtime.js`: facade.
5. `orchestrator.js`: `runDelegation` rewrite.
6. `examples/supervisor-adapter.mjs`.
7. `test/runtime.test.js`.
8. `.claude/skills/.../SKILL.md`.
9. README + architecture docs.
