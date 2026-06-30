/**
 * Delivery Gate — Mechanical quality gate that runs at session Stop.
 *
 * Zero-config auto-trigger via Stop hook (hooks.json).
 * Checks disk space and learning library freshness on every response.
 *
 * Called by run-with-flags.js as: module.exports.run(raw, options)
 * Contract: run(rawString, { hookId, pluginRoot, scriptPath, truncated, maxStdin })
 * Returns: { exitCode: 0|2, stderr?: string }
 *
 * Exit codes: 0 = pass, 2 = block
 *   - Disk critical (<15GB) always blocks
 *   - Complex session (≥3 edits) + ≥3 learning libs stale → blocks (strict mode)
 *   - Complex session + growth-log stale → blocks (strict mode)
 *   - Set DELIVERY_GATE_MODE=minimal to only block on disk critical
 *
 * @module delivery-gate
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

// ── Configuration ──────────────────────────────────────────
const DISK_REMIND_GB = 50;
const DISK_WARN_GB = 30;
const DISK_CRIT_GB = 15;
const COMPLEX_THRESHOLD = 3; // Edit/Write calls to classify as complex
const STALE_THRESHOLD_COUNT = 3; // ≥ this many stale libs → block (strict mode)
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MODE = (process.env.DELIVERY_GATE_MODE || 'strict').toLowerCase();
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024; // 10MB — refuse to parse larger transcripts
const EDIT_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit']);

// Learning library paths (relative to memory directory — resolved via getMemoryDir())
const LIBS = [
  'growth-log',
  'decisions/log.md',
  'output-index.md',
  'ratings-tracker.md',
  'tooling_capabilities.md',
];

// ── Memory directory resolution ──────────────────────────────

/**
 * Resolve the learning library base directory.
 * Checks CLAUDE_PROJECT_DIR for project-scoped memory first,
 * falls back to ~/.claude/memory/ for non-project sessions.
 *
 * @returns {string} Absolute path to the memory directory
 */
function getMemoryDir() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const safe = projectDir.replace(/:/g, '-').replace(/\\/g, '-').replace(/\//g, '-');
    return path.join(os.homedir(), '.claude', 'projects', safe, 'memory');
  }
  return path.join(os.homedir(), '.claude', 'memory');
}

// ── Disk space ─────────────────────────────────────────────

/**
 * Get free disk space on the home drive, in GB.
 * Uses execFileSync with argument arrays — no shell interpolation.
 * Platform support: wmic + PowerShell fallback (Windows), df -BG (Unix).
 *
 * @returns {number|null} Free GB, or null if the check fails (fail-open)
 */
