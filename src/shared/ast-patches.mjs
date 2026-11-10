import { parse } from './acorn.mjs';

export const AST_PATCH_IDS = [
  'user-type-ant', 'bun-standalone-executable', 'growthbook-env-overrides-graph',
  'computer-use-default', 'ultraplan', 'voice-mode',
  'geo-stego-date', 'remote-settings-off', 'wiggly-dove',
  'compact-summary-provenance-v2', 'synthetic-continuation-provenance-v1',
];

const COMPACT_HEADER = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.';
const COMPACT_CONTINUATION = 'Continue the conversation from where it left off without asking the user any further questions.';
const COMPACT_INTERNAL_MARKER = 'CRITICAL: Respond with TEXT ONLY';
const COMPACT_REQUEST_MARKER = 'compact-summary-request-v2';
const COMPACT_HELPER_MARKER = 'sanitizeCompactSummaryV1';
const SYNTHETIC_PROVENANCE_MARKER = 'synthetic-continuation-provenance-v1';
const anchors = ['external', 'isStandaloneExecutable', 'environmentOverridesParsed',
  'pixelValidation', 'ultraplan', 'tengu_amber_quartz_disabled', 's date is ',
  'Remote settings:', 'remote-settings.json', 'tengu_wiggly_dove',
  COMPACT_HEADER, COMPACT_CONTINUATION, 'CLAUDE_CODE_RESUME_PROMPT', 'FHr'];
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

const isFunction = node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']
  .includes(node?.type);
const directCall = (node, name) => node?.type === 'CallExpression' &&
  node.callee?.type === 'Identifier' && node.callee.name === name;
const objectProperty = (object, name) => object?.type === 'ObjectExpression' &&
  object.properties.find(property => property.type === 'Property' && propertyName(property) === name);
const objectHasProperty = (object, name) => Boolean(objectProperty(object, name));

function nestedCall(root, name) {
  let found;
  walk(root, node => {
    if (!found && directCall(node, name)) found = node;
  });
  return found;
}

function appendObjectProperties(code, object, properties) {
  const original = code.slice(object.start, object.end);
  return `${original.slice(0, -1)}${original.length > 2 ? ',' : ''}${properties}}`;
}

function compactSanitizerExpression(code, call, source) {
  return `globalThis.__clawgodHelpers.${COMPACT_HELPER_MARKER}(${code.slice(call.start, call.end)},` +
    `{kind:"auto-continuation",version:2,source:${JSON.stringify(source)}}).text`;
}

function syntheticMetadata(code, object, source, sourceExpression = JSON.stringify(source)) {
  return appendObjectProperties(code, object,
    `promptSource:"system",origin:{kind:"auto-continuation",version:1,source:${sourceExpression}}`);
}

export const parsePatchSource = code => parse(code, {
  ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true,
  allowReturnOutsideFunction: true, allowImportExportEverywhere: true,
});

