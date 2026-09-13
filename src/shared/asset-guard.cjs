'use strict';
// Asset-execution guard for graph installs.
//
// In a native Claude install the bundled skill assets (e.g. the eval-hillclimb
// `runner-scaffold.mjs` / `build-report-lite.mjs` templates) exist only as
// virtual `/$bunfs/root/...` entries inside the binary, so code that
// mis-resolves one as a spawn target fails with ENOENT and the caller
// degrades gracefully. In a graph install those files are extracted to real
// paths under <install>/bunfs — and in claude ≥2.1.270 a path reachable from
// Skill-tool invocations mis-resolves exactly such an asset as the CLI entry
// and spawns it with headless args (`-p ...`). The template's arg parser
// exits 2 on unknown flags, that status propagates into the caller, and the
// whole CLI session dies ("claude exited with error: exit status 2").
//
// This guard wraps the child_process entry points: when a spawn targets a
// graph asset script (a `.mjs` directly under the bunfs dir — only skill
// templates live there; graph code is `chunk-*.js`), it either re-targets
// the call to the real CLI binary (when the remaining args start with a
// headless `-p`/`--print` flag, restoring the caller's intent) or fails the
// call softly with exit status 0, matching the ENOENT degradation a native
// binary exhibits. Every interception is appended to a log file for
// forensics, so a recurrence still reveals the exact argv that triggered it.

const { appendFileSync } = require('fs');

const PRINT_FLAGS = new Set(['-p', '--print']);

function normalizePath(p) {
  return String(p).replace(/\\/g, '/');
}

function isAssetPath(p, bunfsDir) {
  if (typeof p !== 'string' || !p.endsWith('.mjs')) return false;
  const dir = normalizePath(bunfsDir).replace(/\/+$/, '');
  const norm = normalizePath(p);
  return norm.startsWith(dir + '/') && !norm.slice(dir.length + 1).includes('/');
}

function isInterpreterCommand(cmd, execPath) {
  if (typeof cmd !== 'string') return false;
  if (execPath && cmd === execPath) return true;
  const base = normalizePath(cmd).split('/').pop();
  return base === 'node' || base === 'bun' || base === 'node.exe' || base === 'bun.exe';
}

// Returns the args that follow the asset script when `cmd`/`args` together
// invoke one (either `execFile(asset, args)` or `spawn(node, [asset, ...args])`),
// or null when the call does not target an asset.
function assetInvocation(cmd, args, bunfsDir, execPath) {
  if (isAssetPath(cmd, bunfsDir)) return Array.isArray(args) ? args.slice() : [];
  if (Array.isArray(args) && args.length > 0 && isAssetPath(args[0], bunfsDir)
      && isInterpreterCommand(cmd, execPath)) {
    return args.slice(1);
  }
  return null;
}

// Returns [cliExecPath, ...rest] when `rest` looks like a headless claude
// invocation and a real CLI binary is known, else null.
function retargetArgs(rest, cliExecPath) {
  if (!cliExecPath) return null;
  if (rest.length === 0 || typeof rest[0] !== 'string' || !PRINT_FLAGS.has(rest[0])) return null;
  return [cliExecPath].concat(rest);
}

function benignSyncResult() {
  return {
    status: 0,
    signal: null,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    pid: -1,
    error: null,
  };
}

function installAssetSpawnGuard(cp, options) {
  const bunfsDir = options.bunfsDir;
  const logFile = options.logFile;
  const cliExecPath = options.cliExecPath || '';
  const runtimeExec = options.runtimeExec || process.argv[0] || process.execPath;

  function log(action, cmd, args) {
    if (!logFile) return;
    try {
      appendFileSync(logFile, `${new Date().toISOString()} action=${action} ppid=${process.ppid}`
        + ` cmd=${JSON.stringify(cmd)} args=${JSON.stringify(args)}\n`);
    } catch { /* forensics only — never block the caller */ }
  }

  function intercept(cmd, args) {
    const rest = assetInvocation(cmd, args, bunfsDir, process.execPath);
    if (rest === null) return null;
    const target = retargetArgs(rest, cliExecPath);
    if (target) {
      log('retarget', cmd, args);
      return target;
    }
    log('soft-fail', cmd, args);
    return [];
  }

  const origSpawnSync = cp.spawnSync;
  if (typeof origSpawnSync === 'function') {
    cp.spawnSync = function (cmd, args, options) {
      const target = intercept(cmd, Array.isArray(args) ? args : []);
      if (target === null) return origSpawnSync.apply(cp, arguments);
      if (target.length > 0) {
        return origSpawnSync.call(cp, target[0], target.slice(1), Array.isArray(args) ? options : args);
      }
      return benignSyncResult();
    };
  }

  const origExecFileSync = cp.execFileSync;
  if (typeof origExecFileSync === 'function') {
    cp.execFileSync = function (cmd, args, options) {
      const target = intercept(cmd, Array.isArray(args) ? args : []);
      if (target === null) return origExecFileSync.apply(cp, arguments);
      if (target.length > 0) {
        return origExecFileSync.call(cp, target[0], target.slice(1), Array.isArray(args) ? options : args);
      }
      return '';
    };
  }

  const origSpawn = cp.spawn;
  if (typeof origSpawn === 'function') {
    cp.spawn = function (cmd, args, options) {
      const target = intercept(cmd, Array.isArray(args) ? args : []);
      if (target === null) return origSpawn.apply(cp, arguments);
      if (target.length > 0) {
        return origSpawn.call(cp, target[0], target.slice(1), Array.isArray(args) ? options : args);
      }
      // Real child that exits 0 immediately: callers get a genuine
      // ChildProcess with working streams and a clean close event.
      return origSpawn.call(cp, runtimeExec, ['-e', 'process.exit(0);'],
        Array.isArray(args) ? options : args);
    };
  }

  const origExecFile = cp.execFile;
  if (typeof origExecFile === 'function') {
    cp.execFile = function (cmd, args, options, callback) {
      const target = intercept(cmd, Array.isArray(args) ? args : []);
      if (target === null) return origExecFile.apply(cp, arguments);
      if (target.length > 0) {
        return origExecFile.call(cp, target[0], target.slice(1),
          Array.isArray(args) ? options : args, Array.isArray(args) ? callback : options);
      }
      return origSpawn.call(cp, runtimeExec, ['-e', 'process.exit(0);'],
        Array.isArray(args) ? options : args, callback);
    };
  }

  return true;
}

module.exports = { installAssetSpawnGuard, assetInvocation, retargetArgs, isAssetPath, isInterpreterCommand };
