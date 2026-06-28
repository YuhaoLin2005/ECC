---
name: growth-log
description: "Teach effective learning capture — write growth logs that extract reusable patterns, not just record events. Failures > achievements. Dedup before writing. Every entry must be transferable."
---

# Growth Log Skill

> **The problem:** Most developers write "fixed a bug in X" as a growth log. That's a diary entry, not a learning artifact. A real growth log extracts the *pattern* so you recognize it next time.
>
> **This skill teaches:** How to write growth logs that compound across sessions.

## When to Use

Invoke this skill:
- After completing a complex task (multi-file, new feature, architecture change)
- After a failure, mistake, or "that was harder than expected" moment
- Before ending a session with any code or config changes
- When the delivery gate flags stale learning libraries
- When you want to review what you've learned over a period

## The Three Rules

### Rule 1: Failures > Achievements

A failure is nutritionally denser than a success. One bug that took 2 hours to find teaches more than 3 features that worked first try.

**Bad:** "Successfully implemented the login flow."
**Good:** "Login flow: session token wasn't persisting because the cookie `SameSite` defaulted to `Lax` in Chrome 128+. Pattern: always explicitly set `SameSite=None; Secure` when cross-origin."

### Rule 2: The Bole Principle (伯乐原则)

Before writing a new entry, ask: *"Is this fundamentally the same as something I already recorded?"*

Same root cause, different symptom → **merge**, don't duplicate.
New root cause → new entry.

**Example:** "Forgot to update output-index after creating a file" and "Forgot to update ratings-tracker after a task" — same root cause (no automatic capture trigger). Merge into one entry about "post-task capture gaps."

### Rule 3: Must Be Transferable

Every entry must answer: *"Next time I face a similar situation, what do I do differently?"*

If you can't write that sentence, you haven't extracted the pattern yet.

## Entry Template

```markdown
## [Title: the pattern, not the event]

### Context
- What was I trying to do?
- What went wrong / what worked surprisingly well?

### Root Cause / Core Insight
- The underlying mechanism, not just the symptom

### The Pattern (transferable)
- Next time [similar situation], I will [specific action].
- Signal to recognize: [what to look for]

### Related
- [[link-to-related-memory]] [[link-to-related-growth-entry]]
```

## Entry Types

| Type | When to Use | Example Title |
|------|------------|---------------|
| **Failure** | Something broke, was harder than expected, or required rework | "Config inheritance ≠ behavior inheritance across sessions" |
| **Methodology** | A repeatable process emerged from the work | "PPT → open-book exam study guide: three-layer structure" |
| **Pattern Discovery** | A reusable insight about tools, systems, or thinking | "Daltino PR template: describe the gap, not the feature" |
| **Capability Change** | A measurable skill improvement | "Git: from clone/push to independent PR with 12 commits" |

## Integration with Delivery Gate

The delivery gate (`quality-gate.py`) checks that growth-log was updated today after any code change. This skill teaches *what to write*, not just *that you wrote something*.

```
Code change → delivery gate checks growth-log freshness →
  if stale: block, ask "what did you learn?"
  if fresh: verify entry quality (pattern extracted? transferable?)
```

## Library Structure

For systematic learning capture, organize into 5 libraries:

| Library | Content | Update Trigger |
|---------|---------|---------------|
| `growth-log/` | Methodologies, failures, patterns | After any complex task |
| `decisions/log.md` | Choices + options + logic + outcome + review date | After any irreversible decision |
| `ratings-tracker.md` | Quantified abilities (0-5 scale) | When a skill demonstrably improves |
| `output-index.md` | File locations across sessions | After creating any deliverable |
| `tooling_capabilities.md` | Available tools inventory | After adding/removing any tool |

## Quality Checklist

Before finalizing a growth log entry:

- [ ] Does the title name the *pattern*, not the event?
- [ ] Is there a "Next time I will..." sentence?
- [ ] Did I check for duplicate patterns before writing? (Bole Principle)
- [ ] Is the root cause distinguished from the symptom?
- [ ] Are related memories cross-linked?

## Anti-Patterns

- ❌ "Fixed bug in payment module" (event, not pattern)
- ❌ Copying the git commit message verbatim (different purpose)
- ❌ Writing an entry for every single commit (only when a pattern emerges)
- ❌ Skipping the transferable sentence (without it, it's just a diary)
- ❌ Duplicating the same pattern under different titles (violates Bole Principle)

## Origin

Extracted from 25+ growth log entries across 5 sessions of DeepSeek V4 Pro + Claude Code development. The methodology survived multiple LLM swaps and produced 4 open-source PRs, 2 published skills, and a self-referential digital twin configuration system — all because failures were systematically converted into transferable patterns.
