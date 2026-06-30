---
name: delivery-gate
description: "Auto-trigger Stop hook that blocks session end until mechanical quality checks pass. Checks disk space, learning library freshness, and growth-log staleness — no configuration needed."
version: 2.0.0
metadata:
  origin: ECC
  autoTrigger: Stop hook (matcher: "*")
  installModule: workflow-quality
---

# Delivery Gate — Zero-Config Auto-Trigger

> **What it does:** At the end of every Claude Code session, delivery-gate checks three mechanical facts before allowing the session to close. No AI, no configuration — just filesystem timestamps and disk usage.
>
> **How it works:** A Stop hook runs `delivery-gate.js` automatically at session end. You don't need to edit settings.json or run anything manually. It's installed via the `workflow-quality` module (SKILL.md) + `hooks-runtime` module (hook script). Both default to `install: true`.

## Checks (deterministic only)

| Check | Mechanism | On Hit |
|-------|-----------|--------|
| Disk space < 15GB | `wmic` (Windows) / `df` (Unix) | **Block** (exit 2) |
| Disk space < 30GB | `wmic` (Windows) / `df` (Unix) | Warning |
| Disk space < 50GB | `wmic` (Windows) / `df` (Unix) | Reminder |
| ≥3 learning libs stale (strict mode) | Filesystem mtime | **Block** (exit 2) |
| growth-log stale + complex task (strict mode) | Filesystem mtime | **Block** (exit 2) |
| Any libs stale, non-complex task | Filesystem mtime | Warning |
| First-time user (no memory/ dir) | Filesystem existence | Guidance (never blocks) |

Disk check failures are **fail-open** — if the platform command fails for any reason, it doesn't block. The hook only blocks on verified facts.

## Why This Exists

Claude Code checks code quality (build → type → lint → test). But there's a different failure mode: the agent produces working code while the **session hygiene was neglected** — learning not captured, disk running out silently.

Over many sessions of "ship and forget," the human hasn't grown. This hook enforces the habit: complex task → must touch learning libraries.

This is the same pattern as CI pipeline gates — automated, deterministic checks that verify machine-readable facts rather than trusting self-reported status.

## Quick Start

**Already installed.** If you installed the `workflow-quality` module, delivery-gate runs automatically at session end. No setup needed.

To verify it's working:
```
[delivery-gate] Reminder: 3 learning libraries not updated today.
[delivery-gate] Stale: .claude/memory/growth-log, .claude/memory/decisions/log.md, .claude/memory/output-index.md
```

## Learning Libraries

The hook checks these 5 paths under your memory directory:

```
{memoryDir}/
├── growth-log/          # Daily learning entries (directory, recursive)
├── decisions/log.md     # Decision log
├── output-index.md      # Index of session outputs
├── ratings-tracker.md   # Skill ratings over time
└── tooling_capabilities.md  # Known tools inventory
```

**Memory directory resolution:** Checks `CLAUDE_PROJECT_DIR` for project-scoped memory (`~/.claude/projects/{hash}/memory/`), falls back to `~/.claude/memory/` for non-project sessions. This is automatic — no configuration needed.

If at least one was modified today, the check passes. If you use different paths, edit the `LIBS` array in `scripts/hooks/delivery-gate.js` (paths are relative to the memory directory).

## Behavior by Session Type

| Session | Edit Count | Behavior |
|---------|-----------|----------|
| Simple (typo, query, single-line) | < 3 | Warning if libs stale, never blocks |
| Complex (multi-file, new feature) | ≥ 3 | Block if ≥3 libs stale OR growth-log stale (strict mode) |

**Strict mode** is the default. Set `DELIVERY_GATE_MODE=minimal` to only block on disk-critical — learning checks become warnings. Set in `.claude/settings.json` or your shell profile.

## Examples

**Simple session — allowed:**
```
edit_count=1 → not complex → exit 0
(warns about stale libs but never blocks)
```

**Complex task, learning captured — allowed:**
```
edit_count=5 → complex → checks libs → growth-log updated today → exit 0
```

**Complex task, no learning — BLOCKED:**
```
edit_count=4 → complex → checks libs → 5 stale → exit 2
stderr: "BLOCKED: Complex task completed (4 edits) but 5 learning libraries not updated.
Stale: .claude/memory/growth-log, .claude/memory/decisions/log.md, ..."
```

**First-time user — guided:**
```
memory/ dir doesn't exist → "Welcome! ..." → exit 0
```

## Paired Skills

- **`/growth-log`** — Teaches *what* to write in learning files so delivery-gate's timestamp checks actually capture useful patterns
- **`/self-audit`** — Reasoning quality gate (completeness/consistency/groundedness/honesty) — complements delivery-gate's mechanical checks

Together: delivery-gate checks the *habit*, growth-log teaches the *content*, self-audit checks the *quality*.

## Limitations

The hook enforces the **habit** of touching learning libraries, not the **quality** of what was recorded. In strict mode, a complex session still blocks if `growth-log` is stale — touching other libraries satisfies the general stale-count rule but not the growth-log-specific rule. In minimal mode, all library checks are warnings only. This is by design — mechanical gates check machine-verifiable facts. For content quality, pair with `self-audit`.

## Compatibility

- Node.js 16+ (no npm dependencies — stdlib only)
- Cross-platform: Windows (wmic/PowerShell fallback), macOS/Linux (GNU df -BG + POSIX df -Pk fallback)
- Zero external dependencies

## See Also

- `scripts/hooks/delivery-gate.js` — Full source with inline configuration
- `/growth-log` — How to write useful learning entries
- `/self-audit` — Reasoning quality verification
