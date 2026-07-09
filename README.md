# Drover for Herdr

CLI agent orchestration for Herdr.

Drover coordinates terminal-based coding agents like Kiro CLI, Claude Code, Codex, OpenCode, and other CLI workers through Herdr workspaces, panes, statuses, and notifications.

Herdr gives you the herd. Drover drives it toward done.

## Status

Early prototype. Kiro CLI is the first target; Claude Code and Codex profiles are included so they can be routed from task files.

## Install

```bash
npm install
npm link
```

## Quick Start

Dry-run the commands Drover would send to Herdr:

```bash
drover run --dry-run --workers 2 "Implement a small feature and verify it"
```

Run a Kiro-first task file:

```bash
drover run --agent kiro --task-file examples/kiro-first.plan.md
```

Use an existing Herdr named session:

```bash
drover run --session work --agent kiro "Investigate the failing tests"
```

## Task Files

Task files are Markdown lists. Each task can optionally choose an agent and stable worker name:

```md
- agent=kiro profile=developer name=planner inspect the repo and produce a short plan
- agent=kiro profile=developer name=builder implement the plan and run focused checks
- agent=codex name=reviewer review the diff for risks
```

## How It Works

Drover uses Herdr's CLI/socket-backed control surface:

- creates or reuses a Herdr workspace
- starts one visible Herdr agent pane per worker
- sends each worker a scoped prompt
- optionally waits for Herdr agent status `done`
- can notify through Herdr when delegation starts

## Commands

```bash
drover run [options] "task"
drover run --task-file plan.md [options]
drover doctor
drover profiles
```

Useful options:

```text
--agent kiro|codex|claude
--agent-profile developer
--agent-command "kiro --some-flag"
--workers 3
--cwd /path/to/repo
--workspace w1
--session work
--wait
--dry-run
--no-notify
```

## Design

Drover is intentionally thin. Herdr remains the actual runtime, UI, SSH-friendly surface, and status source. Drover adds a CAO-style supervisor layer on top: splitting work, launching workers, dispatching prompts, and collecting status.

See [docs/architecture.md](docs/architecture.md).

## Herdr Plugin

The repo includes a first `herdr-plugin.toml` so Drover can later be linked into Herdr:

```bash
herdr plugin link /path/to/herdr-drover
```

The initial actions are intentionally minimal: `doctor` and a Kiro-first plan launcher.
