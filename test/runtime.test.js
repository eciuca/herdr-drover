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
