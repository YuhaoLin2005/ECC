/**
 * Delivery Gate — Mechanical quality gate that runs at session Stop.
 *
 * Checks (deterministic only, no AI inference):
 * 1. Disk space (platform commands — wmic on Windows, df on Unix)
 * 2. Learning library freshness (filesystem mtime)
 * 3. Growth-log staleness (for complex sessions, strict mode)
 *
 * First-time users (no memory/ dir) are guided, not blocked.
 * Disk check failures are fail-open (don't block on infra issues).
 *
 * @module delivery-gate
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// ── Configuration ──────────────────────────────────────────
const DISK_WARN_GB = 50;
const DISK_CRIT_GB = 15;
const COMPLEX_THRESHOLD = 3; // Edit/Write/MultiEdit calls to classify as complex
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Learning library paths (relative to ~/.claude/)
const LIBS = [
  'memory/growth-log',
  'memory/decisions/log.md',
  'memory/output-index.md',
  'memory/ratings-tracker.md',
  'memory/tooling_capabilities.md',
];

// ── Disk space ─────────────────────────────────────────────

function getDiskFreeGB() {
  const homedir = os.homedir();
  try {
    if (process.platform === 'win32') {
      const drive = homedir[0].toUpperCase();
      // Primary: wmic
      const result = execSync(
        `wmic logicaldisk where "Caption='${drive}:'" get FreeSpace /value`,
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const match = result.match(/FreeSpace=(\d+)/);
      if (match) return Number(match[1]) / (1024 * 1024 * 1024);

      // Fallback: PowerShell
      const psResult = execSync(
        `powershell -NoProfile -Command "(Get-PSDrive ${drive}).Free"`,
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const free = Number(psResult.trim());
      if (!isNaN(free)) return free / (1024 * 1024 * 1024);
    } else {
      // Unix: df -BG /
      const result = execSync('df -BG /', { encoding: 'utf8', timeout: 5000 });
      const cols = result.split('\n')[1]?.split(/\s+/);
      if (cols && cols.length >= 4) {
        const free = parseInt(cols[3], 10);
        if (!isNaN(free)) return free;
      }
    }
  } catch {
    // Fail-open: can't determine disk space → don't block
    return null;
  }
  return null;
}

// ── Library freshness ──────────────────────────────────────

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

function checkLibFreshness(homedir, now) {
  const results = [];
  for (const lib of LIBS) {
    const full = path.join(homedir, lib);
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
    results.push({ path: lib, mtime, hoursAgo, stale: hoursAgo > 24 });
  }
  return results;
}

// ── Message builders ───────────────────────────────────────

function msgDiskBlock(gb) {
  return [
    `DISK CRITICAL: ${gb.toFixed(1)}GB free (threshold: ${DISK_CRIT_GB}GB)`,
    `Your home drive is nearly full. Claude may fail to write files.`,
    `Action: Free at least ${(DISK_CRIT_GB - gb).toFixed(1)}GB before continuing.`,
  ];
}

function msgDiskWarn(gb) {
  return [
    `Disk low: ${gb.toFixed(1)}GB free (warn threshold: ${DISK_WARN_GB}GB)`,
    `Consider cleaning up temporary files and old downloads soon.`,
    `Current session can continue, but risk increases below ${DISK_CRIT_GB}GB.`,
  ];
}

function msgStaleBlock(stalePaths) {
  return [
    `BLOCKED: Complex task completed but learning libraries are stale.`,
    `Stale (${stalePaths.length}/${LIBS.length}): ${stalePaths.join(', ')}`,
    `Action: Update at least one learning file before ending the session. See /growth-log.`,
  ];
}

function msgStaleWarn(stalePaths) {
  const s = stalePaths.length === 1 ? 'y' : 'ies';
  return [
    `Reminder: ${stalePaths.length} learning librar${s} not updated today.`,
    `Stale: ${stalePaths.join(', ')}`,
    `Consider capturing what you learned. Use /growth-log for guidance.`,
  ];
}

function msgFirstTime() {
  return [
    `Welcome! It looks like this is your first session with learning tracking.`,
    `No learning libraries found yet — this is normal for new setups.`,
    `To start: create memory/growth-log/ in your .claude directory. See /growth-log.`,
  ];
}

// ── Edit count from input ──────────────────────────────────

function countEdits(input) {
  let count = 0;
  try {
    const messages = input?.messages || [];
    for (const msg of messages) {
      if (
        msg.tool === 'Write' ||
        msg.tool === 'Edit' ||
        msg.tool === 'MultiEdit'
      ) {
        count++;
      }
    }
  } catch {
    // Can't parse input → assume non-complex
  }
  return count;
}

// ── Main hook ──────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {string[]} ctx.flags  — enabled flags (standard, strict, minimal)
 * @param {object}   ctx.input  — parsed stdin JSON (transcript messages)
 * @returns {{ code: number, messages: string[][] }}
 */
function run(ctx) {
  const flags = ctx.flags || [];
  const strict = flags.includes('strict');
  const minimal = flags.includes('minimal');
  const homedir = os.homedir();
  const now = Date.now();
  const messages = [];

  // 1. Disk check (fail-open)
  const freeGB = getDiskFreeGB();
  if (freeGB !== null) {
    if (freeGB < DISK_CRIT_GB) {
      messages.push(msgDiskBlock(freeGB));
    } else if (freeGB < DISK_WARN_GB) {
      messages.push(msgDiskWarn(freeGB));
    }
  }

  // 2. First-time user check
  const memoryDir = path.join(homedir, 'memory');
  if (!fs.existsSync(memoryDir)) {
    messages.push(msgFirstTime());
    emitMessages(messages, minimal);
    return { code: 0, messages };
  }

  // 3. Library freshness
  const libResults = checkLibFreshness(homedir, now);
  const stalePaths = libResults.filter(r => r.stale).map(r => r.path);
  const growthLogStale = libResults.find(
    r => r.path === 'memory/growth-log'
  )?.stale;

  // 4. Complexity check
  const editCount = countEdits(ctx.input);
  const isComplex = editCount >= COMPLEX_THRESHOLD;

  // 5. Block / warn
  if (isComplex) {
    if (strict && stalePaths.length >= 3) {
      messages.push(msgStaleBlock(stalePaths));
    } else if (strict && growthLogStale && stalePaths.length >= 1) {
      messages.push(msgStaleBlock(['memory/growth-log']));
    }
    // Non-blocking warning (when not already blocked)
    if (
      stalePaths.length > 0 &&
      !messages.some(m => m[0].startsWith('BLOCKED'))
    ) {
      messages.push(msgStaleWarn(stalePaths));
    }
  }

  emitMessages(messages, minimal);

  const blocked = messages.some(
    m => m[0].startsWith('BLOCKED') || m[0].startsWith('DISK CRITICAL')
  );
  return { code: blocked ? 2 : 0, messages };
}

function emitMessages(messages, minimal) {
  if (minimal) return;
  for (const group of messages) {
    for (const m of group) {
      const isBlock =
        m.startsWith('BLOCKED') || m.startsWith('DISK CRITICAL');
      const tag = isBlock ? '[delivery-gate] BLOCK: ' : '[delivery-gate] ';
      process.stderr.write(`${tag}${m}\n`);
    }
  }
}

module.exports = { run };
