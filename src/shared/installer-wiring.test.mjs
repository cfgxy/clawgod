#!/usr/bin/env node
// Wiring regression tests for the installer channel.
//
// Pins the four installer-facing defects fixed alongside the skill-template
// entry guard:
//   1. skill-entry-guard.cjs must be written to $CLAWGOD_DIR BEFORE
//      post-process.mjs executes (post-process imports it at module top).
//      Regressed once: fresh installs died with ERR_MODULE_NOT_FOUND while
//      the swallowed error left a dead installation behind.
//   2. install.sh error paths call err(); it must be defined before first
//      use (regressed once: "command not found" masked the real failure).
//   3. install.sh post-install sanity verify must be fail-closed: a non-zero
//      probe status or empty output must abort the install, never
//      `|| true`-swallow into a false pass.
//   4. feature-gates.cjs must survive a missing woven CLAWGOD_FEATURES_META
//      (legacy or hand-assembled layouts): warn + default gates ON, never a
//      bare ReferenceError that kills the CLI at startup.
//
// Structural checks run against BOTH src/templates/install.{sh,ps1} and the
// committed generated install.{sh,ps1} — a stale build artifact fails here
// before it can ship.
//
// Run with: node src/shared/installer-wiring.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = join(fileURLToPath(import.meta.url), '..');
const root = join(here, '..', '..');

const files = {
  shTemplate: readFileSync(join(root, 'src', 'templates', 'install.sh'), 'utf8'),
  shGenerated: readFileSync(join(root, 'install.sh'), 'utf8'),
  ps1Template: readFileSync(join(root, 'src', 'templates', 'install.ps1'), 'utf8'),
  ps1Generated: readFileSync(join(root, 'install.ps1'), 'utf8'),
};

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function lineOf(text, needle) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return -1;
}

// ── 1. err() defined before first use (install.sh) ──────────────

for (const label of ['template', 'generated']) {
  test(`install.sh (${label}): err() defined before first use`, () => {
    const text = label === 'template' ? files.shTemplate : files.shGenerated;
    const defLine = lineOf(text, 'err()');
    assert.notEqual(defLine, -1, 'err() is never defined');
    const firstCall = lineOf(text, 'err "');
    assert.notEqual(firstCall, -1, 'err() has no call sites');
    assert.ok(defLine < firstCall, `err() defined at line ${defLine}, first call at line ${firstCall}`);
  });
}

// ── 2. guard written before post-process runs ───────────────────

for (const label of ['template', 'generated']) {
  test(`install.sh (${label}): skill-entry-guard written before post-process runs`, () => {
    const text = label === 'template' ? files.shTemplate : files.shGenerated;
    const guardWrite = lineOf(text, 'cat > "$CLAWGOD_DIR/skill-entry-guard.cjs"');
    const postProcRun = lineOf(text, 'node "$CLAWGOD_DIR/post-process.mjs"');
    assert.notEqual(guardWrite, -1, 'guard write block missing');
    assert.notEqual(postProcRun, -1, 'post-process invocation missing');
    assert.ok(guardWrite < postProcRun, `guard written at line ${guardWrite}, post-process runs at line ${postProcRun}`);
  });

  test(`install.ps1 (${label}): skill-entry-guard written before post-process runs`, () => {
    const text = label === 'template' ? files.ps1Template : files.ps1Generated;
    const guardWrite = lineOf(text, 'Set-Content (Join-Path $ClawDir "skill-entry-guard.cjs")');
    const postProcRun = lineOf(text, '& node $postProc');
    assert.notEqual(guardWrite, -1, 'guard write block missing');
    assert.notEqual(postProcRun, -1, 'post-process invocation missing');
    assert.ok(guardWrite < postProcRun, `guard written at line ${guardWrite}, post-process runs at line ${postProcRun}`);
  });
}

// ── 3. sanity verify is fail-closed (install.sh) ────────────────

for (const label of ['template', 'generated']) {
  test(`install.sh (${label}): sanity verify aborts on probe failure`, () => {
    const text = label === 'template' ? files.shTemplate : files.shGenerated;
    assert.ok(
      !/--version 2>&1 \|\| true/.test(text),
      'sanity probe still swallows failure with `|| true`',
    );
    const statusCapture = lineOf(text, 'sanity_status=$?');
    const statusCheck = lineOf(text, '"$sanity_status" -ne 0');
    const verifyStart = lineOf(text, 'Verifying Bun can load patched cli.original.cjs');
    assert.notEqual(statusCapture, -1, 'sanity exit status never captured');
    assert.notEqual(statusCheck, -1, 'sanity exit status never checked against non-zero');
    assert.ok(verifyStart !== -1 && statusCapture > verifyStart && statusCheck > statusCapture,
      'fail-closed status check must sit inside the verify block');
    // The verify block must be able to abort the installer.
    const afterCheck = text.split('\n').slice(statusCheck).join('\n');
    const abort = afterCheck.slice(0, afterCheck.indexOf('fi\ninfo "Bun loads cli.original.cjs"'));
    assert.ok(/exit 1/.test(abort), 'verify failure path never exits non-zero');
  });
}

