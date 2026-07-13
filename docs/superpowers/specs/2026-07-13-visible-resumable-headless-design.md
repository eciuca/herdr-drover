# Visible + Resumable Headless Delegation — Design

**Status:** approved for planning
**Date:** 2026-07-13

## Goal

Give Drover workers the properties a supervisor wants from "interactive" delegation — **live visibility**, **human takeover**, and **multi-turn follow-ups** — without driving an interactive agent TUI, which a live spike proved unreliable.

## Background: why not real interactive mode

A throwaway spike drove claude and kiro interactively through herdr's `agent send` / `pane send-keys` / `agent read` primitives (~10 runs). It failed three independent ways:

- **Submission is inconsistent** — `agent send` + `send-keys enter` sometimes never triggers a turn (agent-status stays `idle`), sometimes does.
- **Output capture is empty/racy** — `agent read` against claude's full-screen alt-buffer TUI returns empty.
- **Agents exit unexpectedly** — interactive kiro vanished (`agent_not_found`) after a submit.

herdr *does* track agent-status for these agents, but its text I/O against their TUIs is not reliable enough to build on. **Headless mode is reliable precisely because it bypasses the TUI** (prompt on stdin, output to a file, a completion marker echoed to the pane matched via `wait output`). This design extends the headless mechanism to cover the interactive goals instead of fighting the TUI.

Reliable interactive TUI driving is **out of scope** and documented as not feasible on herdr 0.7.2 with these agents.

## Design

Three additions to the existing headless mode (`execMode: "headless"`). Interactive mode (`execMode: "interactive"`) and the current one-shot headless behavior remain; this adds a richer headless variant.

### 1. Visibility — tee output to the pane

Today's wrapper redirects agent output to a file, so the pane shows only the marker. Change it to **tee** — output goes to the pane (live) **and** the file (for `collect`):

```
<agent> < prompt 2>&1 | tee -a "$OUT"; printf '%s turn=%s exit=%s\n' "<marker>" "$n" "${PIPESTATUS[0]}"
```

The pane now streams the agent working. `collect()` still reads the file; `observe()` still matches the marker (printed after the tee). An optional `verbose` flag can select a richer agent output format (e.g. claude `--verbose`) for step-by-step visibility; default is plain.

### 2. Takeover — surface the pane

Each worker already runs in a genuine, persistent, visible herdr pane. Expose the worker's `paneId` on the `delegate()` handle and in `workers()`, and document `herdr agent attach <paneId>` (and `pane read`) as the takeover entry points. No new mechanism — the pane is real; we just surface how to grab it.

### 3. Multi-turn — one persistent pane, resume per turn

A worker's pane runs a **turn loop** wrapper: it waits for the next prompt file, runs the agent (turn 1 fresh; later turns resume the same session), tees output, prints a per-turn marker, and loops. This keeps a single continuous, watchable session per worker.

New facade method `followUp(id, prompt)`: writes the next prompt file and triggers the loop; returns after the turn's marker is observed (or exposes `observe` per turn). Resume uses per-agent commands:

- claude: `claude -p --resume <sessionId>` (or `-c`/`--continue`); session id captured from turn 1.
- kiro: `kiro-cli chat --resume-id <id>` (flags seen in `kiro-cli chat --help`).

**Open point to verify early in the plan (spike-first discipline):** confirm that headless resume actually works for claude and kiro, and pin the exact mechanism (capture `session_id` via structured output on turn 1 vs. `claude -c` "continue most recent in cwd"). The turn-loop wrapper shape depends on this; verify before building it.

## Facade API (additions)

- `delegate(spec)` — unchanged surface; in the visible variant the pane streams output and the handle carries `paneId`.
- `observe(id, { turn? })` — waits on the current turn's marker (per-turn markers include the turn number).
- `collect(id)` — reads the captured output file (full transcript across turns, or per-turn).
- `followUp(id, prompt)` — runs the next turn in the same pane, resuming the session.
- `release(id)` / `close(...)` — unchanged (close the pane / workspace).
- Handle / `workers()` expose `paneId` for `herdr agent attach`.

## Agent profiles (additions)

- `resumeCommand(sessionId, profileName)` for claude and kiro (codex best-effort/UNVERIFIED, per issue #2).
- A way to capture/derive the session id per agent for resume.

## Completion detection

Per-turn **output marker** matched via `herdr wait output --match` — the mechanism already proven reliable. (This supersedes the earlier working→idle idea, which belonged to the abandoned interactive path.)

## Testing

- **Unit (dry-run / fake herdr):** wrapper command generation — tee to pane + file, per-turn markers, turn-loop structure; `followUp` writes the prompt/trigger and observes the right marker; `resumeCommand` argv per agent; existing interactive + headless tests stay green.
- **Live (verified by the implementer/overseer against herdr 0.7.2):** a claude worker's output is visible in the pane; a `followUp` turn resumes the same session; `herdr agent attach` works; `collect` returns the transcript. kiro verified where feasible; codex remains UNVERIFIED (not installed).

## Constraints

- Node ≥20, ES modules, no new npm dependencies, `node --test`.
- Do not break existing `interactive` mode or the current one-shot `headless` tests.
- Primary agents: claude and kiro. codex stays best-effort/UNVERIFIED.
- Herdr teardown/worktree/wait verbs are those confirmed against live herdr 0.7.2.

## Out of scope

- Reliable interactive TUI driving (send-prompt-to-live-TUI) — spike-proven unreliable; documented, not built.
- codex live verification (codex not installed).
