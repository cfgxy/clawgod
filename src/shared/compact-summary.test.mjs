import assert from 'node:assert/strict';
import { sanitizeCompactSummaryV1 } from './runtime-helpers.cjs';

const trusted = { kind: 'auto-continuation', version: 2, source: 'compact-summary-full-v2' };

const legacyPrompt = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by an <summary> block.

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by an <summary> block. Tool calls will be rejected and you will fail the task.`;

const wrapper = `<clawgod-compact-request version="2" tool-policy="deny">
${legacyPrompt}
</clawgod-compact-request>`;

const clean = sanitizeCompactSummaryV1(`Before\n\n${wrapper}\n\nAfter`, trusted);
assert.equal(clean.version, 1);
assert.equal(clean.disposition, 'sanitized');
assert.equal(clean.text, 'Before\n\nAfter');
assert.ok(clean.reasons.includes('removed-versioned-or-complete-legacy-stanza'));

const quoted = sanitizeCompactSummaryV1(`Before\n> <clawgod-compact-request version="2" tool-policy="deny">\n> internal\n> </clawgod-compact-request>\nAfter`, trusted);
assert.equal(quoted.disposition, 'sanitized');
assert.equal(quoted.text, 'Before\nAfter');

const plusListed = sanitizeCompactSummaryV1(`Before\n+ <clawgod-compact-request version="2" tool-policy="deny">\n+ internal\n+ </clawgod-compact-request>\nAfter`, trusted);
assert.equal(plusListed.disposition, 'sanitized');

const userSameText = sanitizeCompactSummaryV1(
  'The user explicitly wrote: CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
  trusted,
);
assert.equal(userSameText.disposition, 'quarantine');
assert.match(userSameText.text, /CRITICAL: Respond with TEXT ONLY/);

const paraphrase = sanitizeCompactSummaryV1(
  'The latest user request says tool calls will be rejected and no tools should be used.',
  { ...trusted, source: 'compact-summary-resume-v2' },
);
assert.equal(paraphrase.disposition, 'quarantine');
assert.match(paraphrase.text, /tool calls will be rejected/);

const incomplete = sanitizeCompactSummaryV1(
  '<clawgod-compact-request version="2" tool-policy="deny">\ninternal',
  trusted,
);
assert.equal(incomplete.disposition, 'quarantine');
assert.equal(incomplete.text.includes('internal'), true);

const untrusted = sanitizeCompactSummaryV1(legacyPrompt, { kind: 'human', source: 'compact-summary-full-v2' });
assert.equal(untrusted.disposition, 'unchanged');
assert.match(untrusted.text, /CRITICAL: Respond with TEXT ONLY/);

const wrongVersion = sanitizeCompactSummaryV1(wrapper, { ...trusted, version: 3 });
assert.equal(wrongVersion.disposition, 'unchanged');
assert.match(wrongVersion.text, /clawgod-compact-request/);

console.log('[compact-summary.test] provenance, exact-boundary sanitization, false-positive safety, and quarantine passed');
