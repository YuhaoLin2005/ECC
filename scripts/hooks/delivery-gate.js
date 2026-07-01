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