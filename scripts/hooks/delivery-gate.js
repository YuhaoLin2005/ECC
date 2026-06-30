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
 * Exit codes: 0 = pass/fail-open, 2 = block (disk critical only)
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
const COMPLEX_THRESHOLD = 3; // Edit/Write calls to classify as complex
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
  ].join('\n');
}

function msgDiskWarn(gb) {
  return [
    `Disk low: ${gb.toFixed(1)}GB free (warn threshold: ${DISK_WARN_GB}GB)`,
    `Consider cleaning up temporary files and old downloads soon.`,
    `Current session can continue, but risk increases below ${DISK_CRIT_GB}GB.`,
  ].join('\n');
}

function msgFirstTime() {
  return [
    `Welcome! No learning libraries found — normal for new setups.`,
    `Create memory/growth-log/ in your .claude directory. See /growth-log.`,
  ].join('\n');
}

function msgStaleWarn(stalePaths) {
  const s = stalePaths.length === 1 ? 'y' : 'ies';
  return [
    `Reminder: ${stalePaths.length} learning librar${s} not updated today.`,
    `Stale: ${stalePaths.join(', ')}`,
    `Use /growth-log to capture what you learned.`,
  ].join('\n');
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
 * Hook entry point. Matches run-with-flags.js contract exactly.
 *
 * @param {string} raw     — raw stdin JSON (transcript data)
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

  // Parse stdin JSON for transcript edit count
  let input = {};
  try {
    if (typeof raw === 'string' && raw.trim()) {
      input = JSON.parse(raw);
    }
  } catch {
    // Malformed JSON → fail-open, don't block
  }

  const homedir = os.homedir();
  const now = Date.now();
  const lines = [];

  // 1. Disk check (fail-open: null → skip)
  const freeGB = getDiskFreeGB();
  if (freeGB !== null) {
    if (freeGB < DISK_CRIT_GB) {
      lines.push(msgDiskBlock(freeGB));
    } else if (freeGB < DISK_WARN_GB) {
      lines.push(msgDiskWarn(freeGB));
    }
  }

  // 2. First-time user check
  const memoryDir = path.join(homedir, 'memory');
  if (!fs.existsSync(memoryDir)) {
    lines.push(msgFirstTime());
    const stderr = lines.map(l => `[delivery-gate] ${l}\n`).join('');
    return { exitCode: 0, stderr };
  }

  // 3. Library freshness
  const libResults = checkLibFreshness(homedir, now);
  const stalePaths = libResults.filter(r => r.stale).map(r => r.path);

  // 4. Complexity check
  const editCount = countEdits(input);
  const isComplex = editCount >= COMPLEX_THRESHOLD;

  // 5. Warn on stale (complex sessions) or remind (simple sessions)
  if (stalePaths.length > 0) {
    if (isComplex) {
      lines.push(msgStaleWarn(stalePaths));
    } else {
      // Simple session — just a quick growth-log reminder if it's the stalest
      const growthLog = libResults.find(r => r.path === 'memory/growth-log');
      if (growthLog && growthLog.stale) {
        lines.push(`Quick reminder: growth-log hasn't been updated in ${growthLog.hoursAgo.toFixed(0)}h.`);
      }
    }
  }

  // 6. Output
  if (lines.length === 0) return { exitCode: 0 };

  const stderr = lines.map(l => `[delivery-gate] ${l}\n`).join('');

  // Only block on disk critical (not on stale libraries — that's advisory)
  const blocked = lines.some(l => l.startsWith('DISK CRITICAL'));
  return { exitCode: blocked ? 2 : 0, stderr };
}

module.exports = { run };
