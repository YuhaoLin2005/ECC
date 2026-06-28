#!/usr/bin/env python3
"""
Stop hook: quality gate with delivery check.
Detects incomplete work, stale learning logs, and low disk space.
Blocks Claude from stopping when a complex task completed without learning capture.

Install: cp this file to ~/.claude/scripts/quality-gate.py
Configure: Add to settings.json hooks.Stop
"""
from __future__ import annotations

import sys
import os
import re
import datetime
import shutil
import logging
from typing import Optional

# ---- Configuration ----
# Patterns that indicate rationalized incompleteness
RATIONALIZE = [
    r'(?:this|that)\s+is\s+a\s+pre[- ]existing\s+(?:issue|bug)\b(?!\s+(?:that|which|and))',
    r'skipping\s+(?:tests?|lint|coverage|type[- ]check)\s+for\s+now',
    r'(?:tests?|coverage)\s+(?:are|is)\s+(?:failing|broken)\s+but\s+(?:I|we)\'ll\s+(?:fix|address)',
    r'(?:not\s+addressing|won\'t\s+fix|leaving)\s+the\s+(?:failing|broken)\s+(?:test|build)',
]

# Files to check for today's updates (relative to project memory dir)
# Customize these to match your learning-capture workflow
LIBS = {
    'ratings-tracker': 'ratings-tracker.md',
    'decisions-log': 'decisions/log.md',
    'growth-log': 'growth-log/',          # directory — any file updated today counts
    'output-index': 'output-index.md',
    'tooling-capabilities': 'tooling_capabilities.md',
}

MIN_CHARS = 40          # minimum transcript length to trigger checks
COMPLEX_THRESHOLD = 3   # Edit/Write calls to classify as "complex task"
DISK_REMIND_GB = 50     # remind when free space below this
DISK_WARN_GB = 30       # warn when free space below this
DISK_CRIT_GB = 15       # block stop when below this
# ---- End Configuration ----

# Configure stderr logger per coding guidelines
logging.basicConfig(
    stream=sys.stderr,
    format='%(levelname)s: %(message)s',
    level=logging.INFO,
)
log = logging.getLogger('quality-gate')


def get_project_memory_dir() -> Optional[str]:
    """Find the current project's memory directory.
    Returns None if no memory directory exists for this project.
    Does NOT fall back to other projects (privacy boundary)."""
    cwd = os.environ.get('CLAUDE_PROJECT_DIR', os.getcwd())
    safe = cwd.replace(':', '').replace('\\', '-').replace('/', '-')
    mem = os.path.expanduser(f'~/.claude/projects/{safe}/memory')
    if os.path.isdir(mem):
        return mem
    return None


def check_disk() -> Optional[int]:
    """Check free space on the disk containing the home directory.
    Works cross-platform: macOS, Linux, Windows.
    Returns free GB, or None if the home directory is unavailable
    (e.g. on a headless CI runner without a real home dir)."""
    try:
        home = os.path.expanduser('~')
        free_gb = shutil.disk_usage(home).free // (2**30)
        return free_gb
    except (FileNotFoundError, PermissionError, OSError):
        # Home dir not accessible — log and continue without disk check
        log.warning('cannot check disk space (home dir inaccessible)')
        return None


def check_stale_libs(mem_dir: str) -> list[str]:
    """Return list of library names not updated today.
    Per-file OSError handling: individual unreadable files are skipped,
    but the scan continues for remaining libraries."""
    today = datetime.date.today()
    stale: list[str] = []
    for name, path in LIBS.items():
        full = os.path.join(mem_dir, path)
        try:
            if os.path.isdir(full):
                has_today = False
                for dirpath, _dirnames, filenames in os.walk(full):
                    for f in filenames:
                        fp = os.path.join(dirpath, f)
                        try:
                            mt = datetime.datetime.fromtimestamp(os.path.getmtime(fp)).date()
                            if mt == today:
                                has_today = True
                                break
                        except OSError:
                            continue
                    if has_today:
                        break
                if not has_today:
                    stale.append(name)
            elif os.path.exists(full):
                try:
                    mt = datetime.datetime.fromtimestamp(os.path.getmtime(full)).date()
                    if mt != today:
                        stale.append(name)
                except OSError:
                    stale.append(name)
            else:
                stale.append(name)
        except OSError as e:
            log.warning('cannot access lib %s: %s', name, e)
            stale.append(name)
    return stale


def count_edits(text: str) -> int:
    """Count Edit/Write tool invocations in the full transcript.
    Matches structured tool-call JSON patterns to avoid false-positives
    from ordinary English prose (e.g., 'Edit the file' in conversation).
    Scans entire transcript — not truncated to tail."""
    return len(re.findall(r'"name":\s*"(?:Edit|Write)"', text))


def main() -> None:
    raw = sys.stdin.read()
    sys.stdout.write(raw)

    # 1. Disk check — three-level: remind / warn / block
    disk_free = check_disk()
    if disk_free is not None:
        if disk_free < DISK_CRIT_GB:
            log.warning('Blocked: disk space at %dGB (<%dGB). Free space before continuing.',
                        disk_free, DISK_CRIT_GB)
            sys.exit(2)
        if disk_free < DISK_WARN_GB:
            log.warning('WARN: disk space at %dGB (<%dGB)', disk_free, DISK_WARN_GB)
        elif disk_free < DISK_REMIND_GB:
            log.info('Reminder: disk space at %dGB (<%dGB)', disk_free, DISK_REMIND_GB)

    # 2. Short session — skip remaining checks
    if len(raw) < MIN_CHARS:
        sys.exit(0)

    # 3. Rationalization pattern detection (logs warning only)
    hits = []
    for p in RATIONALIZE:
        m = re.search(p, raw[-8000:], re.IGNORECASE)
        if m:
            hits.append(m.group(0)[:80])
    if hits:
        log.warning('quality-gate: %s', hits)

    # 4. Learning capture check
    mem_dir = get_project_memory_dir()
    edit_count = count_edits(raw)
    is_complex = edit_count >= COMPLEX_THRESHOLD

    if mem_dir:
        stale = check_stale_libs(mem_dir)
    else:
        # No memory dir — setup incomplete. Warn but don't block;
        # blocking users who haven't opted in yet is worse than false-pass.
        if is_complex:
            log.warning('No project memory directory found — cannot verify learning capture.')
            log.warning('Set up memory/ per delivery-gate SKILL.md to enable enforcement.')
        stale = []

    parts = []
    if is_complex:
        status_icons = ['X' if s in stale else 'O' for s in LIBS]
        parts.append(
            f'\n  Complex task ({edit_count} edits). '
            f'Check: [{"][".join(f"{k}:{v}" for k,v in zip(LIBS.keys(), status_icons))}]'
        )
    if stale:
        parts.append(f'  Stale ({len(stale)}): {", ".join(stale)}')

    if parts:
        log.warning('\n'.join(parts))

    # 5. Block if complex task completed without learning capture
    if is_complex:
        if len(stale) >= 3:
            log.warning('Blocked: complex task but >=3 learning libs stale.')
            log.warning(f'Stale: {", ".join(stale)}. Update before stopping.')
            sys.exit(2)
        if 'growth-log' in stale:
            log.warning('Blocked: code changes made but no growth-log update.')
            log.warning('Write growth-log before stopping (even if "no new learnings").')
            sys.exit(2)

    sys.exit(0)


if __name__ == '__main__':
    main()
