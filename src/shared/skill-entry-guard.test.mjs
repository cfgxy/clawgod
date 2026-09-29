#!/usr/bin/env node
// Unit tests for src/shared/skill-entry-guard.cjs — the lite tokenizer, the
// dual-form hazard predicate and the idempotent template heal.
//
// Pure Node; no Bun and no Claude bundle required. The last block exercises
// REAL graph-install templates when ~/.clawgod/bunfs exists (always
// read-only: templates are copied to a temp sandbox before any heal) and is
// skipped silently elsewhere (e.g. CI runners).
//
// Run with: node src/shared/skill-entry-guard.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  stripForScan, scanSkillTemplateHazards, healSkillTemplates, appendGuardLog,
} = require('./skill-entry-guard.cjs');

const REAL_BUNFS = join(process.env.HOME || '', '.clawgod', 'bunfs');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ── sandbox helpers ─────────────────────────────────────────────
const sandboxes = [];
function mkBunfs(files) {
  const root = mkdtempSync(join(tmpdir(), 'seg-test-'));
  const bunfs = join(root, 'bunfs');
  mkdirSync(bunfs, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(bunfs, name), content);
  }
  sandboxes.push(root);
  return bunfs;
}
process.on('exit', () => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function depthAt(stripped, offset) {
  let depth = 0;
  for (let k = 0; k < offset; k++) {
    if (stripped[k] === '{') depth++;
    else if (stripped[k] === '}') depth--;
  }
  return depth;
}
function hitsFor(src) {
  return scanSkillTemplateHazards(mkBunfs({ 'probe-x1y2.mjs': src }));
}
function forms(hits) { return hits.map((h) => h.form); }

// ── tokenizer ───────────────────────────────────────────────────

test('stripForScan: output length always equals input length', () => {
  const samples = [
    '// c\nconst a = "}{";\n',
    'const s = `t ${`n ${1}`} e`;\n',
    '/* multi\nline { comment */\nconst r = /[{]/;\n#!x\n',
    "const e = \"a\\\"b}\"; const c = '\\'';\n",
  ];
  for (const s of samples) assert.equal(stripForScan(s).length, s.length);
});

test('stripForScan: braces in comments/strings/regex/template text stay inert', () => {
  const src = [
    '// comment { opens nothing',
    'const s = "string } brace";',
    'const t = `tpl { text`;',
    'const r = /re{2} [/]x/;',
    'main();',
  ].join('\n') + '\n';
  const stripped = stripForScan(src);
  const off = stripped.indexOf('main');
  assert.ok(off > 0);
  assert.equal(depthAt(stripped, off), 0);
});

test('stripForScan: ${...} interpolation braces DO count as code', () => {
  const src = 'const t = `a${ {x: 1} }b`;\nmain();\n';
  const stripped = stripForScan(src);
  assert.equal(depthAt(stripped, stripped.indexOf('main')), 0);
  // the object literal braces inside the interpolation are visible
  const ipen = stripped.indexOf('${');
  assert.ok(stripped.slice(ipen, stripped.indexOf('}b`')).includes('{x: 1}'));
});

// ── hazard scan shape 2: top-level bare execution body ─────────

test('scan: top-level process.argv hit', () => {
  const hits = hitsFor('const arg = process.argv[2];\n');
  assert.equal(hits.length, 1);
  assert.match(forms(hits)[0], /bare execution body/);
  assert.equal(hits[0].line, 1);
});

test('scan: top-level process.exit( hit', () => {
  const hits = hitsFor('if (!ok) process.exit(1);\n');
  assert.equal(hits.length, 1);
});

test('scan: argv/exit behind canonical guard is clean', () => {
  const src = 'if (import.meta.main) {\n  const arg = process.argv[2];\n  if (!arg) process.exit(2);\n}\n';
  assert.deepEqual(hitsFor(src), []);
});

test('scan: argv/exit inside a function body is clean', () => {
  assert.deepEqual(hitsFor('function readArg() {\n  return process.argv[2];\n}\n'), []);
  assert.deepEqual(hitsFor('function die() { process.exit(1); }\n'), []);
});

test('scan: one-liner method keeps argv function-scoped', () => {
  assert.deepEqual(hitsFor('const o = { fn() { return process.argv; } };\n'), []);
});

test('scan: argv inside comment/string/regex/template text is ignored', () => {
  const src = [
    '// see process.argv docs',
    'const s = "process.argv";',
    "const r = /process[.]exit[(]/;",
    'const t = `call process.exit(1) here`;',
    'const u = { note: "uses process.argv" };',
  ].join('\n') + '\n';
  assert.deepEqual(hitsFor(src), []);
});

// ── hazard scan shape 1: unguarded top-level entry call ────────

test('scan: trailing bare main() with local declaration is a hit', () => {
  const src = 'function main() {\n  return 1;\n}\n\nmain();\n';
  const hits = hitsFor(src);
  assert.equal(hits.length, 1);
  assert.match(forms(hits)[0], /unguarded top-level entry call/);
});

test('scan: async trailing entry is a hit', () => {
  const src = 'async function main() {}\n\nmain();\n';
  assert.equal(hitsFor(src).length, 1);
});

test('scan: guarded trailing entry is clean', () => {
  const src = 'function main() {\n  return 1;\n}\n\nif (import.meta.main) main();\n';
  assert.deepEqual(hitsFor(src), []);
});

test('scan: entry call inside a function body is clean', () => {
  const src = 'function main() {}\nfunction wrap() {\n  main();\n}\n';
  assert.deepEqual(hitsFor(src), []);
});

test('scan: trailing call of an undeclared name is clean', () => {
  assert.deepEqual(hitsFor('function other() {}\nfoo();\n'), []);
});

// ── heal: neutralize, back up, log, idempotency, unmatched ─────

const SCAFFOLD = [
  '#!/usr/bin/env node',
  'import { parseArgs } from "node:util";',
  'function main() {',
  '  console.log("scaffold-main");',
  '}',
  '',
  'main();',
  '',
].join('\n');

const LITE = [
  'function build(arg) {',
  '  return arg;',
  '}',
  'const arg = process.argv[2];',
  'if (!arg || arg === "-h") {',
  '  console.error("usage: node build-report-lite.mjs <flow-dir>");',
  '  process.exit(arg ? 0 : 2);',
  '}',
  'try {',
  '  build(arg);',
  '} catch (e) {',
  '  console.error(e && e.message);',
  '  process.exit(1);',
  '}',
  '',
].join('\n');

test('heal: scaffold shape wraps trailing main(), backs up, logs', () => {
  const bunfs = mkBunfs({ 'runner-scaffold-t0001.mjs': SCAFFOLD });
  const log = join(bunfs, '..', 'guard.log');
  const r = healSkillTemplates(bunfs, { logFile: log });
  assert.deepEqual(r.fixed, ['runner-scaffold-t0001.mjs']);
  const fp = join(bunfs, 'runner-scaffold-t0001.mjs');
  const healed = readFileSync(fp, 'utf8');
  assert.match(healed, /\nif \(import\.meta\.main\) main\(\);\n$/);
  assert.equal((healed.match(/import\.meta\.main/g) || []).length, 1);
  const backup = readFileSync(fp + '.clawgod-orig', 'utf8');
  assert.equal(backup, SCAFFOLD);
  assert.ok(readFileSync(log, 'utf8').includes(' action=guarded runner-scaffold-t0001.mjs'));
});

test('heal: lite shape wraps the top-level body from the anchor to EOF', () => {
  const bunfs = mkBunfs({ 'build-report-lite-t0002.mjs': LITE });
  const r = healSkillTemplates(bunfs, { logFile: '' });
  assert.deepEqual(r.fixed, ['build-report-lite-t0002.mjs']);
  const healed = readFileSync(join(bunfs, 'build-report-lite-t0002.mjs'), 'utf8');
  assert.ok(healed.startsWith('function build(arg) {'));
  assert.match(healed, /\{\nconst arg = process\.argv\[2\];/);
  assert.match(healed, /\n}\n$/);
  assert.equal((healed.match(/import\.meta\.main/g) || []).length, 1);
  // the healed file must remain syntactically valid ESM
  const chk = spawnSync(process.execPath, ['--check', join(bunfs, 'build-report-lite-t0002.mjs')]);
  assert.equal(chk.status, 0, `node --check failed: ${chk.stderr}`);
});

test('heal: guarded files no longer scan as hazards', () => {
  const bunfs = mkBunfs({ 'runner-scaffold-t0003.mjs': SCAFFOLD, 'build-report-lite-t0003.mjs': LITE });
  assert.ok(scanSkillTemplateHazards(bunfs).length >= 2);
  healSkillTemplates(bunfs, { logFile: '' });
  assert.deepEqual(scanSkillTemplateHazards(bunfs), []);
});

test('heal: idempotent — second run is a no-op with byte-stable files', () => {
  const bunfs = mkBunfs({ 'runner-scaffold-t0004.mjs': SCAFFOLD, 'build-report-lite-t0004.mjs': LITE });
  const log = join(bunfs, '..', 'guard2.log');
  const first = healSkillTemplates(bunfs, { logFile: log });
  assert.equal(first.fixed.length, 2);
  const before = Object.fromEntries(readdirSync(bunfs).map((f) =>
    [f, readFileSync(join(bunfs, f), 'utf8')]));
  const logLines = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;

  const second = healSkillTemplates(bunfs, { logFile: log });
  assert.deepEqual(second.fixed, []);
  assert.deepEqual(second.alreadyGuarded.sort(),
    ['build-report-lite-t0004.mjs', 'runner-scaffold-t0004.mjs']);
  assert.deepEqual(second.unmatched, []);
  for (const [f, c] of Object.entries(before)) {
    assert.equal(readFileSync(join(bunfs, f), 'utf8'), c, `file changed: ${f}`);
  }
  assert.equal(readFileSync(log, 'utf8').split('\n').filter(Boolean).length, logLines);
});

test('heal: unmatched shape is reported and left byte-identical', () => {
  const mutated = SCAFFOLD.replace(/\nmain\(\);\s*$/, '\n');
  const bunfs = mkBunfs({ 'runner-scaffold-t0005.mjs': mutated });
  const r = healSkillTemplates(bunfs, { logFile: '' });
  assert.equal(r.unmatched.length, 1);
  assert.match(r.unmatched[0].reason, /shape changed/);
  assert.equal(readFileSync(join(bunfs, 'runner-scaffold-t0005.mjs'), 'utf8'), mutated);
  assert.equal(existsSync(join(bunfs, 'runner-scaffold-t0005.mjs.clawgod-orig')), false);
});

test('heal: missing bunfs dir and non-template files are untouched', () => {
  assert.deepEqual(healSkillTemplates(join(mkdtempSync(join(tmpdir(), 'seg-test-x')), 'nope'), { logFile: '' }),
    { fixed: [], alreadyGuarded: [], unmatched: [], backups: [] });
  const bunfs = mkBunfs({ 'eval-tool-t0006.mjs': 'process.exit(9);\n' });
  const r = healSkillTemplates(bunfs, { logFile: '' });
  assert.deepEqual(r.fixed, []);
  assert.equal(readFileSync(join(bunfs, 'eval-tool-t0006.mjs'), 'utf8'), 'process.exit(9);\n');
});

test('appendGuardLog: writes a timestamped action line, never throws', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'seg-test-')), 'g.log');
  appendGuardLog(log, 'fatal', 'a.mjs:1');
  assert.match(readFileSync(log, 'utf8'), /^\d{4}-\d{2}-\d{2}T.* action=fatal a\.mjs:1\n$/);
  appendGuardLog('', 'noop', 'x'); // empty logFile is a no-op
});

