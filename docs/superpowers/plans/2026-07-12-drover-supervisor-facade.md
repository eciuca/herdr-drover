# Drover Supervisor Facade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stable `createDroverRuntime()` facade over Drover's Herdr control surface, with opt-in worker cleanup and git-worktree isolation, a runnable supervisor adapter example, an installed onboarding skill, and docs.

**Architecture:** A new `src/runtime.js` becomes the public API. It owns one lazy Herdr workspace and a worker registry, and exposes `delegate / delegateMany / observe / collect / release / close / workers`. `src/orchestrator.js`'s `runDelegation` is rewritten as a thin wrapper over the facade, preserving its return shape so `src/cli.js` is untouched. `src/herdr.js` gains teardown + worktree verbs. `src/planner.js` gains `normalizeTask` and an extended `buildWorkerPrompt`. Drover stays thin: supervisors own sequencing via `delegate → observe → collect`.

**Tech Stack:** Node.js ≥20, ES modules, `node:test`, no runtime dependencies.

## Global Constraints

- Node `>=20`, `"type": "module"` — ES module `import`/`export` only.
- No new npm dependencies.
- Test runner is `node --test` (`npm test`); assertions via `node:assert/strict`.
- Existing suite `test/planner.test.js` must stay green — do NOT change `parseTaskList` or `splitInlineTask` behaviour.
- `src/cli.js` must remain unchanged; `runDelegation({ herdr, tasks, options })` must keep returning `{ workspace, launched, waits, commands }`.
- Herdr teardown/worktree verb strings (`agent stop`, `workspace close`, `worktree create`) are ASSUMED — validated only structurally via dry-run/fake tests. Do not claim they work against a live Herdr.
- Kiro is the primary profile: `kiro` → `kiro-cli chat --agent developer`. Example, skill, and tests must exercise kiro.
- Commit after every task.

## File Structure

- Create `src/runtime.js` — the facade (`createDroverRuntime`, private `safeWorkerName`).
- Modify `src/planner.js` — add `normalizeTask`, extend `buildWorkerPrompt`.
- Modify `src/herdr.js` — add `stopAgent`, `closeWorkspace`, `createWorktree`, `extractWorktreePath`.
- Modify `src/orchestrator.js` — rewrite `runDelegation` over the facade.
- Create `examples/supervisor-adapter.mjs` — runnable kiro plan→build→review hand-off demo.
- Create `test/runtime.test.js` — facade + normalization + prompt tests.
- Create `.claude/skills/herdr-drover-supervisor-onboarding/SKILL.md` — onboarding skill.
- Modify `README.md`, `docs/architecture.md` — supervisor integration section.

---

### Task 1: Task normalization + prompt extension (`src/planner.js`)

**Files:**
- Modify: `src/planner.js` (add `normalizeTask`; extend `buildWorkerPrompt`)
- Test: `test/runtime.test.js` (create; holds normalization + prompt tests)

**Interfaces:**
- Produces:
  - `normalizeTask(spec, { defaultAgent = "kiro", index = 1 })` → `{ name, agent, profile, cwd, task, constraints, expectedArtifacts, statusPolicy, isolation }`. Throws `Error` if `spec.task` is empty after trim.
  - `buildWorkerPrompt({ task, workerName, goal, preamble, constraints, expectedArtifacts })` → string. `constraints`/`expectedArtifacts` optional; output byte-identical to today when both omitted.

- [ ] **Step 1: Write the failing tests**

Create `test/runtime.test.js` with:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTask, buildWorkerPrompt } from "../src/planner.js";

test("normalizeTask fills agent and name defaults", () => {
  const spec = normalizeTask({ task: "do it" }, { defaultAgent: "kiro", index: 3 });
  assert.equal(spec.agent, "kiro");
  assert.equal(spec.name, "worker-3");
  assert.equal(spec.task, "do it");
});

test("normalizeTask keeps explicit fields and passthrough metadata", () => {
  const spec = normalizeTask(
    {
      name: "builder",
      agent: "codex",
      profile: "default",
      cwd: "/repo",
      task: "  build  ",
      constraints: ["scoped"],
      expectedArtifacts: ["diff"],
      statusPolicy: { waitFor: "done", timeoutMs: 10 },
      isolation: "worktree",
    },
    { defaultAgent: "kiro", index: 1 },
  );
  assert.equal(spec.name, "builder");
  assert.equal(spec.agent, "codex");
  assert.equal(spec.profile, "default");
  assert.equal(spec.cwd, "/repo");
  assert.equal(spec.task, "build");
  assert.deepEqual(spec.constraints, ["scoped"]);
  assert.deepEqual(spec.expectedArtifacts, ["diff"]);
  assert.deepEqual(spec.statusPolicy, { waitFor: "done", timeoutMs: 10 });
  assert.equal(spec.isolation, "worktree");
});

