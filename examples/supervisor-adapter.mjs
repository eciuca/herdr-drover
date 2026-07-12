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
