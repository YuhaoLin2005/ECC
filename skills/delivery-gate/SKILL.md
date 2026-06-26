---
name: delivery-gate
description: Stop hook that blocks Claude from finishing until quality checks pass. Detects incomplete tasks, stale learning logs, and low disk space. Complements verification-loop by checking thinking quality (contradictions, omissions, unverified assumptions) rather than just code quality.
---

# Delivery Gate — Self-Audit Stop Hook

A Stop hook that forces Claude to verify quality before it can finish. Unlike verification-loop (which checks build/test/lint), this system checks **thinking quality**: did Claude assume something untested? Did it skip documenting a lesson? Is disk space dangerously low?

## When to Activate

- Any project where you want Claude to learn from its mistakes over time
- Long coding sessions where "done" often means "code works but thinking was sloppy"
- Teams that want consistent quality standards across AI-assisted work

## Installation

### 1. Install the hook script

```bash
cp hooks/quality-gate.py ~/.claude/scripts/
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
## 收尾铁律

复杂任务结束必须自动输出:
1. 自审 — 矛盾/遗漏/未验证假设/美化
2. 教学 — 为什么做/如何做/核心收益 (仅代码任务)
3. 交付门 — 五库+C盘
4. 沉淀 — 新事实→persona | 翻车→growth-log
5. 产出索引
```

### 4. Create memory libraries

See `memory/README.md` for the five-library setup.

## How It Works

The hook receives the full transcript on stdin. It:
1. Detects "rationalization patterns" (e.g., "this is a pre-existing issue")
2. Counts Edit/Write calls to detect complex tasks
3. Checks if five learning libraries were updated today
4. Checks C drive space
5. Blocks (exit 2) when complex tasks complete without learning capture

## Customization

Edit `quality-gate.py`:
- `RATIONALIZE` regex patterns — add your team's common excuses
- `LIBS` dictionary — customize which files to check
- `MIN_CHARS` — minimum transcript length to trigger checks
- C drive thresholds — adjust for your environment

## Related Skills

- `verification-loop` — Technical checks (build, type, lint, test). Different scope: code output vs learning capture.
- `gateguard` — Same architecture (deterministic hook + pattern matching), different lifecycle point (PreToolUse vs Stop).
