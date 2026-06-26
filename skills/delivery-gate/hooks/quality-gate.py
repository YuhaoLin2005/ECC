#!/usr/bin/env python3
"""
Stop hook: quality gate with delivery check.
Detects incomplete work, stale learning logs, and low disk space.
Blocks Claude from stopping when a complex task completed without learning capture.

Install: cp this file to ~/.claude/scripts/quality-gate.py
Configure: Add to settings.json hooks.Stop
"""
import sys, os, re, datetime, shutil

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
    'tooling-capabilities': 'tooling-capabilities.md',
}

MIN_CHARS = 40          # minimum transcript length to trigger checks
COMPLEX_THRESHOLD = 3   # Edit/Write calls to classify as "complex task"
C_WARN_GB = 50          # warn when free space below this
C_CRIT_GB = 15          # block stop when below this
# ---- End Configuration ----


def get_project_memory_dir():
    """Find the current project's memory directory."""
    cwd = os.environ.get('CLAUDE_PROJECT_DIR', os.getcwd())
    safe = cwd.replace(':', '').replace('\\', '-').replace('/', '-')
    mem = os.path.expanduser(f'~/.claude/projects/{safe}/memory')
    if os.path.isdir(mem):
        return mem
    # Fallback: most recently modified project memory
    base = os.path.expanduser('~/.claude/projects')
    if os.path.isdir(base):
        dirs = []
        for d in os.listdir(base):
            dp = os.path.join(base, d)
            if os.path.isdir(dp):
                dirs.append((os.path.getmtime(dp), dp))
        if dirs:
            return os.path.join(sorted(dirs, reverse=True)[0][1], 'memory')
    return None


def check_stale_libs(mem_dir):
    """Return list of library names not updated today."""
    today = datetime.date.today()
    stale = []
    for name, path in LIBS.items():
        full = os.path.join(mem_dir, path)
        if os.path.isdir(full):
            has_today = False
            for f in os.listdir(full):
                fp = os.path.join(full, f)
                if os.path.isfile(fp):
                    mt = datetime.datetime.fromtimestamp(os.path.getmtime(fp)).date()
                    if mt == today:
                        has_today = True
                        break
            if not has_today:
                stale.append(name)
        elif os.path.exists(full):
            mt = datetime.datetime.fromtimestamp(os.path.getmtime(full)).date()
            if mt != today:
                stale.append(name)
        else:
            stale.append(name)
    return stale


def count_edits(text):
    """Count Edit/Write tool invocations in the last assistant response."""
    tail = text[-8000:]
    return len(re.findall(r'(?:Edit|Write)\s+', tail))


def main():
    raw = sys.stdin.read()
    if len(raw) < MIN_CHARS:
        sys.exit(0)

    tail = raw[-8000:]

    # 1. Hard pattern detection
    hits = []
    for p in RATIONALIZE:
        m = re.search(p, tail, re.IGNORECASE)
        if m:
            hits.append(m.group(0)[:80])
    if hits:
        print(f'quality-gate: {hits}', file=sys.stderr)

    # 2. Delivery gate
    mem_dir = get_project_memory_dir()
    edit_count = count_edits(raw)
    is_complex = edit_count >= COMPLEX_THRESHOLD

    if mem_dir:
        stale = check_stale_libs(mem_dir)
    else:
        stale = []

    c_free = shutil.disk_usage('C:').free // (2**30)
    c_warn = c_free < C_WARN_GB
    c_crit = c_free < C_CRIT_GB

    # Build warning message
    parts = []
    if is_complex:
        status_icons = ['X' if s in stale else 'O' for s in LIBS]
        parts.append(
            f'\n  Complex task ({edit_count} edits). '
            f'Check: [{"][".join(f"{k}:{v}" for k,v in zip(LIBS.keys(), status_icons))}]'
        )
    if stale:
        parts.append(f'  Stale ({len(stale)}): {", ".join(stale)}')
    if c_warn:
        parts.append(f'  {"CRIT" if c_crit else "WARN"}: C drive {c_free}GB free')

    if parts:
        print('\n'.join(parts), file=sys.stderr)

    # 3. Block conditions
    if is_complex and len(stale) >= len(LIBS):
        print('\nBlocked: complex task completed but no learning captured today.', file=sys.stderr)
        print('Update at least one library (e.g. growth-log) before stopping.', file=sys.stderr)
        sys.exit(2)

    if c_crit:
        print(f'\nBlocked: C drive at {c_free}GB. Free space before continuing.', file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == '__main__':
    main()