// ── real graph-install templates (read-only copies; skip if absent) ──

if (existsSync(REAL_BUNFS)) {
  const scaffoldSrc = readdirSync(REAL_BUNFS).find((f) => f.startsWith('runner-scaffold-') && f.endsWith('.mjs'));
  const liteSrc = readdirSync(REAL_BUNFS).find((f) => f.startsWith('build-report-lite-') && f.endsWith('.mjs'));

  if (scaffoldSrc && liteSrc) {
    test('real templates: heal, then import-context require keeps the caller alive', async () => {
      const bunfs = mkBunfs({});
      cpSync(join(REAL_BUNFS, scaffoldSrc), join(bunfs, scaffoldSrc));
      cpSync(join(REAL_BUNFS, liteSrc), join(bunfs, liteSrc));
      const r = healSkillTemplates(bunfs, { logFile: '' });
      assert.deepEqual(r.fixed.sort(), [liteSrc, scaffoldSrc]);
      assert.deepEqual(scanSkillTemplateHazards(bunfs), []);

      // host-shaped in-process evaluation of BOTH healed templates; the
      // placeholder argv matches the field crash shape (never a real prompt)
      const driver = join(bunfs, '..', 'driver.mjs');
      writeFileSync(driver, [
        'const { pathToFileURL } = await import("node:url");',
        `await import(pathToFileURL(${JSON.stringify(join(bunfs, scaffoldSrc))}));`,
        `await import(pathToFileURL(${JSON.stringify(join(bunfs, liteSrc))}));`,
        'console.log("CALLER-SURVIVED");',
      ].join('\n'));
      const out = spawnSync(process.execPath, [driver, '-p', 'REDACTED-PROMPT-SAMPLE'], { encoding: 'utf8' });
      assert.equal(out.status, 0, `caller died: ${out.stderr}`);
      assert.match(out.stdout, /CALLER-SURVIVED/);
    });

    test('real templates: node direct-run semantics survive the guard', () => {
      const bunfs = mkBunfs({});
      cpSync(join(REAL_BUNFS, scaffoldSrc), join(bunfs, scaffoldSrc));
      cpSync(join(REAL_BUNFS, liteSrc), join(bunfs, liteSrc));
      healSkillTemplates(bunfs, { logFile: '' });
      const scaffold = join(bunfs, scaffoldSrc);
      const lite = join(bunfs, liteSrc);

      let out = spawnSync(process.execPath, [scaffold, '-h'], { encoding: 'utf8' });
      assert.equal(out.status, 0, `scaffold -h exited ${out.status}`);
      assert.match(out.stdout + out.stderr, /usage/i);

      out = spawnSync(process.execPath, [lite, '-h'], { encoding: 'utf8' });
      assert.equal(out.status, 0, `lite -h exited ${out.status}`);
      assert.match(out.stderr, /usage/);

      out = spawnSync(process.execPath, [lite], { encoding: 'utf8' });
      assert.equal(out.status, 2, `lite no-arg exited ${out.status}`);
      assert.match(out.stderr, /usage/);
    });
  }
}

// ── runner ──────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error(`       ${error.message.split('\n').join('\n       ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
