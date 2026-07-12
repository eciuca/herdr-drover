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

import {
  HerdrCli,
  extractWorktreePath,
  extractRootPaneId,
  extractAgentPaneId,
} from "../src/herdr.js";

test("HerdrCli teardown + worktree verbs generate expected commands (dry-run)", async () => {
  const herdr = new HerdrCli({ dryRun: true });
  await herdr.closePane("wA:p1");
  await herdr.closeWorkspace("ws-1");
  await herdr.createWorktree({ cwd: "/repo", branch: "drover/builder" });
  assert.deepEqual(herdr.commands, [
    ["herdr", "pane", "close", "wA:p1"],
    ["herdr", "workspace", "close", "ws-1"],
    ["herdr", "worktree", "create", "--cwd", "/repo", "--branch", "drover/builder", "--json"],
  ]);
});

test("extractWorktreePath reads nested path or falls back to dry-run stub", () => {
  assert.equal(extractWorktreePath({ result: { worktree: { path: "/wt/a" } } }), "/wt/a");
  assert.equal(extractWorktreePath({ path: "/wt/b" }), "/wt/b");
  assert.equal(extractWorktreePath({}, { dryRun: true, name: "c" }), "dry-run-worktree/c");
  assert.equal(extractWorktreePath({}, {}), undefined);
});

test("extractRootPaneId and extractAgentPaneId read herdr result shapes", () => {
  assert.equal(extractRootPaneId({ result: { root_pane: { pane_id: "wA:p1" } } }), "wA:p1");
  assert.equal(extractRootPaneId({}), undefined);
  assert.equal(extractAgentPaneId({ result: { agent: { pane_id: "wA:p2" } } }), "wA:p2");
  assert.equal(extractAgentPaneId({}), undefined);
});

import { createDroverRuntime } from "../src/runtime.js";

function makeFakeHerdr(responses = {}) {
  return {
    dryRun: false,
    commands: [],
    calls: [],
    _paneSeq: 1,
    _push(method, args, ret) {
      this.calls.push({ method, args });
      return ret;
    },
    async createWorkspace(opts) {
      this.commands.push(["workspace", "create"]);
      return this._push(
        "createWorkspace",
        [opts],
        responses.createWorkspace ?? { result: { workspace: { id: "ws-1" }, root_pane: { pane_id: "ws-1:p1" } } },
      );
    },
    async startAgent(opts) {
      this.commands.push(["agent", "start", opts.name]);
      const paneId = `ws-1:p${++this._paneSeq}`; // root pane is p1
      return this._push("startAgent", [opts], { result: { agent: { pane_id: paneId } } });
    },
    async closePane(paneId) {
      this.commands.push(["pane", "close", paneId]);
      return this._push("closePane", [paneId], {});
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
    async closeWorkspace(id) {
      return this._push("closeWorkspace", [id], {});
    },
    async createWorktree(opts) {
      return this._push(
        "createWorktree",
        [opts],
        responses.createWorktree ?? { result: { worktree: { path: `/wt/${opts.branch}` } } },
      );
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
  assert.equal(wt.branch, "drover/sup-builder");
  assert.equal(wt.cwd, "/repo");
  const start = only(herdr, "startAgent")[0].args[0];
  assert.equal(start.cwd, "/wt/drover/sup-builder");
});

test("first delegate closes the workspace bootstrap pane exactly once", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, cwd: "/repo", namePrefix: "sup" });
  await drover.delegate({ name: "a", agent: "kiro", task: "x" });
  await drover.delegate({ name: "b", agent: "kiro", task: "y" });
  const closes = only(herdr, "closePane").map((c) => c.args[0]);
  assert.deepEqual(closes, ["ws-1:p1"]); // only the bootstrap pane, once
});

test("delegate does not close a bootstrap pane when reusing an existing workspace", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr, workspaceId: "ext-ws", cwd: "/repo", namePrefix: "sup" });
  await drover.delegate({ name: "a", agent: "kiro", task: "x" });
  assert.equal(only(herdr, "createWorkspace").length, 0);
  assert.equal(only(herdr, "closePane").length, 0);
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
  const paneCloses = only(herdr, "closePane").map((c) => c.args[0]);
  assert.ok(paneCloses.includes("ws-1:p2")); // worker a's own pane (p1 was bootstrap)

  await drover.close({ closeWorkspace: true });
  assert.equal(only(herdr, "closeWorkspace")[0].args[0], "ws-1");
});

test("observe and collect throw on unknown worker id", async () => {
  const herdr = makeFakeHerdr();
  const drover = createDroverRuntime({ herdr });
  await assert.rejects(() => drover.observe("nope"), /Unknown worker/);
  await assert.rejects(() => drover.collect("nope"), /Unknown worker/);
});
