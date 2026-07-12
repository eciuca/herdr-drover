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
