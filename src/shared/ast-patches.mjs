import { parse } from './acorn.mjs';

export const AST_PATCH_IDS = [
  'user-type-ant', 'bun-standalone-executable', 'growthbook-env-overrides-graph',
  'computer-use-default', 'ultraplan', 'voice-mode',
  'geo-stego-date', 'remote-settings-off', 'wiggly-dove', 'compact-summary-sanitize',
];

const COMPACT_HEADER = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.';
const COMPACT_CONTINUATION = 'Continue the conversation from where it left off without asking the user any further questions.';
const COMPACT_INTERNAL_MARKER = 'CRITICAL: Respond with TEXT ONLY';
const anchors = ['external', 'isStandaloneExecutable', 'environmentOverridesParsed',
  'pixelValidation', 'ultraplan', 'tengu_amber_quartz_disabled', 's date is ',
  'Remote settings:', 'remote-settings.json', 'tengu_wiggly_dove',
  COMPACT_HEADER, COMPACT_CONTINUATION];
const gate = id => `globalThis.__clawgodPatches?.[${JSON.stringify(id)}]!==!1`;
const literal = (node, value) => node?.type === 'Literal' && node.value === value;
const propertyName = node => node.computed
  ? (node.key?.type === 'Literal' ? node.key.value : undefined)
  : (node.key?.name ?? node.key?.value);
const member = (node, name) => node?.type === 'MemberExpression' &&
  (node.computed ? literal(node.property, name) : node.property.name === name);
const thisMember = (node, name) => member(node, name) && node.object.type === 'ThisExpression';
const boolean = (node, value) => literal(node, value) ||
  (node?.type === 'UnaryExpression' && node.operator === '!' && literal(node.argument, value ? 0 : 1));
const isUndefined = node => node?.type === 'UnaryExpression' && node.operator === 'void' &&
  literal(node.argument, 0);
const stringValues = node => node?.type === 'Literal' && typeof node.value === 'string' ? [node.value]
  : node?.type === 'TemplateLiteral' ? node.quasis.map(quasi => quasi.value.cooked ?? '') : [];

export const parsePatchSource = code => parse(code, {
  ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true,
  allowReturnOutsideFunction: true, allowImportExportEverywhere: true,
});

// Iterative traversal avoids adding a second call stack limit to large bundles.
function walk(root, visit) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    visit(node);
    for (const value of Object.values(node)) {
      if (value?.type) pending.push(value);
      else if (Array.isArray(value)) {
        for (const child of value) if (child?.type) pending.push(child);
      }
    }
  }
}

function hasGate(node, id) {
  let found = false;
  walk(node, child => {
    if (member(child, id) && member(child.object, '__clawgodPatches') &&
        child.object.object.name === 'globalThis') found = true;
  });
  return found;
}

function hasRemoteSettingsContext(node) {
  let found = false;
  walk(node, child => {
    const strings = child.type === 'Literal' && typeof child.value === 'string' ? [child.value]
      : child.type === 'TemplateLiteral' ? child.quasis.map(quasi => quasi.value.cooked ?? '') : [];
    if (strings.some(value => value.includes('Remote settings:') || value.includes('remote-settings.json'))) found = true;
  });
  return found;
}