function getDiskFreeGB() {
  const homedir = os.homedir();
  try {
    if (process.platform === 'win32') {
      const drive = homedir[0].toUpperCase();
      // Primary: wmic (argument array, no shell)
      const result = execFileSync(
        'wmic',
        ['logicaldisk', 'where', `Caption='${drive}:'`, 'get', 'FreeSpace', '/value'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const match = result.match(/FreeSpace=(\d+)/);
      if (match) return Number(match[1]) / (1024 * 1024 * 1024);

      // Fallback: PowerShell (argument array, no shell)
      const psResult = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-PSDrive ${drive}).Free`],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const free = Number(psResult.trim());
      if (!isNaN(free)) return free / (1024 * 1024 * 1024);
    } else {
      // Unix: GNU df -BG, POSIX df -Pk fallback for macOS/BSD
      const unixCmds = [['-BG'], ['-Pk']];
      for (const args of unixCmds) {
        try {
          const result = execFileSync('df', [...args, homedir], { encoding: 'utf8', timeout: 5000 });
          const cols = result.split('\n')[1]?.split(/\s+/);
          if (cols && cols.length >= 4) {
            const free = parseInt(cols[3], 10);
            if (!isNaN(free)) {
              return args[0] === '-Pk' ? free / (1024 * 1024) : free; // -Pk returns KB → GB
            }
          }
        } catch { /* try next command */ }
      }
    }
  } catch {
    // Fail-open: can't determine disk space → don't block
    return null;
  }
  return null;
}

// ── Library freshness ──────────────────────────────────────

/**
 * Recursively find the newest mtime (ms) among all files in a directory.
 * Skips dotfiles and traverses subdirectories.
 *
 * @param {string} dirPath — absolute path to the directory
 * @returns {number} Newest mtimeMs, or 0 if directory is empty or inaccessible
 */
function getNewestMtimeInDir(dirPath) {
  let newest = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = getNewestMtimeInDir(full);
        if (sub > newest) newest = sub;
      } else {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    }
  } catch {
    return 0; // Directory doesn't exist → stale
  }
  return newest;
}

/**
 * Check freshness of all learning libraries.
 * Uses .map() for immutable array construction (no in-place .push()).
 *
 * @param {string} memoryDir — absolute path to the memory directory
 * @param {number} now       — current timestamp (Date.now())
 * @returns {Array<{path: string, mtime: number, hoursAgo: number, stale: boolean}>}
 */
function checkLibFreshness(memoryDir, now) {
  const oneDayHours = ONE_DAY_MS / (1000 * 60 * 60);
  return LIBS.map(lib => {
    const full = path.join(memoryDir, lib);
    let mtime = 0;
    try {
      const stat = fs.statSync(full);
      mtime = stat.isDirectory()
        ? getNewestMtimeInDir(full)
        : stat.mtimeMs;
    } catch {
      mtime = 0; // Missing → stale
    }
    const hoursAgo = mtime > 0 ? (now - mtime) / (1000 * 60 * 60) : Infinity;
    return { path: full, mtime, hoursAgo, stale: hoursAgo > oneDayHours };
  });
}

// ── Message builders ───────────────────────────────────────

/**
 * Build block message for critically low disk space.
 *
 * @param {number} gb — current free GB
 * @returns {string}
 */
function msgDiskBlock(gb) {
  return [
    `DISK CRITICAL: ${gb.toFixed(1)}GB free (threshold: ${DISK_CRIT_GB}GB)`,
    `Your home drive is nearly full. Claude may fail to write files.`,
    `Action: Free at least ${(DISK_CRIT_GB - gb).toFixed(1)}GB before continuing.`,
  ].join('\n');
}

/**
 * Build reminder message for moderately low disk space.
 *
 * @param {number} gb — current free GB
 * @returns {string}
 */
function msgDiskRemind(gb) {
  return [
    `Reminder: ${gb.toFixed(1)}GB free (remind threshold: ${DISK_REMIND_GB}GB).`,
    `Consider cleaning up temporary files and old downloads soon.`,
  ].join('\n');
}

/**
 * Build warning message for low disk space.
 *
 * @param {number} gb — current free GB
 * @returns {string}
 */
function msgDiskWarn(gb) {
  return [
    `Disk low: ${gb.toFixed(1)}GB free (warn threshold: ${DISK_WARN_GB}GB).`,
    `Clean up soon — risk increases below ${DISK_CRIT_GB}GB.`,
  ].join('\n');
}

/**
 * Build guidance message for first-time users.
 *
 * @param {string} memoryDir — absolute path to the expected memory directory
 * @returns {string}
 */
function msgFirstTime(memoryDir) {
  return [
    `Welcome! No learning libraries found — normal for new setups.`,
    `Create ${path.join(memoryDir, 'growth-log')} in your home directory. See /growth-log.`,
  ].join('\n');
}

/**
 * Build block message for stale learning libraries after a complex session.
 *
 * @param {string[]} stalePaths — paths of stale libraries
 * @param {number} editCount    — number of edit tool calls in the session
 * @returns {string}
 */
function msgStaleBlock(stalePaths, editCount) {
  const s = stalePaths.length === 1 ? 'y' : 'ies';
  return [
    `BLOCKED: Complex task completed (${editCount} edits) but ${stalePaths.length} learning librar${s} not updated.`,
    `Stale: ${stalePaths.join(', ')}`,
    `Use /growth-log to capture what you learned, then the gate will pass.`,
  ].join('\n');
}

/**
 * Build warning message for stale learning libraries.
 *
 * @param {string[]} stalePaths — paths of stale libraries
 * @returns {string}
 */
function msgStaleWarn(stalePaths) {
  const s = stalePaths.length === 1 ? 'y' : 'ies';
  return [
    `Reminder: ${stalePaths.length} learning librar${s} not updated today.`,
    `Stale: ${stalePaths.join(', ')}`,
    `Use /growth-log to capture what you learned.`,
  ].join('\n');
}

// ── Edit count from transcript ─────────────────────────────

/**
 * Recursively count Write/Edit/MultiEdit tool_use entries in a parsed JSON value.
 * Handles both Claude Code JSONL (type: "assistant" with message.content blocks)
 * and flat tool format (type: "tool_use" or tool_name field).
 *
 * @param {*} value — parsed JSON value to scan
 * @param {number} depth — recursion guard (max 10)
 * @returns {number}
 */
function countEditToolUses(value, depth = 0) {
  if (value == null || depth > 10) return 0;

  let count = 0;

  if (Array.isArray(value)) {
    for (const item of value) {
      count += countEditToolUses(item, depth + 1);
    }
  } else if (typeof value === 'object') {
    // Flat tool format: the entry itself is a tool_use
    if ((value.type === 'tool_use' || value.tool_name) &&
        EDIT_TOOL_NAMES.has(value.tool_name || value.name)) {
      count += 1;
    }
    // Claude Code JSONL: assistant message with nested content blocks
    if (value.type === 'assistant' && Array.isArray(value.message?.content)) {
      for (const block of value.message.content) {
        if (block.type === 'tool_use' && EDIT_TOOL_NAMES.has(block.name)) {
          count += 1;
        }
      }
    }
  }

  return count;
}

/**
 * Count Write/Edit/MultiEdit tool calls in the session transcript.
 * Stop payloads provide `transcript_path` (JSONL), not `.messages` array.
 *
 * Validates transcript_path before parsing: resolves to absolute path,
 * checks isFile() and enforces MAX_TRANSCRIPT_BYTES. Parses each line
 * as JSON and recursively counts tool_use entries.
 *
 * @param {object} input — parsed Stop event payload
 * @returns {number}
 */
function countEdits(input) {
  const transcriptPath = input?.transcript_path;
  if (!transcriptPath) return 0;

  // Validate transcript_path before reading
  let resolved;
  try {
    resolved = path.resolve(transcriptPath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return 0;
    if (stat.size > MAX_TRANSCRIPT_BYTES) {
      process.stderr.write(
        `[delivery-gate] Transcript too large ` +
        `(${(stat.size / 1024 / 1024).toFixed(1)}MB > ${MAX_TRANSCRIPT_BYTES / 1024 / 1024}MB), ` +
        `skipping edit count\n`
      );
      return 0;
    }
  } catch {
    return 0; // Fail-open: can't stat transcript
  }

  try {
    // Use resolved path (not original) — both validated above via statSync
    const content = fs.readFileSync(resolved, 'utf8');
    let count = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      count += countEditToolUses(entry);
    }
    return count;
  } catch {
    return 0; // Fail-open: can't read transcript → assume simple session
  }
}

// ── Quality gate helpers ───────────────────────────────────

/**
 * Check available disk space against warning and critical thresholds.
 * Calls getDiskFreeGB() internally; fail-open (null) returns empty lines.
 *
 * @returns {{ lines: string[], blocked: boolean }}
 */
function checkDiskSpace() {
  const freeGB = getDiskFreeGB();
  if (freeGB === null) return { lines: [], blocked: false };

  if (freeGB < DISK_CRIT_GB) {
    return { lines: [msgDiskBlock(freeGB)], blocked: true };
  }
  if (freeGB < DISK_WARN_GB) {
    return { lines: [msgDiskWarn(freeGB)], blocked: false };
  }
  if (freeGB < DISK_REMIND_GB) {
    return { lines: [msgDiskRemind(freeGB)], blocked: false };
  }
  return { lines: [], blocked: false };
}

/**
 * Determine whether to block or warn based on stale learning libraries.
 * Applies strict vs minimal mode and simple vs complex session thresholds.
 *
 * @param {Array<{path: string, stale: boolean, hoursAgo: number}>} libResults
 * @param {number} editCount — number of edit tool calls in the session
 * @returns {{ lines: string[], blocked: boolean }}
 */
function checkStaleLibraries(libResults, editCount) {
  const stalePaths = libResults.filter(r => r.stale).map(r => r.path);
  if (stalePaths.length === 0) return { lines: [], blocked: false };

  const isComplex = editCount >= COMPLEX_THRESHOLD;

  if (isComplex && MODE !== 'minimal') {
    // Strict mode (default): block if ≥3 libs stale or growth-log specifically stale
    const growthLog = libResults.find(r => r.path.includes('growth-log'));
    const growthLogStale = growthLog && growthLog.stale;

    if (stalePaths.length >= STALE_THRESHOLD_COUNT || growthLogStale) {
      return { lines: [msgStaleBlock(stalePaths, editCount)], blocked: true };
    }
  } else if (isComplex) {
    // Minimal mode: warn only
    return { lines: [msgStaleWarn(stalePaths)], blocked: false };
  } else {
    // Simple session — quick growth-log reminder if it's the stalest
    const growthLog = libResults.find(r => r.path.includes('growth-log'));
    if (growthLog && growthLog.stale) {
      return {
        lines: [`Quick reminder: growth-log hasn't been updated in ${growthLog.hoursAgo.toFixed(0)}h.`],
        blocked: false
      };
    }
  }

  return { lines: [], blocked: false };
}

