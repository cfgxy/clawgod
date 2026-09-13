// Tests for the asset-execution guard (asset-guard.cjs). The guard exists
// because graph installs put bundled skill-asset scripts (runner-scaffold /
// build-report-lite templates) on disk where claude ≥2.1.270 can mis-resolve
// one as the CLI entry during Skill-tool invocations; the template then exits
// 2 on the headless `-p` args and the status propagates, killing the session.
//
// Run: node src/shared/asset-guard.test.mjs  (wired into CI compat-daily)
//
// Coverage: asset-path detection (bunfs direct children only), invocation
// splitting (execFile-style vs interpreter-style), headless retargeting,
// soft-fail results, spawn/execFile wrapper behavior against a recording
// fake, and passthrough of unrelated spawns.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installAssetSpawnGuard,
  assetInvocation,
  retargetArgs,
  isAssetPath,
  isInterpreterCommand,
} from './asset-guard.cjs';

const bunfsDir = join(tmpdir(), 'clawgod-guard-test-bunfs');
const scaffold = join(bunfsDir, 'runner-scaffold-abc123.mjs');
const report = join(bunfsDir, 'build-report-lite-def456.mjs');

// ── isAssetPath ──────────────────────────────────────────────────────────────

assert.equal(isAssetPath(scaffold, bunfsDir), true, 'scaffold template is an asset');
assert.equal(isAssetPath(report, bunfsDir), true, 'build-report template is an asset');
assert.equal(isAssetPath(join(bunfsDir, 'chunk-abc123.js'), bunfsDir), false, 'chunks are not assets');
assert.equal(isAssetPath(join(bunfsDir, 'nested', 'runner-scaffold-x.mjs'), bunfsDir), false,
  'nested paths are not graph assets');
assert.equal(isAssetPath('/elsewhere/runner-scaffold-x.mjs', bunfsDir), false, 'outside bunfs is not an asset');
assert.equal(isAssetPath(undefined, bunfsDir), false, 'non-string is not an asset');

// ── isInterpreterCommand ─────────────────────────────────────────────────────

assert.equal(isInterpreterCommand('/usr/bin/bun'), true);
assert.equal(isInterpreterCommand('bun.exe'), true);
assert.equal(isInterpreterCommand('node'), true);
assert.equal(isInterpreterCommand('git'), false);
assert.equal(isInterpreterCommand('/usr/bin/bun', '/usr/bin/bun'), true, 'execPath match');

// ── assetInvocation ──────────────────────────────────────────────────────────

// execFile-style: the asset itself is the command.
assert.deepEqual(
  assetInvocation(scaffold, ['-p', 'hello'], bunfsDir),
  ['-p', 'hello'],
  'execFile-style invocation yields trailing args',
);
// interpreter-style: interpreter + [asset, ...args].
assert.deepEqual(
  assetInvocation('/usr/bin/bun', [scaffold, '-p', 'hello'], bunfsDir),
  ['-p', 'hello'],
  'interpreter-style invocation strips interpreter and asset',
);
// not an interpreter → not an invocation even when args[0] is an asset.
assert.equal(assetInvocation('git', [scaffold, '-p'], bunfsDir), null, 'non-interpreter front is ignored');
// unrelated command → null.
assert.equal(assetInvocation('git', ['status'], bunfsDir), null, 'unrelated commands pass through');

// ── retargetArgs ─────────────────────────────────────────────────────────────

const cli = '/fake/claude.orig';
assert.deepEqual(retargetArgs(['-p', 'hello'], cli), [cli, '-p', 'hello'], '-p retargets to the CLI');
assert.deepEqual(retargetArgs(['--print', 'hello'], cli), [cli, '--print', 'hello'], '--print retargets');
assert.equal(retargetArgs(['--flow', '.'], cli), null, 'non-headless args are not retargeted');
assert.equal(retargetArgs(['-p', 'hello'], ''), null, 'no known CLI → no retarget');
assert.equal(retargetArgs([], cli), null, 'no args → no retarget');

// ── installAssetSpawnGuard (against a recording fake) ───────────────────────

function makeFakeCp() {
  const calls = [];
  const cp = {
    calls,
    spawnSync(cmd, args, options) {
      calls.push({ api: 'spawnSync', cmd, args, options });
      return { status: 0, stdout: '' };
    },
    execFileSync(cmd, args, options) {
      calls.push({ api: 'execFileSync', cmd, args, options });
      return 'orig';
    },
    spawn(cmd, args, options) {
      calls.push({ api: 'spawn', cmd, args, options });
      return { pid: 123 };
    },
    execFile(cmd, args, options, callback) {
      calls.push({ api: 'execFile', cmd, args, options, callback });
      return { pid: 124 };
    },
  };
  return cp;
}

const logDir = mkdtempSync(join(tmpdir(), 'clawgod-guard-log-'));
const logFile = join(logDir, 'asset-spawn-guard.log');
try {
  // Retarget case: headless invocation is redirected to the real CLI.
  const retargetCp = makeFakeCp();
  installAssetSpawnGuard(retargetCp, { bunfsDir, logFile, cliExecPath: cli });
  const r1 = retargetCp.spawnSync('bun', [scaffold, '-p', 'do a thing'], { encoding: 'utf8' });
  assert.deepEqual(
    retargetCp.calls.at(-1),
    { api: 'spawnSync', cmd: cli, args: ['-p', 'do a thing'], options: { encoding: 'utf8' } },
    'headless spawn is retargeted to the real CLI with args intact',
  );
  assert.deepEqual(r1, { status: 0, stdout: '' }, 'retargeted result comes from the real spawn');

  // Soft-fail case: non-headless invocation exits cleanly without executing.
  const softCp = makeFakeCp();
  installAssetSpawnGuard(softCp, { bunfsDir, logFile, cliExecPath: cli });
  softCp.spawnSync(scaffold, ['--flow', '.']);
  assert.equal(softCp.calls.length, 0, 'soft-failed sync spawn never reaches the real spawn');
  const asyncChild = softCp.spawn('bun', [scaffold, '--flow', '.']);
  assert.equal(asyncChild.pid, 123, 'soft-failed async spawn still returns a ChildProcess');
  assert.equal(softCp.calls[0].cmd, process.argv[0], 'async soft-fail runs the runtime exit-0 trampoline');
  assert.deepEqual(softCp.calls[0].args, ['-e', 'process.exit(0);'], 'trampoline exits 0');

  // execFile API is covered too, in both directions.
  const execCp = makeFakeCp();
  installAssetSpawnGuard(execCp, { bunfsDir, logFile, cliExecPath: cli });
  execCp.execFile(scaffold, ['-p', 'x']);
  assert.deepEqual(execCp.calls[0].cmd, cli, 'execFile headless invocation is retargeted');
  execCp.execFileSync('git', ['status']);
  assert.deepEqual(execCp.calls.at(-1), { api: 'execFileSync', cmd: 'git', args: ['status'], options: undefined },
    'unrelated execFileSync passes through untouched');

  // Forensics log captured both actions.
  const log = readFileSync(logFile, 'utf8');
  assert.ok(log.includes('action=retarget'), 'retarget is logged');
  assert.ok(log.includes('action=soft-fail'), 'soft-fail is logged');
  assert.ok(log.includes('runner-scaffold-abc123.mjs'), 'log records the asset path');
} finally {
  rmSync(logDir, { recursive: true, force: true });
}

console.log('asset-guard tests passed');