// One parse per candidate file, shared by every semantic patch. Keep only edit
// ranges; the large AST can be collected before the next graph chunk is parsed.
export function scanAstPatches(code) {
  const results = Object.fromEntries(AST_PATCH_IDS.map(id => [id, { matches: [], present: false, patched: false }]));
  if (!anchors.some(anchor => code.includes(anchor))) return results;
  const tree = parsePatchSource(code);
  const edit = (id, node, replacement) => {
    results[id].matches.push({ start: node.start, end: node.end, replacement });
  };
  const injectReturn = (id, fn, value) => {
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(fn?.type) || fn.async || fn.generator) return;
    if (hasGate(fn, id)) return;
    const body = fn.body;
    const original = code.slice(body.start, body.end);
    if (body.type !== 'BlockStatement') {
      edit(id, body, `(${gate(id)}?${value}:(${original}))`);
      return;
    }
    let insertion = body.start + 1;
    for (const statement of body.body) {
      if (!statement.directive) break;
      insertion = statement.end;
    }
    const offset = insertion - body.start;
    edit(id, body, `${original.slice(0, offset)};if(${gate(id)})return ${value};${original.slice(offset)}`);
  };

  // Remote settings are identified by the eligibility helper's diagnostics,
  // not a minified name or the common cache/`{eligible}` prefix. Keep this
  // local to one chunk: cross-chunk imports are not a stable contract.
  const functions = new Map();
  const compactHeaderBindings = new Set();
  const wigglyLiterals = new Set(), wigglyHandled = new Set();
  walk(tree, node => {
    if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier') {
      functions.set(node.id.name, node);
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
        literal(node.init, COMPACT_HEADER)) compactHeaderBindings.add(node.id.name);
  });
  walk(tree, node => {
    if (literal(node, 'tengu_wiggly_dove')) wigglyLiterals.add(node.start);
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      const flags = node.body.filter(s => s.type === 'VariableDeclaration')
        .flatMap(s => s.declarations).filter(d => literal(d.init, 'tengu_wiggly_dove'));
      for (const flag of flags) {
        const id = 'wiggly-dove';
        const candidates = node.body.filter(fn => {
          if (fn.type !== 'FunctionDeclaration' || fn.params.length || fn.async || fn.generator) return false;
          // Only the boolean eligibility helper, never a collector or a
          // nested function with a shadowed flag binding.
          const statements = fn.body.body.filter(s => !s.directive && s.type !== 'EmptyStatement');
          const guards = statements.slice(0, -1);
          const last = statements.at(-1);
          if (!guards.length || !guards.every(s => s.type === 'IfStatement' && !s.alternate &&
              s.consequent.type === 'ReturnStatement' && boolean(s.consequent.argument, false)) ||
              last?.type !== 'ReturnStatement' || last.argument?.type !== 'CallExpression') return false;
          return flag.id.type === 'Identifier' && guards.some(s => {
            const call = s.test.type === 'UnaryExpression' && s.test.operator === '!' ? s.test.argument : null;
            return call?.type === 'CallExpression' && call.arguments.length === 2 &&
              call.arguments[0].type === 'Identifier' && call.arguments[0].name === flag.id.name &&
              boolean(call.arguments[1], false);
          });
        });
        if (candidates.length !== 1) continue;
        wigglyHandled.add(flag.init.start);
        if (hasGate(candidates[0], id)) results[id].patched = true;
        else injectReturn(id, candidates[0], '!1');
      }
    }

    if (node.type === 'ObjectExpression') {
      // Spreads, accessors and duplicate keys can change which value is used.
      const props = node.properties;
      const named = name => props.filter(p => p.type === 'Property' && propertyName(p) === name);
      const names = named('name');
      if (names.some(p => literal(p.value, 'ultraplan'))) {
        const enabled = named('isEnabled');
        const patched = enabled.length === 1 && hasGate(enabled[0].value, 'ultraplan');
        if (patched) results.ultraplan.patched = true;
        else results.ultraplan.present = true;
        if (names.length === 1 && enabled.length === 1 && enabled[0].kind === 'init' &&
            !props.some(p => p.type === 'SpreadElement' || (p.computed && p.key.type !== 'Literal'))) {
          injectReturn('ultraplan', enabled[0].value, '!0');
        }
      }
      const enabled = named('enabled');
      if (named('pixelValidation').length === 1 && enabled.length === 1 &&
          enabled[0].kind === 'init' && boolean(enabled[0].value, false) &&
          !props.some(p => p.type === 'SpreadElement' || (p.computed && p.key.type !== 'Literal'))) {
        edit('computer-use-default', enabled[0].value,
          `(${gate('computer-use-default')}?!0:(${code.slice(enabled[0].value.start, enabled[0].value.end)}))`);
      }
    }

    if (node.type === 'FunctionDeclaration' && node.params.length === 1 &&
        node.params[0].type === 'Identifier' && !node.async && !node.generator) {
      const date = node.body.body.find(s => s.type === 'ReturnStatement')?.argument;
      const quasis = date?.type === 'TemplateLiteral' ? date.quasis.map(q => q.value.cooked) : [];
      if (quasis.length === 3 && quasis[0] === 'Today' && quasis[1] === 's date is ' && quasis[2] === '.') {
        const id = 'geo-stego-date';
        if (hasGate(node, id)) results[id].patched = true;
        else {
          results[id].present = true;
          const bindings = new Map(node.body.body.filter(s => s.type === 'VariableDeclaration')
            .flatMap(s => s.declarations).filter(d => d.id.type === 'Identifier').map(d => [d.id.name, d.init]));
          const formatted = bindings.get(date.expressions[1]?.name);
          const call = formatted?.type === 'ConditionalExpression' ? formatted.consequent : null;
          const param = node.params[0].name;
          if (call?.type === 'CallExpression' && member(call.callee, 'replaceAll') &&
              call.callee.object.name === param && call.arguments.length === 2 &&
              literal(call.arguments[0], '-') && literal(call.arguments[1], '/') && formatted.alternate.name === param) {
            injectReturn(id, node, `\`Today's date is \${${param}}.\``);
          }
        }
      }
    }

    if (node.type === 'FunctionDeclaration' && node.params.length === 0 &&
        !node.async && !node.generator && node.body.body.length === 1 &&
        node.body.body[0].type === 'ReturnStatement') {
      const value = node.body.body[0].argument;
      if (literal(value, 'external')) edit('user-type-ant', value, '"ant"');
      const standalone = expr => expr?.type === 'BinaryExpression' && expr.operator === '===' &&
        member(expr.left, 'isStandaloneExecutable') && expr.left.object.name === 'Bun' && boolean(expr.right, true);
      const typeofBun = expr => expr?.type === 'BinaryExpression' && expr.operator === '<' &&
        expr.left.type === 'UnaryExpression' && expr.left.operator === 'typeof' &&
        expr.left.argument.name === 'Bun' && literal(expr.right, 'u');
      if (standalone(value) || (value?.type === 'LogicalExpression' && value.operator === '&&' &&
          typeofBun(value.left) && standalone(value.right))) edit('bun-standalone-executable', value, '!0');
      if (value?.type === 'UnaryExpression' && value.operator === '!' &&
          value.argument.type === 'CallExpression' && value.argument.callee.type === 'Identifier' &&
          value.argument.arguments.length === 2 && literal(value.argument.arguments[0], 'tengu_amber_quartz_disabled') &&
          boolean(value.argument.arguments[1], false)) {
        edit('voice-mode', value, `(${gate('voice-mode')}?!0:(${code.slice(value.start, value.end)}))`);
      }
    }

    if (node.type === 'FunctionDeclaration' && node.params.length === 0 &&
        !node.async && !node.generator) {
      const statements = node.body.body;
      const cached = statements.find(statement => statement.type === 'VariableDeclaration' &&
        statement.declarations.length === 1 && statement.declarations[0].id.type === 'Identifier' &&
        statement.declarations[0].init?.type === 'CallExpression');
      const cachedName = cached?.declarations[0].id.name;
      const cachedReturn = cachedName && statements.find(statement =>
        statement.type === 'IfStatement' && statement.test.type === 'BinaryExpression' &&
        statement.test.operator === '!==' && statement.test.left.type === 'Identifier' &&
        statement.test.left.name === cachedName && isUndefined(statement.test.right) &&
        statement.consequent.type === 'ReturnStatement' && statement.consequent.argument?.type === 'Identifier' &&
        statement.consequent.argument.name === cachedName);
      const eligibility = statements.find(statement => statement.type === 'VariableDeclaration' &&
        statement.declarations.length === 1 && statement.declarations[0].id.type === 'ObjectPattern' &&
        statement.declarations[0].init?.type === 'CallExpression' &&
        statement.declarations[0].init.callee.type === 'Identifier' &&
        statement.declarations[0].id.properties.some(property => property.type === 'Property' &&
          propertyName(property) === 'eligible'));
      const helper = eligibility && functions.get(eligibility.declarations[0].init.callee.name);
      if (helper && hasRemoteSettingsContext(helper)) {
        const id = 'remote-settings-off';
        if (!cachedReturn) results[id].present = true;
        else {
          results[id].present = false;
          if (hasGate(node, id)) results[id].patched = true;
          else injectReturn(id, node, '!1');
        }
      }
    }

    if ((node.type === 'MethodDefinition' || node.type === 'Property') &&
        propertyName(node) === 'getEnvironmentOverrides' && node.value?.body?.type === 'BlockStatement') {
      const statements = node.value.body.body;
      // Fix only the dead return that precedes the actual override reader.
      for (let i = 0; i < statements.length - 1; i++) {
        const statement = statements[i];
        const values = statement.argument?.expressions;
        const next = statements[i + 1];
        if (statement.type !== 'ReturnStatement' || values?.length !== 2) continue;
        const [assignment, result] = values;
        if (assignment.type !== 'AssignmentExpression' || assignment.operator !== '=' ||
            !thisMember(assignment.left, 'environmentOverridesParsed') || !boolean(assignment.right, true) ||
            !thisMember(result, 'environmentOverrides') || next.type !== 'VariableDeclaration') continue;
        const readsOverrides = next.declarations.some(d => d.init?.type === 'CallExpression' &&
          member(d.init.callee, 'readEnvironmentOverrides') && thisMember(d.init.callee.object, 'deps'));
        if (readsOverrides) edit('growthbook-env-overrides-graph', statement,
          `${code.slice(assignment.start, assignment.end)};`);
      }
    }

    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) &&
        node.params.length >= 1 && node.params[0].type === 'Identifier' && node.body?.type === 'BlockStatement') {
      const id = 'compact-summary-sanitize';
      const strings = [];
      const templates = [];
      walk(node.body, child => {
        strings.push(...stringValues(child));
        if (child.type === 'TemplateLiteral') templates.push(child);
      });
      const isContinuationBuilder = strings.some(value => value.includes(COMPACT_CONTINUATION));
      if (!isContinuationBuilder) return;

      const contentBindings = new Set();
      walk(node.body, child => {
        if (child.type !== 'ObjectExpression') return;
        for (const property of child.properties) {
          if (property.type === 'Property' && propertyName(property) === 'content' &&
              property.value.type === 'Identifier') contentBindings.add(property.value.name);
        }
      });
      const templateBindings = new Map(node.body.body.filter(statement =>
        statement.type === 'VariableDeclaration').flatMap(statement => statement.declarations)
        .filter(declaration => declaration.id.type === 'Identifier' &&
          declaration.init?.type === 'TemplateLiteral').map(declaration =>
          [declaration.init.start, declaration.id.name]));
      const headerTemplates = templates.filter(template => {
        if (!contentBindings.has(templateBindings.get(template.start))) return false;
        const localHeader = template.expressions.some(expression =>
          expression.type === 'Identifier' && compactHeaderBindings.has(expression.name));
        // The graph bundle imports the header from a sibling chunk. Its message
        // body ends with the summarized input and has a distinct header binding.
        const importedHeader = template.expressions.at(-1)?.type === 'Identifier' &&
          template.quasis.at(-1)?.value.cooked === '' &&
          template.quasis.some(quasi => quasi.value.cooked?.includes('\n\n')) &&
          template.expressions.slice(0, -1).some(expression => expression.type === 'Identifier');
        return localHeader || importedHeader;
      });
      if (headerTemplates.length !== 1) {
        results[id].present = true;
        return;
      }

      const summaryReferences = new Set(headerTemplates[0].expressions
        .filter(expression => expression.type === 'Identifier').map(expression => expression.name));
      const isSummaryExpression = expression => {
        const inputCalls = [];
        walk(expression, child => {
          if (child.type === 'CallExpression' && child.callee.type === 'Identifier' &&
              child.arguments.length === 1 && child.arguments[0].type === 'Identifier' &&
              child.arguments[0].name === node.params[0].name) inputCalls.push(child);
        });
        return inputCalls.length === 1;
      };
      const summaries = node.body.body.filter(statement => statement.type === 'VariableDeclaration')
        .flatMap(statement => statement.declarations).filter(declaration =>
          declaration.id.type === 'Identifier' && summaryReferences.has(declaration.id.name) &&
          declaration.init && isSummaryExpression(declaration.init));
      if (summaries.length !== 1) {
        results[id].present = true;
        return;
      }
      const summary = summaries[0];
      const summarySource = code.slice(summary.init.start, summary.init.end);
      const existingSanitizer = summary.init.type === 'CallExpression' &&
        member(summary.init.callee, 'trim') &&
        summarySource.includes(COMPACT_INTERNAL_MARKER);
      if (existingSanitizer) {
        results[id].patched = true;
        return;
      }
      const original = code.slice(summary.init.start, summary.init.end);
      // The compactor's own no-tools prompt is valid only while creating the
      // summary. Drop quoted copies before the summary becomes a user message.
      const sanitize = `(${original}).replace(/(?:^|\\n)[^\\n]*(?:(?:(?:latest|most recent)\\s+)?user\\s+(?:message|request)|(?:本次)?最新?用户(?:消息|要求))[^\\n]*\\n\\s*(?:>\\s*)?["“”]?\\s*CRITICAL: Respond with TEXT ONLY\\. Do NOT call any tools\\.\\s*["“”]?(?:\\n\\s*(?:>\\s*)?["“”]?\\s*Your entire response must be plain text:[^\\n]*["“”]?)?/giu,"").replace(/(?:^|\\n)[^\\n]*CRITICAL: Respond with TEXT ONLY\\. Do NOT call any tools\\.[^\\n]*(?:\\n\\s*(?:>\\s*)?["“”]?\\s*Your entire response must be plain text:[^\\n]*["“”]?)?/gu,"").replace(/(?:^|\\n)\\s*(?:>\\s*)?["“”]?\\s*Your entire response must be plain text:[^\\n]*/gu,"").replace(/\\n{3,}/g,"\\n\\n").trim()`;
      edit(id, summary.init, sanitize);
    }
  });
  if ([...wigglyLiterals].some(start => !wigglyHandled.has(start))) {
    results['wiggly-dove'].present = true;
    results['wiggly-dove'].matches = [];
  }
  return results;
}

export function applyAstEdits(code, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts = [];
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) throw new Error('Overlapping AST patch edits');
    parts.push(code.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  parts.push(code.slice(cursor));
  return parts.join('');
}
