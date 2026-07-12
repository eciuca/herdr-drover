import { readFile } from "node:fs/promises";

const TASK_LINE = /^\s*(?:[-*]|\d+[.)])\s+(?<body>.+?)\s*$/;
export function splitInlineTask(task, { workers = 1, defaultAgent = "kiro" } = {}) {
  const trimmed = String(task || "").trim();
  if (!trimmed) return [];
  if (workers <= 1) {
    return [
      {
        name: "worker-1",
        agent: defaultAgent,
        task: trimmed,
      },
    ];
  }

  return [
    {
      name: "planner",
      agent: defaultAgent,
      task: [
        "Create a short implementation plan for this goal.",
        "Identify files likely to change, risks, and a worker breakdown.",
        "",
        `Goal: ${trimmed}`,
      ].join("\n"),
    },
    {
      name: "builder",
      agent: defaultAgent,
      task: [
        "Implement the primary change for this goal.",
        "Keep edits scoped, do not revert unrelated changes, and run focused checks.",
        "",
        `Goal: ${trimmed}`,
      ].join("\n"),
    },
    ...Array.from({ length: Math.max(0, workers - 2) }, (_, index) => ({
      name: `reviewer-${index + 1}`,
      agent: defaultAgent,
      task: [
        "Review the current implementation direction for risks, missing tests, and blockers.",
        "Do not make broad unrelated edits. Leave a concise review summary.",
        "",
        `Goal: ${trimmed}`,
      ].join("\n"),
    })),
  ];
}

export async function readTaskFile(path, { defaultAgent = "kiro" } = {}) {
  const text = await readFile(path, "utf8");
  return parseTaskList(text, { defaultAgent });
}

export function parseTaskList(text, { defaultAgent = "kiro" } = {}) {
  const tasks = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    const parsed = parseTaskMetadata(match.groups.body, { defaultAgent, index: tasks.length + 1 });
    if (!parsed.task) continue;
    tasks.push(parsed);
  }
  return tasks;
}

function parseTaskMetadata(body, { defaultAgent, index }) {
  const words = body.trim().split(/\s+/);
  const metadata = {};
  const taskWords = [];
  let inMetadata = true;
  for (const word of words) {
    const keyValue = /^([a-z][a-z0-9_-]*)=(.+)$/i.exec(word);
    if (inMetadata && keyValue) {
      metadata[keyValue[1].toLowerCase()] = keyValue[2];
      continue;
    }
    inMetadata = false;
    taskWords.push(word);
  }
  return {
    name: metadata.name || `worker-${index}`,
    agent: metadata.agent || defaultAgent,
    profile: metadata.profile,
    task: taskWords.join(" ").trim(),
  };
}

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
    .filter((line) => line !== null)
    .join("\n");
}