// ── Main hook ──────────────────────────────────────────────

/**
 * Hook entry point. Matches run-with-flags.js contract exactly.
 *
 * @param {string} raw     — raw stdin JSON (Stop event payload)
 * @param {object} options — { hookId, pluginRoot, scriptPath, truncated, maxStdin }
 * @returns {{ exitCode: number, stderr?: string }}
 */
function run(raw, options = {}) {
  if (options.truncated) {
    return {
      exitCode: 0,
      stderr: '[delivery-gate] stdin truncated, skipping (fail-open)\n'
    };
  }

  // Parse stdin JSON for Stop event data
  let input = {};
  try {
    if (typeof raw === 'string' && raw.trim()) {
      input = JSON.parse(raw);
    }
  } catch {
    return {
      exitCode: 0,
      stderr: '[delivery-gate] Could not parse stdin JSON, skipping (fail-open)\n'
    };
  }

  const homedir = os.homedir();
  const now = Date.now();
  const memoryDir = getMemoryDir();

  // 1. Disk check (fail-open: null → skip, returned as empty lines)
  const { lines: diskLines, blocked: diskBlocked } = checkDiskSpace();

  // 2. First-time user check
  if (!fs.existsSync(memoryDir)) {
    const allLines = [...diskLines, msgFirstTime(memoryDir)];
    const stderr = allLines.map(l => `[delivery-gate] ${l}\n`).join('');
    return { exitCode: diskBlocked ? 2 : 0, stderr };
  }

  // 3. Library freshness (resolves paths under memoryDir)
  const libResults = checkLibFreshness(memoryDir, now);

  // 4. Complexity check (reads transcript via Stop payload's transcript_path)
  const editCount = countEdits(input);

  // 5. Stale library handling (strict mode: block on complex sessions)
  const { lines: staleLines, blocked: staleBlocked } = checkStaleLibraries(libResults, editCount);

  // 6. Combine and output
  const allLines = [...diskLines, ...staleLines];
  if (allLines.length === 0) return { exitCode: 0 };

  const stderr = allLines.map(l => `[delivery-gate] ${l}\n`).join('');
  return { exitCode: (diskBlocked || staleBlocked) ? 2 : 0, stderr };
}

module.exports = {
  run,
  checkDiskSpace,
  checkStaleLibraries,
  checkLibFreshness,
  countEditToolUses,
  countEdits,
  getDiskFreeGB,
  getMemoryDir,
  getNewestMtimeInDir,
  msgDiskBlock,
  msgDiskRemind,
  msgDiskWarn,
  msgFirstTime,
  msgStaleBlock,
  msgStaleWarn,
};