test("normalizeTask throws on missing task", () => {
  assert.throws(() => normalizeTask({ name: "x" }, {}), /task/);
});

test("buildWorkerPrompt is unchanged when no constraints or artifacts", () => {
  const prompt = buildWorkerPrompt({
    task: "assignment text",
    workerName: "w1",
    preamble: "PREAMBLE",
  });
  assert.ok(prompt.startsWith("PREAMBLE\n\nWorker: w1"));
  assert.ok(prompt.includes("Assignment:\nassignment text"));
  assert.ok(!prompt.includes("Expected artifacts:"));
  assert.equal(prompt.split("\n").filter((l) => l === "").length, 3);
});

test("buildWorkerPrompt appends constraints and expected artifacts", () => {
  const prompt = buildWorkerPrompt({
    task: "assignment",
    workerName: "w1",
    preamble: "P",
    constraints: ["no unrelated edits"],
    expectedArtifacts: ["changed files", "status summary"],
  });
  assert.ok(prompt.includes("- no unrelated edits"));
  assert.ok(prompt.includes("Expected artifacts:\n- changed files\n- status summary"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime.test.js`
Expected: FAIL — `normalizeTask` is not exported (`SyntaxError`/`TypeError: normalizeTask is not a function`).

- [ ] **Step 3: Add `normalizeTask` and extend `buildWorkerPrompt`**

In `src/planner.js`, add this new export (place it next to `buildWorkerPrompt`):

```js
export function normalizeTask(spec = {}, { defaultAgent = "kiro", index = 1 } = {}) {
  const task = String(spec.task || "").trim();
  if (!task) throw new Error('Task spec requires a non-empty "task".');
  return {
    name: spec.name || `worker-${index}`,
    agent: spec.agent || defaultAgent,
    profile: spec.profile,
    cwd: spec.cwd,
    task,
    constraints: spec.constraints,
    expectedArtifacts: spec.expectedArtifacts,
    statusPolicy: spec.statusPolicy,
    isolation: spec.isolation,
  };
}
```

Replace the existing `buildWorkerPrompt` with:

```js
export function buildWorkerPrompt({ task, workerName, goal, preamble, constraints, expectedArtifacts }) {
  const extraRules = Array.isArray(constraints)
    ? constraints.filter(Boolean).map((rule) => `- ${rule}`)
    : [];
  const artifacts =
    Array.isArray(expectedArtifacts) && expectedArtifacts.filter(Boolean).length
      ? ["", "Expected artifacts:", ...expectedArtifacts.filter(Boolean).map((item) => `- ${item}`)]
      : [];
  return [
    preamble,
    "",
    `Worker: ${workerName}`,
    goal ? `Overall goal: ${goal}` : null,
    "",
    "Assignment:",
    task,
    "",
    "Rules:",
    "- You are not alone in the codebase; do not revert unrelated edits.",
    "- Keep the work scoped to this assignment.",
    "- If blocked, state the exact blocker and what input is needed.",
    "- Finish with: changed files, checks run, status, and next recommended step.",
    ...extraRules,
    ...artifacts,
  ]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/runtime.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite (guard the existing prompt callers)**

Run: `npm test`
Expected: PASS — `test/planner.test.js` still green (unchanged behaviour).

- [ ] **Step 6: Commit**

```bash
git add src/planner.js test/runtime.test.js
git commit -m "feat: add normalizeTask and constraint-aware buildWorkerPrompt"
```

---

### Task 2: Herdr teardown + worktree verbs (`src/herdr.js`)

**Files:**
- Modify: `src/herdr.js` (add methods + `extractWorktreePath` export)
- Test: `test/runtime.test.js` (append)

**Interfaces:**
- Produces (on `HerdrCli`):
  - `stopAgent(target)` → runs `["agent", "stop", target]`
  - `closeWorkspace(workspaceId)` → runs `["workspace", "close", workspaceId]`
  - `createWorktree({ name, cwd, branch, base })` → runs `["worktree", "create", name, ...flags]`
- Produces (module export):
  - `extractWorktreePath(response, { dryRun, name })` → string path or `undefined`

- [ ] **Step 1: Write the failing tests**

Append to `test/runtime.test.js`:

```js
import { HerdrCli, extractWorktreePath } from "../src/herdr.js";

test("HerdrCli teardown + worktree verbs generate expected commands (dry-run)", async () => {
  const herdr = new HerdrCli({ dryRun: true });
  await herdr.stopAgent("builder");
  await herdr.closeWorkspace("ws-1");
  await herdr.createWorktree({ name: "builder", cwd: "/repo", branch: "drover/builder" });
  assert.deepEqual(herdr.commands, [
    ["herdr", "agent", "stop", "builder"],
    ["herdr", "workspace", "close", "ws-1"],
    ["herdr", "worktree", "create", "builder", "--cwd", "/repo", "--branch", "drover/builder"],
  ]);
});

test("extractWorktreePath reads nested path or falls back to dry-run stub", () => {
  assert.equal(extractWorktreePath({ worktree: { path: "/wt/a" } }), "/wt/a");
  assert.equal(extractWorktreePath({ path: "/wt/b" }), "/wt/b");
  assert.equal(extractWorktreePath({}, { dryRun: true, name: "c" }), "dry-run-worktree/c");
  assert.equal(extractWorktreePath({}, {}), undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime.test.js`
Expected: FAIL — `herdr.stopAgent is not a function` / `extractWorktreePath is not exported`.

- [ ] **Step 3: Add the methods to `HerdrCli`**

In `src/herdr.js`, inside the `HerdrCli` class, add after the `notify` method:

```js
  stopAgent(target) {
    return this.run(["agent", "stop", target]);
  }

  closeWorkspace(workspaceId) {
    return this.run(["workspace", "close", workspaceId]);
  }

  createWorktree({ name, cwd, branch, base } = {}) {
    const args = ["worktree", "create", name];
    if (cwd) args.push("--cwd", cwd);
    if (branch) args.push("--branch", branch);
    if (base) args.push("--base", base);
    return this.run(args);
  }
```

At module scope (next to `extractWorkspaceId`), add:

```js
export function extractWorktreePath(response, { dryRun = false, name } = {}) {
  return (
    response?.worktree?.path ||
    response?.result?.worktree?.path ||
    response?.path ||
    response?.worktree_path ||
    (dryRun ? `dry-run-worktree/${name}` : undefined)
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/runtime.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/herdr.js test/runtime.test.js
git commit -m "feat: add Herdr agent-stop, workspace-close, and worktree verbs"
```

---

### Task 3: The facade (`src/runtime.js`)

**Files:**
- Create: `src/runtime.js`
- Test: `test/runtime.test.js` (append — uses a fake herdr)

**Interfaces:**
- Consumes: `HerdrCli`, `extractWorkspaceId`, `extractWorktreePath` from `./herdr.js`; `commandForAgent`, `getAgentProfile` from `./agents.js`; `buildWorkerPrompt`, `normalizeTask` from `./planner.js`.
- Produces: `createDroverRuntime(config)` → object with:
  - `delegate(spec)` → `{ id, workerName, agent, task, isolation, startResult }`
  - `delegateMany(specs, { wait })` → `{ workspace, launched, waits, commands }`
  - `observe(id, { status, timeoutMs })` → herdr `waitAgent` result
  - `collect(id, { source, lines })` → `{ id, workerName, agent, output }`
  - `release(id)` → `{ id, workerName, result }`
  - `close({ closeWorkspace })` → `{ closed, workspaceResult }`
  - `workers()` → array of `{ id, workerName, agent, task, isolation, stopped }`
  - `herdr`, getter `commands`, getter `workspace`

- [ ] **Step 1: Write the failing tests**

Append to `test/runtime.test.js`. First, a reusable fake herdr, then the facade tests:

```js
import { createDroverRuntime } from "../src/runtime.js";

function makeFakeHerdr(responses = {}) {
  return {
    dryRun: false,
    commands: [],
    calls: [],
    _push(method, args, ret) {
      this.calls.push({ method, args });
      return ret;
    },
    async createWorkspace(opts) {
      this.commands.push(["workspace", "create"]);
      return this._push("createWorkspace", [opts], responses.createWorkspace ?? { workspace: { id: "ws-1" } });
    },
    async startAgent(opts) {
      this.commands.push(["agent", "start", opts.name]);
      return this._push("startAgent", [opts], { started: opts.name });
    },
    async sendAgent(target, text) {
      this.commands.push(["agent", "send", target]);
      return this._push("sendAgent", [target, text], {});
    },
    async waitAgent(target, opts) {
      return this._push("waitAgent", [target, opts], responses.waitAgent ?? { status: "done" });
    },
    async readAgent(target, opts) {
      return this._push("readAgent", [target, opts], responses.readAgent ?? { stdout: "worker output" });
    },
    async stopAgent(target) {
      return this._push("stopAgent", [target], {});
    },
    async closeWorkspace(id) {
      return this._push("closeWorkspace", [id], {});
    },
    async createWorktree(opts) {
      return this._push("createWorktree", [opts], responses.createWorktree ?? { worktree: { path: `/wt/${opts.name}` } });
    },
    async notify(...args) {
      return this._push("notify", args, {});
    },
  };
}

const only = (herdr, method) => herdr.calls.filter((c) => c.method === method);

test("delegate launches one kiro worker: workspace once, start focused, send prompt", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "sup" });
  const handle = await drover.delegate({ name: "planner", agent: "kiro", task: "make a plan" });

  assert.equal(handle.id, "sup-planner");
  assert.equal(handle.agent, "kiro");
  assert.equal(only(herdr, "createWorkspace").length, 1);

  const start = only(herdr, "startAgent")[0].args[0];
  assert.deepEqual(start.command, ["kiro-cli", "chat", "--agent", "developer"]);
  assert.equal(start.focus, true);
  assert.equal(start.cwd, "/repo");
  assert.equal(start.workspaceId, "ws-1");

  const send = only(herdr, "sendAgent")[0];
  assert.equal(send.args[0], "sup-planner");
  assert.ok(send.args[1].includes("Assignment:\nmake a plan"));
});

test("second delegate reuses workspace, splits, and de-duplicates names", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "sup" });
  await drover.delegate({ name: "dev", agent: "kiro", task: "a" });
  const second = await drover.delegate({ name: "dev", agent: "kiro", task: "b" });

  assert.equal(only(herdr, "createWorkspace").length, 1);
  assert.equal(second.id, "sup-dev-2");
  const starts = only(herdr, "startAgent");
  assert.equal(starts[0].args[0].focus, true);
  assert.equal(starts[1].args[0].focus, false);
  assert.equal(starts[1].args[0].split, "right");
});

test("delegate with worktree isolation creates worktree and starts there", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "sup" });
  await drover.delegate({ name: "builder", agent: "kiro", task: "build", isolation: "worktree" });

  const wt = only(herdr, "createWorktree")[0].args[0];
  assert.equal(wt.name, "sup-builder");
  const start = only(herdr, "startAgent")[0].args[0];
  assert.equal(start.cwd, "/wt/sup-builder");
});

test("delegateMany returns legacy shape and waits when asked", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "run" });
  const result = await drover.delegateMany(
    [
      { name: "planner", agent: "kiro", task: "plan" },
      { name: "reviewer", agent: "codex", task: "review" },
    ],
    { wait: true },
  );

  assert.equal(result.workspace.workspaceId, "ws-1");
  assert.equal(result.launched.length, 2);
  assert.deepEqual(
    result.launched.map((l) => l.workerName),
    ["run-planner", "run-reviewer"],
  );
  assert.equal(only(herdr, "waitAgent").length, 2);
  assert.ok(result.waits.every((w) => w.status === "done"));
  assert.equal(result.commands, herdr.commands);
});

test("observe, collect, release, and close drive the right herdr methods", async () => {
  const herdr = makeFakeHerdr({ readAgent: { stdout: "final report" } });
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "sup" });
  const a = await drover.delegate({ name: "a", agent: "kiro", task: "x" });

  await drover.observe(a.id, { status: "blocked" });
  assert.equal(only(herdr, "waitAgent")[0].args[1].status, "blocked");

  const collected = await drover.collect(a.id);
  assert.equal(collected.output, "final report");
  assert.equal(collected.agent, "kiro");

  await drover.release(a.id);
  assert.deepEqual(only(herdr, "stopAgent")[0].args, ["sup-a"]);

  await drover.close({ closeWorkspace: true });
  assert.equal(only(herdr, "closeWorkspace")[0].args[0], "ws-1");
});

test("observe and collect throw on unknown worker id", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr });
  await assert.rejects(() => drover.observe("nope"), /Unknown worker/);
  await assert.rejects(() => drover.collect("nope"), /Unknown worker/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime.test.js`
Expected: FAIL — `Cannot find module '../src/runtime.js'`.

- [ ] **Step 3: Write `src/runtime.js`**

```js
import { HerdrCli, extractWorkspaceId, extractWorktreePath } from "./herdr.js";
import { commandForAgent, getAgentProfile } from "./agents.js";
import { buildWorkerPrompt, normalizeTask } from "./planner.js";

export function createDroverRuntime(config = {}) {
  const {
    herdr = new HerdrCli({ session: config.session, dryRun: config.dryRun }),
    cwd,
    namePrefix = "drover",
    goal,
    splitDirection = "right",
    cleanup = "keep",
    waitTimeoutMs = 1_800_000,
    defaultAgent = "kiro",
    agentProfile,
    agentCommand,
    workspaceId,
    workspaceLabel,
  } = config;

  const registry = new Map();
  let workspace = workspaceId ? { workspaceId, created: false } : null;
  let workspacePromise = null;

  async function ensureWorkspace() {
    if (workspace) return workspace;
    if (!workspacePromise) {
      const label = workspaceLabel || `${namePrefix}-ws`;
      workspacePromise = herdr
        .createWorkspace({ cwd, label, focus: false, env: { DROVER_WORKSPACE: label } })
        .then((result) => {
          workspace = {
            workspaceId: extractWorkspaceId(result) || (herdr.dryRun ? `dry-run-${label}` : undefined),
            created: true,
            result,
          };
          return workspace;
        });
    }
    return workspacePromise;
  }

  function uniqueName(base) {
    let name = base;
    let counter = 2;
    while (registry.has(name)) name = `${base}-${counter++}`;
    return name;
  }

  async function delegate(spec) {
    const normalized = normalizeTask(spec, { defaultAgent, index: registry.size + 1 });
    const profile = getAgentProfile(normalized.agent);
    const ws = await ensureWorkspace();
    const isFirst = registry.size === 0;
    const workerName = uniqueName(safeWorkerName(`${namePrefix}-${normalized.name}`));

    let workerCwd = normalized.cwd ?? cwd;
    let worktree;
    if (normalized.isolation === "worktree") {
      const wtResult = await herdr.createWorktree({
        name: workerName,
        cwd: workerCwd,
        branch: `drover/${workerName}`,
      });
      worktree = extractWorktreePath(wtResult, { dryRun: herdr.dryRun, name: workerName });
      workerCwd = worktree || workerCwd;
    }

    const profileName = normalized.profile || agentProfile || profile.defaultProfile;
    const command = commandForAgent(profile, agentCommand, profileName);
    const env = {
      HERDR_AGENT: profile.herdrAgentHint,
      DROVER_WORKER_NAME: workerName,
      DROVER_AGENT: profile.id,
    };
    if (profileName) env.DROVER_AGENT_PROFILE = profileName;

    const startResult = await herdr.startAgent({
      name: workerName,
      command,
      cwd: workerCwd,
      workspaceId: ws.workspaceId,
      split: isFirst ? undefined : splitDirection,
      env,
      focus: isFirst,
    });

    const prompt = buildWorkerPrompt({
      task: normalized.task,
      workerName,
      goal,
      preamble: profile.promptPreamble,
      constraints: normalized.constraints,
      expectedArtifacts: normalized.expectedArtifacts,
    });
    await herdr.sendAgent(workerName, prompt);

    registry.set(workerName, {
      id: workerName,
      workerName,
      agent: profile.id,
      profile: profileName,
      task: normalized.task,
      isolation: normalized.isolation,
      worktree,
      statusPolicy: normalized.statusPolicy,
      startResult,
      stopped: false,
    });

    return {
      id: workerName,
      workerName,
      agent: profile.id,
      task: normalized.task,
      isolation: normalized.isolation,
      startResult,
    };
  }

  async function delegateMany(specs, { wait = false } = {}) {
    const launched = [];
    for (const spec of specs) {
      const handle = await delegate(spec);
      launched.push({
        workerName: handle.workerName,
        agent: handle.agent,
        task: handle.task,
        startResult: handle.startResult,
      });
    }

    const waits = [];
    if (wait) {
      for (const item of launched) {
        const record = registry.get(item.workerName);
        const status = record?.statusPolicy?.waitFor || "done";
        const timeoutMs = record?.statusPolicy?.timeoutMs || waitTimeoutMs;
        try {
          const waitResult = await herdr.waitAgent(item.workerName, { status, timeoutMs });
          waits.push({ workerName: item.workerName, status: "done", waitResult });
        } catch (error) {
          waits.push({ workerName: item.workerName, status: "not_done", error: error.message });
        }
      }
    }

    return { workspace, launched, waits, commands: herdr.commands };
  }

  function requireRecord(id) {
    const record = registry.get(id);
    if (!record) throw new Error(`Unknown worker "${id}".`);
    return record;
  }

  async function observe(id, { status = "done", timeoutMs = waitTimeoutMs } = {}) {
    const record = requireRecord(id);
    return herdr.waitAgent(record.workerName, { status, timeoutMs });
  }

  async function collect(id, { source, lines } = {}) {
    const record = requireRecord(id);
    const result = await herdr.readAgent(record.workerName, { source, lines });
    const output = result && typeof result.stdout === "string" ? result.stdout : result;
    return { id, workerName: record.workerName, agent: record.agent, output };
  }

  async function release(id) {
    const record = requireRecord(id);
    if (record.stopped) return { id, workerName: record.workerName, stopped: true };
    const result = await herdr.stopAgent(record.workerName);
    record.stopped = true;
    return { id, workerName: record.workerName, result };
  }

  async function close({ closeWorkspace: shouldClose = false } = {}) {
    for (const record of registry.values()) {
      if (!record.stopped) {
        await herdr.stopAgent(record.workerName);
        record.stopped = true;
      }
    }
    let workspaceResult;
    if (shouldClose && workspace?.created && workspace.workspaceId) {
      workspaceResult = await herdr.closeWorkspace(workspace.workspaceId);
    }
    return { closed: shouldClose, workspaceResult };
  }

  function workers() {
    return [...registry.values()].map((record) => ({
      id: record.id,
      workerName: record.workerName,
      agent: record.agent,
      task: record.task,
      isolation: record.isolation,
      stopped: record.stopped,
    }));
  }

  return {
    delegate,
    delegateMany,
    observe,
    collect,
    release,
    close,
    workers,
    herdr,
    cleanup,
    get commands() {
      return herdr.commands;
    },
    get workspace() {
      return workspace;
    },
  };
}

function safeWorkerName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/runtime.test.js`
Expected: PASS (all facade tests plus Task 1/2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime.js test/runtime.test.js
git commit -m "feat: add createDroverRuntime facade with delegate/observe/collect/teardown"
```

---

### Task 4: Rewrite `runDelegation` over the facade (`src/orchestrator.js`)

**Files:**
- Modify: `src/orchestrator.js` (replace entire file contents)
- Test: `test/runtime.test.js` (append a compatibility test)

**Interfaces:**
- Consumes: `createDroverRuntime` from `./runtime.js`.
- Produces: `runDelegation({ herdr, tasks, options })` → `{ workspace, launched, waits, commands }` — SAME shape `src/cli.js` prints today.

- [ ] **Step 1: Write the failing test**

Append to `test/runtime.test.js`:

```js
import { runDelegation } from "../src/orchestrator.js";

test("runDelegation preserves legacy shape and notifies", async () => {
  const herdr = makeFakeHerdr();
  const result = await runDelegation({
    herdr,
    tasks: [
      { name: "planner", agent: "kiro", profile: "developer", task: "plan it" },
      { name: "builder", agent: "kiro", task: "build it" },
    ],
    options: {
      cwd: "/repo",
      namePrefix: "drover",
      defaultAgent: "kiro",
      goal: "ship",
      wait: true,
      notify: true,
      splitDirection: "right",
    },
  });

  assert.deepEqual(Object.keys(result).sort(), ["commands", "launched", "waits", "workspace"]);
  assert.equal(result.launched.length, 2);
  assert.equal(result.workspace.workspaceId, "ws-1");
  assert.equal(only(herdr, "notify").length, 1);
});

test("runDelegation throws on empty task list", async () => {
  await assert.rejects(() => runDelegation({ herdr: makeFakeHerdr(), tasks: [], options: {} }), /No tasks/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/runtime.test.js`
Expected: FAIL — current `runDelegation` does not call `notify` on a fake lacking prior wiring? It does call `herdr.notify`, but the current implementation builds workers itself and its worker names / behaviour differ. The new compatibility test asserting `Object.keys` order and notify count should pass structurally, but run it to confirm current behaviour, then proceed to the rewrite. If it already passes, still do Step 3 (the rewrite is the deliverable) and re-run.

- [ ] **Step 3: Replace `src/orchestrator.js` entirely**

```js
import { createDroverRuntime } from "./runtime.js";

export async function runDelegation({ herdr, tasks, options = {} }) {
  if (!tasks.length) throw new Error("No tasks to delegate.");

  const namePrefix = options.namePrefix || "drover";
  const workspaceLabel = options.workspaceLabel || `${namePrefix}-${Date.now()}`;

  const runtime = createDroverRuntime({
    herdr,
    cwd: options.cwd,
    workspaceId: options.workspaceId,
    workspaceLabel,
    namePrefix,
    goal: options.goal,
    splitDirection: options.splitDirection || "right",
    waitTimeoutMs: options.waitTimeoutMs,
    defaultAgent: options.defaultAgent,
    agentProfile: options.agentProfile,
    agentCommand: options.agentCommand,
  });

  const result = await runtime.delegateMany(tasks, { wait: Boolean(options.wait) });

  if (options.notify) {
    await herdr.notify("Drover delegation started", `${result.launched.length} worker(s) in ${workspaceLabel}`);
  }

  return {
    workspace: result.workspace,
    launched: result.launched,
    waits: result.waits,
    commands: result.commands,
  };
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — all of `test/runtime.test.js` and `test/planner.test.js`.

- [ ] **Step 5: Verify the CLI dry-run still works end-to-end**

Run: `node ./bin/drover.mjs run --dry-run --workers 2 "Validate supervisor integration"`
Expected: JSON printed with `workspace`, `launched` (2 workers: `drover-planner`, `drover-builder`), and a `commands` array containing `workspace create`, two `agent start`, two `agent send`, and a `notification show`.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.js test/runtime.test.js
git commit -m "refactor: rewrite runDelegation over the createDroverRuntime facade"
```

---

### Task 5: Supervisor adapter example (`examples/supervisor-adapter.mjs`)

**Files:**
- Create: `examples/supervisor-adapter.mjs`

**Interfaces:**
- Consumes: `createDroverRuntime` from `../src/runtime.js`.

- [ ] **Step 1: Write the example**

```js
#!/usr/bin/env node
// Minimal supervisor: plan -> build -> review with kiro, using supervisor-driven
// hand-off (delegate -> observe -> collect -> delegate next). Drover stays thin.
//
// Safe to run without Herdr/kiro installed via --dry-run:
//   node examples/supervisor-adapter.mjs --dry-run

import { createDroverRuntime } from "../src/runtime.js";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const drover = createDroverRuntime({
    dryRun,
    cwd: process.cwd(),
    namePrefix: "sup",
    goal: "Add a small validated feature",
    defaultAgent: "kiro",
  });

  const planner = await drover.delegate({
    name: "planner",
    agent: "kiro",
    profile: "developer",
    task: "Inspect the repo and produce a short scoped plan.",
    expectedArtifacts: ["plan summary", "files likely to change"],
  });
  await drover.observe(planner.id, { status: "done" });
  const plan = await drover.collect(planner.id);

  const builder = await drover.delegate({
    name: "builder",
    agent: "kiro",
    profile: "developer",
    isolation: "worktree",
    task: `Implement this plan, keep edits scoped, run focused checks.\n\nPlan:\n${plan.output}`,
    constraints: ["do not revert unrelated edits"],
  });
  await drover.observe(builder.id, { status: "done" });
  const build = await drover.collect(builder.id);

  const reviewer = await drover.delegate({
    name: "reviewer",
    agent: "kiro",
    profile: "reviewer",
    task: `Review the implementation for risks and missing tests.\n\nBuild report:\n${build.output}`,
  });
  await drover.observe(reviewer.id, { status: "done" });
  const review = await drover.collect(reviewer.id);

  console.log(JSON.stringify(
    {
      dryRun,
      workers: drover.workers(),
      review: review.output,
      commands: drover.commands,
    },
    null,
    2,
  ));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 2: Run the example in dry-run**

Run: `node examples/supervisor-adapter.mjs --dry-run`
Expected: JSON printed. `commands` contains one `workspace create`, a `worktree create` for the builder, three `agent start` + three `agent send`. No throw. (In dry-run, `collect` returns the recorded dry-run command object as `output`, which is fine — the point is that the command sequence is generated.)

- [ ] **Step 3: Commit**

```bash
git add examples/supervisor-adapter.mjs
git commit -m "docs: add kiro plan-build-review supervisor adapter example"
```

---

### Task 6: Install the onboarding skill (`.claude/skills/...`)

**Files:**
- Create: `.claude/skills/herdr-drover-supervisor-onboarding/SKILL.md`

**Interfaces:** none (documentation skill).

- [ ] **Step 1: Write the skill file**

```markdown
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

Note: `agent stop`, `workspace close`, and `worktree create` Herdr verbs are
assumed by Drover; confirm them against your Herdr version before relying on live
teardown.

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
```

- [ ] **Step 2: Verify the frontmatter parses**

Run: `node -e "const fs=require('fs');const t=fs.readFileSync('.claude/skills/herdr-drover-supervisor-onboarding/SKILL.md','utf8');const m=t.match(/^---\n([\s\S]*?)\n---/);if(!m)throw new Error('no frontmatter');if(!/name:\s*herdr-drover-supervisor-onboarding/.test(m[1]))throw new Error('bad name');if(!/description:/.test(m[1]))throw new Error('no description');console.log('frontmatter ok')"`
Expected: `frontmatter ok`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/herdr-drover-supervisor-onboarding/SKILL.md
git commit -m "docs: install herdr-drover-supervisor-onboarding skill"
```

---

### Task 7: Update README + architecture docs

**Files:**
- Modify: `README.md` (add a "Supervisor Integration" section before "## Design")
- Modify: `docs/architecture.md` (add a "Facade" section; update "Next Steps")

**Interfaces:** none.

- [ ] **Step 1: Add the README section**

Insert this block into `README.md` immediately before the `## Design` heading:

```markdown
## Supervisor Integration

External supervisors bind to the stable facade in `src/runtime.js`, not to
internal modules.

\`\`\`js
import { createDroverRuntime } from "./src/runtime.js";

const drover = createDroverRuntime({ session: "work", cwd: "/repo", namePrefix: "sup" });

const planner = await drover.delegate({ name: "planner", agent: "kiro", profile: "developer", task: "Write a plan" });
await drover.observe(planner.id, { status: "done" });
const plan = await drover.collect(planner.id);

const builder = await drover.delegate({ name: "builder", agent: "kiro", isolation: "worktree", task: \`Implement:\n\${plan.output}\` });
await drover.observe(builder.id, { status: "done" });

await drover.close({ closeWorkspace: true }); // cleanup is opt-in; default keeps workers
\`\`\`

- Hand-off is supervisor-driven: `delegate → observe → collect → delegate`.
- Cleanup defaults to keep. Use `release(id)` / `close({ closeWorkspace })` to tear down.
- Cross-repo work: one runtime per repo, sharing a session.
- Same-repo parallel workers: pass `isolation: "worktree"` to avoid stomping.

See `examples/supervisor-adapter.mjs` for a kiro plan→build→review run.
```

- [ ] **Step 2: Update `docs/architecture.md`**

Add this section after the "## Delegation Model" section:

```markdown
## Facade

`src/runtime.js` exposes `createDroverRuntime()` as the stable public API.
`runDelegation` (used by the CLI) is a thin wrapper over it. Supervisors call
`delegate`, `delegateMany`, `observe`, `collect`, `release`, and `close`. The
runtime owns one lazy workspace and a worker registry keyed by worker name.

Cleanup defaults to `keep`; teardown is explicit. Same-repo parallelism uses
`isolation: "worktree"` (Herdr `worktree create`); cross-repo work uses one
runtime per workspace.
```

Then in the "## Next Steps" list, remove the line
`- Add worktree creation using \`herdr worktree create\` for isolated workers.`
(now implemented) and add:
`- Confirm Herdr teardown/worktree verb strings against a live Herdr build.`

- [ ] **Step 3: Verify docs render (no broken code fences)**

Run: `node -e "const fs=require('fs');for(const f of ['README.md','docs/architecture.md']){const c=fs.readFileSync(f,'utf8');const fences=(c.match(/\`\`\`/g)||[]).length;if(fences%2)throw new Error(f+': unbalanced code fences');}console.log('docs ok')"`
Expected: `docs ok`

- [ ] **Step 4: Final full validation**

Run: `npm test && node ./bin/drover.mjs run --dry-run --workers 2 "final check" >/dev/null && echo OK`
Expected: tests pass, then `OK`.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture.md
git commit -m "docs: document supervisor facade, cleanup, and worktree isolation"
```

---

## Notes for the implementer

- The teardown/worktree Herdr verbs are best-effort guesses. Tests assert only
  the generated command arrays. When a live Herdr is available, confirm
  `agent stop`, `workspace close`, and `worktree create` (and their flags), then
  adjust `src/herdr.js` and the corresponding assertions in `test/runtime.test.js`.
- Do not modify `src/cli.js` — Task 4 keeps `runDelegation`'s contract stable so
  the CLI keeps working unchanged.
