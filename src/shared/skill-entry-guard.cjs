'use strict';
// Skill-template entry guard for graph installs.
//
// Failure mechanism (verified against a live 2.1.270 graph install): in a
// graph install the bundled skill templates (the eval-hillclimb
// `runner-scaffold` and `build-report-lite` scripts) are extracted to real
// files under <install>/bunfs. Claude Code's skill-file manifest chunk (a
// minified `chunk-*.js` module) executes `Re("<install>/bunfs/xxx.mjs")` at
// module top level, where `Re = import.meta.require` - Bun's require - so
// the template is evaluated IN-PROCESS while the CLI starts. A template
// without an entry guard then parses the *host CLI's* argv (it reads
// process.argv.slice(2), which is the CLI's argv, not a shell command): on
// a headless `-p ...` invocation its arg parser prints
// "unknown argument: -p" and calls process.exit(2), killing the whole CLI
// before the session starts. The crash is intermittent because the
// manifest chunk loads lazily - only sessions that touch the skill file
// table pull it in.
//
// Fix (entry neutralization): the templates are only meant to be executed
// directly (`node run-eval.mjs ...` / `node build-report-lite.mjs ...`), so
// their top-level entry is wrapped in `if (import.meta.main)`: direct
// execution still runs, and an in-process require()/import() becomes an
// inert module load instead of an argv-parsing exit(2). import.meta.main
// was verified on node v22.22.3 and bun 1.3.14 (true when the file is the
// executed program, false under require()/import() on both).
//
// Scan (fail-fast): bunfs/*.mjs files are also scanned for the same hazard
// shapes in templates we do not know by name (future upstream templates).
// A hit aborts the CLI with an explicit launcher error naming the file,
// instead of the cryptic mid-startup "unknown argument: -p" death.
//
// The two hazard shapes covered by the scan predicate:
//   1. unguarded top-level entry call - the last code statement of the file
//      is a bare `name();` where `name` is declared in the file (the
//      runner-scaffold shape: unconditional trailing main()).
//   2. top-level bare execution body - code at brace depth 0 reads
//      process.argv or calls process.exit (the build-report-lite shape:
//      trailing argv handling and try/catch at top level).

const {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require('fs');
const { join } = require('path');
const { appendFileSync } = require('fs');

// Canonical guard written by the neutralizer. Its presence also marks a
// file as already guarded (idempotent re-runs skip it).
const GUARD_OPEN = 'if (import.meta.main) {';
const GUARD_LINE = 'if (import.meta.main)';

const KNOWN_TEMPLATES = [
  {
    name: 'runner-scaffold',
    filePrefix: 'runner-scaffold-',
    kind: 'trailing-entry-call',
    // sanity: the file really declares the entry being neutralized
    declarationRe: /\b(?:async\s+)?function\s+main\s*\(/,
  },
  {
    name: 'build-report-lite',
    filePrefix: 'build-report-lite-',
    kind: 'tail-body',
    bodyAnchor: 'const arg = process.argv[2];',
    declarationRe: /\bfunction\s+build\s*\(/,
  },
];

// ─── Lite tokenizer ─────────────────────────────────────────────
// Blank out comments, string/template/regex literal CONTENTS (spaces,
// newlines kept) so brace depth and line structure of the real code
// survive. Output length always equals input length. Handles // and
// /* */ comments, '...' and "..." strings with escapes, `...` template
// literals with ${...} interpolations (recursively tokenized), /regex/
// literals via the previous-significant-token heuristic, and the #!
// shebang line. Regex detection is a heuristic; a misparse can only move
// the depth estimate, and the scan predicates below are shaped so that a
// stale depth fails toward flagging (clear error) rather than staying
// silent on a real hazard.

function regexAllowed(prev, src, i) {
  if (prev === '') return true;
  if ('(,=:[!&|?{};+-*%~^<>'.includes(prev)) return true;
  let j = i - 1;
  let word = '';
  while (j >= 0 && /[A-Za-z_$0-9]/.test(src[j])) {
    word = src[j] + word;
    j--;
  }
  return [
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
    'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
  ].includes(word);
}

function stripForScan(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let prev = '';

  if (src.startsWith('#!')) {
    while (i < n && src[i] !== '\n') {
      out[i] = ' ';
      i++;
    }
  }

  // Consumes template-literal text after an opening backtick. `${...}`
  // interpolations stay visible (they are code) and recurse into code().
  function templateText() {
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        if (out[i] !== '\n') out[i] = ' ';
        if (i + 1 < n && out[i + 1] !== '\n') out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '`') {
        out[i] = ' ';
        i++;
        prev = '`';
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        code('}');
        if (src[i] === '}') i++;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
    }
  }

  // Consumes code until one of `stop` chars appears at this segment's
  // brace depth 0 (leaves that char unconsumed). Empty `stop` = top level.
  function code(stop) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        const s = i;
        while (i < n && src[i] !== '\n') i++;
        blank(s, i);
        continue;
      }
      if (c === '/' && d === '*') {
        const s = i;
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
        blank(s, i);
        continue;
      }
      if (c === '"' || c === "'") {
        const s = i;
        i++;
        while (i < n && src[i] !== c) {
          if (src[i] === '\\') i++;
          i++;
        }
        i = Math.min(n, i + 1);
        blank(s, i);
        prev = '"';
        continue;
      }
      if (c === '`') {
        out[i] = ' ';
        i++;
        templateText();
        continue;
      }
      if (c === '/' && d !== '/' && d !== '*' && regexAllowed(prev, src, i)) {
        const s = i;
        i++;
        let inClass = false;
        while (i < n) {
          const r = src[i];
          if (r === '\\') {
            i += 2;
            continue;
          }
          if (r === '\n') break;
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) {
            i++;
            break;
          }
          i++;
        }
        blank(s, i);
        prev = '/';
        continue;
      }
      if (stop && stop.includes(c) && depth === 0) return;
      if (c === '{') depth++;
      else if (c === '}') {
        if (depth === 0) return;
        depth--;
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }

  code('');
  return out.join('');
}

