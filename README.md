# Drover for Herdr

CLI agent orchestration for Herdr.

Drover coordinates terminal-based coding agents like Claude Code, Codex, Kiro CLI, OpenCode, and other CLI workers through Herdr workspaces, panes, statuses, and notifications.

Herdr gives you the herd.
Drover drives it toward done.

## Why

Coding agents are most useful when they can run in parallel, stay visible, and hand work back only when something needs attention.
Herdr already makes agent sessions pleasant to use: remote SSH access, panes, agent status recognition, and notifications.

Drover adds the missing orchestration layer:

- assign tasks to agents
- launch agents in Herdr panes
- coordinate multiple workers
- watch for blocked/done states
- collect progress
- route review back to the human
- keep work organized across repos and worktrees

## Goals

Drover is built for people who want to use Herdr as their main agent terminal, but need more than manual pane management.
It should make it easy to:

- run Claude Code, Codex, Kira CLI, and other agents side by side
- delegate tasks from one supervisor prompt
- use Herdr as the visual runtime
- keep agent state readable
- work remotely over SSH
- avoid constantly checking every terminal pane

## How It Works

Drover sits above Herdr and uses Herdr’s CLI/socket API to control the workspace.

A typical flow:
1. Create or select a Herdr workspace
2. Create worktrees or working directories
3. Start one or more agent panes
4. Send each agent a scoped task
5. Monitor output and agent status
6. Detect blocked, waiting, done, or review-needed states
7. Notify the user or continue orchestration

## Example
bash
drover run "Implement the auth cleanup plan across the repo"
Drover may split the task into workers:
text
planner     -> breaks down the task
codex-1     -> edits backend auth flow
claude-1    -> reviews edge cases
codex-2     -> updates tests
reviewer    -> summarizes changes and blockers
Each worker runs in Herdr, so the human can inspect, interrupt, or continue any session directly.

## Design Principles

- Herdr stays the main interface
- - agents are real CLI processes, not hidden abstractions
- every worker has a visible pane and readable state
- orchestration should be inspectable, interruptible, and recoverable
- human review is a first-class state, not an afterthought
- works well over SSH

## Inspired By

Drover takes inspiration from:

- AWS CLI Agent Orchestrator
- tmux-based multi-agent workflows
- Claude Code and Codex terminal workflows
- Herdr’s agent-aware terminal experience
  
## Status

Early concept / prototype.

Initial target:

- Herdr workspace discovery
- pane creation
- agent launch commands
- task dispatch
- status polling
- blocked/done detection
- summary output

## Name
A drover is someone who drives and guides a herd.

That felt right for a Herdr orchestrator.
