# Visible + Resumable Headless Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `session` execution mode to Drover — a persistent, visible, multi-turn headless worker whose output streams to its herdr pane, can be taken over by a human, and accepts follow-up prompts that resume the same agent conversation.

**Architecture:** A new `execMode: "session"` runs each worker as a shell **turn-loop** in one persistent herdr pane. The loop waits for a prompt file, runs the agent (turn 1 fresh; later turns resume the most recent conversation in the worker's cwd), tees output to the pane **and** an output file, then prints a per-turn completion marker. The facade drives turns by writing prompt files and matching per-turn markers via `wait output`. Reliable interactive TUI driving was spike-proven infeasible and is out of scope.

**Tech Stack:** Node.js ≥20, ES modules, `node:test`, no runtime dependencies. Bash worker wrapper. herdr 0.7.2 CLI.

## Global Constraints

- Node `>=20`, `"type": "module"` — ES module `import`/`export` only.
- No new npm dependencies. Test runner is `node --test` (`npm test`); assertions via `node:assert/strict`.
- Do NOT break existing `interactive` mode, the existing one-shot `headless` mode, or any current test. The full suite is green at 37 tests before this plan.
- Primary agents are `claude` and `kiro`; both have live-verified headless resume. `codex` stays best-effort/UNVERIFIED (not installed) per issue #2.
- Resume mechanism (verified live 2026-07-13): claude follow-up = `claude -p -c --dangerously-skip-permissions`; kiro follow-up = `kiro-cli chat --no-interactive --trust-all-tools --resume --agent <profile>`. Both read the prompt on stdin and continue the most recent conversation in the worker's cwd.
- Reuse the existing `config.headlessDir` override so tests write control/prompt/output files into a throwaway dir (see the `HEADLESS_TMP` pattern already in `test/runtime.test.js`).
- Commit after every task.

## File Structure

- Modify `src/agents.js` — add `headlessResumeCommand()` to the claude/kiro/codex profiles and a module-level `headlessResumeCommandForAgent()`.
- Modify `src/runtime.js` — add `execMode: "session"`: a `prepareSession()` builder, a `delegate` branch, session-aware `observe`/`collect`, a new `followUp()` method, and expose `paneId` on the delegate handle and in `workers()`.
- Modify `test/runtime.test.js` — append tests (do not touch existing tests).
- Modify `README.md` and `docs/architecture.md` — document session mode + human takeover.

---

### Task 1: Agent resume commands (`src/agents.js`)

**Files:**
- Modify: `src/agents.js` (add `headlessResumeCommand` to three profiles; add `headlessResumeCommandForAgent`)
- Test: `test/runtime.test.js` (append)

**Interfaces:**
- Produces:
  - claude `headlessResumeCommand()` → `["claude","-p","-c","--dangerously-skip-permissions"]`
  - kiro `headlessResumeCommand(profileName="developer")` → `["kiro-cli","chat","--no-interactive","--trust-all-tools","--resume","--agent",profileName]`
  - codex `headlessResumeCommand()` → `["codex","exec","--dangerously-bypass-approvals-and-sandbox","resume","-"]` (UNVERIFIED)
  - `headlessResumeCommandForAgent(profile, overrideCommand, profileName)` → argv, throws if the profile has none.

- [ ] **Step 1: Write the failing tests**

Append to `test/runtime.test.js` (near the other agent imports — `getAgentProfile`/`headlessCommandForAgent` are already exported from `../src/agents.js`; add `headlessResumeCommandForAgent` to that import or add a new import line):

```js
import { getAgentProfile, headlessResumeCommandForAgent } from "../src/agents.js";

test("headlessResumeCommandForAgent returns continue/resume argv per agent", () => {
  assert.deepEqual(headlessResumeCommandForAgent(getAgentProfile("claude")), [
    "claude", "-p", "-c", "--dangerously-skip-permissions",
  ]);
  assert.deepEqual(headlessResumeCommandForAgent(getAgentProfile("kiro"), undefined, "developer"), [
    "kiro-cli", "chat", "--no-interactive", "--trust-all-tools", "--resume", "--agent", "developer",
  ]);
  assert.deepEqual(headlessResumeCommandForAgent(getAgentProfile("codex")), [
    "codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "resume", "-",
  ]);
});

test("headlessResumeCommandForAgent honors an override command", () => {
  assert.deepEqual(headlessResumeCommandForAgent(getAgentProfile("claude"), ["x", "--y"]), ["x", "--y"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime.test.js`
Expected: FAIL — `headlessResumeCommandForAgent` is not exported.

- [ ] **Step 3: Implement**

In `src/agents.js`, add a `headlessResumeCommand` method to each profile object.

In the `kiro` profile:
```js
    // Headless resume: continue the most recent conversation in the worker's cwd
    // (verified live). Prompt still arrives on stdin via the Drover wrapper.
    headlessResumeCommand(profileName = "developer") {
      return ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools", "--resume", "--agent", profileName];
    },
```

In the `codex` profile (UNVERIFIED, alongside its existing `headlessCommand`):
```js
    // UNVERIFIED (issue #2): codex not installed; resume argv is best-effort.
    headlessResumeCommand() {
      return ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "resume", "-"];
    },
```

In the `claude` profile:
```js
    // Headless resume: `-c` continues the most recent conversation in the cwd
    // (verified live). Prompt arrives on stdin.
    headlessResumeCommand() {
      return ["claude", "-p", "-c", "--dangerously-skip-permissions"];
    },
```

At module scope, next to `headlessCommandForAgent`, add:
```js
export function headlessResumeCommandForAgent(profile, overrideCommand, profileName) {
  if (overrideCommand?.length) return overrideCommand;
  if (profile.headlessResumeCommand) return profile.headlessResumeCommand(profileName || profile.defaultProfile);
  throw new Error(`Agent "${profile.id}" has no headless resume command.`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/runtime.test.js`
Expected: PASS (both new tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — nothing else changed.

- [ ] **Step 6: Commit**

```bash
git add src/agents.js test/runtime.test.js
git commit -m "feat: add headless resume commands for claude/kiro/codex"
```

---

### Task 2: Session wrapper + delegate branch (`src/runtime.js`)

**Files:**
- Modify: `src/runtime.js`
- Test: `test/runtime.test.js` (append)

**Interfaces:**
- Consumes: `headlessResumeCommandForAgent` from `./agents.js`; existing `headlessCommandForAgent`, `buildWorkerPrompt`, `extractAgentPaneId`.
- Produces:
  - `execMode: "session"` (config) or per-spec `mode: "session"`.
  - Private `prepareSession({ workerName, profile, profileName, prompt })` → `{ command, ctrlDir, outFile, markerBase, promptFileFor(n) }`.
  - `delegate(spec)` in session mode: builds the turn-loop wrapper, writes turn-1 prompt, starts the agent, records `{ mode:"session", paneId, ctrlDir, outFile, markerBase, turn:1 }`, sends NO prompt.
  - `delegate` handle now includes `paneId`.

- [ ] **Step 1: Write the failing tests**

Append to `test/runtime.test.js` (uses `makeFakeHerdr`, `only`, and `HEADLESS_TMP` already defined):

```js
test("session mode builds a persistent turn-loop wrapper, writes turn 1, sends no prompt", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  const w = await drover.delegate({ name: "worker", agent: "claude", task: "do the thing" });

  assert.equal(only(herdr, "sendAgent").length, 0);
  assert.equal(w.paneId, "ws-1:p2");

  const script = only(herdr, "startAgent")[0].args[0].command[2];
  // turn loop, tee to pane + file, per-turn marker, resume branch
  assert.match(script, /while true/);
  assert.match(script, /tee -a/);
  assert.match(script, /__DROVER_DONE_s-worker__ turn=/);
  for (const tok of ["claude", "-p", "--dangerously-skip-permissions"]) assert.ok(script.includes(tok));
  assert.ok(script.includes("-c"), "resume branch uses claude -p -c");
});
```

Also append a unit test for the turn-1 prompt file (read it back). Add this test right after the one above:

```js
import { readFile as _readFile } from "node:fs/promises";
import { join as _join } from "node:path";

test("session delegate writes the turn-1 prompt into the control dir", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  await drover.delegate({ name: "w2", agent: "kiro", task: "assignment body here" });
  // control dir is <headlessDir>/<workerName>; turn-1 prompt is prompt.1
  const text = await _readFile(_join(HEADLESS_TMP, "s-w2", "prompt.1"), "utf8");
  assert.ok(text.includes("Assignment:\nassignment body here"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime.test.js`
Expected: FAIL — session mode not implemented (`w.paneId` undefined / wrapper not a loop / prompt file missing).

- [ ] **Step 3: Implement `prepareSession` and the session delegate branch**

In `src/runtime.js`, update the agents import to include `headlessResumeCommandForAgent`:
```js
import { commandForAgent, headlessCommandForAgent, headlessResumeCommandForAgent, getAgentProfile } from "./agents.js";
```

Add `mkdir` to the fs import:
```js
import { writeFile, readFile, mkdtemp, mkdir } from "node:fs/promises";
```

Add a helper next to `prepareHeadless` (inside `createDroverRuntime`):
```js
  // Build a persistent, visible turn-loop worker command. The pane waits for
  // prompt.<n> files, runs the agent (turn 1 fresh; later turns resume the most
  // recent conversation in the cwd), tees output to the pane AND an output file,
  // then prints a per-turn completion marker. Prompt on stdin — no TUI driving.
  async function prepareSession({ workerName, profile, profileName, prompt }) {
    const turn1 = headlessCommandForAgent(profile, agentCommand, profileName);
    const resume = headlessResumeCommandForAgent(profile, agentResumeCommand, profileName);
    if (!headlessDir) headlessDir = await mkdtemp(join(tmpdir(), "drover-"));
    const ctrlDir = join(headlessDir, workerName);
    await mkdir(ctrlDir, { recursive: true });
    const outFile = join(ctrlDir, "out");
    const markerBase = `__DROVER_DONE_${workerName}__`;
    await writeFile(join(ctrlDir, "prompt.1"), prompt);
    const q = shellQuote;
    const script =
      `CTRL=${q(ctrlDir)}; OUT=${q(outFile)}; MARK=${q(markerBase)}; n=0; ` +
      `while true; do ` +
      `while [ ! -f "$CTRL/prompt.$((n+1))" ]; do sleep 0.3; done; ` +
      `n=$((n+1)); ` +
      `if [ "$n" -eq 1 ]; then ${turn1.map(q).join(" ")} < "$CTRL/prompt.$n" 2>&1 | tee -a "$OUT"; ` +
      `else ${resume.map(q).join(" ")} < "$CTRL/prompt.$n" 2>&1 | tee -a "$OUT"; fi; ` +
      `printf '\\n%s turn=%s exit=%s\\n' "$MARK" "$n" "\${PIPESTATUS[0]}"; ` +
      `done`;
    return { command: ["bash", "-lc", script], ctrlDir, outFile, markerBase };
  }
```

Add `agentResumeCommand` to the config destructure (next to `agentCommand`):
```js
    agentResumeCommand,
```

In `delegate`, compute the mode and branch. Replace the existing headless/interactive command selection block:
```js
    // (existing)
    let command;
    let headless;
    if (mode === "headless") {
      headless = await prepareHeadless({ workerName, profile, profileName, prompt });
      command = headless.command;
    } else {
      command = commandForAgent(profile, agentCommand, profileName);
    }
```
with:
```js
    let command;
    let headless;
    let session;
    if (mode === "session") {
      session = await prepareSession({ workerName, profile, profileName, prompt });
      command = session.command;
    } else if (mode === "headless") {
      headless = await prepareHeadless({ workerName, profile, profileName, prompt });
      command = headless.command;
    } else {
      command = commandForAgent(profile, agentCommand, profileName);
    }
```

Change the prompt-send guard so session mode also skips `sendAgent` (the prompt is delivered via the prompt file):
```js
    if (mode !== "headless" && mode !== "session") {
      await herdr.sendAgent(workerName, prompt);
    }
```

Extend the `registry.set(workerName, { ... })` record with session fields (add these keys alongside the existing ones):
```js
      ctrlDir: session?.ctrlDir,
      markerBase: session?.markerBase,
      outFile: headless?.outFile ?? session?.outFile,
      turn: session ? 1 : undefined,
```
(Keep the existing `outFile: headless?.outFile` line replaced by the combined line above; do not set `outFile` twice.)

Add `paneId` to the `delegate` return handle:
```js
    return {
      id: workerName,
      workerName,
      paneId,
      agent: profile.id,
      task: normalized.task,
      isolation: normalized.isolation,
      startResult,
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/runtime.test.js`
Expected: PASS (both new tests) and all prior tests still green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime.js test/runtime.test.js
git commit -m "feat: add session execMode with visible turn-loop wrapper"
```

---

### Task 3: Session observe / collect / followUp (`src/runtime.js`)

**Files:**
- Modify: `src/runtime.js`
- Test: `test/runtime.test.js` (append)

**Interfaces:**
- Consumes: session record fields from Task 2 (`mode`, `ctrlDir`, `outFile`, `markerBase`, `turn`, `paneId`).
- Produces:
  - `observe(id, opts)` — for session workers waits `wait output --match "<markerBase> turn=<turn> "` (trailing space disambiguates turn 1 from turn 10).
  - `collect(id)` — for session workers reads `outFile` (full transcript).
  - `followUp(id, prompt)` → `{ id, workerName, turn }` — increments the turn, writes `prompt.<turn>`, returns; caller then `observe`s/`collect`s. Throws if the worker is not a session worker or is unknown.
  - `workers()` entries now include `paneId`.

- [ ] **Step 1: Write the failing tests**

Append to `test/runtime.test.js`:

```js
test("session observe waits on the per-turn marker; collect reads the transcript file", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  const w = await drover.delegate({ name: "w3", agent: "claude", task: "t" });

  await drover.observe(w.id);
  assert.equal(only(herdr, "waitAgent").length, 0, "session must not use agent-status");
  const wo = only(herdr, "waitOutput")[0];
  assert.equal(wo.args[0], "ws-1:p2");
  assert.equal(wo.args[1].match, "__DROVER_DONE_s-w3__ turn=1 ");

  const collected = await drover.collect(w.id);
  assert.equal(typeof collected.output, "string"); // file may be empty under the fake
  assert.equal(only(herdr, "readAgent").length, 0, "session collect must not read the pane");
});

test("followUp writes the next prompt and advances the turn; observe matches it", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({
    herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP,
  });
  const w = await drover.delegate({ name: "w4", agent: "claude", task: "first" });
  const f = await drover.followUp(w.id, "second turn please");
  assert.equal(f.turn, 2);

  const text = await _readFile(_join(HEADLESS_TMP, "s-w4", "prompt.2"), "utf8");
  assert.equal(text, "second turn please");

  await drover.observe(w.id);
  const lastWait = only(herdr, "waitOutput").at(-1);
  assert.equal(lastWait.args[1].match, "__DROVER_DONE_s-w4__ turn=2 ");
});

