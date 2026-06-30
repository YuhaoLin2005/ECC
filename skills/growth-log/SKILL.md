---
name: growth-log
description: "Use after complex tasks, failures, or when capturing what you learned. Pre-check verifies learning files exist before you write. Teaches how to write growth logs that extract reusable patterns — not diary entries."
version: 1.2.0
metadata:
  origin: ECC
  autoActivation: skill keyword match in description
  installModule: workflow-quality
---

# Growth Log — Pre-Check + Writing Guide

> **Pre-check first:** Before you write anything, the skill verifies that your learning library exists. First-time setup takes 30 seconds. After that, every session end triggers `delivery-gate` to confirm you actually wrote something.
>
> **The problem:** Most people write "fixed a bug in X" as a learning log. That's a diary entry, not a learning artifact. A real growth log extracts the *pattern* so you recognize it next time.
>
> **This skill teaches:** How to write learning entries that compound across sessions. Works with any note-taking system — Markdown files, Notion, Obsidian, plain text.

## Quick Start

- **First-time setup:** Create `~/.claude/memory/growth-log/` directory. That's it — `delivery-gate` handles the rest.
- **When to write:** After complex tasks (multi-file, new feature, architecture change), failures, or non-obvious decisions. Skip for typos and single-line tweaks.
- **What to write:** One `.md` file per day (`YYYY-MM-DD.md`), each entry 4-8 sentences, title names the *pattern* not the event.

## Pre-Check (runs automatically)

When you invoke `/growth-log`, the skill first verifies:

```
[growth-log] Pre-check:
[growth-log]   memory/ dir: ✓ exists
[growth-log]   memory/growth-log/: ✓ exists (3 entries)
[growth-log]   memory/decisions/log.md: ✓ exists (updated today)
[growth-log]   memory/output-index.md: ✗ missing
[growth-log]   → Create it? A blank output-index.md takes 10 seconds.
```

**First-time user path:** If `memory/` doesn't exist, the skill creates the scaffold for you — no manual setup beyond confirming "yes, create the directory structure."

## When to Activate

- After completing a complex task (multi-file, new feature, architecture change)
- After a failure, mistake, or "that was harder than expected" moment
- When you want to review what you've learned over a period

**When NOT to activate:** Trivial changes (typo fixes, single-line tweaks, config value changes with no debugging). The threshold: *did this task involve debugging, redoing, rollback, or a non-obvious decision?* If yes → write an entry. If no → skip.

## The Three Rules

### Rule 1: Failures > Achievements

A failure is nutritionally denser than a success. One bug that took 2 hours to find teaches more than 3 features that worked first try.

**Bad:** "Successfully implemented the login flow."
**Good (web dev):** "Login flow: session token wasn't persisting because the cookie `SameSite` defaulted to `Lax` in Chrome 128+. Pattern: always explicitly set `SameSite=None; Secure` when cross-origin. Signal to recognize: auth breaks after browser upgrade or when crossing origin boundaries."
**Good (data pipeline):** "CSV import failed silently on empty rows because `pandas.read_csv(dropna=False)` keeps zero-width rows that `len()` counts as valid. Pattern: always `df.dropna(how='all', inplace=True)` before row-count validation."

### Rule 2: The Bole Principle (伯乐原则)

Before writing a new entry, ask: *"Is this fundamentally the same as something I already recorded?"*

Same root cause, different symptom → **merge**, don't duplicate. New root cause → new entry.

**How to check:** Search existing entries for keywords from your root cause before writing. If you find a match, add your new symptom as an additional example under the existing entry rather than creating a duplicate.

**Example:** "Forgot to update the output index after creating a file" and "Forgot to update skill ratings after a task" — same root cause (no automatic capture trigger). Merge into one entry about "post-task capture gaps."

### Rule 3: Must Be Transferable

Every entry must answer: *"Next time I face a similar situation, what do I do differently?"*