export function validateContinuationGraph(files) {
  const entries = Object.entries(files);
  const compact = entries.find(([name]) => name.endsWith('/bunfs/chunk-ps7vnt4g.js'))?.[1];
  const runner = entries.find(([name]) => name.endsWith('/bunfs/chunk-7ydy3vzs.js'))?.[1];
  if (compact === undefined && runner === undefined) return { ok: true, skipped: true };
  if (compact === undefined || runner === undefined) {
    return { ok: false, reason: 'continuation graph is missing a required producer or consumer chunk' };
  }

  const count = (source, needle) => source.split(needle).length - 1;
  const states = [
    ['compact request provenance', count(compact, COMPACT_REQUEST_MARKER), 3],
    ['compact sanitizer calls', count(compact, COMPACT_HELPER_MARKER), 4],
    ['compact result provenance',
      ['compact-summary-full-v2', 'compact-summary-partial-v2', 'compact-summary-reactive-v2']
        .reduce((total, marker) => total + count(compact, marker), 0), 9],
    ['synthetic consumer provenance',
      count(compact, 'CLAWGOD_RESUME_PROVENANCE') + count(compact, 'cross-machine-v1'), 2],
    ['runner provenance', count(runner, 'CLAWGOD_RESUME_PROVENANCE'), 1],
  ];
  const allClean = states.every(([, actual]) => actual === 0);
  const allPatched = states.every(([, actual, expected]) => actual === expected);
  const errors = [];
  if (count(compact, 'isCompactSummary:!0') !== 3) {
    errors.push(`compact result rows: expected 3, got ${count(compact, 'isCompactSummary:!0')}`);
  }
  if (!allClean && !allPatched) {
    errors.push(`continuation provenance is partial: ${states
      .map(([label, actual, expected]) => `${label}=${actual}/${expected}`).join(', ')}`);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, reason: errors.join('; ') };
}

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

    if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier' &&
        node.body?.type === 'BlockStatement') {
      const compactId = 'compact-summary-provenance-v2';
      const syntheticId = 'synthetic-continuation-provenance-v1';
      const functionName = node.id.name;

      if (['_Nr', 'yWs', 'Ken'].includes(functionName)) {
        const calls = [];
        walk(node.body, child => {
          if (directCall(child, 'Ie') && child.arguments[0]?.type === 'ObjectExpression') {
            calls.push(child);
          }
        });
        const requests = calls.filter(call => {
          const object = call.arguments[0];
          return objectProperty(object, 'content') &&
            !objectHasProperty(object, 'isCompactSummary') &&
            !object.properties.some(property => property.type === 'SpreadElement');
        });
        const resultCalls = calls.filter(call => {
          const object = call.arguments[0];
          return objectHasProperty(object, 'isCompactSummary') &&
            object.properties.some(property => property.type === 'SpreadElement' &&
              nestedCall(property.argument, '$J'));
        });
        if (requests.length === 1) {
          const requestSource = code.slice(requests[0].start, requests[0].end);
          if (requestSource.includes(COMPACT_REQUEST_MARKER)) results[compactId].patched = true;
          else {
            results[compactId].present = true;
            edit(compactId, requests[0].arguments[0], appendObjectProperties(code,
              requests[0].arguments[0],
              `isMeta:!0,promptSource:"system",origin:{kind:"auto-continuation",version:2,source:"${COMPACT_REQUEST_MARKER}"}`));
          }
        } else {
          results[compactId].present = true;
        }

        const sourceKind = functionName === '_Nr' ? 'full' : functionName === 'yWs' ? 'partial' : 'reactive';
        if (resultCalls.length === 1) {
          const resultObject = resultCalls[0].arguments[0];
          const spread = resultObject.properties.find(property => property.type === 'SpreadElement' &&
            nestedCall(property.argument, '$J'));
          const summaryCall = spread && nestedCall(spread.argument, '$J');
          const summarySource = spread ? code.slice(spread.argument.start, spread.argument.end) : '';
          const resultSource = `compact-summary-${sourceKind}-v2`;
          const resultObjectSource = code.slice(resultObject.start, resultObject.end);
          const compactFlag = objectProperty(resultObject, 'isCompactSummary');
          if (!spread || !summaryCall) {
            results[compactId].present = true;
          } else {
            let changed = false;
            if (!summarySource.includes(COMPACT_HELPER_MARKER)) {
              results[compactId].present = true;
              edit(compactId, spread.argument, compactSanitizerExpression(code, summaryCall, resultSource));
              changed = true;
            }
            if (!resultObjectSource.includes(resultSource)) {
              if (!compactFlag) {
                results[compactId].present = true;
              } else {
                results[compactId].present = true;
                edit(compactId, compactFlag,
                  `${code.slice(compactFlag.start, compactFlag.end)},promptSource:"system",origin:{kind:"auto-continuation",version:2,source:"${resultSource}"}`);
                changed = true;
              }
            }
            if (!changed && summarySource.includes(COMPACT_HELPER_MARKER) &&
                resultObjectSource.includes(resultSource)) results[compactId].patched = true;
          }
        } else {
          results[compactId].present = true;
        }
      }

      if (functionName === 'Uen' || functionName === 'NJ') {
        const returns = [];
        walk(node.body, child => {
          if (child.type === 'ReturnStatement' && child.argument &&
              code.slice(child.argument.start, child.argument.end).includes('Ben(')) returns.push(child);
        });
        if (returns.length === 1) {
          const original = code.slice(returns[0].argument.start, returns[0].argument.end);
          if (original.includes('clawgod-compact-request')) {
            results[compactId].patched = true;
          } else {
            results[compactId].present = true;
            const open = '<clawgod-compact-request version="2" tool-policy="deny">\n';
            const close = '\n</clawgod-compact-request>';
            edit(compactId, returns[0].argument,
              `${JSON.stringify(open)}+(${original})+${JSON.stringify(close)}`);
          }
        }
      }

      if (functionName === 'aQt') {
        const compactRows = [];
        const resumeRows = [];
        walk(node.body, child => {
          if (child.type === 'VariableDeclaration' && child.declarations.length === 1) {
            const declaration = child.declarations[0];
            if (declaration.id.type === 'Identifier' && declaration.id.name === 'Qe' &&
                directCall(declaration.init, 'aHe')) compactRows.push(child);
          }
          if (directCall(child, 'Ie') && child.arguments[0]?.type === 'ObjectExpression') {
            const object = child.arguments[0];
            const content = objectProperty(object, 'content')?.value;
            if (directCall(content, 'FHr') && objectHasProperty(object, 'isMeta')) resumeRows.push(object);
          }
        });
        if (compactRows.length === 1) {
          if (code.slice(node.start, node.end).includes('__clawgodCompactResumeV2')) {
            results[compactId].patched = true;
          } else {
            results[compactId].present = true;
            const original = code.slice(compactRows[0].start, compactRows[0].end);
            const injection = `;globalThis.__clawgodCompactResumeV2=!0;Qe=Qe.map(_clawgodRow=>{if(_clawgodRow?.type!=="user"||_clawgodRow.isCompactSummary!==!0)return _clawgodRow;const _clawgodOrigin=_clawgodRow.origin;if(_clawgodOrigin!==void 0&&(_clawgodOrigin.kind!=="auto-continuation"||![1,2].includes(_clawgodOrigin.version)||!["compact-summary-full-v2","compact-summary-partial-v2","compact-summary-reactive-v2","compact-summary-resume-v2"].includes(_clawgodOrigin.source))){globalThis.__clawgodResumeQuarantine=!0;return null}const _clawgodProvenance=_clawgodOrigin??{kind:"auto-continuation",version:1,source:"compact-summary-resume-v2"};const _clawgodSanitized=globalThis.__clawgodHelpers.${COMPACT_HELPER_MARKER}(_clawgodRow.message?.content,_clawgodProvenance);if(_clawgodSanitized.disposition==="quarantine"){globalThis.__clawgodResumeQuarantine=!0;return null}if(_clawgodSanitized.disposition!=="sanitized")return _clawgodRow;return{..._clawgodRow,message:{..._clawgodRow.message,content:_clawgodSanitized.text},origin:_clawgodOrigin??{kind:"auto-continuation",version:1,source:"compact-summary-resume-v2"}}}).filter(_clawgodRow=>_clawgodRow!==null);`;
            edit(compactId, compactRows[0], original + injection);
          }
        }
        for (const object of resumeRows) {
          const original = code.slice(object.start, object.end);
          if (original.includes(SYNTHETIC_PROVENANCE_MARKER) ||
              original.includes('CLAWGOD_RESUME_PROVENANCE')) results[syntheticId].patched = true;
          else {
            results[syntheticId].present = true;
            edit(syntheticId, object, syntheticMetadata(code, object, SYNTHETIC_PROVENANCE_MARKER,
              'process.env.CLAWGOD_RESUME_PROVENANCE??"runner-resume-v1"'));
          }
        }
      }

      if (functionName === 'e7o') {
        const calls = [];
        walk(node.body, child => {
          if (directCall(child, 'Ie') && child.arguments[0]?.type === 'ObjectExpression') calls.push(child);
        });
        for (const call of calls) {
          const object = call.arguments[0];
          if (!objectProperty(object, 'content') || !objectHasProperty(object, 'isMeta')) continue;
          const original = code.slice(object.start, object.end);
          if (original.includes(SYNTHETIC_PROVENANCE_MARKER) || original.includes('cross-machine-v1')) {
            results[syntheticId].patched = true;
          } else {
            results[syntheticId].present = true;
            edit(syntheticId, object, syntheticMetadata(code, object, SYNTHETIC_PROVENANCE_MARKER,
              '"cross-machine-v1"'));
          }
        }
      }
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