test("followUp rejects unknown and non-session workers", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "s", headlessDir: HEADLESS_TMP });
  await assert.rejects(() => drover.followUp("nope", "x"), /Unknown worker/);
  const w = await drover.delegate({ name: "iw", agent: "kiro", task: "interactive" }); // default interactive
  await assert.rejects(() => drover.followUp(w.id, "x"), /not a session worker/);
});

test("workers() includes paneId", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "s", execMode: "session", headlessDir: HEADLESS_TMP });
  const w = await drover.delegate({ name: "w5", agent: "claude", task: "t" });
  assert.equal(drover.workers()[0].paneId, w.paneId);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime.test.js`
Expected: FAIL — `followUp` undefined; session `observe`/`collect` not routed; `workers()` lacks `paneId`.

- [ ] **Step 3: Implement**

In `observe`, add a session branch before the headless branch:
```js
  async function observe(id, { status = "done", timeoutMs = waitTimeoutMs } = {}) {
    const record = requireRecord(id);
    if (record.mode === "session") {
      return herdr.waitOutput(record.paneId, { match: `${record.markerBase} turn=${record.turn} `, timeoutMs });
    }
    if (record.mode === "headless") {
      return herdr.waitOutput(record.paneId, { match: record.doneMarker, timeoutMs });
    }
    return herdr.waitAgent(record.paneId || record.workerName, { status, timeoutMs });
  }
