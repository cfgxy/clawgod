'use strict';
// Runtime helpers shared by injected patches, exposed on
// globalThis.__clawgodHelpers. The patched cli.original.cjs lives in its own
// module scope, so it reaches these helpers only through globalThis.
//
// cli.cjs requires this module once at launch; after that, adding a new
// helper means editing this single file — no build.js / cli.cjs / template
// changes. (feature-gates.cjs is a future merge target here.)
//
// Helpers return values only: injected code owns gating, env reads, timers,
// and mutation of the renderer's state.

// Parses a CLAWGOD_CLASSIFIER_TIMEOUT_MS value to a finite number, or null
// when it cannot be parsed (missing/blank/non-numeric/Infinity/overflow). The
// caller decides the fallback: the injected patch code checks for null
// explicitly and keeps the original formula, while any real number — a
// legitimate "0" included — is applied as a floor. Returning null (not 0)
// keeps "0" as a real override and never conflates it with a parse failure.
function classifierTimeoutFloor(envValue) {
  if (typeof envValue === 'string' && envValue.trim() === '') return null;
  const value = Number(envValue);
  return Number.isFinite(value) ? value : null;
}

// A DA1 reply can arrive in multiple stdin reads (issue #171). The renderer
// normally flushes incomplete escapes after 50ms, which turns a split ESC [
// into a key and lets the reply's suffix reach the text input. While a DA1
// sentinel is outstanding, allow the same 2s inter-read budget upstream uses
// for recognized control-sequence prefixes. This also covers 2.1.263, whose
// longer-prefix handling predates that upstream fix.
//
// Do not filter input: ordinary keys, paste, and complete sequences still go
// through the existing parser immediately. A lone Escape or Alt+[ during a
// pending probe is delayed, then passed to the original parser on timeout.
// With no outstanding probe, even those keys retain their usual timing.
function terminalReplyDelay(querier, reader, now) {
  const parse = reader?.parse;
  if (parse?.mode !== 'NORMAL' || typeof parse.incomplete !== 'string') return 0;
  if (!/^\x1b(?:\[(?:\?[\d;]*)?)?$/.test(parse.incomplete)) return 0;
  // 2.1.263 writes queue entries immediately. 2.1.274 adds `written`, and
  // may queue probes before stdin attaches; those cannot have replies yet.
  if (!Array.isArray(querier?.queue) || !querier.queue.some((entry) =>
    entry?.kind === 'barrier' || (entry?.kind === 'sentinel' && entry.written !== false))) return 0;
  if (!Number.isFinite(now) || !Number.isFinite(reader.lastInputAt)) return 0;
  return Math.max(0, 2000 - Math.max(0, now - reader.lastInputAt));
}

const COMPACT_WRAPPER_OPEN = /^<clawgod-compact-request\b[^>]*\bversion=["']2["'][^>]*>$/iu;
const COMPACT_WRAPPER_CLOSE = /^<\/clawgod-compact-request>$/iu;
const COMPACT_LEGACY_OPEN = /^CRITICAL: Respond with TEXT ONLY\. Do NOT call any tools\.$/u;
const COMPACT_LEGACY_REMINDER = /^REMINDER: Do NOT call any tools\b/u;
const COMPACT_LEGACY_MARKERS = [
  /Do NOT use (?:Read|Bash|Grep|Glob|Edit|Write)/iu,
  /Tool calls will be REJECTED/iu,
  /Your entire response must be plain text/iu,
  /Respond with TEXT ONLY/iu,
];
const COMPACT_PROVENANCE_SOURCES = new Set([
  'compact-summary-full-v2',
  'compact-summary-partial-v2',
  'compact-summary-reactive-v2',
  'compact-summary-resume-v2',
]);

function stripQuotedListPrefix(line) {
  let value = line.trim();
  for (;;) {
    const next = value.replace(/^(?:>\s*|[-*+]\s+|\d+[.)]\s+)/u, '');
    if (next === value) return value;
    value = next.trim();
  }
}

function sanitizeCompactSummaryV1(text, provenance) {
  const result = {
    version: 1,
    text: typeof text === 'string' ? text : text,
    disposition: 'unchanged',
    reasons: [],
  };
  if (typeof text !== 'string') {
    result.reasons.push('non-string-content');
    return result;
  }
  if (provenance?.kind !== 'auto-continuation' ||
      ![1, 2].includes(provenance.version) ||
      !COMPACT_PROVENANCE_SOURCES.has(provenance.source)) {
    result.reasons.push('untrusted-provenance');
    return result;
  }

  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const removeRanges = [];
  let ambiguous = false;
  for (let index = 0; index < lines.length; index++) {
    const normalized = stripQuotedListPrefix(lines[index]);
    if (COMPACT_WRAPPER_OPEN.test(normalized)) {
      let end = -1;
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        if (COMPACT_WRAPPER_CLOSE.test(stripQuotedListPrefix(lines[cursor]))) {
          end = cursor;
          break;
        }
      }
      if (end < 0) {
        ambiguous = true;
        continue;
      }
      removeRanges.push([index, end]);
      index = end;
      continue;
    }
    if (!COMPACT_LEGACY_OPEN.test(normalized)) continue;
    let end = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      if (COMPACT_LEGACY_REMINDER.test(stripQuotedListPrefix(lines[cursor]))) {
        end = cursor;
        break;
      }
    }
    if (end < 0) {
      if (COMPACT_LEGACY_MARKERS.some((marker) => marker.test(lines.slice(index).join('\n')))) {
        ambiguous = true;
      }
      continue;
    }
    removeRanges.push([index, end]);
    index = end;
  }

  if (ambiguous) {
    result.disposition = 'quarantine';
    result.reasons.push('incomplete-or-ambiguous-internal-stanza');
    return result;
  }
  if (removeRanges.length === 0) {
    if (COMPACT_LEGACY_MARKERS.some((marker) => marker.test(text))) {
      result.disposition = 'quarantine';
      result.reasons.push('semantic-internal-instruction-without-boundary');
    } else {
      result.reasons.push('no-internal-stanza');
    }
    return result;
  }

  const removed = new Set();
  for (const [start, end] of removeRanges) {
    for (let index = start; index <= end; index++) removed.add(index);
  }
  result.text = lines.filter((_, index) => !removed.has(index)).join('\n')
    .replace(/\n{3,}/gu, '\n\n').trim();
  result.disposition = 'sanitized';
  result.reasons.push('removed-versioned-or-complete-legacy-stanza');
  return result;
}

// The runtime container (globalThis.__clawgodHelpers) IS the module's own
// exports, so a new helper only needs an export line here to be reachable
// from the patched bundle — no separate registration object. We expose
// module.exports, not module (the latter carries id/filename/paths metadata).
module.exports.classifierTimeoutFloor = classifierTimeoutFloor;
module.exports.terminalReplyDelay = terminalReplyDelay;
module.exports.sanitizeCompactSummaryV1 = sanitizeCompactSummaryV1;
globalThis.__clawgodHelpers = module.exports;
