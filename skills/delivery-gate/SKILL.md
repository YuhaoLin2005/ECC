---
name: delivery-gate
description: Stop hook that blocks Claude from finishing until quality checks pass. Detects rationalization patterns, stale learning logs (via mtime), and low disk space. Complements verification-loop by enforcing learning capture rather than just checking code quality.
---

# Delivery Gate — Self-Audit Stop Hook

A Stop hook that blocks Claude from finishing when quality conditions aren't met. Unlike verification-loop (which checks build/test/lint), this system checks **session hygiene**: did Claude rationalize skipping work? Did it update learning logs after code changes? Is disk space dangerously low?

## When to Activate

- Any project where you want Claude to learn from its mistakes over time
- Long coding sessions where "done" often means "code works but thinking was sloppy"
- Teams that want consistent quality standards across AI-assisted work

## Installation

### 1. Install the hook script

```bash
# From the ECC repo root (after cloning/forking):
cp skills/delivery-gate/hooks/quality-gate.py ~/.claude/scripts/
```

### 2. Configure in settings.json

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/scripts/quality-gate.py",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

### 3. Add CLAUDE.md rules

Add this block to your project or global CLAUDE.md:

```markdown
## Session-End Checklist (收尾铁律)

After complex tasks, verify before stopping:
1. Self-Audit — contradictions, omissions, unverified assumptions, sugar-coating
2. Teaching Output — why + how + core benefit (code tasks only)
3. Delivery Gate — five libraries + disk space
4. Capture — new facts→persona | failures→growth-log
5. Output Index — record deliverable paths
```

### 4. Create memory libraries

See `memory/README.md` for the five-library setup.

## How It Works

The hook parses stdin (handles both raw transcript text and JSON with `transcript_path` for Claude Code Stop hooks). It:
1. Scans for rationalization patterns (e.g., "this is a pre-existing issue", "skip tests for now")
2. Counts Edit/Write tool invocations to detect complex tasks
3. Checks if five learning libraries were modified today (filesystem mtime)
4. Checks home-directory filesystem disk space
5. Blocks (exit 2) when complex tasks complete without learning capture or disk is critically low

## Customization

Edit `quality-gate.py`:
- `RATIONALIZE` regex patterns — add your team's common excuses
- `LIBS` dictionary — customize which files to check
- `MIN_CHARS` — minimum transcript length to trigger checks
- `DISK_REMIND_GB` / `DISK_WARN_GB` / `DISK_CRIT_GB` — adjust for your environment

## Examples

### Normal session — no blocking

```
$ claude  # edits 2 files, updates growth-log
...
Claude tries to stop → hook runs:
  edit_count=2 (< 3, not complex) → exit 0 (allowed)
```

### Complex task, learning captured — allowed

```
$ claude  # edits 5 files, updates growth-log/2026-06-26.md
...
Claude tries to stop → hook runs:
  edit_count=5 (complex) → checks LIBS → growth-log updated today → exit 0 (allowed)
```

### Complex task, no learning — BLOCKED

```
$ claude  # edits 4 files, nothing written to memory
...
Claude tries to stop → hook runs:
  edit_count=4 (complex) → checks LIBS → all 5 stale → exit 2 (blocked)
  stderr: "Blocked: complex task completed but no learning captured today."
```

### Low disk space — BLOCKED regardless

```
$ claude  # any session, home filesystem at 12GB
...
Claude tries to stop → hook runs:
  disk_free=12GB < 15GB critical → exit 2 (blocked)
  stderr: "Blocked: disk space at 12GB (threshold: 15GB)."
```

## Related Skills

- `verification-loop` — Technical checks (build, type, lint, test). Different scope: code output vs learning capture.
- `gateguard` — Same architecture (deterministic hook + pattern matching), different lifecycle point (PreToolUse vs Stop).
