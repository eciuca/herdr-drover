import { cwd as processCwd } from "node:process";
import { HerdrCli } from "./herdr.js";
import { readTaskFile, splitInlineTask } from "./planner.js";
import { runDelegation } from "./orchestrator.js";
import { AGENT_PROFILES } from "./agents.js";

export async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case "run":
      return runCommand(rest);
    case "doctor":
      return doctorCommand(rest);
    case "profiles":
      return profilesCommand();
    case "help":
    case "--help":
    case "-h":
    case undefined:
      return printHelp();
    default:
      throw new Error(`Unknown command "${command}". Run "drover help".`);
  }
}

async function runCommand(argv) {
  const parsed = parseArgs(argv);
  const taskText = parsed.positionals.join(" ").trim();
  const defaultAgent = parsed.agent || "kiro";
  const tasks = parsed.taskFile
    ? await readTaskFile(parsed.taskFile, { defaultAgent })
    : splitInlineTask(taskText, {
        workers: Number(parsed.workers || 1),
        defaultAgent,
      });

  const herdr = new HerdrCli({
    bin: parsed.herdrBin || "herdr",
    session: parsed.session,
    dryRun: Boolean(parsed.dryRun),
    timeoutMs: Number(parsed.commandTimeoutMs || 30_000),
  });

  const result = await runDelegation({
    herdr,
    tasks,
    options: {
      cwd: parsed.cwd || processCwd(),
      workspaceId: parsed.workspace,
      workspaceLabel: parsed.workspaceLabel,
      defaultAgent,
      agentProfile: parsed.agentProfile,
      namePrefix: parsed.namePrefix || "drover",
      goal: taskText || parsed.taskFile,
      wait: Boolean(parsed.wait),
      notify: parsed.notify !== false,
      splitDirection: parsed.split || "right",
      waitTimeoutMs: Number(parsed.waitTimeoutMs || 1_800_000),
      agentCommand: parsed.agentCommand ? shellWords(parsed.agentCommand) : undefined,
    },
  });

  console.log(JSON.stringify(result, null, 2));
}

async function doctorCommand(argv) {
  const parsed = parseArgs(argv);
  const herdr = new HerdrCli({
    bin: parsed.herdrBin || "herdr",
    session: parsed.session,
    dryRun: Boolean(parsed.dryRun),
    timeoutMs: Number(parsed.commandTimeoutMs || 30_000),
  });
  const result = await herdr.status();
  console.log(JSON.stringify({ ok: !result.stderr, result, commands: herdr.commands }, null, 2));
}

function profilesCommand() {
  console.log(JSON.stringify(AGENT_PROFILES, null, 2));
}

function parseArgs(argv) {
  const parsed = { positionals: [], notify: true };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      parsed.positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      parsed.positionals.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (rawKey.startsWith("no-")) {
      parsed[toCamel(rawKey.slice(3))] = false;
      continue;
    }
    const key = toCamel(rawKey);
    if (["dryRun", "wait"].includes(key)) {
      parsed[key] = true;
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`Missing value for --${rawKey}`);
    parsed[key] = value;
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function shellWords(value) {
  return String(value)
    .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map((part) => part.replace(/^["']|["']$/g, "")) || [];
}

function printHelp() {
  console.log(`Drover for Herdr

Usage:
  drover run [options] "task"
  drover run --task-file plan.md [options]
  drover doctor [--session name]
  drover profiles

Options:
  --agent kiro|codex|claude       Worker profile, default: kiro
  --agent-profile developer       Provider-specific profile, e.g. Kiro developer/reviewer
  --agent-command "kiro --flag"   Override worker launch command
  --workers N                     Split one inline task into N role prompts
  --task-file PATH                Markdown task list; supports "agent=codex name=api ..."
  --cwd PATH                      Working directory for Herdr workers
  --workspace ID                  Use an existing Herdr workspace
  --workspace-label TEXT          Label for a new workspace
  --session NAME                  Herdr named session
  --name-prefix TEXT              Prefix for worker names, default: drover
  --wait                          Wait for Herdr agent status "done"
  --wait-timeout-ms N             Per-worker wait timeout
  --dry-run                       Print Herdr commands without executing
  --no-notify                     Skip Herdr notification

Examples:
  drover run --dry-run --workers 2 "Implement auth cleanup"
  drover run --agent kiro --task-file examples/kiro-first.plan.md
`);
}