// ── 4. feature-gates survives a missing woven META ──────────────

const GATES_SRC = readFileSync(join(root, 'src', 'shared', 'feature-gates.cjs'), 'utf8');

// Runs feature-gates.cjs in an isolated VM context. `metaConst` simulates the
// build-time weave (null = legacy layout where the constant is absent);
// `patchesJson` feeds the fake ~/.clawgod/patches.json; `env` seeds
// CLAWGOD_FEATURE_* overrides.
function runGates({ metaConst = null, patchesJson = null, env = {} } = {}) {
  const stderr = [];
  const warnings = [];
  const sandbox = {
    require(name) {
      if (name === 'path') return { join: (...p) => p.join('/') };
      if (name === 'os') return { homedir: () => '/fake-home' };
      if (name === 'fs') {
        return {
          readFileSync(p) {
            if (String(p).endsWith('patches.json')) {
              if (patchesJson === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
              return patchesJson;
            }
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          },
        };
      }
      throw new Error(`unexpected require(${name})`);
    },
    process: {
      env,
      stderr: {
        write(s) {
          const text = String(s);
          stderr.push(text);
          if (text.includes('[clawgod]')) warnings.push(text);
        },
      },
    },
  };

  let source = GATES_SRC;
  if (metaConst !== null) {
    assert.ok(source.includes('// {{CLAWGOD:FEATURES_META}}'), 'weave marker missing from source');
    source = source.replace('// {{CLAWGOD:FEATURES_META}}', `const CLAWGOD_FEATURES_META = ${metaConst};`);
  }
  vm.runInNewContext(source, sandbox, { filename: 'feature-gates.cjs' });
  return { gates: sandbox.__clawgodPatches, stderr, warnings };
}

test('feature-gates: missing woven META degrades with warning, no ReferenceError', () => {
  const { gates, warnings } = runGates({ metaConst: null });
  // No baked meta → no baked-patch gating; wrapper-owned features still gate.
  // (JSON round-trip: gates comes from a vm realm with a foreign prototype.)
  assert.deepEqual(JSON.parse(JSON.stringify(gates)), { 'bun-ant-shim': true });
  assert.equal(warnings.length, 1, `expected exactly one clawgod warning, got: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /CLAWGOD_FEATURES_META/);
});

test('feature-gates: missing META keeps gates ON even when patches.json is invalid', () => {
  const { gates } = runGates({ metaConst: null, patchesJson: '{not json' });
  assert.deepEqual(JSON.parse(JSON.stringify(gates)), { 'bun-ant-shim': true });
});

test('feature-gates: woven META computes per-patch gates from patches.json', () => {
  const meta = JSON.stringify({ 'patch-a': ['feat-one'], 'patch-b': ['feat-two'] });
  const cfg = JSON.stringify({ 'feat-one': false, 'stale-legacy': true });
  const { gates, warnings } = runGates({ metaConst: meta, patchesJson: cfg });
  assert.equal(gates['patch-a'], false, 'patch-a disabled via patches.json');
  assert.equal(gates['patch-b'], true, 'patch-b defaults on');
  assert.equal(gates['bun-ant-shim'], true);
  assert.ok(warnings.some((w) => /unknown feature "stale-legacy"/.test(w)),
    'unknown-feature residue should warn when meta is present');
});

test('feature-gates: CLAWGOD_FEATURE_* env override wins over patches.json', () => {
  const meta = JSON.stringify({ 'patch-a': ['feat-one'], 'patch-b': ['feat-two'] });
  const cfg = JSON.stringify({ 'feat-one': false });
  const { gates } = runGates({
    metaConst: meta,
    patchesJson: cfg,
    env: { CLAWGOD_FEATURE_FEAT_ONE: 'true' },
  });
  assert.equal(gates['patch-a'], true, 'env override restores a patches.json-disabled feature');
});

test('feature-gates: no meta means no unknown-feature residue warnings', () => {
  const { warnings } = runGates({ metaConst: null, patchesJson: JSON.stringify({ 'feat-one': false }) });
  assert.equal(warnings.length, 1, 'only the missing-meta warning should appear');
  assert.doesNotMatch(warnings[0], /unknown feature/);
});

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