// Depth at the start of each line of already-stripped code.
function lineStartDepths(stripped) {
  const depths = [];
  let depth = 0;
  for (const line of stripped.split('\n')) {
    depths.push(depth);
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  return depths;
}

// Brace depth at a character offset of a stripped source. stripForScan
// blanks every non-code character, so counting braces up to the offset is
// exact — this is the authoritative "is this token at top level" test and
// also answers tokens that merely share a line with a block opener.
function depthAt(stripped, offset) {
  let depth = 0;
  for (let k = 0; k < offset; k++) {
    const ch = stripped[k];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

// ─── Fix B: hazard scan ─────────────────────────────────────────
// Returns [{ file, form, line, detail }] for bunfs/*.mjs files whose
// top-level code would execute on an in-process require(). Both shapes
// from the module header are covered; anything inside function bodies,
// behind the canonical guard, or inside comments/strings/regex/template
// text is ignored.

function scanText(content, fileName) {
  const hits = [];
  const stripped = stripForScan(content);
  const lines = stripped.split('\n');
  const depths = lineStartDepths(stripped);

  let off = 0;
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const t = raw.trim();
    if (t && depths[li] === 0 && !t.startsWith(GUARD_LINE)
        && (t.includes('process.argv') || t.includes('process.exit('))) {
      // A top-level line may open a block before the match (`fn() { ... }`
      // one-liners keep argv function-scoped); judge at the match itself.
      const mi = raw.indexOf('process.argv');
      const mj = raw.indexOf('process.exit(');
      const at = mi === -1 ? mj : (mj === -1 ? mi : Math.min(mi, mj));
      if (at !== -1 && depthAt(stripped, off + at) === 0) {
        hits.push({
          file: fileName,
          form: 'top-level argv/exit (bare execution body)',
          line: li + 1,
          detail: t.slice(0, 100),
        });
      }
    }
    off += raw.length + 1;
  }

  // Shape 1: the LAST code line is a bare declared-function call.
  for (let li = lines.length - 1; li >= 0; li--) {
    const t = lines[li].trim();
    if (!t) continue;
    const m = /^([\w$]+)\(\);\s*;?$/.exec(t);
    if (m && depths[li] === 0) {
      const name = m[1];
      const declRe = new RegExp(
        '(?:^|\\n)[^\\n]*(?:\\bfunction\\s+' + name + '\\s*\\(|\\b(?:const|let|var)\\s+' + name + '\\s*=)',
      );
      if (declRe.test(stripped)) {
        hits.push({
          file: fileName,
          form: 'unguarded top-level entry call',
          line: li + 1,
          detail: t,
        });
      }
    }
    break;
  }
  return hits;
}

function scanSkillTemplateHazards(bunfsDir) {
  const hits = [];
  if (!existsSync(bunfsDir)) return hits;
  for (const f of readdirSync(bunfsDir).sort()) {
    if (!f.endsWith('.mjs')) continue;
    let content;
    try {
      content = readFileSync(join(bunfsDir, f), 'utf8');
    } catch {
      continue;
    }
    hits.push(...scanText(content, f));
  }
  return hits;
}

// ─── Fix A: neutralize the known templates ──────────────────────
// Idempotent. Writes a .clawgod-orig backup next to the file before the
// first rewrite and appends an action line to logFile. Files whose shape
// no longer matches are reported in `unmatched` and left untouched - the
// hazard scan then decides at startup whether they are still dangerous.

function appendGuardLog(logFile, action, detail) {
  if (!logFile) return;
  try {
    appendFileSync(logFile, new Date().toISOString() + ' action=' + action
      + ' ' + detail + '\n');
  } catch {
    /* forensics only - never block the caller */
  }
}

function healSkillTemplates(bunfsDir, options) {
  const logFile = (options && options.logFile) || '';
  const report = { fixed: [], alreadyGuarded: [], unmatched: [], backups: [] };
  if (!existsSync(bunfsDir)) return report;

  for (const tpl of KNOWN_TEMPLATES) {
    for (const f of readdirSync(bunfsDir).sort()) {
      if (!f.startsWith(tpl.filePrefix) || !f.endsWith('.mjs')) continue;
      const fp = join(bunfsDir, f);
      let content;
      try {
        content = readFileSync(fp, 'utf8');
      } catch (e) {
        report.unmatched.push({ file: f, reason: 'unreadable: ' + (e && e.message || e) });
        continue;
      }
      if (content.includes('import.meta.main')) {
        report.alreadyGuarded.push(f);
        continue;
      }

      let guarded;
      if (tpl.kind === 'trailing-entry-call') {
        if (!tpl.declarationRe.test(content) || !/\nmain\(\);\s*$/.test(content)) {
          report.unmatched.push({
            file: f,
            reason: 'trailing bare main() entry not found (template shape changed?)',
          });
          continue;
        }
        guarded = content.replace(/\nmain\(\);\s*$/, '\n' + GUARD_LINE + ' main();\n');
      } else {
        const occurrences = content.split(tpl.bodyAnchor).length - 1;
        if (occurrences !== 1 || !tpl.declarationRe.test(content)) {
          report.unmatched.push({
            file: f,
            reason: 'single top-level `' + tpl.bodyAnchor + '` anchor not found (template shape changed?)',
          });
          continue;
        }
        const stripped = stripForScan(content);
        const anchorOffset = stripped.indexOf(tpl.bodyAnchor);
        if (depthAt(stripped, anchorOffset) !== 0) {
          report.unmatched.push({ file: f, reason: 'body anchor is not at top level' });
          continue;
        }
        guarded = content
          .replace(tpl.bodyAnchor, GUARD_OPEN + '\n' + tpl.bodyAnchor)
          .replace(/\s*$/, '\n}\n');
      }

      const backup = fp + '.clawgod-orig';
      if (!existsSync(backup)) {
        try {
          copyFileSync(fp, backup);
          report.backups.push(backup);
        } catch {
          /* best-effort */
        }
      }
      try {
        writeFileSync(fp, guarded);
        report.fixed.push(f);
        appendGuardLog(logFile, 'guarded', f);
      } catch (e) {
        report.unmatched.push({ file: f, reason: 'write failed: ' + (e && e.message || e) });
      }
    }
  }
  return report;
}

module.exports = { stripForScan, scanSkillTemplateHazards, healSkillTemplates, appendGuardLog };
