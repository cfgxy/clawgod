import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { healSkillTemplates } from './skill-entry-guard.cjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = `${here}/cli.original.js`;
const dst = `${here}/cli.original.cjs`;
const pathMapFile = `${here}/pathmap.json`;

let code = readFileSync(src, 'utf8');

// v2.1.245+ splits the app into an ESM chunk graph; post-process then
// rewrites the whole bunfs/ dir too. Legacy single-bundle has no pathmap.
const isChunked = existsSync(pathMapFile);

// (0) Strip leading @bun pragma comments (e.g. "// @bun @bytecode @bun-cjs\n")
// Bun requires the file to start directly with "(function" (CJS) or the
// first import (ESM) — any preceding comment breaks that detection.
function stripPragma(c) { return c.replace(/^(?:\/\/[^\n]*\n)+/, ''); }

// build-time fileURLToPath() leaks → use cli.cjs's own __filename
function fixFileURLs(c) {
  return c.replace(
    /[\w$]+\.fileURLToPath\("file:\/\/\/home\/runner\/work\/claude-cli-internal\/claude-cli-internal\/[^"]*"\)/g,
    () => '__filename',
  );
}

if (isChunked) {
  // ── v2.1.245+ ESM chunk graph path ──
  const pathMap = JSON.parse(readFileSync(pathMapFile, 'utf8'));
  // build the replace table: /$bunfs/root/X → <here>/<relative-on-disk>
  const replaceTable = new Map();
  for (const [bunPath, rel] of Object.entries(pathMap)) {
    replaceTable.set(bunPath, join(here, rel));
  }

  function rewriteGraph(text) {
    // Replace string literals containing the virtual in-bundle root
    // (POSIX "/$bunfs/root/..." or Windows single-drive "B:/~BUN/root/...")
    // with the on-disk absolute path from the replace table.
    return text.replace(/["'`](?:\/\$bunfs\/root|[A-Za-z]:\/~BUN\/root)\/[^"'`]+["'`]/g, (m) => {
      const body = m.slice(1, -1);
      const target = replaceTable.get(body) || replaceTable.get(body.replaceAll('\\','/'));
      // JSON.stringify emits a valid JS string literal. This is essential on
      // Windows, where path.join() returns backslashes that would otherwise be
      // interpreted as escapes (for example, \b in "\bunfs").
      return target ? JSON.stringify(target) : m;
    });
  }

  // entry → cli.original.cjs (ESM, no IIFE wrap)
  code = stripPragma(code);
  code = rewriteGraph(code);
  code = fixFileURLs(code);
  writeFileSync(dst, code);
  unlinkSync(src);

  // rewrite every chunk/asset file in bunfs/ in place
  const bunfsDir = join(here, 'bunfs');
  let n = 0;
  for (const f of readdirSync(bunfsDir)) {
    if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue;
    const fp = join(bunfsDir, f);
    let fc = readFileSync(fp, 'utf8');
    fc = stripPragma(fc);
    fc = rewriteGraph(fc);
    fc = fixFileURLs(fc);
    writeFileSync(fp, fc);
    n++;
  }
  // Neutralize unguarded top-level entry code in the extracted skill
  // templates (see skill-entry-guard.cjs). Graph installs release them as
  // real files that claude's skill-file manifest requires in-process at
  // startup; unguarded, their argv parsing exits 2 and kills the whole CLI
  // (the "unknown argument: -p" crash). Direct execution is unaffected:
  // import.meta.main holds when the file is run as a program (verified on
  // node v22 / bun 1.3). Failures are reported, never fatal here - the
  // launcher-side hazard scan decides at startup.
  const segReport = healSkillTemplates(bunfsDir, { logFile: join(here, 'skill-entry-guard.log') });
  for (const f of segReport.fixed) console.log(`skill-template guarded: ${f}`);
  for (const f of segReport.alreadyGuarded) console.log(`skill-template already guarded: ${f}`);
  for (const s of segReport.unmatched) console.log(`skill-template NOT guarded (${s.reason}): ${s.file}`);

  console.log(`cli.original.cjs: ${code.length} bytes (chunked, rewrote ${n} graph files)`);
} else {
  // ── Legacy single-bundle path ──
  code = stripPragma(code);

  // (1) bunfs .node module paths → runtime vendor lookup
  code = code.replace(
    /require\(['"](\/\$bunfs\/root\/([\w-]+)\.node)['"]\)/g,
    (m, _full, name) =>
      `require(require('path').join(__dirname,'vendor',${JSON.stringify(name)},\`\${process.arch==='arm64'?'arm64':'x64'}-\${process.platform==='darwin'?'darwin':process.platform==='linux'?'linux':'win32'}\`,${JSON.stringify(name + '.node')}))`,
  );

  code = fixFileURLs(code);

  // (3) make the outer (function(...){...}) actually run
  code = code.replace(/\}\)\s*$/, '})(exports, require, module, __filename, __dirname)');

  writeFileSync(dst, code);
  unlinkSync(src);
  console.log(`cli.original.cjs: ${code.length} bytes`);
}
