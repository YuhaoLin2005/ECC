/**
 * Tests for scripts/hooks/delivery-gate.js
 *
 * Run with: node tests/hooks/delivery-gate.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  run,
  checkStaleLibraries,
  countEditToolUses,
  countEdits,
  msgDiskBlock,
  msgDiskRemind,
  msgDiskWarn,
  msgFirstTime,
  msgStaleBlock,
  msgStaleWarn,
} = require('../../scripts/hooks/delivery-gate');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;

// ── countEditToolUses: flat tool_use format ────────────────────

console.log('\ncountEditToolUses: flat tool_use format');
console.log('======================================\n');

if (test('counts Write tool_use in flat format', () => {
  const entry = { type: 'tool_use', name: 'Write', tool_input: { file_path: '/x.ts' } };
  assert.strictEqual(countEditToolUses(entry), 1);
})) passed++; else failed++;

if (test('counts Edit tool_use in flat format', () => {
  const entry = { type: 'tool_use', name: 'Edit', tool_input: { file_path: '/x.ts' } };
  assert.strictEqual(countEditToolUses(entry), 1);
})) passed++; else failed++;

if (test('counts MultiEdit tool_use in flat format', () => {
  const entry = { type: 'tool_use', name: 'MultiEdit', tool_input: { edits: [] } };
  assert.strictEqual(countEditToolUses(entry), 1);
})) passed++; else failed++;

if (test('ignores non-edit tools (Read, Grep, Bash)', () => {
  assert.strictEqual(countEditToolUses({ type: 'tool_use', name: 'Read' }), 0);
  assert.strictEqual(countEditToolUses({ type: 'tool_use', name: 'Grep' }), 0);
  assert.strictEqual(countEditToolUses({ type: 'tool_use', name: 'Bash' }), 0);
})) passed++; else failed++;

if (test('uses tool_name field as alternative to name', () => {
  const entry = { type: 'tool_use', tool_name: 'Write' };
  assert.strictEqual(countEditToolUses(entry), 1);
})) passed++; else failed++;

// ── countEditToolUses: Claude Code JSONL format ────────────────

console.log('\ncountEditToolUses: Claude Code JSONL format');
console.log('============================================\n');

if (test('counts Write/Edit in assistant message content blocks', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', name: 'Write', input: { file_path: '/x.ts' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/y.ts' } },
      ]
    }
  };
  assert.strictEqual(countEditToolUses(entry), 2);
})) passed++; else failed++;

if (test('counts MultiEdit in assistant message content blocks', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'MultiEdit', input: { edits: [] } },
      ]
    }
  };
  assert.strictEqual(countEditToolUses(entry), 1);
})) passed++; else failed++;

if (test('ignores non-edit tools in assistant content blocks', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/x.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: 'some text' },
      ]
    }
  };
  assert.strictEqual(countEditToolUses(entry), 0);
})) passed++; else failed++;

// ── countEditToolUses: edge cases ──────────────────────────────

console.log('\ncountEditToolUses: edge cases');
console.log('=============================\n');

if (test('returns 0 for null/undefined', () => {
  assert.strictEqual(countEditToolUses(null), 0);
  assert.strictEqual(countEditToolUses(undefined), 0);
})) passed++; else failed++;

if (test('returns 0 for empty object', () => {
  assert.strictEqual(countEditToolUses({}), 0);
})) passed++; else failed++;

if (test('returns 0 for primitive values (string, number)', () => {
  assert.strictEqual(countEditToolUses('hello'), 0);
  assert.strictEqual(countEditToolUses(42), 0);
  assert.strictEqual(countEditToolUses(true), 0);
})) passed++; else failed++;

if (test('recursively scans arrays of entries', () => {
  const entries = [
    { type: 'tool_use', name: 'Write' },
    { type: 'tool_use', name: 'Read' },
    { type: 'tool_use', name: 'Edit' },
  ];
  assert.strictEqual(countEditToolUses(entries), 2);
})) passed++; else failed++;

if (test('respects depth limit (depth > 10 returns 0)', () => {
  let deep = { type: 'tool_use', name: 'Write' };
  for (let i = 0; i < 12; i++) {
    deep = { nested: deep };
  }
  assert.strictEqual(countEditToolUses(deep), 0);
})) passed++; else failed++;

// ── countEdits: transcript file parsing ────────────────────────

console.log('\ncountEdits: transcript file parsing');
console.log('====================================\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-gate-test-'));

function writeTranscript(filename, lines) {
  const f = path.join(tmpDir, filename);
  fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8');
  return f;
}

if (test('returns 0 when transcript_path is missing', () => {
  assert.strictEqual(countEdits({}), 0);
  assert.strictEqual(countEdits({ transcript_path: null }), 0);
  assert.strictEqual(countEdits({ transcript_path: undefined }), 0);
})) passed++; else failed++;

if (test('returns 0 when transcript_path points to nonexistent file', () => {
  assert.strictEqual(countEdits({ transcript_path: '/nonexistent/path/transcript.jsonl' }), 0);
})) passed++; else failed++;

if (test('counts Write/Edit/MultiEdit in JSONL transcript', () => {
  const f = writeTranscript('mixed.jsonl', [
    JSON.stringify({ type: 'tool_use', name: 'Write', tool_input: { file_path: '/a.ts' } }),
    JSON.stringify({ type: 'tool_use', name: 'Read', tool_input: { file_path: '/b.ts' } }),
    JSON.stringify({ type: 'tool_use', name: 'Edit', tool_input: { file_path: '/c.ts' } }),
    JSON.stringify({ type: 'tool_use', name: 'MultiEdit', tool_input: { edits: [{ file_path: '/d.ts' }] } }),
  ]);
  assert.strictEqual(countEdits({ transcript_path: f }), 3);
})) passed++; else failed++;

if (test('returns 0 for transcript with only non-edit tools', () => {
  const f = writeTranscript('no-edits.jsonl', [
    JSON.stringify({ type: 'tool_use', name: 'Read' }),
    JSON.stringify({ type: 'tool_use', name: 'Grep' }),
    JSON.stringify({ type: 'tool_use', name: 'Bash' }),
  ]);
  assert.strictEqual(countEdits({ transcript_path: f }), 0);
})) passed++; else failed++;

if (test('skips blank lines and invalid JSON gracefully', () => {
  const f = writeTranscript('messy.jsonl', [
    '',
    'not valid json at all',
    JSON.stringify({ type: 'tool_use', name: 'Write' }),
    '',
    JSON.stringify({ type: 'tool_use', name: 'Edit' }),
  ]);
  assert.strictEqual(countEdits({ transcript_path: f }), 2);
})) passed++; else failed++;

if (test('counts edits in assistant JSONL format (nested content blocks)', () => {
  const f = writeTranscript('assistant.jsonl', [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: '/x.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/y.ts' } },
        ]
      }
    }),
  ]);
  assert.strictEqual(countEdits({ transcript_path: f }), 2);
})) passed++; else failed++;

if (test('handles mixed assistant and flat entries in same transcript', () => {
  const f = writeTranscript('mixed-format.jsonl', [
    JSON.stringify({ type: 'tool_use', name: 'Write' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] }
    }),
  ]);
  assert.strictEqual(countEdits({ transcript_path: f }), 2);
})) passed++; else failed++;

// ── checkStaleLibraries: block/warn logic ──────────────────────

console.log('\ncheckStaleLibraries: block/warn logic');
console.log('=====================================\n');

function makeLibResult(libPath, stale, hoursAgo) {
  return { path: libPath, mtime: Date.now() - hoursAgo * 3600000, hoursAgo, stale };
}

const allFresh = [
  makeLibResult('.claude/memory/growth-log', false, 1),
  makeLibResult('.claude/memory/decisions/log.md', false, 2),
  makeLibResult('.claude/memory/output-index.md', false, 3),
  makeLibResult('.claude/memory/ratings-tracker.md', false, 4),
  makeLibResult('.claude/memory/tooling_capabilities.md', false, 5),
];

const allStale = [
  makeLibResult('.claude/memory/growth-log', true, 30),
  makeLibResult('.claude/memory/decisions/log.md', true, 30),
  makeLibResult('.claude/memory/output-index.md', true, 30),
  makeLibResult('.claude/memory/ratings-tracker.md', true, 30),
  makeLibResult('.claude/memory/tooling_capabilities.md', true, 30),
];

if (test('all fresh → no block, no lines', () => {
  const result = checkStaleLibraries(allFresh, 5);
  assert.strictEqual(result.blocked, false);
  assert.deepStrictEqual(result.lines, []);
})) passed++; else failed++;

if (test('complex + strict (default) + all 5 stale → BLOCK', () => {
  const result = checkStaleLibraries(allStale, 5);
  assert.strictEqual(result.blocked, true);
  assert.ok(result.lines[0].includes('BLOCKED'));
  assert.ok(result.lines[0].includes('5 edits'));
})) passed++; else failed++;

if (test('complex + growth-log stale alone → BLOCK (strict growth-log rule)', () => {
  const staleGrowthOnly = [
    makeLibResult('.claude/memory/growth-log', true, 30),
    makeLibResult('.claude/memory/decisions/log.md', false, 1),
    makeLibResult('.claude/memory/output-index.md', false, 1),
    makeLibResult('.claude/memory/ratings-tracker.md', false, 1),
    makeLibResult('.claude/memory/tooling_capabilities.md', false, 1),
  ];
  const result = checkStaleLibraries(staleGrowthOnly, 5);
  assert.strictEqual(result.blocked, true);
  assert.ok(result.lines[0].includes('BLOCKED'));
})) passed++; else failed++;

if (test('complex + exactly 3 stale (threshold) + growth-log fresh → BLOCK', () => {
  const threeStale = [
    makeLibResult('.claude/memory/growth-log', false, 1),
    makeLibResult('.claude/memory/decisions/log.md', false, 1),
    makeLibResult('.claude/memory/output-index.md', true, 30),
    makeLibResult('.claude/memory/ratings-tracker.md', true, 30),
    makeLibResult('.claude/memory/tooling_capabilities.md', true, 30),
  ];
  const result = checkStaleLibraries(threeStale, 5);
  assert.strictEqual(result.blocked, true);
})) passed++; else failed++;

if (test('complex + only 2 stale + growth-log fresh → no block (below threshold)', () => {
  const twoStale = [
    makeLibResult('.claude/memory/growth-log', false, 1),
    makeLibResult('.claude/memory/decisions/log.md', false, 1),
    makeLibResult('.claude/memory/output-index.md', false, 1),
    makeLibResult('.claude/memory/ratings-tracker.md', true, 30),
    makeLibResult('.claude/memory/tooling_capabilities.md', true, 30),
  ];
  const result = checkStaleLibraries(twoStale, 5);
  assert.strictEqual(result.blocked, false);
  assert.strictEqual(result.lines.length, 0);
})) passed++; else failed++;

if (test('simple session (<3 edits) → quick reminder for stale growth-log', () => {
  const result = checkStaleLibraries(allStale, 2);
  assert.strictEqual(result.blocked, false);
  assert.ok(result.lines[0].includes('Quick reminder'));
  assert.ok(result.lines[0].includes('growth-log'));
})) passed++; else failed++;

if (test('simple session + growth-log fresh → no output (even with other stale)', () => {
  const growthFresh = [
    makeLibResult('.claude/memory/growth-log', false, 1),
    makeLibResult('.claude/memory/decisions/log.md', true, 30),
    makeLibResult('.claude/memory/output-index.md', true, 30),
    makeLibResult('.claude/memory/ratings-tracker.md', true, 30),
    makeLibResult('.claude/memory/tooling_capabilities.md', true, 30),
  ];
  const result = checkStaleLibraries(growthFresh, 2);
  assert.strictEqual(result.blocked, false);
  assert.strictEqual(result.lines.length, 0);
})) passed++; else failed++;

// ── Message builders ───────────────────────────────────────────

console.log('\nMessage builders: format verification');
console.log('======================================\n');

if (test('msgDiskBlock includes free GB and threshold GB', () => {
  const msg = msgDiskBlock(10.5);
  assert.ok(msg.includes('10.5GB'));
  assert.ok(msg.includes('15GB'), 'should mention DISK_CRIT_GB threshold');
  assert.ok(msg.includes('DISK CRITICAL'));
})) passed++; else failed++;

if (test('msgDiskWarn includes free GB and warn threshold', () => {
  const msg = msgDiskWarn(20);
  assert.ok(msg.includes('20.0GB'));
  assert.ok(msg.includes('30GB'), 'should mention DISK_WARN_GB threshold');
  assert.ok(msg.includes('Disk low'));
})) passed++; else failed++;

if (test('msgDiskRemind includes free GB and remind threshold', () => {
  const msg = msgDiskRemind(35);
  assert.ok(msg.includes('35.0GB'));
  assert.ok(msg.includes('50GB'), 'should mention DISK_REMIND_GB threshold');
  assert.ok(msg.includes('Reminder'));
})) passed++; else failed++;

if (test('msgFirstTime is first-time-user guidance', () => {
  const msg = msgFirstTime();
  assert.ok(msg.includes('Welcome'));
  assert.ok(msg.includes('learning libraries'));
  assert.ok(msg.includes('growth-log'));
})) passed++; else failed++;

if (test('msgStaleBlock includes edit count and stale paths', () => {
  const stalePaths = ['.claude/memory/growth-log', '.claude/memory/decisions/log.md'];
  const msg = msgStaleBlock(stalePaths, 5);
  assert.ok(msg.includes('BLOCKED'));
  assert.ok(msg.includes('5 edits'));
  assert.ok(msg.includes('2 learning libraries'));
  assert.ok(msg.includes('growth-log'));
  assert.ok(msg.includes('decisions/log.md'));
})) passed++; else failed++;

if (test('msgStaleBlock uses singular "library" for 1 stale path', () => {
  const msg = msgStaleBlock(['.claude/memory/growth-log'], 3);
  assert.ok(msg.includes('1 learning library'));
  assert.ok(!msg.includes('libraries'));
})) passed++; else failed++;

if (test('msgStaleWarn includes stale paths and growth-log hint', () => {
  const msg = msgStaleWarn(['.claude/memory/output-index.md']);
  assert.ok(msg.includes('Reminder'));
  assert.ok(msg.includes('Stale'));
  assert.ok(msg.includes('output-index.md'));
  assert.ok(msg.includes('growth-log'));
})) passed++; else failed++;

// ── run() contract: stdin/error handling ───────────────────────

console.log('\nrun() contract: stdin parsing and fail-open');
console.log('============================================\n');

if (test('returns exitCode 0 + stderr warning when stdin is truncated', () => {
  const result = run('{}', { truncated: true });
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stderr.includes('truncated'));
  assert.ok(result.stderr.includes('fail-open'));
})) passed++; else failed++;

if (test('returns exitCode 0 + stderr warning when stdin is invalid JSON', () => {
  const result = run('not valid json at all!!!', {});
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.stderr.includes('Could not parse'));
  assert.ok(result.stderr.includes('fail-open'));
})) passed++; else failed++;

if (test('handles empty string without throwing', () => {
  const result = run('', {});
  assert.strictEqual(result.exitCode, 0);
  // May or may not have stderr depending on disk state — either is valid
})) passed++; else failed++;

if (test('handles whitespace-only input without throwing', () => {
  const result = run('   \n  ', {});
  assert.strictEqual(result.exitCode, 0);
})) passed++; else failed++;

if (test('handles null/undefined raw without throwing', () => {
  assert.strictEqual(run(null, {}).exitCode, 0);
  assert.strictEqual(run(undefined, {}).exitCode, 0);
})) passed++; else failed++;

if (test('result always has numeric exitCode and optional stderr', () => {
  const r1 = run('{}', {});
  assert.strictEqual(typeof r1.exitCode, 'number');
  assert.ok(r1.exitCode === 0 || r1.exitCode === 2);
  // stderr may be undefined if no issues found — that's valid
})) passed++; else failed++;

// ── Cleanup ────────────────────────────────────────────────────

if (tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n=== Test Results ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

process.exit(failed > 0 ? 1 : 0);
