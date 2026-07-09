import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskList, splitInlineTask } from "../src/planner.js";

test("splitInlineTask creates one kiro worker by default", () => {
  const tasks = splitInlineTask("ship it");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].agent, "kiro");
  assert.equal(tasks[0].task, "ship it");
});

test("splitInlineTask creates planner, builder, and reviewers", () => {
  const tasks = splitInlineTask("build feature", { workers: 3, defaultAgent: "codex" });
  assert.deepEqual(
    tasks.map((task) => task.name),
    ["planner", "builder", "reviewer-1"],
  );
  assert.ok(tasks.every((task) => task.agent === "codex"));
});

test("parseTaskList reads markdown task lines with optional agent/name metadata", () => {
  const tasks = parseTaskList(`
# Plan
- agent=kiro name=api implement the API worker
- agent=codex write tests
- plain default task
`, { defaultAgent: "claude" });
  assert.deepEqual(tasks, [
    { name: "api", agent: "kiro", profile: undefined, task: "implement the API worker" },
    { name: "worker-2", agent: "codex", profile: undefined, task: "write tests" },
    { name: "worker-3", agent: "claude", profile: undefined, task: "plain default task" },
  ]);
});

test("parseTaskList reads provider profile metadata", () => {
  const tasks = parseTaskList("- agent=kiro profile=reviewer name=review review the diff");
  assert.deepEqual(tasks, [
    { name: "review", agent: "kiro", profile: "reviewer", task: "review the diff" },
  ]);
});