If you can't write that sentence, you haven't extracted the pattern yet.

**How to extract a pattern from a concrete event:**
1. State what happened in one sentence
2. Ask "why?" iteratively until you reach root cause (usually 3-5 whys)
3. Generalize: "What class of problem is this?" (not "Chrome 128 bug" but "browser default change breaking existing behavior")
4. Formulate as: "Next time I see [signal], I will [action]."
5. Name the signal: what specific observable tells you this pattern is active?

## Entry Template

**Scope:** One entry per distinct root cause. Typical length: 4-8 sentences. If it takes >2 minutes to write, you're narrating events. If <30 seconds, you haven't gone deep enough.

```markdown
## [Title: the pattern, not the event]

### Context
- What was I trying to do?
- What went wrong / what worked surprisingly well?

### Root Cause / Core Insight
- The underlying mechanism, not just the symptom

### The Pattern (transferable)
- Next time [similar situation], I will [specific action].
- Signal to recognize: [what observable tells me this pattern is active?]

### Related
- [entry-name](../path/to/related-entry.md)
```

## Entry Types

All four types use the template above. The type determines which sections carry the most weight:

| Type | When to Use | Emphasis | Example Title |
|------|------------|----------|---------------|
| **Failure** | Something broke, needed debugging, or required rework | Root Cause | "Config inheritance ≠ behavior inheritance across sessions" |
| **Methodology** | A repeatable process emerged from the work | Context / Pattern | "PPT → open-book exam study guide: three-layer structure" |
| **Pattern Discovery** | A reusable insight about tools, systems, or thinking | Pattern section | "PR description template: describe the gap, not the feature" |
| **Capability Change** | A measurable skill improvement | Context (before vs after) | "Git: from clone/push to independent PR with 12 commits" |

## Quality Checklist

Before finalizing a growth log entry:

- [ ] Does the title name the *pattern*, not the event?
- [ ] Is there a "Next time I will..." sentence?
- [ ] Is the "Signal to recognize" specific enough to trigger the pattern next time?
- [ ] Did I search existing entries for duplicates before writing? (Bole Principle)
- [ ] Is the root cause distinguished from the symptom?
- [ ] Are related memories cross-linked?
- [ ] Is the entry 4-8 sentences? Shorter = too shallow; longer = narrating events.

## Anti-Patterns

- Avoid: "Fixed bug in payment module" (event, not pattern)
- Avoid: Copying the git commit message verbatim (commits describe what changed; logs extract why it matters)
- Avoid: Writing an entry for every commit (only when a pattern emerges)
- Avoid: Skipping the transferable sentence (without it, it's just a diary — this is non-negotiable)
- Avoid: Duplicating the same pattern under different titles (violates Bole Principle — search before writing)

## Storage

```
~/.claude/memory/
├── growth-log/          # One .md file per day: YYYY-MM-DD.md
├── decisions/           # Decision log: log.md
├── output-index.md      # Cross-session file locator
├── ratings-tracker.md   # Skill ratings over time
└── tooling_capabilities.md  # Known tools catalog
```

The `delivery-gate` Stop hook checks these files via mtime. The pre-check in this skill verifies they exist before you write.

## How delivery-gate and growth-log Work Together

```
Task completes → delivery-gate fires at Stop:
  → mtime check: was any learning file touched today?
    → Stale: block — "what did you learn?"
    → Fresh: pass

growth-log skill (this skill):
  → Pre-check: do the files exist? (first-time setup if not)
  → Teaches: what to write so the files contain useful patterns, not empty timestamps
```

Having enforcement without methodology → empty entries. Having methodology without enforcement → forgotten captures. Each is independently useful; together they close the loop.

## See Also

- `/delivery-gate` — The Stop hook that enforces the learning habit
- `/self-audit` — Reasoning quality verification (complements mechanical checks)
- `scripts/hooks/delivery-gate.js` — Hook source with inline configuration