```

In `collect`, treat session like headless (read the output file). Change the headless guard to also cover session:
```js
    if (record.mode === "headless" || record.mode === "session") {
      let output = "";
      try {
        output = await readFile(record.outFile, "utf8");
      } catch {
        output = "";
      }
      return { id, workerName: record.workerName, agent: record.agent, output };
    }
```

Add `followUp` after `collect`:
```js
  async function followUp(id, prompt) {
    const record = requireRecord(id);
    if (record.mode !== "session") throw new Error(`Worker "${id}" is not a session worker.`);
    record.turn += 1;
    await writeFile(join(record.ctrlDir, `prompt.${record.turn}`), String(prompt));
    return { id, workerName: record.workerName, turn: record.turn };
  }
```

Add `followUp` to the returned object (next to `collect`):
```js
    collect,
    followUp,
```

Add `paneId` to each `workers()` entry:
```js
  function workers() {
    return [...registry.values()].map((record) => ({
      id: record.id,
      workerName: record.workerName,
      paneId: record.paneId,
      agent: record.agent,
      task: record.task,
      isolation: record.isolation,
      stopped: record.stopped,
    }));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/runtime.test.js`
Expected: PASS (new tests) and all prior tests still green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime.js test/runtime.test.js
git commit -m "feat: session observe/collect/followUp and paneId exposure"
```

---

### Task 4: Document session mode + takeover (`README.md`, `docs/architecture.md`)

**Files:**
- Modify: `README.md` (add a "Session mode (visible, multi-turn)" subsection under the existing Supervisor Integration section)
- Modify: `docs/architecture.md` (add a "Session mode" note after the Facade section)

**Interfaces:** none (documentation).

- [ ] **Step 1: Add the README subsection**

Insert this block into `README.md` immediately after the fenced example in the `## Supervisor Integration` section (before `## Design` if that is the next heading):

```markdown
### Session mode (visible, multi-turn, human takeover)

`execMode: "session"` runs each worker as a persistent, **visible** agent in its
own herdr pane — output streams to the pane (not just a file), so you can watch
it, `herdr agent attach <paneId>` to take over, then hand back. Follow-up turns
resume the same conversation.

\`\`\`js
const drover = createDroverRuntime({ cwd: "/repo", namePrefix: "sup", execMode: "session" });

const w = await drover.delegate({ name: "dev", agent: "claude", task: "Draft a plan" });
await drover.observe(w.id);            // waits for turn 1's completion marker
console.log(w.paneId);                 // herdr agent attach <paneId> to take over

await drover.followUp(w.id, "Now implement step 1.");
await drover.observe(w.id);            // waits for turn 2
const transcript = await drover.collect(w.id);
\`\`\`

Multi-turn resume continues the most recent conversation in the worker's cwd, so
give a multi-turn worker its own cwd (e.g. `isolation: "worktree"`) when other
workers share the base directory. Reliable interactive TUI driving is not
supported — session mode delivers visibility/takeover/multi-turn without it.
```

- [ ] **Step 2: Add the architecture note**

Add this after the `## Facade` section in `docs/architecture.md`:

```markdown
## Session mode

`execMode: "session"` launches a worker as a shell turn-loop in one persistent,
visible herdr pane. The loop waits for `prompt.<n>` files, runs the agent (turn 1
fresh; later turns resume via `claude -p -c` / `kiro ... --resume`), tees output
to the pane and an output file, and prints a per-turn marker matched with
`wait output`. `followUp(id, prompt)` drives the next turn; `collect` reads the
transcript file; `paneId` (on the handle and in `workers()`) is the takeover
point. This exists because driving an interactive agent TUI through herdr's
text primitives proved unreliable; session mode keeps the reliable headless
mechanism while adding visibility, takeover, and multi-turn.
```

- [ ] **Step 3: Verify docs render (balanced code fences)**

Run: `node -e "const fs=require('fs');for(const f of ['README.md','docs/architecture.md']){const c=fs.readFileSync(f,'utf8');if((c.match(/\`\`\`/g)||[]).length%2)throw new Error(f+': unbalanced fences');}console.log('docs ok')"`
Expected: `docs ok`

- [ ] **Step 4: Final full validation**

Run: `npm test && node ./bin/drover.mjs run --dry-run --workers 2 "final check" >/dev/null && echo OK`
Expected: tests pass, then `OK`.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture.md
git commit -m "docs: document session mode (visible, multi-turn, takeover)"
```

---

## Notes for the implementer

- The turn-loop wrapper is a bash string; unit tests assert its structure (loop,
  tee, per-turn marker, resume branch) — they do NOT run it. Live end-to-end
  verification (a claude worker's output visible in the pane, a `followUp` turn
  resuming the session, `collect` returning the transcript, `herdr agent attach`)
  is done during the final whole-branch review against live herdr 0.7.2.
- Per-turn marker match strings carry a **trailing space** (`turn=1 `) so `turn=1`
  never matches `turn=10`.
- codex resume is UNVERIFIED (not installed); do not claim it works live.
- Do not modify `src/cli.js`.
```
