import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const MAIN_MARKERS = [
  'AIDRAW_E2E_UTILITY_CONTAINMENT',
  'AIDRAW_E2E_FND09_UTILITY_PROFILE',
  'fnd09-utility-containment-probe.json',
  'fnd09-forbidden-network.json',
  'FND-09 packaged raster utility crash/cancel/restart containment',
  'Utility task was cancelled.',
];

const WORKER_MARKERS = [
  'containment-probe',
  'hang',
  'The utility containment probe is unavailable outside isolated packaged QA.',
  'process.crash',
];

const MAX_INTERPRETER_STEPS = 50_000;
const MAX_CALL_DEPTH = 128;
const UNKNOWN_CONSTANT = Symbol('unknown-constant');
const UNDEFINED_VALUE = Object.freeze({ kind: 'primitive', value: undefined });
const NULL_VALUE = Object.freeze({ kind: 'primitive', value: null });
const UNINITIALIZED_VALUE = Object.freeze({ kind: 'uninitialized' });

// This is an RC allowlist, not a semantic model. A production pair may be
// updated only after independent review of the complete extracted sources.
// The fixture identity keeps source tests portable and is never selected by
// scripts/verify-package.mjs.
const EXACT_EMITTED_SUBJECTS = Object.freeze({
  'reviewed-main-worker-pair-20260825-published-pixel-tile-contract': Object.freeze({
    main: Object.freeze({
      bytes: 2_792_944,
      sha256: '89fb235085ff5c8d498ae08ea2d2c7ef37eb55cd2fe5768f7d526212619f4386',
    }),
    worker: Object.freeze({
      bytes: 226_266,
      sha256: '67e5684f1e4dce03350e8caa506de9a4eafe7dbb1ec3cb630cbc5dc6db0581b5',
    }),
  }),
  'reviewed-main-worker-pair-20260825-authoring-contract': Object.freeze({
    main: Object.freeze({
      bytes: 2_786_217,
      sha256: '73779f92fc830f4ef1b99708abebdea2d5196f72f7b75629a7eae042a4c827db',
    }),
    worker: Object.freeze({
      bytes: 226_266,
      sha256: '67e5684f1e4dce03350e8caa506de9a4eafe7dbb1ec3cb630cbc5dc6db0581b5',
    }),
  }),
  'reviewed-main-worker-pair-20260822': Object.freeze({
    main: Object.freeze({
      bytes: 2_725_816,
      sha256: '36df77ab28c0b91d47b2ed0c1e2e8ebd7aa8f1233a8e408c2c01872e75029402',
    }),
    worker: Object.freeze({
      bytes: 211_576,
      sha256: 'd6cf67f957f2f84d4c30d96a6b7e5ec811065e229222d07ed0402c397b530e1c',
    }),
  }),
  'maintained-unit-fixture': Object.freeze({
    main: Object.freeze({
      bytes: 4_772,
      sha256: 'd20d5fe7d4425e4cd52de4c07d3cca5b3cdf02e90960991ec72de7a974810bf0',
    }),
    worker: Object.freeze({
      bytes: 1_068,
      sha256: 'e75a2df63f822f505dcdcc1f6aeae9ddf6b276f6160f365526aa0d1e2ee951ab',
    }),
  }),
});

function emittedSourceIdentity(source) {
  return {
    bytes: Buffer.byteLength(source, 'utf8'),
    sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
  };
}

function exactIdentityMatches(actual, expected) {
  return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
}

function resolveExactEmittedSubject(actual, requestedSubject) {
  if (requestedSubject !== undefined) {
    const expected = EXACT_EMITTED_SUBJECTS[requestedSubject];
    if (!expected) throw new Error(`Unknown packaged utility containment emitted subject: ${requestedSubject}.`);
    return { name: requestedSubject, expected };
  }
  const matches = Object.entries(EXACT_EMITTED_SUBJECTS).filter(([, expected]) => (
    exactIdentityMatches(actual.main, expected.main) || exactIdentityMatches(actual.worker, expected.worker)
  ));
  if (matches.length !== 1) {
    throw new Error('Packaged utility containment exact emitted subject identity mismatch: no unique reviewed subject can be inferred.');
  }
  return { name: matches[0][0], expected: matches[0][1] };
}

class ProofUnsupportedError extends Error {}
class ProofNonTerminationError extends Error {}
class ProofTargetReached extends Error {}
class ProofRuntimeThrow extends Error {
  constructor(value) {
    super('interpreted code threw before subject admission');
    this.value = value;
  }
}

function unwrapExpression(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

function callableBody(node) {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
  ) ? node.body : undefined;
}

function propertyNameText(name, model) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)
    || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const value = constantValue(name.expression, model);
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

function hasStaticModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

function parseJavaScript(source, label) {
  if (typeof source !== 'string') throw new Error(`${label} must be JavaScript source text.`);
  const sourceFile = ts.createSourceFile(`${label}.mjs`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    throw new Error(`${label} is not syntax-valid JavaScript at offset ${first.start ?? 0}.`);
  }
  return sourceFile;
}

function createLexicalModel(sourceFile) {
  let nextScopeId = 1;
  let nextBindingId = 1;
  const scopeForNode = new Map();
  const bindingForName = new Map();
  const bindings = new Set();
  const writes = new Map();
  const callableNodes = new Set();
  const classNodes = new Set();

  const createScope = (parent, kind, node) => ({
    id: nextScopeId++, parent, kind, node, bindings: new Map(),
  });
  const sourceScope = createScope(undefined, 'source', sourceFile);

  const declare = (scope, identifier, declaration, kind, patternPath = []) => {
    let binding = scope.bindings.get(identifier.text);
    if (!binding) {
      binding = {
        id: nextBindingId++,
        name: identifier.text,
        scope,
        declarations: [],
        functionDeclarations: [],
        classDeclarations: [],
      };
      scope.bindings.set(identifier.text, binding);
      bindings.add(binding);
    }
    binding.declarations.push({ declaration, identifier, kind, patternPath });
    if (kind === 'function') binding.functionDeclarations.push(declaration);
    if (kind === 'class') binding.classDeclarations.push(declaration);
    bindingForName.set(identifier, binding);
    return binding;
  };

  const nearestVarScope = (scope) => {
    let current = scope;
    while (current.parent && current.kind !== 'function' && current.kind !== 'source') current = current.parent;
    return current;
  };

  const declarePattern = (scope, pattern, declaration, kind, path = []) => {
    if (ts.isIdentifier(pattern)) {
      declare(scope, pattern, declaration, kind, path);
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) {
          declarePattern(scope, element.name, element, kind, [...path, { kind: 'rest' }]);
          continue;
        }
        const key = element.propertyName
          ? propertyNameText(element.propertyName)
          : ts.isIdentifier(element.name) ? element.name.text : undefined;
        declarePattern(scope, element.name, element, kind, [...path, { kind: 'property', key }]);
      }
      return;
    }
    if (ts.isArrayBindingPattern(pattern)) {
      pattern.elements.forEach((element, index) => {
        if (ts.isBindingElement(element)) declarePattern(scope, element.name, element, kind, [...path, { kind: 'property', key: String(index) }]);
      });
    }
  };

  const build = (node, scope) => {
    if (node === sourceFile) {
      scopeForNode.set(node, sourceScope);
      for (const statement of sourceFile.statements) build(statement, sourceScope);
      return;
    }

    if (callableBody(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) declare(scope, node.name, node, 'function');
      callableNodes.add(node);
      const functionScope = createScope(scope, 'function', node);
      scopeForNode.set(node, functionScope);
      if (ts.isFunctionExpression(node) && node.name) declare(functionScope, node.name, node, 'function');
      for (const parameter of node.parameters) {
        scopeForNode.set(parameter, functionScope);
        declarePattern(functionScope, parameter.name, parameter, 'parameter');
        if (parameter.initializer) build(parameter.initializer, functionScope);
      }
      if (node.body) build(node.body, functionScope);
      return;
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (ts.isClassDeclaration(node) && node.name) declare(scope, node.name, node, 'class');
      classNodes.add(node);
      const classScope = createScope(scope, 'class', node);
      scopeForNode.set(node, classScope);
      if (ts.isClassExpression(node) && node.name) declare(classScope, node.name, node, 'class');
      for (const clause of node.heritageClauses ?? []) build(clause, classScope);
      for (const member of node.members) build(member, classScope);
      return;
    }

    if (ts.isBlock(node)) {
      const blockScope = createScope(scope, 'block', node);
      scopeForNode.set(node, blockScope);
      for (const statement of node.statements) build(statement, blockScope);
      return;
    }

    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
      || ts.isSwitchStatement(node) || ts.isCatchClause(node)) {
      const blockScope = createScope(scope, 'block', node);
      scopeForNode.set(node, blockScope);
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        const declaration = node.variableDeclaration;
        scopeForNode.set(declaration, blockScope);
        declarePattern(blockScope, declaration.name, declaration, 'catch');
      }
      ts.forEachChild(node, (child) => {
        if (!ts.isCatchClause(node) || child !== node.variableDeclaration) build(child, blockScope);
      });
      return;
    }

    scopeForNode.set(node, scope);
    if (ts.isVariableDeclaration(node)) {
      const list = ts.isVariableDeclarationList(node.parent) ? node.parent : undefined;
      const isConst = Boolean(list && (list.flags & ts.NodeFlags.Const));
      const isLet = Boolean(list && (list.flags & ts.NodeFlags.Let));
      const kind = isConst ? 'const' : isLet ? 'let' : 'var';
      const targetScope = kind === 'var' ? nearestVarScope(scope) : scope;
      declarePattern(targetScope, node.name, node, kind);
    }
    ts.forEachChild(node, (child) => build(child, scope));
  };

  build(sourceFile, sourceScope);

  const resolveBinding = (identifier) => {
    if (!ts.isIdentifier(identifier)) return undefined;
    const declared = bindingForName.get(identifier);
    if (declared) return declared;
    let scope = scopeForNode.get(identifier) ?? sourceScope;
    while (scope) {
      const binding = scope.bindings.get(identifier.text);
      if (binding) return binding;
      scope = scope.parent;
    }
    return undefined;
  };

  const recordWrite = (binding, record) => {
    if (!binding) return;
    let records = writes.get(binding);
    if (!records) {
      records = [];
      writes.set(binding, records);
    }
    records.push(record);
  };

  const recordPatternInitialization = (pattern, initializer, declaration) => {
    if (ts.isIdentifier(pattern)) {
      recordWrite(bindingForName.get(pattern), {
        node: declaration,
        expression: initializer,
        kind: 'initialization',
      });
      return;
    }
    for (const element of pattern.elements ?? []) {
      if (ts.isBindingElement(element)) recordPatternInitialization(element.name, initializer, element);
    }
  };

  const collectWrites = (node) => {
    if (ts.isVariableDeclaration(node)) recordPatternInitialization(node.name, node.initializer, node);
    if (ts.isBinaryExpression(node) && [
      ts.SyntaxKind.EqualsToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
    ].includes(node.operatorToken.kind)) {
      const target = unwrapExpression(node.left);
      if (ts.isIdentifier(target)) recordWrite(resolveBinding(target), { node, expression: node.right, kind: 'assignment' });
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      const target = unwrapExpression(node.operand);
      if (ts.isIdentifier(target)) recordWrite(resolveBinding(target), { node, expression: undefined, kind: 'update' });
    }
    ts.forEachChild(node, collectWrites);
  };
  collectWrites(sourceFile);
  for (const records of writes.values()) records.sort((left, right) => left.node.getStart(sourceFile) - right.node.getStart(sourceFile));

  return {
    bindings,
    bindingForName,
    callableNodes,
    classNodes,
    resolveBinding,
    scopeForNode,
    sourceScope,
    writes,
  };
}

function primitive(value) {
  if (value === undefined) return UNDEFINED_VALUE;
  if (value === null) return NULL_VALUE;
  return { kind: 'primitive', value };
}

function constantValue(node, model, seen = new Set()) {
  if (!node) return UNKNOWN_CONSTANT;
  node = unwrapExpression(node);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const binding = model?.resolveBinding(node);
    if (!binding) {
      if (node.text === 'undefined') return undefined;
      if (node.text === 'NaN') return Number.NaN;
      if (node.text === 'Infinity') return Number.POSITIVE_INFINITY;
      return UNKNOWN_CONSTANT;
    }
    if (seen.has(binding)) return UNKNOWN_CONSTANT;
    const records = model.writes.get(binding) ?? [];
    if (records.length !== 1 || !records[0].expression) return UNKNOWN_CONSTANT;
    seen.add(binding);
    const value = constantValue(records[0].expression, model, seen);
    seen.delete(binding);
    return value;
  }
  if (ts.isVoidExpression(node)) return undefined;
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = constantValue(node.operand, model, seen);
    if (operand === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT;
    if (node.operator === ts.SyntaxKind.ExclamationToken) return !operand;
    if (node.operator === ts.SyntaxKind.PlusToken) return Number(operand);
    if (node.operator === ts.SyntaxKind.MinusToken) return -Number(operand);
    if (node.operator === ts.SyntaxKind.TildeToken) return ~Number(operand);
  }
  if (ts.isConditionalExpression(node)) {
    const condition = constantValue(node.condition, model, seen);
    if (condition === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT;
    return constantValue(condition ? node.whenTrue : node.whenFalse, model, seen);
  }
  if (ts.isBinaryExpression(node)) {
    const left = constantValue(node.left, model, seen);
    if (left === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT;
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return left ? constantValue(node.right, model, seen) : left;
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return left ? left : constantValue(node.right, model, seen);
    }
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return left === null || left === undefined ? constantValue(node.right, model, seen) : left;
    }
    const right = constantValue(node.right, model, seen);
    if (right === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsToken: return left == right;
      case ts.SyntaxKind.ExclamationEqualsToken: return left != right;
      case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right;
      case ts.SyntaxKind.LessThanToken: return left < right;
      case ts.SyntaxKind.LessThanEqualsToken: return left <= right;
      case ts.SyntaxKind.GreaterThanToken: return left > right;
      case ts.SyntaxKind.GreaterThanEqualsToken: return left >= right;
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.SlashToken: return left / right;
      case ts.SyntaxKind.PercentToken: return left % right;
      default: return UNKNOWN_CONSTANT;
    }
  }
  return UNKNOWN_CONSTANT;
}

function walk(root, callback) {
  const visit = (node) => {
    callback(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function descendants(root, predicate) {
  const matches = [];
  walk(root, (node) => {
    if (predicate(node)) matches.push(node);
  });
  return matches;
}

function nodeContainsText(node, sourceFile, text) {
  return node.getText(sourceFile).includes(text);
}

function expressionMemberName(expression, model) {
  expression = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const value = constantValue(expression.argumentExpression, model);
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

function expressionReceiver(expression) {
  expression = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return expression.expression;
  return undefined;
}

function isOptionalAccess(node) {
  return Boolean(node.questionDotToken)
    || (typeof ts.isPropertyAccessChain === 'function' && ts.isPropertyAccessChain(node))
    || (typeof ts.isElementAccessChain === 'function' && ts.isElementAccessChain(node))
    || (typeof ts.isCallChain === 'function' && ts.isCallChain(node));
}

function samePrimitive(left, right) {
  return left.kind === 'primitive' && right.kind === 'primitive' && Object.is(left.value, right.value);
}

function truthy(value) {
  if (value.kind !== 'primitive') return true;
  return Boolean(value.value);
}

function nullish(value) {
  return value.kind === 'primitive' && (value.value === null || value.value === undefined);
}

/**
 * Interpret only the enclosing installation language up to the inner emitted
 * chunk's strict-mode boundary. State is deliberately concrete: each call has
 * a fresh lexical frame, every allocation has its own property map, and writes
 * replace values. An operation that cannot be justified by this language stops
 * the proof instead of adding an optimistic edge.
 */
function createReachabilityInterpreter({ sourceFile, model, target, context }) {
  let steps = 0;
  let nextObjectId = 1;
  const activeCallables = [];
  const microtasks = [];
  const timers = [];
  let nextTimerOrder = 0;
  const readyPromises = [];
  const parentPortRegistrations = [];
  let platformEventsPublished = false;

  const unsupported = (node, reason) => {
    const offset = node?.getStart(sourceFile) ?? 0;
    throw new ProofUnsupportedError(`${reason} at offset ${offset}`);
  };

  const step = (node) => {
    steps += 1;
    if (steps > MAX_INTERPRETER_STEPS) unsupported(node, `proof exceeded its deterministic ${MAX_INTERPRETER_STEPS}-step bound`);
  };

  const makeFunction = (node, environment) => ({ kind: 'function', node, environment });
  const makeClass = (node, environment) => ({ kind: 'class', node, environment });

  const createFrame = (scope, parent, thisValue = UNDEFINED_VALUE) => {
    const frame = { scope, parent, thisValue, values: new Map() };
    for (const binding of scope.bindings.values()) {
      if (binding.functionDeclarations.length === 1) frame.values.set(binding, makeFunction(binding.functionDeclarations[0], frame));
      else if (binding.declarations.some((declaration) => declaration.kind === 'var')) frame.values.set(binding, UNDEFINED_VALUE);
      else frame.values.set(binding, UNINITIALIZED_VALUE);
    }
    return frame;
  };

  const frameForBinding = (binding, environment) => {
    let frame = environment;
    while (frame && frame.scope !== binding.scope) frame = frame.parent;
    if (!frame) unsupported(binding.declarations[0]?.declaration, `binding ${binding.name} has no live lexical frame`);
    return frame;
  };

  const readBinding = (binding, environment) => {
    const frame = frameForBinding(binding, environment);
    const value = frame.values.get(binding) ?? UNINITIALIZED_VALUE;
    if (value.kind === 'uninitialized') unsupported(binding.declarations[0]?.declaration, `binding ${binding.name} is read before initialization`);
    return value;
  };

  const writeBinding = (binding, value, environment) => {
    frameForBinding(binding, environment).values.set(binding, value);
  };

  const globalValue = (identifier) => {
    switch (identifier.text) {
      case 'undefined': return UNDEFINED_VALUE;
      case 'NaN': return primitive(Number.NaN);
      case 'Infinity': return primitive(Number.POSITIVE_INFINITY);
      case 'Promise': return { kind: 'native-promise-constructor' };
      case 'process': return { kind: 'platform-process' };
      case 'require': return { kind: 'require-function' };
      case 'setTimeout':
      case 'setImmediate': return { kind: 'global-scheduler', name: identifier.text, queue: 'timer' };
      case 'queueMicrotask': return { kind: 'global-scheduler', name: identifier.text, queue: 'microtask' };
      case 'clearTimeout':
      case 'clearImmediate': return { kind: 'global-timer-canceller', name: identifier.text };
      case 'setInterval': return { kind: 'unsupported-recurring-scheduler', name: identifier.text };
      case 'AbortController': return { kind: 'abort-controller-class' };
      default: unsupported(identifier, `unresolved global ${identifier.text} is outside the accepted proof language`);
    }
  };

  const propertyKey = (name, environment) => {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)
      || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return String(name.text);
    if (ts.isComputedPropertyName(name)) {
      const value = evaluateExpression(name.expression, environment);
      if (value.kind === 'primitive' && (typeof value.value === 'string' || typeof value.value === 'number')) return String(value.value);
    }
    unsupported(name, 'computed property key is not statically known');
  };

  const allocateObject = (node, classValue) => ({
    kind: 'object', id: nextObjectId++, node, classValue, properties: new Map(),
  });

  const classMember = (classValue, name, wantStatic) => classValue.node.members.find((member) => (
    ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)
  ) && hasStaticModifier(member) === wantStatic && propertyKey(member.name, classValue.environment) === name);

  const readProperty = (owner, name, node) => {
    if (owner.kind === 'object') {
      if (owner.properties.has(name)) return owner.properties.get(name);
      if (owner.classValue) {
        const member = classMember(owner.classValue, name, false);
        if (member) return makeFunction(member, owner.classValue.environment);
      }
      return UNDEFINED_VALUE;
    }
    if (owner.kind === 'class') {
      const member = classMember(owner, name, true);
      return member ? makeFunction(member, owner.environment) : UNDEFINED_VALUE;
    }
    if (owner.kind === 'native-promise-constructor' && name === 'resolve') return { kind: 'native-promise-resolve' };
    if (owner.kind === 'native-promise' && ['then', 'catch', 'finally'].includes(name)) {
      return { kind: 'native-promise-method', name, promise: owner };
    }
    if (owner.kind === 'platform-process' && name === 'parentPort') {
      return context === 'worker' ? { kind: 'platform-parent-port' } : UNDEFINED_VALUE;
    }
    if (owner.kind === 'platform-process' && name === 'nextTick') {
      return { kind: 'global-scheduler', name: 'process.nextTick', queue: 'microtask' };
    }
    if (owner.kind === 'platform-parent-port' && ['on', 'once', 'addListener', 'prependListener'].includes(name)) {
      return { kind: 'parent-port-registration', name, receiver: owner };
    }
    if (owner.kind === 'abort-controller' && name === 'signal') return owner.signal;
    if (owner.kind === 'abort-controller' && name === 'abort') return { kind: 'abort-method', receiver: owner };
    if (owner.kind === 'abort-signal' && name === 'addEventListener') {
      return { kind: 'abort-registration', name, receiver: owner };
    }
    if (owner.kind === 'electron-module' && name === 'app') return { kind: 'electron-app' };
    if (owner.kind === 'electron-app' && name === 'whenReady') return { kind: 'electron-when-ready' };
    if (owner.kind === 'electron-app' && name === 'on') return { kind: 'electron-app-registration', receiver: owner };
    unsupported(node, `property ${name} has no proven receiver contract`);
  };

  const writeProperty = (owner, name, value, node) => {
    if (owner.kind !== 'object') unsupported(node, `cannot assign property ${name} on an unproven receiver`);
    owner.properties.set(name, value);
  };

  const evaluateReference = (node, environment) => {
    node = unwrapExpression(node);
    if (ts.isIdentifier(node)) {
      const binding = model.resolveBinding(node);
      return {
        value: binding ? readBinding(binding, environment) : globalValue(node),
        receiver: UNDEFINED_VALUE,
        skipped: false,
        set: binding ? (value) => writeBinding(binding, value, environment) : undefined,
      };
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const owner = evaluateExpression(node.expression, environment);
      if (isOptionalAccess(node) && nullish(owner)) return { value: UNDEFINED_VALUE, receiver: owner, skipped: true };
      if (nullish(owner)) unsupported(node, 'property access on a nullish receiver');
      let name;
      if (ts.isPropertyAccessExpression(node)) name = node.name.text;
      else if (node.argumentExpression) {
        const key = evaluateExpression(node.argumentExpression, environment);
        if (key.kind === 'primitive' && (typeof key.value === 'string' || typeof key.value === 'number')) name = String(key.value);
        else unsupported(node.argumentExpression, 'computed property key is not statically known');
      } else unsupported(node, 'element access has no key');
      return {
        value: readProperty(owner, name, node),
        receiver: owner,
        skipped: false,
        set: (value) => writeProperty(owner, name, value, node),
      };
    }
    unsupported(node, 'assignment/call target is outside the accepted proof language');
  };

  const bindPattern = (pattern, value, environment) => {
    if (ts.isIdentifier(pattern)) {
      const binding = model.bindingForName.get(pattern) ?? model.resolveBinding(pattern);
      if (!binding) unsupported(pattern, `declaration ${pattern.text} has no lexical binding`);
      writeBinding(binding, value, environment);
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) unsupported(element, 'rest destructuring is outside the accepted proof language');
        const name = element.propertyName
          ? propertyKey(element.propertyName, environment)
          : ts.isIdentifier(element.name) ? element.name.text : unsupported(element, 'nested shorthand destructuring needs an explicit property');
        let property = readProperty(value, name, element);
        if (property.kind === 'primitive' && property.value === undefined && element.initializer) {
          property = evaluateExpression(element.initializer, environment);
        }
        bindPattern(element.name, property, environment);
      }
      return;
    }
    if (ts.isArrayBindingPattern(pattern)) {
      pattern.elements.forEach((element, index) => {
        if (!ts.isBindingElement(element)) return;
        if (element.dotDotDotToken) unsupported(element, 'rest destructuring is outside the accepted proof language');
        let property = readProperty(value, String(index), element);
        if (property.kind === 'primitive' && property.value === undefined && element.initializer) {
          property = evaluateExpression(element.initializer, environment);
        }
        bindPattern(element.name, property, environment);
      });
      return;
    }
    unsupported(pattern, 'binding pattern is outside the accepted proof language');
  };

  const createPromise = () => ({
    kind: 'native-promise',
    state: 'pending',
    fulfillment: UNDEFINED_VALUE,
    locked: false,
    reactions: [],
  });

  const scheduleMicrotask = (task) => {
    microtasks.push(task);
  };

  const publishPromise = (promise, state, value) => {
    if (promise.state !== 'pending') return;
    promise.state = state;
    promise.fulfillment = value;
    const reactions = promise.reactions.splice(0);
    for (const reaction of reactions) scheduleMicrotask(() => reaction(state, value));
  };

  const resolvePromise = (promise, value) => {
    if (promise.locked) return;
    promise.locked = true;
    if (value === promise) {
      publishPromise(promise, 'rejected', primitive('promise self-resolution'));
      return;
    }
    if (value?.kind === 'native-promise') {
      const adopt = (state, settledValue) => publishPromise(promise, state, settledValue);
      if (value.state === 'pending') value.reactions.push(adopt);
      else scheduleMicrotask(() => adopt(value.state, value.fulfillment));
      return;
    }
    if (value?.kind === 'object') {
      const ownThen = value.properties.get('then');
      const inheritedThen = value.classValue && classMember(value.classValue, 'then', false);
      if ((ownThen && !(ownThen.kind === 'primitive' && ownThen.value === undefined)) || inheritedThen) {
        throw new ProofUnsupportedError('non-native thenable adoption is outside the accepted proof language');
      }
    }
    publishPromise(promise, 'fulfilled', value);
  };

  const rejectPromise = (promise, value) => {
    if (promise.locked) return;
    promise.locked = true;
    publishPromise(promise, 'rejected', value);
  };

  const invokeFunction = (functionValue, receiver, arguments_, callNode) => {
    const node = functionValue.node;
    if (activeCallables.length >= MAX_CALL_DEPTH) unsupported(callNode, `proof exceeded its deterministic ${MAX_CALL_DEPTH}-call-depth bound`);
    activeCallables.push(node);
    const isAsync = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    try {
      const functionScope = model.scopeForNode.get(node);
      if (!functionScope) unsupported(node, 'callable has no lexical scope');
      const functionFrame = createFrame(functionScope, functionValue.environment, ts.isArrowFunction(node)
        ? functionValue.environment.thisValue
        : receiver);
      for (let index = 0; index < node.parameters.length; index += 1) {
        const parameter = node.parameters[index];
        let argument = arguments_[index] ?? UNDEFINED_VALUE;
        if (argument.kind === 'primitive' && argument.value === undefined && parameter.initializer) {
          argument = evaluateExpression(parameter.initializer, functionFrame);
        }
        bindPattern(parameter.name, argument, functionFrame);
      }
      let completion;
      if (ts.isBlock(node.body)) completion = executeContainer(node.body, functionFrame);
      else completion = { kind: 'return', value: evaluateExpression(node.body, functionFrame) };
      const returned = completion?.kind === 'return' ? completion.value : UNDEFINED_VALUE;
      if (completion?.kind === 'throw') {
        if (!isAsync) throw new ProofRuntimeThrow(completion.value);
        const rejected = createPromise();
        rejectPromise(rejected, completion.value);
        return rejected;
      }
      if (!isAsync) return returned;
      const result = createPromise();
      resolvePromise(result, returned);
      return result;
    } catch (error) {
      if (!isAsync) throw error;
      if (error instanceof ProofTargetReached) throw error;
      if (error instanceof ProofUnsupportedError) throw error;
      const result = createPromise();
      if (error instanceof ProofRuntimeThrow) rejectPromise(result, error.value);
      else if (error instanceof ProofNonTerminationError) result.locked = true;
      else throw error;
      return result;
    } finally {
      activeCallables.pop();
    }
  };

  const constructClass = (classValue, arguments_, node) => {
    if ((classValue.node.heritageClauses?.length ?? 0) > 0) {
      unsupported(node, 'derived-class construction is outside the accepted proof language');
    }
    const instance = allocateObject(node, classValue);
    const constructor = classValue.node.members.find(ts.isConstructorDeclaration);
    if (constructor) invokeFunction(makeFunction(constructor, classValue.environment), instance, arguments_, node);
    return instance;
  };

  const chainPromise = (source, onFulfilled, onRejected, callNode, isFinally = false) => {
    const result = createPromise();
    const reaction = (state, value) => {
      try {
        if (isFinally) {
          if (onFulfilled?.kind !== 'function') {
            if (state === 'fulfilled') resolvePromise(result, value);
            else rejectPromise(result, value);
            return;
          }
          const finalizerResult = invokeFunction(onFulfilled, UNDEFINED_VALUE, [], callNode);
          const continuation = createPromise();
          resolvePromise(continuation, finalizerResult);
          const resume = (finalizerState, finalizerValue) => {
            if (finalizerState === 'rejected') rejectPromise(result, finalizerValue);
            else if (state === 'fulfilled') resolvePromise(result, value);
            else rejectPromise(result, value);
          };
          if (continuation.state === 'pending') continuation.reactions.push(resume);
          else scheduleMicrotask(() => resume(continuation.state, continuation.fulfillment));
          return;
        }
        const callback = state === 'fulfilled' ? onFulfilled : onRejected;
        if (callback?.kind !== 'function') {
          if (state === 'fulfilled') resolvePromise(result, value);
          else rejectPromise(result, value);
          return;
        }
        resolvePromise(result, invokeFunction(callback, UNDEFINED_VALUE, [value], callNode));
      } catch (error) {
        if (error instanceof ProofTargetReached || error instanceof ProofUnsupportedError) throw error;
        if (error instanceof ProofRuntimeThrow) rejectPromise(result, error.value);
        else if (error instanceof ProofNonTerminationError) result.locked = true;
        else throw error;
      }
    };
    if (source.state === 'pending') source.reactions.push(reaction);
    else scheduleMicrotask(() => reaction(source.state, source.fulfillment));
    return result;
  };

  const invoke = (callee, receiver, arguments_, node, isNew) => {
    if (callee.kind === 'function' && !isNew) return invokeFunction(callee, receiver, arguments_, node);
    if (callee.kind === 'class' && isNew) return constructClass(callee, arguments_, node);
    if (callee.kind === 'require-function' && !isNew) {
      const requested = arguments_[0];
      if (context === 'main' && requested?.kind === 'primitive' && requested.value === 'electron') return { kind: 'electron-module' };
      unsupported(node, 'only the main-process electron module has a proven require contract');
    }
    if (callee.kind === 'native-promise-constructor' && isNew) {
      const executor = arguments_[0];
      if (!executor || executor.kind !== 'function') unsupported(node, 'native Promise requires a proven lexical executor');
      const promise = createPromise();
      const resolve = { kind: 'promise-settler', settle: (value) => resolvePromise(promise, value) };
      const reject = { kind: 'promise-settler', settle: (value) => rejectPromise(promise, value) };
      try {
        invokeFunction(executor, UNDEFINED_VALUE, [resolve, reject], node);
      } catch (error) {
        if (error instanceof ProofRuntimeThrow) rejectPromise(promise, error.value);
        else throw error;
      }
      return promise;
    }
    if (callee.kind === 'native-promise-resolve' && !isNew) {
      const value = arguments_[0] ?? UNDEFINED_VALUE;
      if (value.kind === 'native-promise') return value;
      const promise = createPromise();
      resolvePromise(promise, value);
      return promise;
    }
    if (callee.kind === 'native-promise-method' && !isNew) {
      if (callee.name === 'finally') return chainPromise(callee.promise, arguments_[0], undefined, node, true);
      if (callee.name === 'catch') return chainPromise(callee.promise, undefined, arguments_[0], node);
      return chainPromise(callee.promise, arguments_[0], arguments_[1], node);
    }
    if (callee.kind === 'global-scheduler' && !isNew) {
      const callback = arguments_[0];
      if (callback?.kind !== 'function') unsupported(node, `${callee.name} requires a proven lexical callback`);
      if (callee.queue === 'microtask') {
        scheduleMicrotask(() => invokeFunction(callback, UNDEFINED_VALUE, arguments_.slice(1), node));
        return UNDEFINED_VALUE;
      }
      const timer = { kind: 'timer-handle', cancelled: false };
      let delay = 0;
      if (callee.name === 'setTimeout' && arguments_[1]) {
        const requested = arguments_[1];
        if (requested.kind !== 'primitive' || typeof requested.value !== 'number' || !Number.isFinite(requested.value)) {
          unsupported(node, 'setTimeout delay must be a proven finite number');
        }
        delay = Math.max(0, requested.value);
      }
      timers.push({
        timer,
        callback,
        arguments_: arguments_.slice(callee.name === 'setTimeout' ? 2 : 1),
        node,
        phase: callee.name === 'setImmediate' ? 1 : 0,
        delay,
        order: nextTimerOrder++,
      });
      return timer;
    }
    if (callee.kind === 'global-timer-canceller' && !isNew) {
      const timer = arguments_[0];
      if (timer?.kind !== 'timer-handle') unsupported(node, `${callee.name} requires a proven timer handle`);
      timer.cancelled = true;
      return UNDEFINED_VALUE;
    }
    if (callee.kind === 'unsupported-recurring-scheduler') unsupported(node, 'recurring scheduler reachability is not modeled');
    if (callee.kind === 'parent-port-registration' && !isNew) {
      const event = arguments_[0];
      const callback = arguments_[1];
      if (callback?.kind !== 'function' || event?.kind !== 'primitive' || typeof event.value !== 'string') {
        unsupported(node, `${callee.name} requires one literal event and a proven lexical callback`);
      }
      if (event.value === 'message') parentPortRegistrations.push({ callback, node });
      return callee.receiver;
    }
    if (callee.kind === 'abort-registration' && !isNew) {
      const event = arguments_[0];
      const callback = arguments_[1];
      if (event?.kind !== 'primitive' || event.value !== 'abort' || callback?.kind !== 'function') {
        unsupported(node, 'AbortSignal registration requires the literal abort event and a proven callback');
      }
      callee.receiver.listeners.push({ callback, node, once: true });
      return UNDEFINED_VALUE;
    }
    if (callee.kind === 'electron-when-ready' && !isNew) {
      const promise = createPromise();
      readyPromises.push(promise);
      return promise;
    }
    if (callee.kind === 'electron-app-registration' && !isNew) {
      unsupported(node, 'generic Electron app events are outside the wrapper proof language');
    }
    if (callee.kind === 'abort-controller-class' && isNew) {
      const controller = { kind: 'abort-controller', aborted: false, signal: { kind: 'abort-signal', aborted: false, listeners: [] } };
      return controller;
    }
    if (callee.kind === 'abort-method' && !isNew) {
      const controller = callee.receiver;
      if (controller.aborted) return UNDEFINED_VALUE;
      controller.aborted = true;
      controller.signal.aborted = true;
      const listeners = controller.signal.listeners.splice(0);
      for (const listener of listeners) invokeFunction(listener.callback, UNDEFINED_VALUE, [allocateObject(node)], listener.node);
      return UNDEFINED_VALUE;
    }
    if (callee.kind === 'promise-settler' && !isNew) {
      callee.settle(arguments_[0] ?? UNDEFINED_VALUE);
      return UNDEFINED_VALUE;
    }
    unsupported(node, `${isNew ? 'construction' : 'call'} has no proven lexical or platform contract`);
  };

  function evaluateExpression(node, environment) {
    step(node);
    node = unwrapExpression(node);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return primitive(true);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return primitive(false);
    if (node.kind === ts.SyntaxKind.NullKeyword) return NULL_VALUE;
    if (ts.isNumericLiteral(node)) return primitive(Number(node.text));
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return primitive(node.text);
    if (ts.isIdentifier(node)) return evaluateReference(node, environment).value;
    if (node.kind === ts.SyntaxKind.ThisKeyword) return environment.thisValue;
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return makeFunction(node, environment);
    if (ts.isClassExpression(node)) return makeClass(node, environment);
    if (ts.isObjectLiteralExpression(node)) {
      const object = allocateObject(node);
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          object.properties.set(propertyKey(property.name, environment), evaluateExpression(property.initializer, environment));
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const binding = model.resolveBinding(property.name);
          if (!binding) unsupported(property, `shorthand ${property.name.text} has no lexical binding`);
          object.properties.set(property.name.text, readBinding(binding, environment));
        } else if (ts.isMethodDeclaration(property)) {
          object.properties.set(propertyKey(property.name, environment), makeFunction(property, environment));
        } else unsupported(property, 'object spread/accessors are outside the accepted proof language');
      }
      return object;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const array = allocateObject(node);
      node.elements.forEach((element, index) => array.properties.set(String(index), evaluateExpression(element, environment)));
      array.properties.set('length', primitive(node.elements.length));
      return array;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return evaluateReference(node, environment).value;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const calleeExpression = unwrapExpression(node.expression);
      const reference = ts.isIdentifier(calleeExpression) || ts.isPropertyAccessExpression(calleeExpression)
        || ts.isElementAccessExpression(calleeExpression)
        ? evaluateReference(calleeExpression, environment)
        : { value: evaluateExpression(calleeExpression, environment), receiver: UNDEFINED_VALUE, skipped: false };
      if (reference.skipped || (isOptionalAccess(node) && nullish(reference.value))) return UNDEFINED_VALUE;
      const arguments_ = (node.arguments ?? []).map((argument) => {
        if (ts.isSpreadElement(argument)) unsupported(argument, 'spread call arguments are outside the accepted proof language');
        return evaluateExpression(argument, environment);
      });
      return invoke(reference.value, reference.receiver, arguments_, node, ts.isNewExpression(node));
    }
    if (ts.isAwaitExpression(node)) {
      const value = evaluateExpression(node.expression, environment);
      if (value.kind !== 'native-promise') return value;
      if (value.state === 'pending') throw new ProofNonTerminationError(`awaited promise cannot settle before subject admission at offset ${node.getStart(sourceFile)}`);
      if (value.state === 'rejected') unsupported(node, 'rejected promise flow requires an explicit catch before subject admission');
      return value.fulfillment;
    }
    if (ts.isVoidExpression(node)) {
      evaluateExpression(node.expression, environment);
      return UNDEFINED_VALUE;
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const operand = evaluateExpression(node.operand, environment);
      if (operand.kind !== 'primitive') unsupported(node, 'unary operation requires a primitive');
      if (node.operator === ts.SyntaxKind.ExclamationToken) return primitive(!truthy(operand));
      if (node.operator === ts.SyntaxKind.PlusToken) return primitive(Number(operand.value));
      if (node.operator === ts.SyntaxKind.MinusToken) return primitive(-Number(operand.value));
      if (node.operator === ts.SyntaxKind.TildeToken) return primitive(~Number(operand.value));
      unsupported(node, 'unary operation is outside the accepted proof language');
    }
    if (ts.isConditionalExpression(node)) {
      const condition = evaluateExpression(node.condition, environment);
      return evaluateExpression(truthy(condition) ? node.whenTrue : node.whenFalse, environment);
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if ([
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
      ].includes(operator)) {
        const reference = evaluateReference(node.left, environment);
        if (!reference.set) unsupported(node.left, 'assignment target cannot be updated');
        if (operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken && !truthy(reference.value)) return reference.value;
        if (operator === ts.SyntaxKind.BarBarEqualsToken && truthy(reference.value)) return reference.value;
        if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken && !nullish(reference.value)) return reference.value;
        const value = evaluateExpression(node.right, environment);
        reference.set(value);
        return value;
      }
      const left = evaluateExpression(node.left, environment);
      if (operator === ts.SyntaxKind.CommaToken) return evaluateExpression(node.right, environment);
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return truthy(left) ? evaluateExpression(node.right, environment) : left;
      if (operator === ts.SyntaxKind.BarBarToken) return truthy(left) ? left : evaluateExpression(node.right, environment);
      if (operator === ts.SyntaxKind.QuestionQuestionToken) return nullish(left) ? evaluateExpression(node.right, environment) : left;
      const right = evaluateExpression(node.right, environment);
      if (left.kind !== 'primitive' || right.kind !== 'primitive') unsupported(node, 'binary operation requires proven primitives');
      switch (operator) {
        case ts.SyntaxKind.EqualsEqualsToken: return primitive(left.value == right.value);
        case ts.SyntaxKind.ExclamationEqualsToken: return primitive(left.value != right.value);
        case ts.SyntaxKind.EqualsEqualsEqualsToken: return primitive(left.value === right.value);
        case ts.SyntaxKind.ExclamationEqualsEqualsToken: return primitive(left.value !== right.value);
        case ts.SyntaxKind.LessThanToken: return primitive(left.value < right.value);
        case ts.SyntaxKind.LessThanEqualsToken: return primitive(left.value <= right.value);
        case ts.SyntaxKind.GreaterThanToken: return primitive(left.value > right.value);
        case ts.SyntaxKind.GreaterThanEqualsToken: return primitive(left.value >= right.value);
        case ts.SyntaxKind.PlusToken: return primitive(left.value + right.value);
        case ts.SyntaxKind.MinusToken: return primitive(left.value - right.value);
        case ts.SyntaxKind.AsteriskToken: return primitive(left.value * right.value);
        case ts.SyntaxKind.SlashToken: return primitive(left.value / right.value);
        case ts.SyntaxKind.PercentToken: return primitive(left.value % right.value);
        default: unsupported(node, 'binary operator is outside the accepted proof language');
      }
    }
    if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) unsupported(node, 'updates are outside the accepted proof language');
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const expression = evaluateExpression(span.expression, environment);
        if (expression.kind !== 'primitive') unsupported(span.expression, 'template interpolation requires a primitive');
        value += String(expression.value) + span.literal.text;
      }
      return primitive(value);
    }
    unsupported(node, `expression kind ${ts.SyntaxKind[node.kind]} is outside the accepted proof language`);
  }

  const executeVariableDeclaration = (declaration, environment) => {
    const value = declaration.initializer ? evaluateExpression(declaration.initializer, environment) : UNDEFINED_VALUE;
    bindPattern(declaration.name, value, environment);
  };

  const executeCase = (clause, environment) => {
    if (clause === target) throw new ProofTargetReached();
    for (const statement of clause.statements) {
      const completion = executeStatement(statement, environment);
      if (completion) return completion;
    }
    return undefined;
  };

  function executeContainer(container, parentEnvironment) {
    step(container);
    if (container === target) throw new ProofTargetReached();
    const scope = model.scopeForNode.get(container);
    const environment = scope && scope !== parentEnvironment.scope ? createFrame(scope, parentEnvironment, parentEnvironment.thisValue) : parentEnvironment;
    for (const statement of container.statements) {
      const completion = executeStatement(statement, environment);
      if (completion) return completion;
    }
    return undefined;
  }

  function executeStatement(statement, environment) {
    step(statement);
    if (statement === target) throw new ProofTargetReached();
    if (ts.isBlock(statement)) return executeContainer(statement, environment);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) executeVariableDeclaration(declaration, environment);
      return undefined;
    }
    if (ts.isExpressionStatement(statement)) {
      evaluateExpression(statement.expression, environment);
      return undefined;
    }
    if (ts.isFunctionDeclaration(statement) || ts.isEmptyStatement(statement)) return undefined;
    if (ts.isClassDeclaration(statement)) {
      if (!statement.name) unsupported(statement, 'class declaration has no lexical name');
      const binding = model.resolveBinding(statement.name);
      if (!binding) unsupported(statement, 'class declaration has no lexical binding');
      writeBinding(binding, makeClass(statement, environment), environment);
      return undefined;
    }
    if (ts.isIfStatement(statement)) {
      const condition = evaluateExpression(statement.expression, environment);
      if (truthy(condition)) return executeStatement(statement.thenStatement, environment);
      return statement.elseStatement ? executeStatement(statement.elseStatement, environment) : undefined;
    }
    if (ts.isReturnStatement(statement)) {
      return { kind: 'return', value: statement.expression ? evaluateExpression(statement.expression, environment) : UNDEFINED_VALUE };
    }
    if (ts.isThrowStatement(statement)) {
      return { kind: 'throw', value: statement.expression ? evaluateExpression(statement.expression, environment) : UNDEFINED_VALUE };
    }
    if (ts.isTryStatement(statement)) {
      let completion = executeContainer(statement.tryBlock, environment);
      if (completion?.kind === 'throw' && statement.catchClause) {
        const catchScope = model.scopeForNode.get(statement.catchClause);
        const catchEnvironment = createFrame(catchScope, environment, environment.thisValue);
        if (statement.catchClause.variableDeclaration) bindPattern(statement.catchClause.variableDeclaration.name, completion.value, catchEnvironment);
        completion = executeContainer(statement.catchClause.block, catchEnvironment);
      }
      if (statement.finallyBlock) completion = executeContainer(statement.finallyBlock, environment) ?? completion;
      return completion;
    }
    if (ts.isSwitchStatement(statement)) {
      const switchScope = model.scopeForNode.get(statement);
      const switchEnvironment = createFrame(switchScope, environment, environment.thisValue);
      const discriminant = evaluateExpression(statement.expression, switchEnvironment);
      if (discriminant.kind !== 'primitive') unsupported(statement.expression, 'switch discriminant is not a proven primitive');
      let selected = -1;
      let defaultIndex = -1;
      for (let index = 0; index < statement.caseBlock.clauses.length; index += 1) {
        const clause = statement.caseBlock.clauses[index];
        if (ts.isDefaultClause(clause)) defaultIndex = index;
        else {
          const value = evaluateExpression(clause.expression, switchEnvironment);
          if (value.kind !== 'primitive') unsupported(clause.expression, 'switch case is not a proven primitive');
          if (samePrimitive(discriminant, value)) {
            selected = index;
            break;
          }
        }
      }
      if (selected < 0) selected = defaultIndex;
      if (selected < 0) return undefined;
      for (let index = selected; index < statement.caseBlock.clauses.length; index += 1) {
        const completion = executeCase(statement.caseBlock.clauses[index], switchEnvironment);
        if (completion?.kind === 'break') return undefined;
        if (completion) return completion;
      }
      return undefined;
    }
    if (ts.isBreakStatement(statement)) return { kind: 'break' };
    if (ts.isWhileStatement(statement)) {
      const condition = evaluateExpression(statement.expression, environment);
      if (!truthy(condition)) return undefined;
      const completion = executeStatement(statement.statement, environment);
      if (completion?.kind === 'break') return undefined;
      if (completion) return completion;
      throw new ProofNonTerminationError(`loop cannot be proven to terminate before subject admission at offset ${statement.getStart(sourceFile)}`);
    }
    if (ts.isForStatement(statement)) {
      if (statement.initializer) {
        if (ts.isVariableDeclarationList(statement.initializer)) {
          for (const declaration of statement.initializer.declarations) executeVariableDeclaration(declaration, environment);
        } else evaluateExpression(statement.initializer, environment);
      }
      if (statement.condition && !truthy(evaluateExpression(statement.condition, environment))) return undefined;
      const completion = executeStatement(statement.statement, environment);
      if (completion?.kind === 'break') return undefined;
      if (completion) return completion;
      throw new ProofNonTerminationError(`for-loop cannot be proven to terminate before subject admission at offset ${statement.getStart(sourceFile)}`);
    }
    unsupported(statement, `statement kind ${ts.SyntaxKind[statement.kind]} is outside the accepted proof language`);
  }

  return {
    prove() {
      try {
        const root = createFrame(model.sourceScope, undefined);
        const completion = executeContainer(sourceFile, root);
        if (completion?.kind === 'throw') throw new ProofRuntimeThrow(completion.value);

        const drainMicrotasks = () => {
          while (microtasks.length > 0) {
            const task = microtasks.shift();
            task();
          }
        };
        drainMicrotasks();

        // These are the only lifecycle events admitted by this wrapper proof.
        // They are published once, after synchronous module evaluation, and the
        // promise/event jobs they create retain ordinary microtask ordering.
        if (!platformEventsPublished) {
          platformEventsPublished = true;
          if (context === 'main') {
            for (const promise of readyPromises) resolvePromise(promise, UNDEFINED_VALUE);
          } else if (context === 'worker') {
            for (const registration of parentPortRegistrations) {
              scheduleMicrotask(() => invokeFunction(registration.callback, { kind: 'platform-parent-port' }, [allocateObject(registration.node)], registration.node));
            }
          }
        }
        drainMicrotasks();

        while (timers.length > 0) {
          timers.sort((left, right) => left.phase - right.phase || left.delay - right.delay || left.order - right.order);
          const scheduled = timers.shift();
          if (!scheduled.timer.cancelled) invokeFunction(scheduled.callback, UNDEFINED_VALUE, scheduled.arguments_, scheduled.node);
          drainMicrotasks();
        }
        return { reached: false, reason: 'subject container was not executed' };
      } catch (error) {
        if (error instanceof ProofTargetReached) return { reached: true };
        if (error instanceof ProofUnsupportedError || error instanceof ProofNonTerminationError || error instanceof ProofRuntimeThrow) {
          return { reached: false, reason: error.message };
        }
        throw error;
      }
    },
  };
}

function assertStructure(condition, description, detail) {
  if (!condition) {
    throw new Error(`Packaged utility containment executable structure is missing: ${description}${detail ? ` (${detail})` : ''}.`);
  }
}

function isThisMember(node, name, model) {
  node = unwrapExpression(node);
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    && expressionMemberName(node, model) === name
    && unwrapExpression(node.expression).kind === ts.SyntaxKind.ThisKeyword;
}

function isLiteral(node, expected, model) {
  const value = constantValue(node, model);
  return value !== UNKNOWN_CONSTANT && Object.is(value, expected);
}

function callReceiverMatchesThis(call) {
  const receiver = expressionReceiver(call.expression);
  return receiver ? unwrapExpression(receiver).kind === ts.SyntaxKind.ThisKeyword : false;
}

function callArgumentLiteral(call, index, expected, model) {
  return Boolean(call.arguments[index] && isLiteral(call.arguments[index], expected, model));
}

function conditionContainsPropertyComparison(node, property, expected, model) {
  let found = false;
  walk(node, (candidate) => {
    if (found || !ts.isBinaryExpression(candidate)) return;
    if (![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(candidate.operatorToken.kind)) return;
    const leftName = expressionMemberName(candidate.left, model);
    const rightName = expressionMemberName(candidate.right, model);
    if ((leftName === property && isLiteral(candidate.right, expected, model))
      || (rightName === property && isLiteral(candidate.left, expected, model))) found = true;
  });
  return found;
}

function switchClauseIsReachable(clause, switchStatement, model) {
  const discriminant = constantValue(switchStatement.expression, model);
  if (discriminant === UNKNOWN_CONSTANT) return true;
  let selected = -1;
  let defaultIndex = -1;
  for (let index = 0; index < switchStatement.caseBlock.clauses.length; index += 1) {
    const candidate = switchStatement.caseBlock.clauses[index];
    if (ts.isDefaultClause(candidate)) defaultIndex = index;
    else {
      const value = constantValue(candidate.expression, model);
      if (value === UNKNOWN_CONSTANT) return true;
      if (selected < 0 && Object.is(value, discriminant)) selected = index;
    }
  }
  if (selected < 0) selected = defaultIndex;
  if (selected < 0) return false;
  const targetIndex = switchStatement.caseBlock.clauses.indexOf(clause);
  if (targetIndex < selected) return false;
  for (let index = selected; index < targetIndex; index += 1) {
    const prior = switchStatement.caseBlock.clauses[index];
    if (prior.statements.some((statement) => ts.isBreakStatement(statement)
      || ts.isReturnStatement(statement) || ts.isThrowStatement(statement))) return false;
  }
  return true;
}

function isStaticallyLive(node, stop, model) {
  let child = node;
  let current = node.parent;
  while (current && current !== stop) {
    if (ts.isIfStatement(current)) {
      const condition = constantValue(current.expression, model);
      if (condition !== UNKNOWN_CONSTANT) {
        if (child === current.thenStatement && !condition) return false;
        if (child === current.elseStatement && condition) return false;
      }
    } else if (ts.isConditionalExpression(current)) {
      const condition = constantValue(current.condition, model);
      if (condition !== UNKNOWN_CONSTANT) {
        if (child === current.whenTrue && !condition) return false;
        if (child === current.whenFalse && condition) return false;
      }
    } else if (ts.isBinaryExpression(current) && child === current.right) {
      const left = constantValue(current.left, model);
      if (left !== UNKNOWN_CONSTANT) {
        if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && !left) return false;
        if (current.operatorToken.kind === ts.SyntaxKind.BarBarToken && left) return false;
        if (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && left !== null && left !== undefined) return false;
      }
    } else if ((ts.isWhileStatement(current) || ts.isDoStatement(current)) && child === current.statement) {
      const condition = constantValue(current.expression, model);
      if (condition !== UNKNOWN_CONSTANT && !condition && ts.isWhileStatement(current)) return false;
    } else if (ts.isForStatement(current) && child === current.statement && current.condition) {
      const condition = constantValue(current.condition, model);
      if (condition !== UNKNOWN_CONSTANT && !condition) return false;
    } else if ((ts.isCaseClause(current) || ts.isDefaultClause(current)) && ts.isSwitchStatement(current.parent.parent)) {
      if (!switchClauseIsReachable(current, current.parent.parent, model)) return false;
    }
    child = current;
    current = current.parent;
  }
  return true;
}

function liveCalls(root, name, model) {
  return descendants(root, (node) => ts.isCallExpression(node)
    && expressionMemberName(node.expression, model) === name
    && isStaticallyLive(node, root, model));
}

function directGlobalCall(call, name, model) {
  const callee = unwrapExpression(call.expression);
  return ts.isIdentifier(callee) && callee.text === name && !model.resolveBinding(callee);
}

function bindingOfIdentifier(node, model) {
  node = unwrapExpression(node);
  return ts.isIdentifier(node) ? model.resolveBinding(node) : undefined;
}

function nodeWithin(node, ancestor) {
  return node.getStart() >= ancestor.getStart() && node.end <= ancestor.end;
}

function recordsWithin(binding, ancestor, model) {
  return (model.writes.get(binding) ?? []).filter((record) => nodeWithin(record.node, ancestor));
}

function findBindingWrittenFrom(ancestor, model, predicate) {
  const matches = [];
  for (const binding of model.bindings) {
    const records = recordsWithin(binding, ancestor, model).filter((record) => record.expression && predicate(unwrapExpression(record.expression), record));
    if (records.length > 0) matches.push({ binding, records });
  }
  return matches.length === 1 ? matches[0].binding : undefined;
}

function findBindingsWrittenFrom(ancestor, model, predicate) {
  const matches = [];
  for (const binding of model.bindings) {
    if (recordsWithin(binding, ancestor, model).some((record) => record.expression && predicate(unwrapExpression(record.expression), record))) {
      matches.push(binding);
    }
  }
  return matches;
}

function bindingHasOnlyOneEffectiveWrite(binding, ancestor, model, predicate) {
  const records = recordsWithin(binding, ancestor, model).filter((record) => record.expression);
  return records.length === 1 && predicate(unwrapExpression(records[0].expression), records[0]);
}

function isThisMethodCall(node, name, model) {
  node = unwrapExpression(node);
  return ts.isCallExpression(node)
    && expressionMemberName(node.expression, model) === name
    && callReceiverMatchesThis(node);
}

function isQueueShiftCall(node, model) {
  node = unwrapExpression(node);
  if (!ts.isCallExpression(node) || expressionMemberName(node.expression, model) !== 'shift') return false;
  const queue = expressionReceiver(node.expression);
  return queue ? isThisMember(queue, 'queue', model) : false;
}

function methodMap(classNode, model) {
  const methods = new Map();
  for (const member of classNode.members) {
    if (!callableBody(member)) continue;
    const name = propertyNameText(member.name, model);
    if (name) methods.set(name, member);
  }
  return methods;
}

function findSupervisorClass(sourceFile, model) {
  const required = ['cancel', 'enqueue', 'ensureWorker', 'pump', 'handleMessage', 'handleExit', 'finish', 'runE2eContainmentProbe'];
  const candidates = [...model.classNodes].filter((classNode) => {
    const methods = methodMap(classNode, model);
    return required.every((name) => methods.has(name));
  });
  assertStructure(candidates.length === 1, 'exactly one raster utility supervisor class must own the containment lifecycle methods');
  return candidates[0];
}

function propertyReceiverBinding(call, model) {
  const receiver = expressionReceiver(call.expression);
  return receiver ? bindingOfIdentifier(receiver, model) : undefined;
}

function callbackArgument(call, index) {
  const argument = call.arguments[index];
  const candidate = argument ? unwrapExpression(argument) : undefined;
  return candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) ? candidate : undefined;
}

function expressionEventPaths(node, paths, eventForCall, model) {
  if (!node) return paths;
  node = unwrapExpression(node);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) return paths;
  if (ts.isConditionalExpression(node)) {
    const conditioned = expressionEventPaths(node.condition, paths, eventForCall, model);
    const value = constantValue(node.condition, model);
    if (value !== UNKNOWN_CONSTANT) {
      return expressionEventPaths(value ? node.whenTrue : node.whenFalse, conditioned, eventForCall, model);
    }
    return [
      ...expressionEventPaths(node.whenTrue, conditioned.map((path) => [...path]), eventForCall, model),
      ...expressionEventPaths(node.whenFalse, conditioned.map((path) => [...path]), eventForCall, model),
    ];
  }
  if (ts.isBinaryExpression(node)) {
    const left = expressionEventPaths(node.left, paths, eventForCall, model);
    if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) return expressionEventPaths(node.right, left, eventForCall, model);
    if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      const value = constantValue(node.left, model);
      const executesRight = node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? Boolean(value)
        : node.operatorToken.kind === ts.SyntaxKind.BarBarToken ? !value
          : value === null || value === undefined;
      if (value !== UNKNOWN_CONSTANT) return executesRight ? expressionEventPaths(node.right, left, eventForCall, model) : left;
      return [...left.map((path) => [...path]), ...expressionEventPaths(node.right, left.map((path) => [...path]), eventForCall, model)];
    }
    return expressionEventPaths(node.right, left, eventForCall, model);
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    let current = paths;
    const receiver = expressionReceiver(node.expression);
    if (receiver) current = expressionEventPaths(receiver, current, eventForCall, model);
    for (const argument of node.arguments ?? []) current = expressionEventPaths(argument, current, eventForCall, model);
    const event = ts.isCallExpression(node) ? eventForCall(node) : undefined;
    return event ? current.map((path) => [...path, event]) : current;
  }
  if (ts.isAwaitExpression(node) || ts.isVoidExpression(node) || ts.isPrefixUnaryExpression(node)
    || ts.isPostfixUnaryExpression(node)) return expressionEventPaths(node.expression ?? node.operand, paths, eventForCall, model);
  if (ts.isArrayLiteralExpression(node)) {
    let current = paths;
    for (const element of node.elements) current = expressionEventPaths(element, current, eventForCall, model);
    return current;
  }
  if (ts.isObjectLiteralExpression(node)) {
    let current = paths;
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) current = expressionEventPaths(property.initializer, current, eventForCall, model);
    }
    return current;
  }
  return paths;
}

function statementEventOutcomes(statements, eventForCall, model) {
  const analyzeSequence = (items, incoming) => {
    let states = incoming;
    for (const statement of items) {
      const terminal = states.filter((state) => state.kind !== 'normal');
      const next = states.filter((state) => state.kind === 'normal').flatMap((state) => analyzeStatement(statement, state.events));
      states = [...terminal, ...next];
    }
    return states;
  };
  const analyzeStatement = (statement, events) => {
    if (ts.isBlock(statement)) return analyzeSequence(statement.statements, [{ kind: 'normal', events }]);
    if (ts.isExpressionStatement(statement)) {
      return expressionEventPaths(statement.expression, [events], eventForCall, model).map((path) => ({ kind: 'normal', events: path }));
    }
    if (ts.isVariableStatement(statement)) {
      let paths = [events];
      for (const declaration of statement.declarationList.declarations) {
        paths = expressionEventPaths(declaration.initializer, paths, eventForCall, model);
      }
      return paths.map((path) => ({ kind: 'normal', events: path }));
    }
    if (ts.isIfStatement(statement)) {
      const conditionPaths = expressionEventPaths(statement.expression, [events], eventForCall, model);
      const value = constantValue(statement.expression, model);
      if (value !== UNKNOWN_CONSTANT) {
        if (value) return conditionPaths.flatMap((path) => analyzeStatement(statement.thenStatement, path));
        return statement.elseStatement
          ? conditionPaths.flatMap((path) => analyzeStatement(statement.elseStatement, path))
          : conditionPaths.map((path) => ({ kind: 'normal', events: path }));
      }
      return conditionPaths.flatMap((path) => [
        ...analyzeStatement(statement.thenStatement, [...path]),
        ...(statement.elseStatement ? analyzeStatement(statement.elseStatement, [...path]) : [{ kind: 'normal', events: [...path] }]),
      ]);
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      const expression = statement.expression;
      return expressionEventPaths(expression, [events], eventForCall, model).map((path) => ({
        kind: ts.isReturnStatement(statement) ? 'return' : 'throw', events: path,
      }));
    }
    return [{ kind: 'unsupported', events }];
  };
  return analyzeSequence(statements, [{ kind: 'normal', events: [] }]);
}

function hasOrderedEvents(events, required) {
  let cursor = 0;
  for (const event of events) if (event === required[cursor]) cursor += 1;
  return cursor === required.length;
}

function directGuard(body, predicate) {
  if (!ts.isBlock(body)) return undefined;
  const index = body.statements.findIndex((statement) => ts.isIfStatement(statement)
    && !statement.elseStatement && ts.isReturnStatement(statement.thenStatement)
    && predicate(statement.expression));
  return index >= 0 ? { statement: body.statements[index], index, continuation: body.statements.slice(index + 1) } : undefined;
}

function isCurrentRequestIdMismatch(node, parameterBinding, model) {
  node = unwrapExpression(node);
  if (!ts.isBinaryExpression(node)
    || ![ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return false;
  const left = unwrapExpression(node.left);
  const right = unwrapExpression(node.right);
  const idSide = expressionMemberName(left, model) === 'id' ? left : expressionMemberName(right, model) === 'id' ? right : undefined;
  const parameterSide = idSide === left ? right : left;
  if (!idSide || bindingOfIdentifier(parameterSide, model) !== parameterBinding) return false;
  const request = expressionReceiver(idSide);
  return Boolean(request && expressionMemberName(request, model) === 'request'
    && isThisMember(expressionReceiver(request), 'current', model));
}

function assertOrderedLifecyclePath(statements, eventForCall, description, model) {
  assertStructure(statements, `${description} must have one exact active-work guard`);
  const outcomes = statementEventOutcomes(statements, eventForCall, model);
  assertStructure(outcomes.length > 0 && outcomes.every((outcome) => outcome.kind !== 'unsupported'
    && hasOrderedEvents(outcome.events, ['finish', 'kill', 'pump'])),
  `${description} must finish, terminate, and pump in that order on every completing path`);
}

function expressionEndsWithBinding(node, binding, before, model) {
  node = unwrapExpression(node);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return expressionEndsWithBinding(node.right, binding, before, model);
  }
  return expressionResolvesToBinding(node, binding, before, model);
}

function unshadowedErrorConstruction(node, model) {
  node = unwrapExpression(node);
  if (!ts.isNewExpression(node)) return false;
  const callee = unwrapExpression(node.expression);
  return ts.isIdentifier(callee) && callee.text === 'Error' && !model.resolveBinding(callee);
}

function localCallReturnsError(call, model) {
  const callee = unwrapExpression(call.expression);
  if (!ts.isIdentifier(callee)) return false;
  const binding = model.resolveBinding(callee);
  if (!binding || binding.functionDeclarations.length !== 1) return false;
  const callable = binding.functionDeclarations[0];
  const body = callableBody(callable);
  if (!body || !ts.isBlock(body)) return false;
  const errorBindings = findBindingsWrittenFrom(body, model, (expression) => unshadowedErrorConstruction(expression, model));
  if (errorBindings.length !== 1) return false;
  const returns = descendants(body, (node) => ts.isReturnStatement(node)
    && callableAncestor(node, body) === undefined);
  return returns.length >= 1 && returns.every((statement) => statement.expression
    && expressionEndsWithBinding(statement.expression, errorBindings[0], statement, model));
}

function expressionProvesFailure(node, model, seen = new Set()) {
  if (!node) return false;
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const binding = model.resolveBinding(node);
    if (!binding || seen.has(binding)) return false;
    const records = (model.writes.get(binding) ?? []).filter((record) => (
      record.expression && record.node.getStart() < node.getStart()
    ));
    if (records.length !== 1) return false;
    seen.add(binding);
    const result = expressionProvesFailure(records[0].expression, model, seen);
    seen.delete(binding);
    return result;
  }
  return unshadowedErrorConstruction(node, model)
    || (ts.isCallExpression(node) && localCallReturnsError(node, model));
}

function hasFailureArgument(call, model) {
  return expressionProvesFailure(call.arguments[1], model);
}

function assertFinishStructure(method, model) {
  const body = callableBody(method);
  assertStructure(body && ts.isBlock(body), 'task settlement must have one inspectable callable body');
  const taskBinding = method.parameters[0] && bindingOfIdentifier(method.parameters[0].name, model);
  const errorBinding = method.parameters[1] && bindingOfIdentifier(method.parameters[1].name, model);
  const responseBinding = method.parameters[2] && bindingOfIdentifier(method.parameters[2].name, model);
  assertStructure(taskBinding && errorBinding && responseBinding,
    'task settlement must retain exact task, failure, and response parameters');
  const calls = descendants(body, ts.isCallExpression).filter((call) => callableAncestor(call, body) === undefined);
  const clear = calls.find((call) => directGlobalCall(call, 'clearTimeout', model)
    && call.arguments[0] && expressionMemberName(call.arguments[0], model) === 'timer'
    && bindingOfIdentifier(expressionReceiver(call.arguments[0]), model) === taskBinding);
  const remove = calls.find((call) => expressionMemberName(call.expression, model) === 'removeEventListener'
    && callArgumentLiteral(call, 0, 'abort', model)
    && expressionMemberName(expressionReceiver(call.expression), model) === 'signal'
    && bindingOfIdentifier(expressionReceiver(expressionReceiver(call.expression)), model) === taskBinding
    && expressionMemberName(call.arguments[1], model) === 'onAbort'
    && bindingOfIdentifier(expressionReceiver(call.arguments[1]), model) === taskBinding);
  const rejects = calls.filter((call) => expressionMemberName(call.expression, model) === 'reject'
    && bindingOfIdentifier(expressionReceiver(call.expression), model) === taskBinding);
  const resolves = calls.filter((call) => expressionMemberName(call.expression, model) === 'resolve'
    && bindingOfIdentifier(expressionReceiver(call.expression), model) === taskBinding);
  const errorReject = rejects.find((call) => bindingOfIdentifier(call.arguments[0], model) === errorBinding);
  const missingReject = rejects.find((call) => unshadowedErrorConstruction(call.arguments[0], model));
  const responseResolve = resolves.find((call) => bindingOfIdentifier(call.arguments[0], model) === responseBinding);
  assertStructure(clear && remove && errorReject && missingReject && responseResolve
    && rejects.length === 2 && resolves.length === 1,
  'task settlement must clean timer/signal state and settle exactly once by failure, response, or fail-closed missing result');

  const propertyTruth = (node, expectedBinding, names) => {
    node = unwrapExpression(node);
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
    return bindingOfIdentifier(node.expression, model) === expectedBinding
      && names.includes(expressionMemberName(node, model)) ? true : undefined;
  };
  for (const [label, error, response, terminal] of [
    ['failure', true, false, errorReject],
    ['response', false, true, responseResolve],
    ['missing result', false, false, missingReject],
  ]) {
    assertPrecisePath(body, [clear, remove, terminal],
      `task settlement ${label} path must clean up and reach its exact terminal action`, model, {
        conditionValue(node) {
          node = unwrapExpression(node);
          if (ts.isIdentifier(node)) {
            const binding = model.resolveBinding(node);
            if (binding === errorBinding) return error;
            if (binding === responseBinding) return response;
          }
          return propertyTruth(node, taskBinding, ['timer', 'signal']) ?? UNKNOWN_CONSTANT;
        },
      });
  }
}

function assertCancelStructure(method, model) {
  const body = callableBody(method);
  const taskBinding = findBindingWrittenFrom(body, model, (expression) => isThisMember(expression, 'current', model));
  const workerBinding = findBindingWrittenFrom(body, model, (expression) => isThisMember(expression, 'worker', model));
  assertStructure(taskBinding && workerBinding, 'active cancellation must capture the active task and active worker by lexical binding');
  assertStructure(bindingHasOnlyOneEffectiveWrite(taskBinding, body, model, (expression) => isThisMember(expression, 'current', model))
    && bindingHasOnlyOneEffectiveWrite(workerBinding, body, model, (expression) => isThisMember(expression, 'worker', model)), 'active cancellation captures must not be reassigned before use');

  const killCalls = liveCalls(body, 'kill', model).filter((call) => propertyReceiverBinding(call, model) === workerBinding);
  const finishCalls = liveCalls(body, 'finish', model).filter((call) => callReceiverMatchesThis(call)
    && bindingOfIdentifier(call.arguments[0], model) === taskBinding && hasFailureArgument(call, model));
  const pumpCalls = liveCalls(body, 'pump', model).filter((call) => callReceiverMatchesThis(call));
  const parameter = method.parameters[0] && bindingOfIdentifier(method.parameters[0].name, model);
  const guard = parameter && directGuard(body, (condition) => isCurrentRequestIdMismatch(condition, parameter, model));
  const queuedBranch = guard?.index === 2 ? body.statements[1] : undefined;
  assertStructure(guard?.index === 2 && ts.isVariableStatement(body.statements[0])
    && queuedBranch && ts.isIfStatement(queuedBranch)
    && descendants(queuedBranch.thenStatement, ts.isReturnStatement).length === 1
    && liveCalls(queuedBranch.thenStatement, 'finish', model).some((call) => callReceiverMatchesThis(call)),
  'active cancellation must reach its exact current-task guard after only the bounded queued-task branch');
  const continuation = guard?.continuation;
  assertOrderedLifecyclePath(continuation, (call) => {
    if (expressionMemberName(call.expression, model) === 'finish' && callReceiverMatchesThis(call)
      && bindingOfIdentifier(call.arguments[0], model) === taskBinding && hasFailureArgument(call, model)) return 'finish';
    if (expressionMemberName(call.expression, model) === 'kill' && propertyReceiverBinding(call, model) === workerBinding) return 'kill';
    if (expressionMemberName(call.expression, model) === 'pump' && callReceiverMatchesThis(call)) return 'pump';
    return undefined;
  }, 'active cancellation must reject, terminate its captured worker, and continue the queue', model);
  assertStructure(killCalls.length === 1 && finishCalls.length >= 1 && pumpCalls.length >= 1
    && !bindingMethodIsMutated(body, workerBinding, 'kill', model),
  'active cancellation must reject, terminate its captured worker, and continue the queue');
  assertPrecisePath(body, [guard.statement, finishCalls.at(-1), killCalls[0], pumpCalls.at(-1)],
    'active cancellation callable must execute its guard, failure settlement, exact worker termination, and queue continuation',
    model, {
      conditionValue(node) {
        if (node === queuedBranch.expression || node === guard.statement.expression) return false;
        return UNKNOWN_CONSTANT;
      },
    });
  return { killCall: killCalls[0], taskBinding, workerBinding };
}

function assertEnqueueStructure(method, model) {
  const body = callableBody(method);
  const registrations = liveCalls(body, 'addEventListener', model).filter((call) => callArgumentLiteral(call, 0, 'abort', model));
  let valid = false;
  for (const registration of registrations) {
    const receiver = expressionReceiver(registration.expression);
    if (!receiver || expressionMemberName(receiver, model) !== 'signal') continue;
    const callback = unwrapExpression(registration.arguments[1]);
    if (!callback || (!ts.isPropertyAccessExpression(callback) && !ts.isElementAccessExpression(callback))) continue;
    const ownerBinding = bindingOfIdentifier(callback.expression, model);
    const callbackName = expressionMemberName(callback, model);
    if (!ownerBinding || callbackName !== 'onAbort') continue;
    const assignments = descendants(body, (node) => ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && expressionMemberName(node.left, model) === callbackName
      && bindingOfIdentifier(expressionReceiver(node.left), model) === ownerBinding);
    const assignment = assignments.find((node) => {
      const value = unwrapExpression(node.right);
      return (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
        && liveCalls(value.body, 'cancel', model).some((call) => callReceiverMatchesThis(call));
    });
    if (assignment) valid = true;
  }
  assertStructure(valid, 'AbortSignal cancellation must invoke the supervisor cancellation path through the exact queued-task callback');
}

function assertPumpStructure(method, model) {
  const body = callableBody(method);
  const workerBinding = findBindingWrittenFrom(body, model, (expression) => {
    const value = ts.isAwaitExpression(expression) ? unwrapExpression(expression.expression) : expression;
    return isThisMethodCall(value, 'ensureWorker', model);
  });
  const taskBinding = findBindingsWrittenFrom(body, model, (expression) => isQueueShiftCall(expression, model)).find((binding) => (
    liveCalls(body, 'postMessage', model).some((call) => propertyReceiverBinding(call, model) === workerBinding
      && expressionMemberName(call.arguments[0], model) === 'request'
      && bindingOfIdentifier(expressionReceiver(call.arguments[0]), model) === binding)
  ));
  assertStructure(workerBinding && taskBinding, 'queued work must capture one acquired worker and one dequeued task');
  assertStructure(bindingHasOnlyOneEffectiveWrite(workerBinding, body, model, (expression) => {
    const value = ts.isAwaitExpression(expression) ? unwrapExpression(expression.expression) : expression;
    return isThisMethodCall(value, 'ensureWorker', model);
  }) && bindingHasOnlyOneEffectiveWrite(taskBinding, body, model, (expression) => isQueueShiftCall(expression, model)),
  'dispatched worker/task bindings must not accumulate or be reassigned');

  const timers = descendants(body, (node) => ts.isCallExpression(node)
    && directGlobalCall(node, 'setTimeout', model)
    && isStaticallyLive(node, body, model));
  const timer = timers.find((call) => callbackArgument(call, 0));
  const callback = timer ? callbackArgument(timer, 0) : undefined;
  assertStructure(callback,
    'task timeout must use the unmodified unshadowed global scheduler');
  const timeoutKills = liveCalls(callback.body, 'kill', model).filter((call) => propertyReceiverBinding(call, model) === workerBinding);
  const timeoutFinishes = liveCalls(callback.body, 'finish', model).filter((call) => callReceiverMatchesThis(call)
    && bindingOfIdentifier(call.arguments[0], model) === taskBinding && hasFailureArgument(call, model));
  const timeoutPumps = liveCalls(callback.body, 'pump', model).filter((call) => callReceiverMatchesThis(call));
  const timeoutGuard = directGuard(callback.body, (condition) => {
    condition = unwrapExpression(condition);
    if (!ts.isBinaryExpression(condition)
      || ![ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(condition.operatorToken.kind)) return false;
    const left = unwrapExpression(condition.left);
    const right = unwrapExpression(condition.right);
    return (isThisMember(left, 'current', model) && bindingOfIdentifier(right, model) === taskBinding)
      || (isThisMember(right, 'current', model) && bindingOfIdentifier(left, model) === taskBinding);
  });
  assertStructure(timeoutGuard?.index === 0,
    'task timeout callback must begin with its exact stale-task guard before any lifecycle action');
  const timeoutContinuation = timeoutGuard?.continuation;
  assertOrderedLifecyclePath(timeoutContinuation, (call) => {
    if (expressionMemberName(call.expression, model) === 'finish' && callReceiverMatchesThis(call)
      && bindingOfIdentifier(call.arguments[0], model) === taskBinding && hasFailureArgument(call, model)) return 'finish';
    if (expressionMemberName(call.expression, model) === 'kill' && propertyReceiverBinding(call, model) === workerBinding) return 'kill';
    if (expressionMemberName(call.expression, model) === 'pump' && callReceiverMatchesThis(call)) return 'pump';
    return undefined;
  }, 'task timeout must reject, terminate the exact dispatched worker, and continue the queue', model);
  assertStructure(timeoutKills.length === 1 && timeoutFinishes.length >= 1 && timeoutPumps.length >= 1
    && !bindingMethodIsMutated(callback.body, workerBinding, 'kill', model),
    'task timeout must reject, terminate the exact dispatched worker, and continue the queue');
  assertPrecisePath(callback.body,
    [timeoutGuard.statement, timeoutFinishes[0], timeoutKills[0], timeoutPumps[0]],
    'task timeout callable must execute its guard, failure settlement, exact worker termination, and queue continuation',
    model, {
      conditionValue(node) {
        if (node === timeoutGuard.statement.expression) return false;
        return UNKNOWN_CONSTANT;
      },
    });

  const dispatches = liveCalls(body, 'postMessage', model).filter((call) => propertyReceiverBinding(call, model) === workerBinding
    && expressionMemberName(call.arguments[0], model) === 'request'
    && bindingOfIdentifier(expressionReceiver(call.arguments[0]), model) === taskBinding);
  assertStructure(dispatches.length >= 1, 'queued work must dispatch its exact request through the captured worker');
  return {
    killCall: timeoutKills[0], taskBinding, workerBinding,
    timer, timeoutCallback: callback, timeoutFinish: timeoutFinishes[0], timeoutPump: timeoutPumps[0],
  };
}

function assertEnsureWorkerStructure(method, model) {
  const body = callableBody(method);
  const forks = liveCalls(body, 'fork', model).filter((call) => callReceiverMatchesThis(call));
  assertStructure(forks.length === 1, 'fresh worker admission must have exactly one fork call');
  const fork = forks[0];
  const promiseResolve = descendants(body, (node) => ts.isCallExpression(node)
    && expressionMemberName(node.expression, model) === 'resolve'
    && classifyStableValue(expressionReceiver(node.expression), node, model) === 'native-promise-constructor'
    && node.arguments.length === 1 && node.arguments[0] === fork);
  assertStructure(promiseResolve.length === 1,
    'fresh worker admission must pass the exact fork result directly through unshadowed native Promise adoption');
  const thenCalls = descendants(body, (node) => ts.isCallExpression(node)
    && expressionMemberName(node.expression, model) === 'then'
    && expressionReceiver(node.expression) === promiseResolve[0]);
  assertStructure(thenCalls.length === 1,
    'fresh worker admission must attach one success continuation to the exact adopted fork result');
  const success = callbackArgument(thenCalls[0], 0);
  const workerParameter = success?.parameters[0]?.name;
  const workerBinding = workerParameter && bindingOfIdentifier(workerParameter, model);
  const listenerRoot = success && callableBody(success);
  assertStructure(success && workerBinding && listenerRoot,
    'fresh worker admission must bind the exact adopted fork allocation in one inspectable continuation');
  const receiverMatches = (node) => bindingOfIdentifier(node, model) === workerBinding;
  const installs = descendants(listenerRoot, (node) => ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && isThisMember(node.left, 'worker', model)
    && bindingOfIdentifier(node.right, model) === workerBinding);
  assertStructure(installs.length === 1, 'the exact fork result must become the supervisor worker before listener admission');
  const listeners = liveCalls(listenerRoot, 'on', model).filter((call) => {
    const receiver = expressionReceiver(call.expression);
    return receiver && receiverMatches(receiver);
  });
  const messageListeners = listeners.filter((call) => callArgumentLiteral(call, 0, 'message', model));
  const exitListeners = listeners.filter((call) => callArgumentLiteral(call, 0, 'exit', model));
  let messageHandler;
  let exitHandler;
  const validPair = messageListeners.some((messageCall) => exitListeners.some((exitCall) => {
    const messageCallback = callbackArgument(messageCall, 1);
    const exitCallback = callbackArgument(exitCall, 1);
    messageHandler = messageCallback && liveCalls(messageCallback.body, 'handleMessage', model).find((call) => callReceiverMatchesThis(call)
      && receiverMatches(call.arguments[0]));
    exitHandler = exitCallback && liveCalls(exitCallback.body, 'handleExit', model).find((call) => callReceiverMatchesThis(call)
      && receiverMatches(call.arguments[0]));
    if (!messageCallback || !exitCallback || !messageHandler || !exitHandler) return false;
    assertPrecisePath(messageCallback.body, [messageHandler],
      'fork message listener callback must reach exact-worker message handling without an earlier completion', model);
    assertPrecisePath(exitCallback.body, [exitHandler],
      'fork exit listener callback must reach exact-worker exit handling without an earlier completion', model);
    return true;
  }));
  assertStructure(messageListeners.length === 1 && exitListeners.length === 1 && validPair,
    'fresh workers must attach message and exit supervision to the exact fork result');
  const returns = descendants(listenerRoot, (node) => ts.isReturnStatement(node)
    && callableAncestor(node, listenerRoot) === undefined
    && node.expression && expressionEndsWithBinding(node.expression, workerBinding, node, model));
  assertStructure(returns.length === 1,
    'fresh worker admission must return the exact fork result after listener installation');
  const stoppedGuard = descendants(listenerRoot, (node) => ts.isIfStatement(node)
    && descendants(node.expression, (candidate) => isThisMember(candidate, 'stopped', model)).length >= 1).at(0);
  assertPrecisePath(listenerRoot, [installs[0], messageListeners[0], exitListeners[0], returns[0]],
    'fresh worker continuation must install, supervise, and return the exact fork allocation on one path', model, {
      conditionValue(node) {
        if (node === stoppedGuard?.expression) return false;
        return UNKNOWN_CONSTANT;
      },
      ignoreThrows: true,
    });
  return {
    fork, promiseResolve: promiseResolve[0], success,
    messageListener: messageListeners[0], exitListener: exitListeners[0],
  };
}

function assertHandleExitStructure(method, model, sourceFile) {
  const body = callableBody(method);
  const workerParameter = method.parameters[0] && bindingOfIdentifier(method.parameters[0].name, model);
  const workerGuard = body?.statements[0];
  const workerComparison = workerGuard && ts.isIfStatement(workerGuard)
    ? unwrapExpression(workerGuard.expression) : undefined;
  const equality = workerComparison && ts.isBinaryExpression(workerComparison)
    ? workerComparison.operatorToken.kind : undefined;
  const comparisonMatches = workerComparison && ts.isBinaryExpression(workerComparison)
    && ((bindingOfIdentifier(workerComparison.left, model) === workerParameter && isThisMember(workerComparison.right, 'worker', model))
      || (bindingOfIdentifier(workerComparison.right, model) === workerParameter && isThisMember(workerComparison.left, 'worker', model)));
  const positiveGuard = comparisonMatches
    && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(equality)
    && ts.isBlock(workerGuard.thenStatement) ? workerGuard.thenStatement : undefined;
  const negativeGuard = comparisonMatches
    && [ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(equality)
    && !workerGuard.elseStatement && ts.isReturnStatement(workerGuard.thenStatement) ? workerGuard : undefined;
  assertStructure(workerParameter && (positiveGuard || negativeGuard),
    'worker exit handling must begin with one exact active-worker identity guard');

  const currentIf = descendants(positiveGuard ?? body, (node) => ts.isIfStatement(node)
    && descendants(node.expression, (candidate) => isThisMember(candidate, 'current', model)).length === 1).at(0);
  const currentBranch = currentIf && ts.isBlock(currentIf.thenStatement)
    ? currentIf.thenStatement : currentIf?.thenStatement;
  const taskBinding = currentBranch && findBindingWrittenFrom(currentBranch, model,
    (expression) => isThisMember(expression, 'current', model));
  const finishCalls = currentBranch ? liveCalls(currentBranch, 'finish', model).filter((call) => callReceiverMatchesThis(call)
    && bindingOfIdentifier(call.arguments[0], model) === taskBinding && hasFailureArgument(call, model)) : [];
  const pumpCalls = liveCalls(positiveGuard ?? body, 'pump', model).filter((call) => callReceiverMatchesThis(call));
  assertStructure(currentIf && taskBinding && finishCalls.length === 1 && pumpCalls.length === 1
    && nodeContainsText(body, sourceFile, 'Raster utility exited unexpectedly with code'),
    'worker exit must reject active work and admit queued recovery');
  assertPrecisePath(body, [workerGuard, finishCalls[0], pumpCalls[0]],
    'worker exit callable must reject exact active work and admit queued recovery on the same active-worker path', model, {
      conditionValue(node) {
        if (node === workerGuard.expression) return Boolean(positiveGuard);
        if (node === currentIf.expression) return true;
        return UNKNOWN_CONSTANT;
      },
    });
  return { finishCall: finishCalls[0], pumpCall: pumpCalls[0], workerGuard, currentIf };
}

function objectLiteralHasProperty(node, name, expected, model) {
  node = unwrapExpression(node);
  return ts.isObjectLiteralExpression(node) && node.properties.some((property) => ts.isPropertyAssignment(property)
    && propertyNameText(property.name, model) === name && isLiteral(property.initializer, expected, model));
}

function expressionResolvesToObjectProperty(node, before, name, expected, model, seen = new Set()) {
  node = unwrapExpression(node);
  if (objectLiteralHasProperty(node, name, expected, model)) return true;
  if (!ts.isIdentifier(node)) return false;
  const binding = model.resolveBinding(node);
  if (!binding || seen.has(binding)) return false;
  const records = (model.writes.get(binding) ?? []).filter((record) => record.expression && record.node.getStart() < before.getStart());
  if (records.length !== 1) return false;
  seen.add(binding);
  const result = expressionResolvesToObjectProperty(records[0].expression, before, name, expected, model, seen);
  seen.delete(binding);
  return result;
}

function assertProbeStructure(method, model, sourceFile) {
  const body = callableBody(method);
  const enqueues = liveCalls(body, 'enqueue', model).filter((call) => callReceiverMatchesThis(call)
    && expressionResolvesToObjectProperty(call.arguments[0], call, 'kind', 'containment-probe', model));
  assertStructure(enqueues.length >= 1
    && nodeContainsText(body, sourceFile, 'The utility containment probe is unavailable outside isolated packaged QA.'),
  'the isolated containment request must enter the supervised worker queue');
}

function classifyStableValue(node, before, model, seen = new Set()) {
  if (!node) return undefined;
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const binding = model.resolveBinding(node);
    if (!binding) {
      if (node.text === 'process') return 'global-process';
      if (node.text === 'Promise') return 'native-promise-constructor';
      if (node.text === 'setTimeout') return 'global-set-timeout';
      if (node.text === 'clearTimeout') return 'global-clear-timeout';
      if (node.text === 'globalThis') return 'global-object';
      if (node.text === 'Object') return 'intrinsic-object';
      if (node.text === 'Reflect') return 'intrinsic-reflect';
      if (node.text === 'Function') return 'intrinsic-function-constructor';
      return undefined;
    }
    if (seen.has(binding)) return undefined;
    const records = (model.writes.get(binding) ?? []).filter((record) => record.expression && record.node.getStart() < before.getStart());
    if (records.length !== 1) return undefined;
    seen.add(binding);
    const result = classifyStableValue(records[0].expression, before, model, seen);
    seen.delete(binding);
    return result;
  }
  if (ts.isCallExpression(node)) {
    const callee = unwrapExpression(node.expression);
    if (ts.isIdentifier(callee) && callee.text === 'require' && !model.resolveBinding(callee)
      && callArgumentLiteral(node, 0, 'electron', model)) return 'electron-module';
    const name = expressionMemberName(callee, model);
    const receiver = expressionReceiver(callee);
    const receiverKind = receiver ? classifyStableValue(receiver, before, model, seen) : undefined;
    if (name === 'whenReady' && receiverKind === 'electron-app') return 'native-promise';
    if (name === 'resolve' && receiverKind === 'native-promise-constructor') return 'native-promise';
    if (name === 'bind' && receiverKind && node.arguments.length === 1) return `bound:${receiverKind}`;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const owner = classifyStableValue(node.expression, before, model, seen);
    const name = expressionMemberName(node, model);
    if (owner === 'electron-module' && name === 'app') return 'electron-app';
    if (owner === 'global-process' && name === 'parentPort') return 'electron-parent-port';
    if (owner === 'global-object' && name === 'process') return 'global-process';
    if (owner === 'global-object' && name === 'Promise') return 'native-promise-constructor';
    if (owner === 'global-object' && name === 'setTimeout') return 'global-set-timeout';
    if (owner === 'global-object' && name === 'clearTimeout') return 'global-clear-timeout';
    if (owner === 'intrinsic-function-constructor' && name === 'prototype') return 'intrinsic-function-prototype';
    if (owner === 'intrinsic-function-prototype' && name === 'call') return 'intrinsic-function-call';
    if (owner === 'intrinsic-object' && ['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf'].includes(name)) {
      return `intrinsic-object-method:${name}`;
    }
    if (owner === 'intrinsic-reflect' && ['apply', 'set', 'deleteProperty', 'defineProperty', 'setPrototypeOf'].includes(name)) {
      return `intrinsic-reflect-method:${name}`;
    }
  }
  return undefined;
}

function possibleStableValues(node, before, model, seen = new Set()) {
  if (!node) return new Set();
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    const binding = model.resolveBinding(node);
    if (!binding) {
      const direct = classifyStableValue(node, before, model);
      return direct ? new Set([direct]) : new Set();
    }
    if (seen.has(binding)) return new Set();
    const records = (model.writes.get(binding) ?? []).filter((record) => record.expression && record.node.getStart() < before.getStart());
    const result = new Set();
    seen.add(binding);
    for (const record of records) {
      const declaration = binding.declarations.find((candidate) => candidate.declaration === record.node);
      const path = [...(declaration?.patternPath ?? [])];
      let projectedExpression = unwrapExpression(record.expression);
      while (path.length > 0 && path[0].kind === 'property') {
        const key = path[0].key;
        if (key !== undefined && ts.isArrayLiteralExpression(projectedExpression) && /^\d+$/u.test(key)) {
          const element = projectedExpression.elements[Number(key)];
          if (!element || ts.isSpreadElement(element)) break;
          projectedExpression = unwrapExpression(element);
          path.shift();
          continue;
        }
        if (key !== undefined && ts.isObjectLiteralExpression(projectedExpression)) {
          const property = projectedExpression.properties.find((candidate) => propertyNameText(candidate.name, model) === key);
          if (!property || !ts.isPropertyAssignment(property)) break;
          projectedExpression = unwrapExpression(property.initializer);
          path.shift();
          continue;
        }
        break;
      }
      let values = possibleStableValues(projectedExpression, before, model, seen);
      for (const part of path) {
        const projected = new Set();
        if (part.kind !== 'property' || part.key === undefined) {
          values = projected;
          break;
        }
        for (const owner of values) {
          if (owner === 'intrinsic-object' && ['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf'].includes(part.key)) {
            projected.add(`intrinsic-object-method:${part.key}`);
          }
          if (owner === 'intrinsic-reflect' && ['set', 'deleteProperty', 'defineProperty', 'setPrototypeOf'].includes(part.key)) {
            projected.add(`intrinsic-reflect-method:${part.key}`);
          }
          if (owner === 'global-object' && part.key === 'process') projected.add('global-process');
          if (owner === 'global-object' && part.key === 'Promise') projected.add('native-promise-constructor');
          if (owner === 'global-object' && part.key === 'setTimeout') projected.add('global-set-timeout');
          if (owner === 'global-object' && part.key === 'clearTimeout') projected.add('global-clear-timeout');
        }
        values = projected;
      }
      for (const value of values) result.add(value);
    }
    seen.delete(binding);
    return result;
  }
  if (ts.isConditionalExpression(node)) {
    return new Set([
      ...possibleStableValues(node.whenTrue, before, model, seen),
      ...possibleStableValues(node.whenFalse, before, model, seen),
    ]);
  }
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
    return new Set([
      ...possibleStableValues(node.left, before, model, seen),
      ...possibleStableValues(node.right, before, model, seen),
    ]);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return possibleStableValues(node.right, before, model, seen);
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const result = new Set();
    const name = expressionMemberName(node, model);
    for (const owner of possibleStableValues(node.expression, before, model, seen)) {
      if (owner === 'global-object' && name === 'process') result.add('global-process');
      if (owner === 'global-object' && name === 'Promise') result.add('native-promise-constructor');
      if (owner === 'global-object' && name === 'setTimeout') result.add('global-set-timeout');
      if (owner === 'global-object' && name === 'clearTimeout') result.add('global-clear-timeout');
      if (owner === 'intrinsic-function-constructor' && name === 'prototype') result.add('intrinsic-function-prototype');
      if (owner === 'intrinsic-function-prototype' && name === 'call') result.add('intrinsic-function-call');
      if (owner === 'intrinsic-object' && ['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf'].includes(name)) {
        result.add(`intrinsic-object-method:${name}`);
      }
      if (owner === 'intrinsic-reflect' && ['apply', 'set', 'deleteProperty', 'defineProperty', 'setPrototypeOf'].includes(name)) {
        result.add(`intrinsic-reflect-method:${name}`);
      }
    }
    return result;
  }
  const direct = classifyStableValue(node, before, model);
  return direct ? new Set([direct]) : new Set();
}

function staticArgumentArray(node, before, model, seen = new Set()) {
  node = unwrapExpression(node);
  if (ts.isArrayLiteralExpression(node) && node.elements.every((element) => !ts.isSpreadElement(element))) {
    return [...node.elements];
  }
  if (!ts.isIdentifier(node)) return undefined;
  const binding = model.resolveBinding(node);
  if (!binding || seen.has(binding)) return undefined;
  const records = (model.writes.get(binding) ?? []).filter((record) => (
    record.expression && record.node.getStart() < before.getStart()
  ));
  if (records.length !== 1) return undefined;
  seen.add(binding);
  const result = staticArgumentArray(records[0].expression, before, model, seen);
  seen.delete(binding);
  return result;
}

function resolvedInvocations(call, model) {
  const results = [];
  const add = (kinds, args, uncertainArguments = false) => {
    for (const kind of kinds) {
      const normalized = kind.startsWith('bound:') ? kind.slice('bound:'.length) : kind;
      results.push({ kind: normalized, args, uncertainArguments });
    }
  };
  const directKinds = possibleStableValues(call.expression, call, model);
  add(directKinds, [...call.arguments]);

  const method = expressionMemberName(call.expression, model);
  const receiver = expressionReceiver(call.expression);
  const receiverKinds = receiver ? possibleStableValues(receiver, call, model) : new Set();
  if (method === 'call') {
    if (receiverKinds.has('intrinsic-function-call')) {
      const targetKinds = call.arguments[0]
        ? possibleStableValues(call.arguments[0], call, model) : new Set();
      add(targetKinds, call.arguments.slice(2), targetKinds.size === 0);
    } else {
      add(receiverKinds, call.arguments.slice(1));
    }
  }
  if (method === 'apply') {
    const args = call.arguments[1] ? staticArgumentArray(call.arguments[1], call, model) : undefined;
    add(receiverKinds, args ?? [], !args);
  }
  if (directKinds.has('intrinsic-reflect-method:apply')) {
    const targetKinds = call.arguments[0]
      ? possibleStableValues(call.arguments[0], call, model) : new Set();
    const args = call.arguments[2] ? staticArgumentArray(call.arguments[2], call, model) : undefined;
    add(targetKinds, args ?? [], !args || targetKinds.size === 0);
  }

  // Resolve known nested call/apply trampolines as value flow rather than as
  // receiver-insensitive member names.  The cap keeps adversarial alias chains
  // deterministic; an unresolved target never becomes a proven safe call.
  for (let cursor = 0; cursor < results.length && results.length <= 64; cursor += 1) {
    const invocation = results[cursor];
    if (invocation.kind === 'intrinsic-function-call') {
      const targetKinds = invocation.args[0]
        ? possibleStableValues(invocation.args[0], call, model) : new Set();
      add(targetKinds, invocation.args.slice(2), invocation.uncertainArguments || targetKinds.size === 0);
    }
    if (invocation.kind === 'intrinsic-reflect-method:apply') {
      const targetKinds = invocation.args[0]
        ? possibleStableValues(invocation.args[0], call, model) : new Set();
      const args = invocation.args[2] ? staticArgumentArray(invocation.args[2], call, model) : undefined;
      add(targetKinds, args ?? [], invocation.uncertainArguments || !args || targetKinds.size === 0);
    }
  }

  const seen = new Set();
  return results.filter((result) => {
    const key = `${result.kind}:${result.uncertainArguments}:${result.args.map((argument) => argument.getStart()).join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function expressionIsProvenLocalObject(node, before, model, seen = new Set()) {
  node = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
    || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node)) return true;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    if (expressionMemberName(node, model) !== 'prototype') return false;
    const owner = unwrapExpression(node.expression);
    return ts.isIdentifier(owner) && expressionIsProvenLocalObject(owner, before, model, seen);
  }
  if (ts.isNewExpression(node)) {
    const callee = unwrapExpression(node.expression);
    return Boolean(ts.isIdentifier(callee) && model.resolveBinding(callee));
  }
  if (!ts.isIdentifier(node)) return false;
  const binding = model.resolveBinding(node);
  if (!binding || seen.has(binding)) return false;
  if (binding.classDeclarations.length === 1 || binding.functionDeclarations.length === 1) return true;
  const records = (model.writes.get(binding) ?? []).filter((record) => (
    record.expression && record.node.getStart() < before.getStart()
  ));
  if (records.length !== 1) return false;
  seen.add(binding);
  const result = expressionIsProvenLocalObject(records[0].expression, before, model, seen);
  seen.delete(binding);
  return result;
}

function timerCallIsCancelled(timerCall, root, model) {
  const timerBindings = [...model.bindings].filter((binding) => (model.writes.get(binding) ?? []).some((record) => (
    record.expression && nodeWithin(timerCall, record.expression)
  )));
  const crashDelay = constantValue(timerCall.arguments[1], model);
  const timerCallback = callbackArgument(timerCall, 0);
  const enclosingRegistration = (callable) => {
    let current = callable?.parent;
    while (current && ts.isParenthesizedExpression(current)) current = current.parent;
    return current && ts.isCallExpression(current) && current.arguments.includes(callable) ? current : undefined;
  };
  return descendants(root, (node) => {
    if (!ts.isCallExpression(node) || !isStaticallyLive(node, root, model)) return false;
    const clears = resolvedInvocations(node, model).filter((invocation) => invocation.kind === 'global-clear-timeout');
    return clears.some((invocation) => {
      if (invocation.uncertainArguments) return true;
      const handle = invocation.args[0];
      const targetsCrashTimer = handle && (nodeWithin(timerCall, handle)
        || timerBindings.some((binding) => expressionResolvesToBinding(handle, binding, node, model)));
      if (!targetsCrashTimer || node.getStart() < timerCall.getStart()) return false;
      const owner = callableAncestor(node, root);
      if (!owner) return true;
      if (owner === timerCallback) return false;
      const scheduler = enclosingRegistration(owner);
      if (!scheduler || !directGlobalCall(scheduler, 'setTimeout', model)) return true;
      const cancellationDelay = constantValue(scheduler.arguments[1], model);
      return !(typeof crashDelay === 'number' && typeof cancellationDelay === 'number'
        && Number.isFinite(crashDelay) && Number.isFinite(cancellationDelay)
        && cancellationDelay > crashDelay);
    });
  }).length > 0;
}

function protectedGlobalMutation(sourceFile, model) {
  const sensitiveUnknownName = (name) => [
    'crash', 'parentPort', 'Promise', 'setTimeout', 'clearTimeout', '__defineGetter__', '__defineSetter__',
  ].includes(name);
  const protectedProperty = (targetKind, name) => targetKind === 'global-process'
    ? ['crash', 'parentPort', '__proto__', '__defineGetter__', '__defineSetter__'].includes(name) || name === undefined
    : targetKind === 'global-object'
      ? ['process', 'Promise', 'setTimeout', 'clearTimeout', '__proto__', '__defineGetter__', '__defineSetter__'].includes(name) || name === undefined
      : false;
  const targetIdentities = (node, before) => possibleStableValues(node, before, model);
  const protectedIdentities = (identities, name) => [...identities].some((kind) => protectedProperty(kind, name));
  const targetIsUnsafeOrUnresolved = (target, name, before) => {
    if (!target) return sensitiveUnknownName(name);
    const identities = targetIdentities(target, before);
    if (protectedIdentities(identities, name)) return true;
    if (identities.size > 0) return false;
    return sensitiveUnknownName(name) && !expressionIsProvenLocalObject(target, before, model);
  };
  const mutations = [];
  walk(sourceFile, (node) => {
    if (!isStaticallyLive(node, sourceFile, model)) return;
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && ['__defineGetter__', '__defineSetter__'].includes(expressionMemberName(node, model))) {
      const directInvocation = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!directInvocation && targetIsUnsafeOrUnresolved(node.expression, expressionMemberName(node, model), node)) {
        mutations.push(node);
      }
    }
    if (ts.isBinaryExpression(node) && [
      ts.SyntaxKind.EqualsToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
    ].includes(node.operatorToken.kind)) {
      const target = unwrapExpression(node.left);
      if (ts.isIdentifier(target) && !model.resolveBinding(target)
        && ['process', 'Promise', 'setTimeout', 'clearTimeout'].includes(target.text)) mutations.push(node);
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        const name = expressionMemberName(target, model);
        if (targetIsUnsafeOrUnresolved(target.expression, name, node)) mutations.push(node);
      }
    }
    if (ts.isDeleteExpression(node)) {
      const target = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        const name = expressionMemberName(target, model);
        if (targetIsUnsafeOrUnresolved(target.expression, name, node)) mutations.push(node);
      }
    }
    if (!ts.isCallExpression(node)) return;
    const directMethod = expressionMemberName(node.expression, model);
    const directReceiver = expressionReceiver(node.expression);
    if (['__defineGetter__', '__defineSetter__'].includes(directMethod)) {
      const key = node.arguments[0] ? constantValue(node.arguments[0], model) : UNKNOWN_CONSTANT;
      const name = key === UNKNOWN_CONSTANT ? undefined : String(key);
      if (targetIsUnsafeOrUnresolved(directReceiver, name, node)) mutations.push(node);
    }

    const invocations = resolvedInvocations(node, model);
    for (const invocation of invocations) {
      const objectMethod = invocation.kind.startsWith('intrinsic-object-method:')
        ? invocation.kind.slice('intrinsic-object-method:'.length) : undefined;
      const reflectMethod = invocation.kind.startsWith('intrinsic-reflect-method:')
        ? invocation.kind.slice('intrinsic-reflect-method:'.length) : undefined;
      if (invocation.uncertainArguments
        && (objectMethod || (reflectMethod && reflectMethod !== 'apply'))) {
        mutations.push(node);
        continue;
      }
      const target = invocation.args[0];
      const key = invocation.args[1] ? constantValue(invocation.args[1], model) : UNKNOWN_CONSTANT;
      const name = key === UNKNOWN_CONSTANT ? undefined : String(key);
      if (objectMethod === 'defineProperty' && targetIsUnsafeOrUnresolved(target, name, node)) mutations.push(node);
      if (['set', 'deleteProperty', 'defineProperty'].includes(reflectMethod)
        && targetIsUnsafeOrUnresolved(target, name, node)) mutations.push(node);
      if (objectMethod === 'setPrototypeOf' || reflectMethod === 'setPrototypeOf') {
        const targetKinds = target ? targetIdentities(target, node) : new Set();
        if (targetKinds.has('global-process') || targetKinds.has('global-object')
          ) mutations.push(node);
      }
      if (!['defineProperties', 'assign'].includes(objectMethod)) continue;
      const targetKinds = target ? targetIdentities(target, node) : new Set();
      if (!targetKinds.has('global-process') && !targetKinds.has('global-object')) continue;
      const sources = objectMethod === 'assign' ? invocation.args.slice(1) : [invocation.args[1]];
      for (const source of sources) {
        const object = source && unwrapExpression(source);
        if (!object || !ts.isObjectLiteralExpression(object)) {
          mutations.push(node);
          break;
        }
        const names = object.properties.map((property) => propertyNameText(property.name, model));
        if (names.some((name) => protectedIdentities(targetKinds, name))) {
          mutations.push(node);
          break;
        }
      }
    }

    const reflectApply = invocations.find((invocation) => invocation.kind === 'intrinsic-reflect-method:apply');
    if (reflectApply) {
      const targetKinds = node.arguments[0] ? targetIdentities(node.arguments[0], node) : new Set();
      const applied = node.arguments[2] ? staticArgumentArray(node.arguments[2], node, model) : undefined;
      const appliedTarget = applied?.[0];
      const appliedKey = applied?.[1] ? constantValue(applied[1], model) : UNKNOWN_CONSTANT;
      const appliedName = appliedKey === UNKNOWN_CONSTANT ? undefined : String(appliedKey);
      if (targetKinds.size === 0 && (!applied || targetIsUnsafeOrUnresolved(appliedTarget, appliedName, node))) mutations.push(node);
    }
  });
  return mutations[0];
}

function expressionResolvesToBinding(node, binding, before, model, seen = new Set()) {
  node = unwrapExpression(node);
  if (!ts.isIdentifier(node)) return false;
  const resolved = model.resolveBinding(node);
  if (resolved === binding) return true;
  if (!resolved || seen.has(resolved)) return false;
  const records = (model.writes.get(resolved) ?? []).filter((record) => record.expression && record.node.getStart() < before.getStart());
  if (records.length === 0) return false;
  seen.add(resolved);
  const result = records.some((record) => expressionResolvesToBinding(record.expression, binding, before, model, seen));
  seen.delete(resolved);
  return result;
}

function bindingMethodIsMutated(root, binding, name, model) {
  return descendants(root, (node) => {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) {
      const target = unwrapExpression(node.left);
      return (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
        && expressionMemberName(target, model) === name
        && expressionResolvesToBinding(target.expression, binding, node, model);
    }
    if (!ts.isCallExpression(node)) return false;
    const calleeKind = classifyStableValue(node.expression, node, model);
    const method = calleeKind?.startsWith('intrinsic-object-method:')
      ? calleeKind.slice('intrinsic-object-method:'.length) : undefined;
    if (!['defineProperty', 'defineProperties', 'assign'].includes(method)) return false;
    const target = node.arguments[0];
    if (!target || !expressionResolvesToBinding(target, binding, node, model)) return false;
    if (method === 'defineProperty') return constantValue(node.arguments[1], model) === name || constantValue(node.arguments[1], model) === UNKNOWN_CONSTANT;
    const source = node.arguments[1] && unwrapExpression(node.arguments[1]);
    if (!source || !ts.isObjectLiteralExpression(source)) return true;
    return source.properties.some((property) => propertyNameText(property.name, model) === name || !propertyNameText(property.name, model));
  }).length > 0;
}

function callableAncestor(node, stop) {
  let current = node.parent;
  while (current && current !== stop) {
    if (callableBody(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function callsOwnedByCallable(callable, name, model) {
  const body = callableBody(callable);
  return liveCalls(body, name, model).filter((call) => callableAncestor(call, body) === undefined);
}

function callableBinding(callable, model) {
  if ((ts.isFunctionDeclaration(callable) || ts.isFunctionExpression(callable)) && callable.name) return model.resolveBinding(callable.name);
  const parent = callable.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return model.resolveBinding(parent.name);
  return undefined;
}

function platformContinuationInvokes(callable, container, model) {
  const binding = callableBinding(callable, model);
  if (!binding) {
    const parent = callable.parent;
    if (ts.isCallExpression(parent)) {
      const index = parent.arguments.indexOf(callable);
      const name = expressionMemberName(parent.expression, model);
      const receiver = expressionReceiver(parent.expression);
      return index === 0 && name === 'then' && classifyStableValue(receiver, parent, model) === 'native-promise';
    }
    return false;
  }
  return descendants(container, (node) => ts.isCallExpression(node) && node !== callable.parent).some((call) => {
    if (!isStaticallyLive(call, container, model)) return false;
    const callee = unwrapExpression(call.expression);
    if (ts.isIdentifier(callee) && model.resolveBinding(callee) === binding) return true;
    const name = expressionMemberName(callee, model);
    if (name !== 'then' || !call.arguments.some((argument) => bindingOfIdentifier(argument, model) === binding)) return false;
    const receiver = expressionReceiver(callee);
    return classifyStableValue(receiver, call, model) === 'native-promise';
  });
}

function scenarioEntryIsActivated(call, container, model) {
  if (!isStaticallyLive(call, container, model)) return false;
  const enclosing = callableAncestor(call, container);
  return !enclosing || platformContinuationInvokes(enclosing, container, model);
}

function scenarioActivationAnchor(call, subjectContainer, model) {
  const enclosing = callableAncestor(call, subjectContainer);
  if (!enclosing) return { activation: call, enclosing: undefined };
  const binding = callableBinding(enclosing, model);
  assertStructure(binding, 'the scenario startup callable must have one lexical binding');
  const activations = descendants(subjectContainer, (node) => {
    if (!ts.isCallExpression(node) || nodeWithin(node, enclosing)) return false;
    const callee = unwrapExpression(node.expression);
    if (ts.isIdentifier(callee) && model.resolveBinding(callee) === binding) return true;
    if (expressionMemberName(callee, model) !== 'then') return false;
    const receiver = expressionReceiver(callee);
    return Boolean(receiver && classifyStableValue(receiver, node, model) === 'native-promise'
      && node.arguments.some((argument) => bindingOfIdentifier(argument, model) === binding));
  });
  assertStructure(activations.length >= 1,
    'the scenario startup callable must have at least one proven direct or app-readiness activation');
  return { activation: activations[0], enclosing };
}

function classBindingForExpression(node, before, model) {
  node = unwrapExpression(node);
  if (ts.isClassExpression(node)) return { node };
  if (!ts.isIdentifier(node)) return undefined;
  const binding = model.resolveBinding(node);
  if (!binding) return undefined;
  if (binding.classDeclarations.length === 1) return { node: binding.classDeclarations[0], binding };
  const records = (model.writes.get(binding) ?? []).filter((record) => record.expression && record.node.getStart() < before.getStart());
  if (records.length !== 1) return undefined;
  const value = unwrapExpression(records[0].expression);
  return ts.isClassExpression(value) ? { node: value, binding } : undefined;
}

function newExpressionConstructs(node, classNode, before, model) {
  node = unwrapExpression(node);
  if (!ts.isNewExpression(node)) return false;
  const value = classBindingForExpression(node.expression, before, model);
  return value?.node === classNode;
}

function classConstructorInstallsSupervisor(classNode, supervisorClass, model) {
  const constructor = classNode.members.find(ts.isConstructorDeclaration);
  if (!constructor?.body) return false;
  return descendants(constructor.body, (node) => ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && isThisMember(node.left, 'rasterUtilities', model)
    && newExpressionConstructs(node.right, supervisorClass, node, model)
    && isStaticallyLive(node, constructor.body, model)).length > 0;
}

function expressionProvidesSupervisor(node, before, supervisorClass, model, seen = new Set()) {
  node = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => ts.isPropertyAssignment(property)
      && propertyNameText(property.name, model) === 'rasterUtilities'
      && newExpressionConstructs(property.initializer, supervisorClass, before, model));
  }
  if (ts.isNewExpression(node)) {
    const engineClass = classBindingForExpression(node.expression, before, model);
    return Boolean(engineClass && classConstructorInstallsSupervisor(engineClass.node, supervisorClass, model));
  }
  if (ts.isIdentifier(node)) {
    const binding = model.resolveBinding(node);
    if (!binding || seen.has(binding)) return false;
    const records = (model.writes.get(binding) ?? []).filter((record) => record.expression && record.node.getStart() < before.getStart());
    if (records.length === 0) return false;
    const latest = records.at(-1);
    if (records.some((record) => record !== latest && record.node.getStart() > latest.node.getStart())) return false;
    seen.add(binding);
    const result = expressionProvidesSupervisor(latest.expression, before, supervisorClass, model, seen);
    seen.delete(binding);
    return result;
  }
  return false;
}

function functionBindingForDeclaration(node, model) {
  return ts.isFunctionDeclaration(node) && node.name ? model.resolveBinding(node.name) : undefined;
}

function rasterUtilitiesRootBinding(call, model) {
  const methodReceiver = expressionReceiver(call.expression);
  if (!methodReceiver || expressionMemberName(methodReceiver, model) !== 'rasterUtilities') return undefined;
  return bindingOfIdentifier(expressionReceiver(methodReceiver), model);
}

function findScenario(sourceFile, model) {
  const candidates = [...model.callableNodes].filter((node) => callableBody(node)
    && callsOwnedByCallable(node, 'runE2eContainmentProbe', model).length >= 2);
  assertStructure(candidates.length === 1, 'exactly one containment scenario callable must own the crash/cancel/restart checks');
  return candidates[0];
}

function assertScenarioStructure(sourceFile, model, scenario, supervisorClass) {
  const body = callableBody(scenario);
  const probeCalls = liveCalls(body, 'runE2eContainmentProbe', model);
  const crash = probeCalls.find((call) => callArgumentLiteral(call, 0, 'crash', model));
  const hang = probeCalls.find((call) => callArgumentLiteral(call, 0, 'hang', model));
  const engineBinding = crash ? rasterUtilitiesRootBinding(crash, model) : undefined;
  assertStructure(crash && hang && engineBinding && rasterUtilitiesRootBinding(hang, model) === engineBinding,
    'the packaged scenario must issue crash and hang probes through one engine raster-utility receiver');
  const exports = liveCalls(body, 'exportDocument', model).filter((call) => rasterUtilitiesRootBinding(call, model) === engineBinding);
  const statuses = liveCalls(body, 'status', model).filter((call) => rasterUtilitiesRootBinding(call, model) === engineBinding);
  const aborts = liveCalls(body, 'abort', model);
  const nativeSets = descendants(body, (node) => ts.isNewExpression(node)).filter((node) => {
    const callee = unwrapExpression(node.expression);
    return ts.isIdentifier(callee) && callee.text === 'Set' && !model.resolveBinding(callee);
  });
  assertStructure(exports.length >= 2 && statuses.length >= 2 && aborts.length >= 1 && nativeSets.length >= 1
    && nodeContainsText(body, sourceFile, 'AbortError'),
  'the packaged scenario must execute cancellation, queued real work, and distinct-worker recovery checks');

  const crashBinding = findBindingWrittenFrom(body, model, (expression) => expression === crash);
  const hangBinding = findBindingWrittenFrom(body, model, (expression) => expression === hang);
  const rejectedCrash = descendants(body, ts.isCallExpression).find((call) => call.arguments[0]
    && expressionResolvesToBinding(call.arguments[0], crashBinding, call, model));
  const rejectedHang = descendants(body, ts.isCallExpression).find((call) => call.arguments[0]
    && expressionResolvesToBinding(call.arguments[0], hangBinding, call, model));
  const controllerBinding = findBindingWrittenFrom(body, model, (expression) => {
    expression = unwrapExpression(expression);
    if (!ts.isNewExpression(expression)) return false;
    const callee = unwrapExpression(expression.expression);
    return ts.isIdentifier(callee) && callee.text === 'AbortController' && !model.resolveBinding(callee);
  });
  const exactAbort = aborts.find((call) => controllerBinding
    && expressionResolvesToBinding(expressionReceiver(call.expression), controllerBinding, call, model));
  assertStructure(crashBinding && hangBinding && rejectedCrash && rejectedHang && controllerBinding && exactAbort,
    'the packaged scenario must await both exact probe tasks and fire the exact hanging-task AbortController');

  let scenarioTry;
  let current = crash.parent;
  while (current && current !== body) {
    if (ts.isTryStatement(current)) { scenarioTry = current; break; }
    current = current.parent;
  }
  const finalReturn = descendants(body, (node) => ts.isReturnStatement(node)
    && callableAncestor(node, body) === undefined).at(-1);
  assertStructure(scenarioTry && finalReturn,
    'the packaged scenario must retain one inspectable pass/failure boundary and final result return');
  const orderedScenarioAnchors = [
    crash,
    exports.find((call) => call.getStart() > crash.getStart()),
    rejectedCrash,
    statuses.find((call) => call.getStart() > rejectedCrash.getStart()),
    hang,
    exports.find((call) => call.getStart() > hang.getStart()),
    exactAbort,
    rejectedHang,
    statuses.find((call) => call.getStart() > rejectedHang.getStart()),
    nativeSets.at(-1),
  ];
  assertStructure(orderedScenarioAnchors.every(Boolean)
    && orderedScenarioAnchors.every((anchor, index) => index === 0 || anchor.getStart() > orderedScenarioAnchors[index - 1].getStart()),
  'the packaged scenario must retain ordered crash, queued-work, cancellation, and distinct-worker pass anchors');
  assertPrecisePath(scenarioTry.tryBlock, orderedScenarioAnchors,
    'the packaged scenario pass path must execute every crash/cancel/restart behavioral anchor before completion',
    model, { ignoreThrows: true });
  const tryIndex = body.statements.indexOf(scenarioTry);
  assertStructure(tryIndex >= 0
    && !body.statements.slice(0, tryIndex).some((statement) => ts.isReturnStatement(statement)
      || ts.isWhileStatement(statement) || ts.isDoStatement(statement) || ts.isForStatement(statement)),
  'the packaged scenario callable must reach its pass/failure boundary and final result without an earlier completion');
  assertPrecisePath(body, [scenarioTry, finalReturn],
    'the packaged scenario callable must reach its pass/failure boundary and final result without an earlier completion',
    model, { ignoreThrows: true });

  const scenarioBinding = functionBindingForDeclaration(scenario, model);
  assertStructure(scenarioBinding, 'the containment scenario must have one lexical function binding');
  const entries = descendants(sourceFile, (node) => ts.isCallExpression(node)
    && bindingOfIdentifier(node.expression, model) === scenarioBinding
    && !nodeWithin(node, scenario));
  const entry = entries.find((call) => call.arguments[0]
    && expressionProvidesSupervisor(call.arguments[0], call, supervisorClass, model));
  assertStructure(entry, 'headless startup must pass an engine that owns the supervisor to the containment scenario');
  return entry;
}

function executionContainers(node) {
  const containers = [];
  let current = node;
  while (current) {
    if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isCaseClause(current) || ts.isDefaultClause(current)) containers.push(current);
    current = current.parent;
  }
  return containers;
}

function commonExecutionContainer(nodes) {
  const first = executionContainers(nodes[0]);
  return first.find((candidate) => nodes.every((node) => nodeWithin(node, candidate)));
}

function executableContains(root, target) {
  if (root === target) return true;
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (node === target) {
      found = true;
      return;
    }
    if (node !== root && (callableBody(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) return;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function directIifeBody(expression) {
  expression = unwrapExpression(expression);
  if (!ts.isCallExpression(expression)) return undefined;
  const callee = unwrapExpression(expression.expression);
  return (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) ? callee.body : undefined;
}

function orderedNormalPath(container, anchors, model) {
  if (anchors.some((anchor, index) => index > 0 && anchor.getStart() <= anchors[index - 1].getStart())) {
    return { reachedAndCompleted: false, states: [] };
  }
  const anchorBits = new Map(anchors.map((anchor, index) => [anchor, 2 ** index]));
  const fullMask = (2 ** anchors.length) - 1;
  const mark = (node, mask) => {
    let result = mask;
    for (const [anchor, bit] of anchorBits) if (executableContains(node, anchor)) result |= bit;
    return result;
  };
  const unique = (states) => {
    const seen = new Set();
    return states.filter((state) => {
      const key = `${state.kind}:${state.mask}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const analyzeSequence = (statements, incoming) => {
    let states = incoming;
    for (const statement of statements) {
      const terminal = states.filter((state) => state.kind !== 'normal');
      const next = states.filter((state) => state.kind === 'normal').flatMap((state) => analyzeStatement(statement, state.mask));
      states = unique([...terminal, ...next]);
    }
    return states;
  };
  const analyzeIife = (expression, mask) => {
    const body = directIifeBody(expression);
    if (!body) return [{ kind: 'normal', mask }];
    if (!ts.isBlock(body)) return [{ kind: 'normal', mask: mark(body, mask) }];
    return analyzeSequence(body.statements, [{ kind: 'normal', mask }]).map((state) => (
      state.kind === 'return' ? { kind: 'normal', mask: state.mask } : state
    ));
  };
  const analyzeStatement = (statement, mask) => {
    const marked = mask | (anchorBits.get(statement) ?? 0);
    if (ts.isBlock(statement)) return analyzeSequence(statement.statements, [{ kind: 'normal', mask }]);
    if (ts.isReturnStatement(statement)) return [{ kind: 'return', mask: marked }];
    if (ts.isThrowStatement(statement)) return [{ kind: 'throw', mask: marked }];
    if (ts.isBreakStatement(statement)) return [{ kind: 'break', mask: marked }];
    if (ts.isContinueStatement(statement)) return [{ kind: 'continue', mask: marked }];
    if (ts.isExpressionStatement(statement)) return analyzeIife(statement.expression, mark(statement.expression, marked));
    if (ts.isVariableStatement(statement)) {
      let states = [{ kind: 'normal', mask: marked }];
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) continue;
        states = states.flatMap((state) => state.kind === 'normal' ? analyzeIife(declaration.initializer, state.mask) : [state]);
      }
      return states;
    }
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isEmptyStatement(statement) || ts.isDebuggerStatement(statement)) return [{ kind: 'normal', mask: marked }];
    if (ts.isIfStatement(statement)) {
      const condition = constantValue(statement.expression, model);
      if (condition !== UNKNOWN_CONSTANT) {
        if (condition) return analyzeStatement(statement.thenStatement, marked);
        return statement.elseStatement ? analyzeStatement(statement.elseStatement, marked) : [{ kind: 'normal', mask: marked }];
      }
      return unique([
        ...analyzeStatement(statement.thenStatement, marked),
        ...(statement.elseStatement ? analyzeStatement(statement.elseStatement, marked) : [{ kind: 'normal', mask: marked }]),
      ]);
    }
    if (ts.isTryStatement(statement)) {
      const tried = analyzeSequence(statement.tryBlock.statements, [{ kind: 'normal', mask: marked }]);
      const nonThrows = tried.filter((state) => state.kind !== 'throw');
      let states = nonThrows;
      if (statement.catchClause && tried.some((state) => state.kind === 'throw')) {
        states = [...states, ...analyzeSequence(statement.catchClause.block.statements, [{ kind: 'normal', mask: marked }])];
      } else if (!statement.catchClause) states = tried;
      if (statement.finallyBlock) {
        states = states.flatMap((state) => {
          const finalStates = analyzeSequence(statement.finallyBlock.statements, [{ kind: 'normal', mask: state.mask }]);
          return finalStates.map((finalState) => finalState.kind === 'normal' ? { ...state, mask: finalState.mask } : finalState);
        });
      }
      return unique(states);
    }
    if (ts.isSwitchStatement(statement)) {
      const discriminant = constantValue(statement.expression, model);
      const clauses = statement.caseBlock.clauses;
      const runFrom = (start) => {
        if (start < 0) return [{ kind: 'normal', mask: marked }];
        const states = analyzeSequence(clauses.slice(start).flatMap((clause) => clause.statements), [{ kind: 'normal', mask: marked }]);
        return states.map((state) => state.kind === 'break' ? { kind: 'normal', mask: state.mask } : state);
      };
      if (discriminant !== UNKNOWN_CONSTANT) {
        let selected = clauses.findIndex((clause) => ts.isCaseClause(clause)
          && constantValue(clause.expression, model) !== UNKNOWN_CONSTANT
          && Object.is(constantValue(clause.expression, model), discriminant));
        if (selected < 0) selected = clauses.findIndex(ts.isDefaultClause);
        return unique(runFrom(selected));
      }
      const starts = clauses.map((_clause, index) => index);
      const noMatch = clauses.some(ts.isDefaultClause) ? [] : [{ kind: 'normal', mask: marked }];
      return unique([...noMatch, ...starts.flatMap(runFrom)]);
    }
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement) || ts.isForStatement(statement)) {
      const conditionNode = ts.isForStatement(statement) ? statement.condition : statement.expression;
      const condition = conditionNode ? constantValue(conditionNode, model) : true;
      if (condition !== UNKNOWN_CONSTANT && !condition && !ts.isDoStatement(statement)) return [{ kind: 'normal', mask: marked }];
      const body = analyzeStatement(statement.statement, marked);
      const exits = body.filter((state) => state.kind === 'break').map((state) => ({ kind: 'normal', mask: state.mask }));
      const abrupt = body.filter((state) => ['return', 'throw'].includes(state.kind));
      if (condition === true) return unique([...exits, ...abrupt, ...body.filter((state) => ['normal', 'continue'].includes(state.kind)).map((state) => ({ kind: 'nonterminate', mask: state.mask }))]);
      return unique([{ kind: 'normal', mask: marked }, ...exits, ...abrupt]);
    }
    if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
      const body = analyzeStatement(statement.statement, marked);
      return unique([{ kind: 'normal', mask: marked }, ...body.filter((state) => ['return', 'throw'].includes(state.kind))]);
    }
    // The emitted bundle has no other top-level control construct in its
    // accepted language. Unknown statement forms fail closed.
    return [{ kind: 'unsupported', mask: marked }];
  };

  const states = analyzeSequence(container.statements ?? [], [{ kind: 'normal', mask: 0 }]);
  const successfulKinds = new Set(['normal']);
  let completionOwner = container;
  while (completionOwner && !ts.isSourceFile(completionOwner) && !callableBody(completionOwner)) {
    if (ts.isCaseClause(completionOwner) || ts.isDefaultClause(completionOwner)) successfulKinds.add('break');
    completionOwner = completionOwner.parent;
  }
  if (ts.isBlock(container) && callableBody(container.parent)) successfulKinds.add('return');
  return {
    reachedAndCompleted: states.some((state) => successfulKinds.has(state.kind) && state.mask === fullMask),
    states,
  };
}

// Critical containment callables use a smaller, deliberately fail-closed
// control-flow language than the module-admission interpreter.  Unlike
// orderedNormalPath(), this walker never marks an anchor merely because it is
// textually nested in an expression: the expression branch containing that
// exact AST node must execute.  Opaque calls are the report's explicit
// normal-completion precondition; directly invoked local/IIFE code with a
// definite throw or non-terminating loop is not opaque and blocks the path.
function preciseOrderedPath(container, anchors, model, options = {}) {
  const anchorBits = new Map(anchors.map((anchor, index) => [anchor, 2 ** index]));
  const fullMask = (2 ** anchors.length) - 1;
  const maxStates = options.maxStates ?? 512;
  const conditionValue = (node) => {
    const overridden = options.conditionValue?.(node);
    if (overridden !== undefined && overridden !== UNKNOWN_CONSTANT) return overridden;
    return constantValue(node, model);
  };
  const mark = (node, mask) => mask | (anchorBits.get(node) ?? 0);
  const unique = (states) => {
    const seen = new Set();
    const result = [];
    for (const state of states) {
      const key = `${state.kind}:${state.mask}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(state);
      if (result.length > maxStates) return [{ kind: 'unsupported', mask: state.mask, detail: 'state-limit' }];
    }
    return result;
  };
  const mapNormal = (states, callback) => unique(states.flatMap((state) => (
    state.kind === 'normal' ? callback(state) : [state]
  )));

  const directCallable = (call) => {
    const callee = unwrapExpression(call.expression);
    if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) return callee;
    if (!ts.isIdentifier(callee)) return undefined;
    const binding = model.resolveBinding(callee);
    if (!binding) return undefined;
    if (binding.functionDeclarations.length === 1) return binding.functionDeclarations[0];
    const records = (model.writes.get(binding) ?? []).filter((record) => (
      record.expression && record.node.getStart() < call.getStart()
    ));
    if (records.length !== 1) return undefined;
    const value = unwrapExpression(records[0].expression);
    return ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value : undefined;
  };
  const directCallableDefiniteAbrupt = (call) => {
    const callable = directCallable(call);
    if (!callable || !ts.isBlock(callable.body)) return undefined;
    const statements = callable.body.statements;
    if (statements.length === 0) return undefined;
    const first = statements[0];
    if (ts.isThrowStatement(first)) return 'throw';
    if ((ts.isWhileStatement(first) || ts.isDoStatement(first))
      && constantValue(first.expression, model) === true
      && descendants(first.statement, ts.isBreakStatement).length === 0) return 'nonterminate';
    if (ts.isForStatement(first) && (!first.condition || constantValue(first.condition, model) === true)
      && descendants(first.statement, ts.isBreakStatement).length === 0) return 'nonterminate';
    return undefined;
  };
  const definitelyPendingPromise = (node) => {
    node = unwrapExpression(node);
    if (!ts.isNewExpression(node)) return false;
    const callee = unwrapExpression(node.expression);
    if (!ts.isIdentifier(callee) || callee.text !== 'Promise' || model.resolveBinding(callee)) return false;
    return callbackIsUnsettled(callbackArgument(node, 0), model);
  };

  const analyzeExpression = (expression, incoming) => {
    if (!expression) return incoming;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
      return analyzeExpression(expression.expression, incoming);
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || ts.isClassExpression(expression)) {
      return incoming.map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isConditionalExpression(expression)) {
      const conditioned = analyzeExpression(expression.condition, incoming);
      return mapNormal(conditioned, (state) => {
        const value = conditionValue(expression.condition);
        if (value !== UNKNOWN_CONSTANT) return analyzeExpression(value ? expression.whenTrue : expression.whenFalse, [state]);
        return unique([
          ...analyzeExpression(expression.whenTrue, [{ ...state }]),
          ...analyzeExpression(expression.whenFalse, [{ ...state }]),
        ]);
      });
    }
    if (ts.isBinaryExpression(expression)) {
      const left = analyzeExpression(expression.left, incoming);
      if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind)) {
        return mapNormal(left, (state) => {
          const value = conditionValue(expression.left);
          const executesRight = expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? Boolean(value)
            : expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ? !value
              : value === null || value === undefined;
          if (value !== UNKNOWN_CONSTANT) {
            return executesRight ? analyzeExpression(expression.right, [state]) : [{ ...state, mask: mark(expression, state.mask) }];
          }
          return unique([
            { ...state, mask: mark(expression, state.mask) },
            ...analyzeExpression(expression.right, [{ ...state }]).map((candidate) => ({
              ...candidate, mask: mark(expression, candidate.mask),
            })),
          ]);
        });
      }
      const right = analyzeExpression(expression.right, left);
      return right.map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isCallExpression(expression)) {
      let states = analyzeExpression(expression.expression, incoming);
      for (const argument of expression.arguments) states = analyzeExpression(argument, states);
      states = states.map((state) => ({ ...state, mask: mark(expression, state.mask) }));
      const callee = unwrapExpression(expression.expression);
      if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
        const body = callableBody(callee);
        if (!body) return states;
        const invoked = ts.isBlock(body)
          ? analyzeSequence(body.statements, states)
          : analyzeExpression(body, states).map((state) => state.kind === 'normal' ? { ...state, kind: 'return' } : state);
        return invoked.map((state) => state.kind === 'return' ? { ...state, kind: 'normal' } : state);
      }
      const abrupt = directCallableDefiniteAbrupt(expression);
      if (abrupt) return states.map((state) => state.kind === 'normal' ? { ...state, kind: abrupt } : state);
      return states;
    }
    if (ts.isNewExpression(expression)) {
      let states = analyzeExpression(expression.expression, incoming);
      for (const argument of expression.arguments ?? []) states = analyzeExpression(argument, states);
      return states.map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isAwaitExpression(expression)) {
      const states = analyzeExpression(expression.expression, incoming)
        .map((state) => ({ ...state, mask: mark(expression, state.mask) }));
      if (definitelyPendingPromise(expression.expression)) {
        return states.map((state) => state.kind === 'normal' ? { ...state, kind: 'nonterminate' } : state);
      }
      return states;
    }
    if (ts.isVoidExpression(expression) || ts.isTypeOfExpression(expression)
      || ts.isDeleteExpression(expression) || ts.isPrefixUnaryExpression(expression)
      || ts.isPostfixUnaryExpression(expression) || ts.isSpreadElement(expression)) {
      const operand = expression.expression ?? expression.operand;
      return analyzeExpression(operand, incoming).map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return analyzeExpression(expression.expression, incoming)
        .map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isElementAccessExpression(expression)) {
      const receiver = analyzeExpression(expression.expression, incoming);
      return analyzeExpression(expression.argumentExpression, receiver)
        .map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isArrayLiteralExpression(expression)) {
      let states = incoming;
      for (const element of expression.elements) states = analyzeExpression(element, states);
      return states.map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isObjectLiteralExpression(expression)) {
      let states = incoming;
      for (const property of expression.properties) {
        if (ts.isPropertyAssignment(property)) states = analyzeExpression(property.initializer, states);
        else if (ts.isShorthandPropertyAssignment(property)) states = analyzeExpression(property.name, states);
        else if (ts.isSpreadAssignment(property)) states = analyzeExpression(property.expression, states);
        else if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)
          || ts.isSetAccessorDeclaration(property)) continue;
        else return [{ kind: 'unsupported', mask: states[0]?.mask ?? 0, detail: ts.SyntaxKind[property.kind] }];
      }
      return states.map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isTemplateExpression(expression)) {
      let states = incoming;
      for (const span of expression.templateSpans) states = analyzeExpression(span.expression, states);
      return states.map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isTaggedTemplateExpression(expression)) {
      const tag = analyzeExpression(expression.tag, incoming);
      return analyzeExpression(expression.template, tag)
        .map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isYieldExpression(expression)) {
      return analyzeExpression(expression.expression, incoming)
        .map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    if (ts.isIdentifier(expression) || ts.isPrivateIdentifier(expression)
      || ts.isLiteralExpression(expression) || expression.kind === ts.SyntaxKind.ThisKeyword
      || expression.kind === ts.SyntaxKind.SuperKeyword || expression.kind === ts.SyntaxKind.ImportKeyword
      || expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword
      || expression.kind === ts.SyntaxKind.NullKeyword) {
      return incoming.map((state) => ({ ...state, mask: mark(expression, state.mask) }));
    }
    return incoming.map((state) => ({
      ...state, kind: 'unsupported', mask: mark(expression, state.mask), detail: ts.SyntaxKind[expression.kind],
    }));
  };

  const analyzeStatement = (statement, incoming) => {
    const states = incoming.map((state) => ({ ...state, mask: mark(statement, state.mask) }));
    if (ts.isBlock(statement)) return analyzeSequence(statement.statements, states);
    if (ts.isExpressionStatement(statement)) return analyzeExpression(statement.expression, states);
    if (ts.isVariableStatement(statement)) {
      let current = states;
      for (const declaration of statement.declarationList.declarations) {
        current = analyzeExpression(declaration.initializer, current);
      }
      return current;
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      return analyzeExpression(statement.expression, states).map((state) => (
        state.kind === 'normal' ? { ...state, kind: ts.isReturnStatement(statement) ? 'return' : 'throw' } : state
      ));
    }
    if (ts.isBreakStatement(statement)) return states.map((state) => ({ ...state, kind: 'break' }));
    if (ts.isContinueStatement(statement)) return states.map((state) => ({ ...state, kind: 'continue' }));
    if (ts.isIfStatement(statement)) {
      const conditioned = analyzeExpression(statement.expression, states);
      return mapNormal(conditioned, (state) => {
        const value = conditionValue(statement.expression);
        if (value !== UNKNOWN_CONSTANT) {
          return value ? analyzeStatement(statement.thenStatement, [state])
            : statement.elseStatement ? analyzeStatement(statement.elseStatement, [state]) : [state];
        }
        return unique([
          ...analyzeStatement(statement.thenStatement, [{ ...state }]),
          ...(statement.elseStatement ? analyzeStatement(statement.elseStatement, [{ ...state }]) : [{ ...state }]),
        ]);
      });
    }
    if (ts.isTryStatement(statement)) {
      const tried = analyzeSequence(statement.tryBlock.statements, states);
      let outcomes = tried.filter((state) => state.kind !== 'throw');
      const thrown = tried.filter((state) => state.kind === 'throw');
      if (statement.catchClause) {
        outcomes = [...outcomes, ...analyzeSequence(statement.catchClause.block.statements,
          thrown.map((state) => ({ ...state, kind: 'normal' })))];
      } else outcomes = [...outcomes, ...thrown];
      if (statement.finallyBlock) {
        outcomes = outcomes.flatMap((state) => analyzeSequence(statement.finallyBlock.statements,
          [{ ...state, kind: 'normal' }]).map((finalState) => (
          finalState.kind === 'normal' ? { ...state, mask: finalState.mask } : finalState
        )));
      }
      return unique(outcomes);
    }
    if (ts.isSwitchStatement(statement)) {
      const discriminantStates = analyzeExpression(statement.expression, states);
      const clauses = statement.caseBlock.clauses;
      const run = (start, state) => {
        if (start < 0) return [state];
        return analyzeSequence(clauses.slice(start).flatMap((clause) => clause.statements), [state])
          .map((candidate) => candidate.kind === 'break' ? { ...candidate, kind: 'normal' } : candidate);
      };
      return mapNormal(discriminantStates, (state) => {
        const value = conditionValue(statement.expression);
        if (value !== UNKNOWN_CONSTANT) {
          let selected = clauses.findIndex((clause) => ts.isCaseClause(clause)
            && constantValue(clause.expression, model) !== UNKNOWN_CONSTANT
            && Object.is(constantValue(clause.expression, model), value));
          if (selected < 0) selected = clauses.findIndex(ts.isDefaultClause);
          return run(selected, state);
        }
        const noMatch = clauses.some(ts.isDefaultClause) ? [] : [state];
        return unique([...noMatch, ...clauses.flatMap((_clause, index) => run(index, { ...state }))]);
      });
    }
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement) || ts.isForStatement(statement)) {
      const conditionNode = ts.isForStatement(statement) ? statement.condition : statement.expression;
      const value = conditionNode ? conditionValue(conditionNode) : true;
      if (value !== UNKNOWN_CONSTANT && !value && !ts.isDoStatement(statement)) return states;
      const bodyStates = analyzeStatement(statement.statement, states);
      const exits = bodyStates.filter((state) => state.kind === 'break').map((state) => ({ ...state, kind: 'normal' }));
      const abrupt = bodyStates.filter((state) => ['return', 'throw', 'unsupported'].includes(state.kind));
      if (value === true) {
        return unique([...exits, ...abrupt, ...bodyStates.filter((state) => ['normal', 'continue'].includes(state.kind))
          .map((state) => ({ ...state, kind: 'nonterminate' }))]);
      }
      return unique([...states, ...exits, ...abrupt]);
    }
    if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
      const body = analyzeStatement(statement.statement, states);
      return unique([...states, ...body.filter((state) => ['return', 'throw', 'unsupported'].includes(state.kind))]);
    }
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isEmptyStatement(statement) || ts.isDebuggerStatement(statement)) return states;
    return states.map((state) => ({ ...state, kind: 'unsupported', detail: ts.SyntaxKind[statement.kind] }));
  };

  function analyzeSequence(statements, incoming) {
    let states = incoming;
    for (const statement of statements) {
      const terminal = states.filter((state) => state.kind !== 'normal');
      const running = states.filter((state) => state.kind === 'normal');
      states = unique([...terminal, ...analyzeStatement(statement, running)]);
    }
    return states;
  }

  const statements = ts.isBlock(container) || ts.isSourceFile(container) ? container.statements
    : ts.isCaseClause(container) || ts.isDefaultClause(container) ? container.statements
      : undefined;
  const states = statements ? analyzeSequence(statements, [{ kind: 'normal', mask: 0 }])
    : ts.isStatement(container) ? analyzeStatement(container, [{ kind: 'normal', mask: 0 }])
      : analyzeExpression(container, [{ kind: 'normal', mask: 0 }]);
  return { states: unique(states), fullMask };
}

function assertPrecisePath(container, anchors, description, model, options = {}) {
  const proof = preciseOrderedPath(container, anchors, model, options);
  const relevant = proof.states.filter((state) => !(options.ignoreThrows && state.kind === 'throw'));
  const allowedKinds = new Set(options.allowedKinds ?? ['normal', 'return']);
  assertStructure(relevant.length > 0
    && relevant.every((state) => state.mask === proof.fullMask && allowedKinds.has(state.kind)),
  description,
  proof.states.map((state) => `${state.kind}:${state.mask}${state.detail ? `:${state.detail}` : ''}`).join(','));
  return proof;
}

function assertSubjectContainerReachable(sourceFile, model, anchors, description, context) {
  const container = commonExecutionContainer(anchors);
  assertStructure(container, `${description} must share one executable installation container`);
  const earliestAnchor = Math.min(...anchors.map((anchor) => anchor.getStart(sourceFile)));
  const strictDirectives = (container.statements ?? []).filter((statement) => ts.isExpressionStatement(statement)
    && ts.isStringLiteral(statement.expression)
    && statement.expression.text === 'use strict'
    && statement.getStart(sourceFile) < earliestAnchor);
  const admission = strictDirectives.at(-1);
  assertStructure(admission, `${description} must retain an inner emitted-chunk strict-mode admission boundary`);
  const proof = createReachabilityInterpreter({ sourceFile, model, target: admission, context }).prove();
  assertStructure(proof.reached, `${description} must be reachable from module evaluation`, proof.reason);
  const ordered = orderedNormalPath(container, anchors, model);
  assertStructure(ordered.reachedAndCompleted,
    `${description} must have one normally completing control-flow path through every ordered implementation anchor`,
    `${ts.SyntaxKind[container.kind]} outcomes ${ordered.states.map((state) => `${state.kind}:${state.mask}`).join(',')}`);
  return container;
}

// Structural assertions below compare lexical bindings and receiver identities;
// marker strings are inventory preconditions only and never satisfy behavior.
function assertMainExecutableStructure(mainSource) {
  const sourceFile = parseJavaScript(mainSource, 'Packaged main process');
  const model = createLexicalModel(sourceFile);
  const globalMutation = protectedGlobalMutation(sourceFile, model);
  assertStructure(!globalMutation,
    'the main containment scheduler and platform globals must remain unmodified',
    globalMutation?.getText(sourceFile).slice(0, 180));
  const supervisorClass = findSupervisorClass(sourceFile, model);
  const methods = methodMap(supervisorClass, model);
  const cancel = assertCancelStructure(methods.get('cancel'), model);
  assertEnqueueStructure(methods.get('enqueue'), model);
  const workerAdmission = assertEnsureWorkerStructure(methods.get('ensureWorker'), model);
  const pump = assertPumpStructure(methods.get('pump'), model);
  const exit = assertHandleExitStructure(methods.get('handleExit'), model, sourceFile);
  assertFinishStructure(methods.get('finish'), model);
  assertProbeStructure(methods.get('runE2eContainmentProbe'), model, sourceFile);
  const scenario = findScenario(sourceFile, model);
  const scenarioEntry = assertScenarioStructure(sourceFile, model, scenario, supervisorClass);
  const emittedContainer = commonExecutionContainer([supervisorClass, scenario, scenarioEntry]);
  assertStructure(emittedContainer, 'main containment implementation must share one emitted-subject container');
  const { activation, enclosing } = scenarioActivationAnchor(scenarioEntry, emittedContainer, model);
  const subjectContainer = assertSubjectContainerReachable(
    sourceFile,
    model,
    [supervisorClass, scenario, activation],
    'main containment implementation',
    'main',
  );
  if (enclosing) {
    const startupPath = orderedNormalPath(callableBody(enclosing), [scenarioEntry], model);
    assertStructure(startupPath.reachedAndCompleted,
      'the activated startup callable must normally complete through the exact scenario invocation');
  }
  assertStructure(scenarioEntryIsActivated(scenarioEntry, subjectContainer, model),
    'headless startup must invoke the scenario through a proven app-readiness continuation');
  return {
    sourceFile,
    model,
    supervisorClass,
    scenario,
    cancelKillCall: cancel.killCall,
    timeoutKillCall: pump.killCall,
    timeoutCallback: pump.timeoutCallback,
    pump,
    workerAdmission,
    exit,
  };
}

function isProvenParentPort(node, before, model) {
  return classifyStableValue(node, before, model) === 'electron-parent-port';
}

function callbackIsUnsettled(executor, model) {
  if (!executor || executor.parameters.length !== 0) return false;
  if (ts.isBlock(executor.body)) return executor.body.statements.length === 0;
  const body = unwrapExpression(executor.body);
  return (ts.isIdentifier(body) && body.text === 'undefined' && !model.resolveBinding(body)) || ts.isVoidExpression(body);
}

function modeReceiverBinding(node, model) {
  node = unwrapExpression(node);
  if ((!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node))
    || expressionMemberName(node, model) !== 'mode') return undefined;
  return bindingOfIdentifier(node.expression, model);
}

function evaluateModePredicate(node, requestBinding, mode, model) {
  node = unwrapExpression(node);
  const constant = constantValue(node, model);
  if (constant !== UNKNOWN_CONSTANT) return Boolean(constant);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const value = evaluateModePredicate(node.operand, requestBinding, mode, model);
    return value === UNKNOWN_CONSTANT ? UNKNOWN_CONSTANT : !value;
  }
  if (!ts.isBinaryExpression(node)) return UNKNOWN_CONSTANT;
  const operator = node.operatorToken.kind;
  if (operator === ts.SyntaxKind.CommaToken) return evaluateModePredicate(node.right, requestBinding, mode, model);
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
    const left = evaluateModePredicate(node.left, requestBinding, mode, model);
    const right = evaluateModePredicate(node.right, requestBinding, mode, model);
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (left === false || right === false) return false;
      return left === true && right === true ? true : UNKNOWN_CONSTANT;
    }
    if (left === true || right === true) return true;
    return left === false && right === false ? false : UNKNOWN_CONSTANT;
  }
  if (![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator)) return UNKNOWN_CONSTANT;
  const leftBinding = modeReceiverBinding(node.left, model);
  const rightBinding = modeReceiverBinding(node.right, model);
  const literalNode = leftBinding === requestBinding ? node.right : rightBinding === requestBinding ? node.left : undefined;
  if (!literalNode) return UNKNOWN_CONSTANT;
  const literal = constantValue(literalNode, model);
  if (literal === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT;
  const equal = Object.is(mode, literal);
  return [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(operator) ? equal : !equal;
}

function pathAllowsMode(node, stop, requestBinding, mode, model) {
  let child = node;
  let current = node.parent;
  while (current && current !== stop) {
    let required;
    if (ts.isIfStatement(current)) {
      if (child === current.thenStatement) required = true;
      else if (child === current.elseStatement) required = false;
      if (required !== undefined) {
        const value = evaluateModePredicate(current.expression, requestBinding, mode, model);
        if ((required && value === false) || (!required && value === true)) return false;
      }
    } else if (ts.isConditionalExpression(current)) {
      if (child === current.whenTrue) required = true;
      else if (child === current.whenFalse) required = false;
      if (required !== undefined) {
        const value = evaluateModePredicate(current.condition, requestBinding, mode, model);
        if ((required && value === false) || (!required && value === true)) return false;
      }
    } else if (ts.isBinaryExpression(current) && child === current.right) {
      const value = evaluateModePredicate(current.left, requestBinding, mode, model);
      if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && value === false) return false;
      if (current.operatorToken.kind === ts.SyntaxKind.BarBarToken && value === true) return false;
    }
    child = current;
    current = current.parent;
  }
  return true;
}

function exactModeDomain(node, stop, requestBinding, model) {
  return ['crash', 'hang', '__other__'].filter((mode) => pathAllowsMode(node, stop, requestBinding, mode, model));
}

function kindReceiverBinding(node, model) {
  node = unwrapExpression(node);
  if ((!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node))
    || expressionMemberName(node, model) !== 'kind') return undefined;
  return bindingOfIdentifier(node.expression, model);
}

function evaluateKindPredicate(node, requestBinding, kind, model) {
  node = unwrapExpression(node);
  const constant = constantValue(node, model);
  if (constant !== UNKNOWN_CONSTANT) return Boolean(constant);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const value = evaluateKindPredicate(node.operand, requestBinding, kind, model);
    return value === UNKNOWN_CONSTANT ? UNKNOWN_CONSTANT : !value;
  }
  if (!ts.isBinaryExpression(node)) return UNKNOWN_CONSTANT;
  const operator = node.operatorToken.kind;
  if (operator === ts.SyntaxKind.CommaToken) return evaluateKindPredicate(node.right, requestBinding, kind, model);
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
    const left = evaluateKindPredicate(node.left, requestBinding, kind, model);
    const right = evaluateKindPredicate(node.right, requestBinding, kind, model);
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (left === false || right === false) return false;
      return left === true && right === true ? true : UNKNOWN_CONSTANT;
    }
    if (left === true || right === true) return true;
    return left === false && right === false ? false : UNKNOWN_CONSTANT;
  }
  if (![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator)) return UNKNOWN_CONSTANT;
  const leftBinding = kindReceiverBinding(node.left, model);
  const rightBinding = kindReceiverBinding(node.right, model);
  const literalNode = leftBinding === requestBinding ? node.right : rightBinding === requestBinding ? node.left : undefined;
  if (!literalNode) return UNKNOWN_CONSTANT;
  const literal = constantValue(literalNode, model);
  if (literal === UNKNOWN_CONSTANT) return UNKNOWN_CONSTANT;
  const equal = Object.is(kind, literal);
  return [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(operator) ? equal : !equal;
}

function bindingIsImmutableConst(binding, root, model) {
  if (!binding || !binding.declarations.some((declaration) => declaration.kind === 'const')) return false;
  return recordsWithin(binding, root, model).filter((record) => record.expression).length === 1;
}

function expressionIsBindingProperty(node, binding, property, model) {
  node = unwrapExpression(node);
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    && expressionMemberName(node, model) === property
    && bindingOfIdentifier(node.expression, model) === binding;
}

function expressionResolvesToBindingProperty(node, binding, property, before, model, seen = new Set()) {
  node = unwrapExpression(node);
  if (expressionIsBindingProperty(node, binding, property, model)) return true;
  if (!ts.isIdentifier(node)) return false;
  const resolved = model.resolveBinding(node);
  if (!resolved || seen.has(resolved)) return false;
  const records = (model.writes.get(resolved) ?? []).filter((record) => (
    record.expression && record.node.getStart() < before.getStart()
  ));
  if (records.length === 0) return false;
  const latest = records.at(-1);
  seen.add(resolved);
  const result = expressionResolvesToBindingProperty(latest.expression, binding, property, before, model, seen);
  seen.delete(resolved);
  return result;
}

function objectPropertyInitializer(node, name, model) {
  node = unwrapExpression(node);
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const property = node.properties.find((candidate) => propertyNameText(candidate.name, model) === name);
  if (property && ts.isPropertyAssignment(property)) return property.initializer;
  if (property && ts.isShorthandPropertyAssignment(property)) return property.name;
  return undefined;
}

function workerPathCondition(node, requestBinding, kind, mode, model) {
  const kindValue = evaluateKindPredicate(node, requestBinding, kind, model);
  if (kindValue !== UNKNOWN_CONSTANT) return kindValue;
  const modeValue = evaluateModePredicate(node, requestBinding, mode, model);
  if (modeValue !== UNKNOWN_CONSTANT) return modeValue;
  return UNKNOWN_CONSTANT;
}

function assertWorkerExecutableStructure(workerSource) {
  const sourceFile = parseJavaScript(workerSource, 'Packaged utility worker');
  const model = createLexicalModel(sourceFile);
  const listenerCandidates = descendants(sourceFile, (node) => ts.isCallExpression(node)
    && expressionMemberName(node.expression, model) === 'on'
    && callArgumentLiteral(node, 0, 'message', model)
    && isProvenParentPort(expressionReceiver(node.expression), node, model));
  const listener = listenerCandidates.toReversed().find((call) => {
    const callback = callbackArgument(call, 1);
    return callback && conditionContainsPropertyComparison(callback.body, 'kind', 'containment-probe', model);
  });
  assertStructure(listener, 'the proven Electron parent-port listener must dispatch containment-probe requests');
  const listenerCallback = callbackArgument(listener, 1);
  const globalMutation = protectedGlobalMutation(sourceFile, model);
  const eventBinding = listenerCallback.parameters[0]
    && bindingOfIdentifier(listenerCallback.parameters[0].name, model);
  const iifeCalls = descendants(listenerCallback.body, (node) => {
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrapExpression(node.expression);
    return (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee))
      && callableBody(callee)?.getText(sourceFile).includes('containment-probe');
  });
  assertStructure(eventBinding && iifeCalls.length === 1,
    'the parent-port event must invoke one inspectable containment dispatch callable');
  const dispatchCallable = unwrapExpression(iifeCalls[0].expression);
  const dispatchBody = callableBody(dispatchCallable);
  assertPrecisePath(listenerCallback.body, [iifeCalls[0]],
    'the parent-port listener callback must invoke containment dispatch without an earlier completion', model, {
      allowedKinds: ['normal', 'return', 'nonterminate'],
    });

  const requestCandidates = [];
  for (const binding of model.bindings) {
    const records = recordsWithin(binding, dispatchBody, model).filter((record) => {
      const expression = record.expression && unwrapExpression(record.expression);
      if (!expression || !ts.isCallExpression(expression) || expression.arguments.length !== 1) return false;
      return expressionIsBindingProperty(expression.arguments[0], eventBinding, 'data', model);
    });
    if (records.length === 1) requestCandidates.push({ binding, record: records[0] });
  }
  assertStructure(requestCandidates.length === 1,
    'the containment request must derive once from the exact parent-port event data');
  const { binding: requestBinding, record: requestRecord } = requestCandidates[0];
  assertStructure(bindingIsImmutableConst(requestBinding, dispatchBody, model),
    'the validated event-derived containment request must remain one immutable lexical value');

  const modeBindings = new Set(descendants(dispatchBody, (node) => modeReceiverBinding(node, model))
    .map((node) => modeReceiverBinding(node, model)).filter(Boolean));
  const kindBindings = new Set(descendants(dispatchBody, (node) => kindReceiverBinding(node, model))
    .map((node) => kindReceiverBinding(node, model)).filter(Boolean));
  assertStructure(modeBindings.size === 1 && modeBindings.has(requestBinding)
    && kindBindings.size === 1 && kindBindings.has(requestBinding),
  'the containment listener kind and mode controls must share the immutable event-derived request binding');
  const containmentIf = descendants(dispatchBody, (node) => ts.isIfStatement(node)
    && evaluateKindPredicate(node.expression, requestBinding, 'containment-probe', model) === true
    && evaluateKindPredicate(node.expression, requestBinding, '__other__', model) === false).at(0);
  assertStructure(containmentIf,
    'the event-derived request must enter one exact containment-probe branch');
  assertPrecisePath(dispatchBody, [requestRecord.expression, containmentIf],
    'worker dispatch must validate exact event data and reach its containment branch without an earlier completion',
    model, {
      conditionValue(node) {
        return workerPathCondition(node, requestBinding, 'containment-probe', '__other__', model);
      },
    });
  const containmentBranch = containmentIf.thenStatement;

  const crashCalls = descendants(containmentBranch, (node) => ts.isCallExpression(node)).filter((call) => {
    if (expressionMemberName(call.expression, model) !== 'crash') return false;
    const receiver = expressionReceiver(call.expression);
    const receiverNode = receiver ? unwrapExpression(receiver) : undefined;
    if (!receiverNode || !ts.isIdentifier(receiverNode) || receiverNode.text !== 'process' || model.resolveBinding(receiverNode)) return false;
    const schedulerCallback = callableAncestor(call, containmentBranch);
    const schedulerCall = schedulerCallback?.parent && ts.isCallExpression(schedulerCallback.parent) ? schedulerCallback.parent : undefined;
    return Boolean(schedulerCall && schedulerCall.arguments[0] === schedulerCallback
      && directGlobalCall(schedulerCall, 'setTimeout', model)
      && !timerCallIsCancelled(schedulerCall, containmentBranch, model)
      && exactModeDomain(schedulerCall, containmentBranch, requestBinding, model).join(',') === 'crash'
      && isStaticallyLive(call, containmentBranch, model));
  });
  assertStructure(crashCalls.length === 1 && !globalMutation,
    'the worker crash probe must invoke unshadowed global process.crash through the unshadowed scheduler');

  const hangs = descendants(containmentBranch, (node) => ts.isNewExpression(node)).filter((candidate) => {
    const callee = unwrapExpression(candidate.expression);
    if (!ts.isIdentifier(callee) || callee.text !== 'Promise' || model.resolveBinding(callee)) return false;
    const executor = callbackArgument(candidate, 0);
    if (!callbackIsUnsettled(executor, model)) return false;
    if (!ts.isAwaitExpression(candidate.parent)) return false;
    return exactModeDomain(candidate.parent, containmentBranch, requestBinding, model).join(',') === 'crash,hang'
      && isStaticallyLive(candidate, containmentBranch, model);
  });
  assertStructure(hangs.length === 1 && !globalMutation,
    'the worker hang probe must await one unshadowed native Promise with no settlement path');

  const responses = liveCalls(containmentBranch, 'postMessage', model)
    .filter((call) => isProvenParentPort(expressionReceiver(call.expression), call, model));
  const exactResponse = responses.find((call) => {
    const payload = call.arguments[0];
    const id = objectPropertyInitializer(payload, 'id', model);
    const ok = objectPropertyInitializer(payload, 'ok', model);
    const kind = objectPropertyInitializer(payload, 'kind', model);
    return id && ok && kind && isLiteral(ok, true, model)
      && expressionResolvesToBindingProperty(id, requestBinding, 'id', call, model)
      && expressionIsBindingProperty(kind, requestBinding, 'kind', model);
  });
  assertStructure(responses.length === 1 && exactResponse,
    'the worker containment branch must publish its exact request id/kind success response through the proven Electron parent port');
  const crashCallback = callableAncestor(crashCalls[0], containmentBranch);
  const crashSchedulerCall = crashCallback?.parent && ts.isCallExpression(crashCallback.parent) ? crashCallback.parent : undefined;
  assertStructure(crashCallback && crashSchedulerCall,
    'the worker crash action must remain inside one inspectable scheduler callback');
  assertPrecisePath(crashCallback.body, [crashCalls[0]],
    'the crash timer callback must reach unshadowed process.crash without an earlier completion', model);
  assertPrecisePath(containmentBranch, [crashSchedulerCall, hangs[0]],
    'the crash-mode branch must schedule exact process termination before entering the unsettled containment wait', model, {
      conditionValue(node) {
        return workerPathCondition(node, requestBinding, 'containment-probe', 'crash', model);
      },
      allowedKinds: ['nonterminate'],
    });
  assertPrecisePath(containmentBranch, [hangs[0]],
    'the hang-mode branch must enter the unsettled containment wait', model, {
      conditionValue(node) {
        return workerPathCondition(node, requestBinding, 'containment-probe', 'hang', model);
      },
      allowedKinds: ['nonterminate'],
    });
  assertPrecisePath(containmentBranch, [exactResponse],
    'the non-crash containment branch must publish its exact success response', model, {
      conditionValue(node) {
        return workerPathCondition(node, requestBinding, 'containment-probe', '__other__', model);
      },
    });
  assertSubjectContainerReachable(sourceFile, model, [listener], 'worker containment listener', 'worker');
  return {
    sourceFile, model, listener, listenerCallback, dispatchCallable, dispatchBody,
    containmentIf, containmentBranch, exactResponse, requestBinding, requestRecord,
    crashCall: crashCalls[0], crashCallback, crashSchedulerCall, hang: hangs[0],
  };
}

function replaceNodeSource(source, sourceFile, node, replacement) {
  return `${source.slice(0, node.getStart(sourceFile))}${replacement}${source.slice(node.end)}`;
}

function replaceNodesSource(source, sourceFile, replacements) {
  return replacements.toSorted((left, right) => right.node.getStart(sourceFile) - left.node.getStart(sourceFile))
    .reduce((current, { node, replacement }) => replaceNodeSource(current, sourceFile, node, replacement), source);
}

function prefixCallableBody(source, sourceFile, callable, prefix) {
  const body = callableBody(callable);
  if (!body) throw new Error('Adversarial callable has no body.');
  if (ts.isBlock(body)) {
    return `${source.slice(0, body.getStart(sourceFile) + 1)}${prefix}${source.slice(body.getStart(sourceFile) + 1)}`;
  }
  return replaceNodeSource(source, sourceFile, body, `{${prefix}return (${body.getText(sourceFile)});}`);
}

function expectContainmentControlRejected(label, input) {
  parseJavaScript(input.mainSource, `Adversarial main control ${label}`);
  parseJavaScript(input.workerSource, `Adversarial worker control ${label}`);
  try {
    assertPackagedUtilityContainmentSources(input);
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith('Packaged utility containment exact emitted subject identity mismatch')
      || error.message.startsWith('Packaged utility containment executable structure is missing:')
    )) return;
    throw new Error(`Packaged utility containment adversarial control ${label} failed before a sound rejection: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`Packaged utility containment adversarial control was accepted: ${label}.`);
}

function wrapSubject(source, body) {
  return body.replace('/*__AIDRAW_SUBJECT__*/', () => source);
}

function insertAfterStrictDirective(source, payload) {
  const sourceFile = parseJavaScript(source, 'Adversarial subject');
  const directive = descendants(sourceFile, (node) => ts.isExpressionStatement(node)
    && ts.isStringLiteral(node.expression) && node.expression.text === 'use strict')[0];
  if (!directive) throw new Error('Adversarial subject has no strict directive.');
  return `${source.slice(0, directive.end)}\n${payload}\n${source.slice(directive.end)}`;
}

const NEGATIVE_REACHABILITY_CONTROLS = Object.freeze([
  ['non-invoking-callback', (source) => wrapSubject(source, 'function __aidrawDiscard(callback){void callback;}\n__aidrawDiscard(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['unconstructed-class-method', (source) => wrapSubject(source, 'class __AIDrawParked{install(){\n/*__AIDRAW_SUBJECT__*/\n}}')],
  ['constructed-but-uncalled-method', (source) => wrapSubject(source, 'class __AIDrawParked{install(){\n/*__AIDRAW_SUBJECT__*/\n}}\nnew __AIDrawParked();')],
  ['factory-noop-on', (source) => wrapSubject(source, 'function __aidrawFactory(){return {on(_event, callback){void callback;}}}\n__aidrawFactory().on("message",()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['factory-noop-once', (source) => wrapSubject(source, 'function __aidrawFactory(){return {once(_event, callback){void callback;}}}\n__aidrawFactory().once("message",()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['factory-noop-add-listener', (source) => wrapSubject(source, 'function __aidrawFactory(){return {addListener(_event, callback){void callback;}}}\n__aidrawFactory().addListener("message",()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['factory-noop-prepend-listener', (source) => wrapSubject(source, 'function __aidrawFactory(){return {prependListener(_event, callback){void callback;}}}\n__aidrawFactory().prependListener("message",()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['null-optional-registration', (source) => wrapSubject(source, 'null?.on("message",()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['literal-false-callback', (source) => wrapSubject(source, 'function __aidrawMaybeInvoke(callback){if(callback)callback();}\n__aidrawMaybeInvoke(false&&(()=>{\n/*__AIDRAW_SUBJECT__*/\n}));')],
  ['overwritten-invoker', (source) => wrapSubject(source, 'let __aidrawInvoke=callback=>callback();\n__aidrawInvoke=callback=>{void callback};\n__aidrawInvoke(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['reassigned-object-method', (source) => wrapSubject(source, 'const __aidrawReceiver={invoke(callback){callback();}};\n__aidrawReceiver.invoke=callback=>{void callback};\n__aidrawReceiver.invoke(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['distinct-class-instances', (source) => wrapSubject(source, 'class __AIDrawReceiver{constructor(run){this.run=run}invoke(callback){if(this.run)callback();}}\nnew __AIDrawReceiver(true);\nnew __AIDrawReceiver(false).invoke(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['distinct-call-frames', (source) => wrapSubject(source, 'function __aidrawFactory(run){return callback=>{if(run)callback();}}\n__aidrawFactory(true);\n__aidrawFactory(false)(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['non-nullish-short-circuit', (source) => wrapSubject(source, '1??(()=>{\n/*__AIDRAW_SUBJECT__*/\n})()')],
  ['unmatched-switch-case', (source) => wrapSubject(source, 'switch("installed"){case "discarded":{\n/*__AIDRAW_SUBJECT__*/\nbreak;}default:break;}')],
  ['unconditional-recursion', (source) => wrapSubject(source, 'function __aidrawRecurse(callback){__aidrawRecurse(callback);callback();}\n__aidrawRecurse(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['early-return-before-subject', (source) => wrapSubject(source, 'function __aidrawInvoke(callback){callback();}\n__aidrawInvoke(()=>{return;\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['factory-noop-then', (source) => wrapSubject(source, 'function __aidrawPromiseFactory(){return {then(callback){void callback;}}}\n__aidrawPromiseFactory().then(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['factory-noop-add-event-listener', (source) => wrapSubject(source, 'function __aidrawEventFactory(){return {addEventListener(_event,callback){void callback;}}}\n__aidrawEventFactory().addEventListener("ready",()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['shadowed-global-scheduler', (source) => wrapSubject(source, 'function setTimeout(callback){void callback;}\nsetTimeout(()=>{\n/*__AIDRAW_SUBJECT__*/\n},0);')],
  ['logical-assignment-overwrite', (source) => wrapSubject(source, 'let __aidrawLogical=callback=>callback();\n__aidrawLogical&&=(callback=>{void callback});\n__aidrawLogical(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['pending-native-promise-continuation', (source) => wrapSubject(source, 'new Promise(()=>{}).then(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['throw-after-subject-directive', (source) => insertAfterStrictDirective(source, 'throw new Error("blocked before containment anchors");')],
  ['infinite-loop-after-subject-directive', (source) => insertAfterStrictDirective(source, 'while(true){}')],
  ['decoy-directive-return-before-subject', (source) => wrapSubject(source, 'function __aidrawInvoke(callback){callback();}\n__aidrawInvoke(()=>{"use strict";return;\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['never-aborted-signal', (source) => wrapSubject(source, 'const __aidrawController=new AbortController();\n__aidrawController.signal.addEventListener("abort",()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['async-returning-pending-promise', (source) => wrapSubject(source, 'async function __aidrawPending(){return new Promise(()=>{});}\n__aidrawPending().then(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['native-promise-adopts-pending', (source) => wrapSubject(source, 'const __aidrawPending=new Promise(()=>{});\nPromise.resolve(__aidrawPending).then(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['finally-returning-pending-promise', (source) => wrapSubject(source, 'Promise.resolve().finally(()=>new Promise(()=>{})).then(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['cancelled-timer', (source) => wrapSubject(source, 'const __aidrawTimer=setTimeout(()=>{\n/*__AIDRAW_SUBJECT__*/\n},0);\nclearTimeout(__aidrawTimer);')],
  ['throwing-superclass', (source) => wrapSubject(source, 'class __AIDrawBase{constructor(){throw new Error("no construction")}}\nclass __AIDrawDerived extends __AIDrawBase{install(){\n/*__AIDRAW_SUBJECT__*/\n}}\nnew __AIDrawDerived().install();')],
]);

const NEGATIVE_MAIN_REACHABILITY_CONTROLS = Object.freeze([
  ['main-process-parent-port', (source) => wrapSubject(source, 'process.parentPort.on("message",()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
]);

const NEGATIVE_WORKER_REACHABILITY_CONTROLS = Object.freeze([
  ['nonexistent-parent-port-event', (source) => wrapSubject(source, 'process.parentPort.on("__aidraw_never__",()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
]);

const POSITIVE_REACHABILITY_CONTROLS = Object.freeze([
  ['direct-invoking-callback', (source) => wrapSubject(source, 'function __aidrawInvoke(callback){callback();}\n__aidrawInvoke(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['constructed-invoked-method', (source) => wrapSubject(source, 'class __AIDrawInstalled{install(){\n/*__AIDRAW_SUBJECT__*/\n}}\nnew __AIDrawInstalled().install();')],
  ['lexical-shadow-isolation', (source) => wrapSubject(source, 'let __aidrawGate=true;\nfunction __aidrawUncalled(){const __aidrawGate=false;}\nif(__aidrawGate){\n/*__AIDRAW_SUBJECT__*/\n}')],
  ['factory-invoking-method', (source) => wrapSubject(source, 'function __aidrawFactory(){return {invoke(callback){callback();}}}\n__aidrawFactory().invoke(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['returned-invoker', (source) => wrapSubject(source, 'function __aidrawFactory(){return callback=>callback();}\n__aidrawFactory()(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['destructured-invoker', (source) => wrapSubject(source, 'function __aidrawFactory(){return {invoke(callback){callback();}}}\nconst {invoke:__aidrawInvoke}=__aidrawFactory();\n__aidrawInvoke(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['computed-property-invoker', (source) => wrapSubject(source, 'const __aidrawReceiver={invoke(callback){callback();}};\n__aidrawReceiver["invoke"](()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['reassigned-to-invoker', (source) => wrapSubject(source, 'const __aidrawReceiver={invoke(callback){void callback;}};\n__aidrawReceiver.invoke=callback=>callback();\n__aidrawReceiver.invoke(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['distinct-invoking-instance', (source) => wrapSubject(source, 'class __AIDrawReceiver{constructor(run){this.run=run}invoke(callback){if(this.run)callback();}}\nnew __AIDrawReceiver(false);\nnew __AIDrawReceiver(true).invoke(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['distinct-invoking-call-frame', (source) => wrapSubject(source, 'function __aidrawFactory(run){return callback=>{if(run)callback();}}\n__aidrawFactory(false);\n__aidrawFactory(true)(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['native-promise-continuation', (source) => wrapSubject(source, 'Promise.resolve().then(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['unshadowed-global-scheduler', (source) => wrapSubject(source, 'setTimeout(()=>{\n/*__AIDRAW_SUBJECT__*/\n},0);')],
  ['proven-abort-signal-registration', (source) => wrapSubject(source, 'const __aidrawController=new AbortController();\n__aidrawController.signal.addEventListener("abort",()=>{\n/*__AIDRAW_SUBJECT__*/\n});\n__aidrawController.abort();')],
  ['non-null-optional-invoker', (source) => wrapSubject(source, 'const __aidrawReceiver={invoke(callback){callback();}};\n__aidrawReceiver?.invoke(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['nullish-assignment-invoker', (source) => wrapSubject(source, 'let __aidrawInvoke=null;\n__aidrawInvoke??=(callback=>callback());\n__aidrawInvoke(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['matched-switch-case', (source) => wrapSubject(source, 'switch("installed"){case "installed":{\n/*__AIDRAW_SUBJECT__*/\nbreak;}default:break;}')],
  ['nullish-right-hand-call', (source) => wrapSubject(source, 'null??(()=>{\n/*__AIDRAW_SUBJECT__*/\n})()')],
  ['terminating-literal-recursion', (source) => wrapSubject(source, 'function __aidrawRecurse(count,callback){if(count===0){callback();return;}__aidrawRecurse(count-1,callback);}\n__aidrawRecurse(3,()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['native-promise-first-settlement', (source) => wrapSubject(source, 'new Promise((resolve,reject)=>{resolve("ready");reject("late");}).then(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['fulfilled-native-promise-adoption', (source) => wrapSubject(source, 'const __aidrawReady=Promise.resolve("ready");\nPromise.resolve(__aidrawReady).then(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
  ['fulfilled-finally-continuation', (source) => wrapSubject(source, 'Promise.resolve().finally(()=>Promise.resolve()).then(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
]);

const POSITIVE_MAIN_REACHABILITY_CONTROLS = Object.freeze([
  ['electron-app-readiness', (source) => wrapSubject(source, 'require("electron").app.whenReady().then(()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
]);

const POSITIVE_WORKER_REACHABILITY_CONTROLS = Object.freeze([
  ['worker-parent-port-message', (source) => wrapSubject(source, 'process.parentPort.on("message",()=>{\n/*__AIDRAW_SUBJECT__*/\n});')],
]);

export function findPackagedUtilityWorkerBundle(archiveFiles) {
  const matches = archiveFiles.filter((entry) => /^\/\.vite\/build\/utility-worker-[^/]+\.js$/.test(entry));
  if (matches.length !== 1) {
    throw new Error(`Packaged raster utility implementation bundle count is ${matches.length}; expected exactly one.`);
  }
  return matches[0];
}

export function assertPackagedUtilityContainmentSources({ mainSource, workerSource, expectedSubject }) {
  const missingMain = MAIN_MARKERS.filter((marker) => !mainSource.includes(marker));
  if (missingMain.length) throw new Error(`Packaged main process is missing FND-09 utility containment inventory: ${missingMain.join(', ')}.`);
  const missingWorker = WORKER_MARKERS.filter((marker) => !workerSource.includes(marker));
  if (missingWorker.length) throw new Error(`Packaged utility worker is missing FND-09 containment inventory: ${missingWorker.join(', ')}.`);
  const actual = {
    main: emittedSourceIdentity(mainSource),
    worker: emittedSourceIdentity(workerSource),
  };
  const subject = resolveExactEmittedSubject(actual, expectedSubject);
  if (!exactIdentityMatches(actual.main, subject.expected.main)
    || !exactIdentityMatches(actual.worker, subject.expected.worker)) {
    throw new Error(
      `Packaged utility containment exact emitted subject identity mismatch for ${subject.name}: `
      + `main ${actual.main.bytes}/${actual.main.sha256}, worker ${actual.worker.bytes}/${actual.worker.sha256}.`,
    );
  }
  return {
    assurance: 'exact-emitted-subject-identity-admission',
    admittedSubject: subject.name,
    identities: actual,
    analysisBoundary: {
      admission: 'sha256-and-byte-length-of-the-complete-extracted-main-and-worker-source-pair',
      driftPolicy: 'every-byte-change-fails-closed-until-a-fresh-review-pins-a-new-subject',
      semanticClaim: 'identity-only-not-general-javascript-control-flow-or-runtime-behavior-proof',
      currentAsarRuntimeEvidence: 'unearned',
    },
  };
}

export function assertPackagedUtilityContainmentAdversarialControls({ mainSource, workerSource, expectedSubject }) {
  assertPackagedUtilityContainmentSources({ mainSource, workerSource, expectedSubject });
  const structuralNegativeCases = [];
  const safeDriftCasesRequiringReview = [];
  for (const [name, wrap] of NEGATIVE_REACHABILITY_CONTROLS) {
    expectContainmentControlRejected(`main reachability: ${name}`, { mainSource: wrap(mainSource), workerSource });
    expectContainmentControlRejected(`worker reachability: ${name}`, { mainSource, workerSource: wrap(workerSource) });
  }
  for (const [name, wrap] of NEGATIVE_MAIN_REACHABILITY_CONTROLS) {
    expectContainmentControlRejected(`main reachability: ${name}`, { mainSource: wrap(mainSource), workerSource });
  }
  for (const [name, wrap] of NEGATIVE_WORKER_REACHABILITY_CONTROLS) {
    expectContainmentControlRejected(`worker reachability: ${name}`, { mainSource, workerSource: wrap(workerSource) });
  }
  for (const [name, wrap] of POSITIVE_REACHABILITY_CONTROLS) {
    expectContainmentControlRejected(`safe main drift still requires review: ${name}`, { mainSource: wrap(mainSource), workerSource });
    expectContainmentControlRejected(`safe worker drift still requires review: ${name}`, { mainSource, workerSource: wrap(workerSource) });
    safeDriftCasesRequiringReview.push(`main:${name}`, `worker:${name}`);
  }
  for (const [name, wrap] of POSITIVE_MAIN_REACHABILITY_CONTROLS) {
    expectContainmentControlRejected(`safe main drift still requires review: ${name}`, { mainSource: wrap(mainSource), workerSource });
    safeDriftCasesRequiringReview.push(`main:${name}`);
  }
  for (const [name, wrap] of POSITIVE_WORKER_REACHABILITY_CONTROLS) {
    expectContainmentControlRejected(`safe worker drift still requires review: ${name}`, { mainSource, workerSource: wrap(workerSource) });
    safeDriftCasesRequiringReview.push(`worker:${name}`);
  }

  const main = assertMainExecutableStructure(mainSource);
  const cancelReceiver = expressionReceiver(main.cancelKillCall.expression);
  const timeoutReceiver = expressionReceiver(main.timeoutKillCall.expression);
  const cancelDecoy = replaceNodeSource(mainSource, main.sourceFile, cancelReceiver, 'globalThis.__aidrawCancellationDecoy');
  const timeoutDecoy = replaceNodeSource(mainSource, main.sourceFile, timeoutReceiver, 'globalThis.__aidrawTimeoutDecoy');
  expectContainmentControlRejected('cancellation kill uses a decoy receiver', { mainSource: cancelDecoy, workerSource });
  expectContainmentControlRejected('timeout kill uses a decoy receiver', { mainSource: timeoutDecoy, workerSource });
  const cancelReceiverText = cancelReceiver.getText(main.sourceFile);
  const timeoutReceiverText = timeoutReceiver.getText(main.sourceFile);
  expectContainmentControlRejected('captured cancellation worker kill is overwritten', {
    mainSource: replaceNodeSource(
      mainSource,
      main.sourceFile,
      main.cancelKillCall,
      `(${cancelReceiverText}.kill=()=>{},${cancelReceiverText}.kill())`,
    ),
    workerSource,
  });
  expectContainmentControlRejected('dispatched timeout worker kill is overwritten', {
    mainSource: replaceNodeSource(
      mainSource,
      main.sourceFile,
      main.timeoutKillCall,
      `(${timeoutReceiverText}.kill=()=>{},${timeoutReceiverText}.kill())`,
    ),
    workerSource,
  });

  const supervisorMethods = methodMap(main.supervisorClass, main.model);
  const abruptLocalPrefixes = [
    ['local-helper-late-throw', 'function __aidrawLocal(){void 0;throw new Error("__aidraw_blocked")}__aidrawLocal();'],
    ['local-helper-late-loop', 'function __aidrawLocal(){void 0;while(true){}}__aidrawLocal();'],
    ['local-helper-recursion', 'function __aidrawLocal(){__aidrawLocal()}__aidrawLocal();'],
    ['throwing-getter-read', 'const __aidrawLocal={get blocked(){throw new Error("__aidraw_blocked")}};void __aidrawLocal.blocked;'],
  ];
  const mainCriticalCallables = [
    ['scenario', main.scenario],
    ['cancellation', supervisorMethods.get('cancel')],
    ['enqueue', supervisorMethods.get('enqueue')],
    ['worker-admission', main.workerAdmission.success],
    ['pump', supervisorMethods.get('pump')],
    ['timeout-callback', main.timeoutCallback],
    ['message-settlement', supervisorMethods.get('handleMessage')],
    ['worker-exit', supervisorMethods.get('handleExit')],
    ['finish', supervisorMethods.get('finish')],
  ];
  assertStructure(mainCriticalCallables.every(([, callable]) => callable),
    'adversarial exact-subject controls must resolve every main critical callable');
  for (const [callableLabel, callable] of mainCriticalCallables) {
    for (const [failureLabel, prefix] of abruptLocalPrefixes) {
      const label = `${callableLabel}-${failureLabel}`;
      expectContainmentControlRejected(label, {
        mainSource: prefixCallableBody(mainSource, main.sourceFile, callable, prefix),
        workerSource,
      });
      structuralNegativeCases.push(label);
    }
  }
  for (const [callableLabel, callable] of [
    ['scenario', main.scenario],
    ['cancellation', supervisorMethods.get('cancel')],
    ['enqueue', supervisorMethods.get('enqueue')],
    ['worker-admission', main.workerAdmission.success],
    ['pump', supervisorMethods.get('pump')],
    ['timeout-callback', main.timeoutCallback],
    ['message-settlement', supervisorMethods.get('handleMessage')],
    ['worker-exit', supervisorMethods.get('handleExit')],
    ['settlement', supervisorMethods.get('finish')],
  ]) {
    for (const [interruptionLabel, prefix] of [
      ['early-return', 'return;'],
      ['definite-throw', 'throw new Error("__aidraw_blocked");'],
      ['implicit-iife-throw', '(()=>{throw new Error("__aidraw_blocked");})();'],
      ['nontermination', 'while(true){}'],
    ]) {
      const label = `${callableLabel}-${interruptionLabel}`;
      expectContainmentControlRejected(label, {
        mainSource: prefixCallableBody(mainSource, main.sourceFile, callable, prefix),
        workerSource,
      });
      structuralNegativeCases.push(label);
    }
  }

  const pumpBody = callableBody(supervisorMethods.get('pump'));
  const finishBody = callableBody(supervisorMethods.get('finish'));
  const enqueueBody = callableBody(supervisorMethods.get('enqueue'));
  const currentPublication = descendants(pumpBody, (node) => ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && isThisMember(node.left, 'current', main.model)
    && bindingOfIdentifier(node.right, main.model) === main.pump.taskBinding).at(0);
  const queueShift = descendants(pumpBody, (node) => isQueueShiftCall(node, main.model)).at(0);
  const exactDispatch = liveCalls(pumpBody, 'postMessage', main.model).find((call) => (
    propertyReceiverBinding(call, main.model) === main.pump.workerBinding
    && expressionMemberName(call.arguments[0], main.model) === 'request'
    && bindingOfIdentifier(expressionReceiver(call.arguments[0]), main.model) === main.pump.taskBinding
  ));
  const finishTerminals = descendants(finishBody, ts.isCallExpression).filter((call) => (
    ['resolve', 'reject'].includes(expressionMemberName(call.expression, main.model))
    && bindingOfIdentifier(expressionReceiver(call.expression), main.model)
      === bindingOfIdentifier(supervisorMethods.get('finish').parameters[0].name, main.model)
  ));
  const abortRegistration = liveCalls(enqueueBody, 'addEventListener', main.model)
    .find((call) => callArgumentLiteral(call, 0, 'abort', main.model));
  assertStructure(currentPublication && queueShift && exactDispatch && finishTerminals.length === 3 && abortRegistration,
    'adversarial lifecycle controls must resolve queue admission, active publication, dispatch, abort, and settlement anchors');
  for (const [label, node, replacement] of [
    ['active-task-publication-removed', currentPublication, 'void 0'],
    ['queue-shift-replaced-with-decoy', queueShift, 'globalThis.__aidrawDecoyTask'],
    ['captured-worker-post-message-noop', exactDispatch, 'void 0'],
    ['abort-registration-noop', abortRegistration, 'void 0'],
    ...finishTerminals.map((terminal, index) => [`finish-terminal-${index + 1}-noop`, terminal, 'void 0']),
  ]) {
    expectContainmentControlRejected(label, {
      mainSource: replaceNodeSource(mainSource, main.sourceFile, node, replacement),
      workerSource,
    });
    structuralNegativeCases.push(label);
  }
  for (const [label, mutation] of [
    ['native-Promise-resolve-overwrite', 'Promise.resolve=()=>({then(){}});'],
    ['native-Promise-then-overwrite', 'Promise.prototype.then=()=>new Promise(()=>{});'],
    ['AbortSignal-addEventListener-overwrite', 'AbortSignal.prototype.addEventListener=()=>{};'],
  ]) {
    expectContainmentControlRejected(label, {
      mainSource: insertAfterStrictDirective(mainSource, mutation),
      workerSource,
    });
    structuralNegativeCases.push(label);
  }

  const forkText = main.workerAdmission.fork.getText(main.sourceFile);
  const conditionalFork = replaceNodeSource(
    mainSource,
    main.sourceFile,
    main.workerAdmission.promiseResolve.arguments[0],
    `(globalThis.__aidrawForkChoice?${forkText}:globalThis.__aidrawForkDecoy)`,
  );
  expectContainmentControlRejected('conditional-fork-versus-decoy', { mainSource: conditionalFork, workerSource });
  structuralNegativeCases.push('conditional-fork-versus-decoy');
  expectContainmentControlRejected('fork-replaced-with-decoy-result', {
    mainSource: replaceNodeSource(mainSource, main.sourceFile, main.workerAdmission.fork, 'globalThis.__aidrawForkDecoy'),
    workerSource,
  });
  structuralNegativeCases.push('fork-replaced-with-decoy-result');

  const messageListenerText = main.workerAdmission.messageListener.getText(main.sourceFile);
  const exitListenerText = main.workerAdmission.exitListener.getText(main.sourceFile);
  expectContainmentControlRejected('mutually-exclusive-fork-listeners', {
    mainSource: replaceNodesSource(mainSource, main.sourceFile, [
      {
        node: main.workerAdmission.messageListener,
        replacement: `(globalThis.__aidrawListenerChoice?(${messageListenerText}):(${exitListenerText}))`,
      },
      { node: main.workerAdmission.exitListener, replacement: 'void 0' },
    ]),
    workerSource,
  });
  structuralNegativeCases.push('mutually-exclusive-fork-listeners');

  const cancelFinish = liveCalls(callableBody(supervisorMethods.get('cancel')), 'finish', main.model)
    .filter((call) => callReceiverMatchesThis(call) && call.getStart() < main.cancelKillCall.getStart()).at(-1);
  const cancelPump = liveCalls(callableBody(supervisorMethods.get('cancel')), 'pump', main.model)
    .find((call) => callReceiverMatchesThis(call) && call.getStart() > main.cancelKillCall.getStart());
  const timeoutCallback = callableAncestor(main.timeoutKillCall, callableBody(supervisorMethods.get('pump')));
  const timeoutPump = timeoutCallback && liveCalls(timeoutCallback.body, 'pump', main.model)
    .find((call) => callReceiverMatchesThis(call) && call.getStart() > main.timeoutKillCall.getStart());
  const timeoutFinish = timeoutCallback && liveCalls(timeoutCallback.body, 'finish', main.model)
    .filter((call) => callReceiverMatchesThis(call) && call.getStart() < main.timeoutKillCall.getStart()).at(-1);
  assertStructure(cancelPump && timeoutPump && cancelFinish?.arguments[1] && timeoutFinish?.arguments[1],
    'adversarial lifecycle controls must resolve exact finish and pump calls');
  for (const [label, node] of [
    ['cancellation-finish-call-noop', cancelFinish],
    ['cancellation-pump-call-noop', cancelPump],
    ['timeout-finish-call-noop', timeoutFinish],
    ['timeout-pump-call-noop', timeoutPump],
  ]) {
    expectContainmentControlRejected(label, {
      mainSource: replaceNodeSource(mainSource, main.sourceFile, node, 'void 0'),
      workerSource,
    });
    structuralNegativeCases.push(label);
  }
  for (const [label, kill, pump] of [
    ['cancellation kill and pump are mutually exclusive', main.cancelKillCall, cancelPump],
    ['timeout kill and pump are mutually exclusive', main.timeoutKillCall, timeoutPump],
  ]) {
    const killText = kill.getText(main.sourceFile);
    const pumpText = pump.getText(main.sourceFile);
    expectContainmentControlRejected(label, {
      mainSource: replaceNodesSource(mainSource, main.sourceFile, [
        { node: kill, replacement: `(globalThis.__aidrawBranch?(${killText}):(${pumpText}))` },
        { node: pump, replacement: 'void 0' },
      ]),
      workerSource,
    });
  }
  expectContainmentControlRejected('cancellation finish loses its failure result', {
    mainSource: replaceNodeSource(mainSource, main.sourceFile, cancelFinish.arguments[1], 'void 0'),
    workerSource,
  });
  expectContainmentControlRejected('timeout finish loses its failure result', {
    mainSource: replaceNodeSource(mainSource, main.sourceFile, timeoutFinish.arguments[1], 'void 0'),
    workerSource,
  });
  expectContainmentControlRejected('cancellation finish receives null instead of failure', {
    mainSource: replaceNodeSource(mainSource, main.sourceFile, cancelFinish.arguments[1], 'null'),
    workerSource,
  });
  expectContainmentControlRejected('timeout finish receives null instead of failure', {
    mainSource: replaceNodeSource(mainSource, main.sourceFile, timeoutFinish.arguments[1], 'null'),
    workerSource,
  });
  structuralNegativeCases.push(
    'cancellation-finish-null-failure',
    'timeout-finish-null-failure',
  );

  const exitFinishText = main.exit.finishCall.getText(main.sourceFile);
  const exitPumpText = main.exit.pumpCall.getText(main.sourceFile);
  expectContainmentControlRejected('worker-exit-finish-and-pump-are-mutually-exclusive', {
    mainSource: replaceNodesSource(mainSource, main.sourceFile, [
      {
        node: main.exit.finishCall,
        replacement: `(globalThis.__aidrawExitChoice?(${exitFinishText}):(${exitPumpText}))`,
      },
      { node: main.exit.pumpCall, replacement: 'void 0' },
    ]),
    workerSource,
  });
  structuralNegativeCases.push('worker-exit-finish-and-pump-are-mutually-exclusive');

  const messageReceiver = expressionReceiver(main.workerAdmission.messageListener.expression);
  const exitReceiver = expressionReceiver(main.workerAdmission.exitListener.expression);
  expectContainmentControlRejected('fork listeners are moved to a no-op decoy receiver', {
    mainSource: replaceNodesSource(mainSource, main.sourceFile, [
      { node: messageReceiver, replacement: 'globalThis.__aidrawListenerDecoy' },
      { node: exitReceiver, replacement: 'globalThis.__aidrawListenerDecoy' },
    ]),
    workerSource,
  });

  const worker = assertWorkerExecutableStructure(workerSource);
  for (const [callableLabel, callable] of [
    ['worker-message-listener', worker.listenerCallback],
    ['worker-dispatch', worker.dispatchCallable],
    ['crash-timer-callback', worker.crashCallback],
  ]) {
    for (const [failureLabel, prefix] of abruptLocalPrefixes) {
      const label = `${callableLabel}-${failureLabel}`;
      expectContainmentControlRejected(label, {
        mainSource,
        workerSource: prefixCallableBody(workerSource, worker.sourceFile, callable, prefix),
      });
      structuralNegativeCases.push(label);
    }
  }
  for (const [callableLabel, callable] of [
    ['worker-message-listener', worker.listenerCallback],
    ['worker-dispatch', worker.dispatchCallable],
    ['crash-timer-callback', worker.crashCallback],
  ]) {
    for (const [interruptionLabel, prefix] of [
      ['early-return', 'return;'],
      ['definite-throw', 'throw new Error("__aidraw_blocked");'],
      ['implicit-iife-throw', '(()=>{throw new Error("__aidraw_blocked");})();'],
      ['nontermination', 'while(true){}'],
    ]) {
      const label = `${callableLabel}-${interruptionLabel}`;
      expectContainmentControlRejected(label, {
        mainSource,
        workerSource: prefixCallableBody(workerSource, worker.sourceFile, callable, prefix),
      });
      structuralNegativeCases.push(label);
    }
  }

  const requestName = worker.requestBinding.name;
  const requestInitializer = unwrapExpression(worker.requestRecord.expression);
  const eventData = ts.isCallExpression(requestInitializer) ? requestInitializer.arguments[0] : undefined;
  assertStructure(eventData,
    'adversarial validator controls must resolve the exact event-data argument');
  for (const [label, replacement] of [
    ['worker-request-String-event-data', `String(${eventData.getText(worker.sourceFile)})`],
    ['worker-request-arbitrary-event-data-factory', `(()=>({kind:"unvalidated",mode:"crash"}))(${eventData.getText(worker.sourceFile)})`],
  ]) {
    expectContainmentControlRejected(label, {
      mainSource,
      workerSource: replaceNodeSource(workerSource, worker.sourceFile, worker.requestRecord.expression, replacement),
    });
    structuralNegativeCases.push(label);
  }
  const requestReassignment = `${requestName}={...${requestName},kind:"containment-probe",mode:"crash"}`;
  expectContainmentControlRejected('validated-worker-request-reassignment', {
    mainSource,
    workerSource: `${workerSource.slice(0, worker.requestRecord.node.end)};${requestReassignment}${workerSource.slice(worker.requestRecord.node.end)}`,
  });
  expectContainmentControlRejected('containment-branch-response-removed-with-unrelated-responses-retained', {
    mainSource,
    workerSource: replaceNodeSource(workerSource, worker.sourceFile, worker.exactResponse, 'void 0'),
  });
  structuralNegativeCases.push(
    'validated-worker-request-reassignment',
    'containment-branch-response-removed-with-unrelated-responses-retained',
  );

  const crashReceiver = expressionReceiver(worker.crashCall.expression);
  const crashDecoy = `${replaceNodeSource(workerSource, worker.sourceFile, crashReceiver, 'globalThis.__aidrawCrashDecoy')}\nvoid "process.crash";`;
  expectContainmentControlRejected('crash uses a decoy receiver', { mainSource, workerSource: crashDecoy });
  expectContainmentControlRejected('global process.crash is overwritten', {
    mainSource,
    workerSource: replaceNodeSource(
      workerSource,
      worker.sourceFile,
      worker.crashCall,
      '(process.crash=()=>{},process.crash())',
    ),
  });
  expectContainmentControlRejected('global native Promise is overwritten', {
    mainSource,
    workerSource: replaceNodeSource(
      workerSource,
      worker.sourceFile,
      worker.hang,
      `(globalThis.Promise=class{constructor(_executor){}},${worker.hang.getText(worker.sourceFile)})`,
    ),
  });
  expectContainmentControlRejected('native Promise is shadowed by a non-invoking class', {
    mainSource,
    workerSource: `{class Promise{constructor(_executor){}}\n${workerSource}\n}`,
  });
  const schedulerText = worker.crashSchedulerCall.getText(worker.sourceFile);
  expectContainmentControlRejected('crash scheduler has a literal-false guard', {
    mainSource,
    workerSource: replaceNodeSource(workerSource, worker.sourceFile, worker.crashSchedulerCall, `false&&(${schedulerText})`),
  });
  expectContainmentControlRejected('crash scheduler has a negated mode guard', {
    mainSource,
    workerSource: replaceNodeSource(workerSource, worker.sourceFile, worker.crashSchedulerCall,
      `${worker.requestBinding.name}.mode!=="crash"&&(${schedulerText})`),
  });
  expectContainmentControlRejected('crash timer is cancelled before it can fire', {
    mainSource,
    workerSource: replaceNodeSource(workerSource, worker.sourceFile, worker.crashSchedulerCall,
      `(()=>{const __aidrawTimer=${schedulerText};clearTimeout(__aidrawTimer);return __aidrawTimer})()`),
  });
  expectContainmentControlRejected('crash timer is cancelled through Function.call', {
    mainSource,
    workerSource: replaceNodeSource(workerSource, worker.sourceFile, worker.crashSchedulerCall,
      `(()=>{const __aidrawTimer=${schedulerText};clearTimeout.call(null,__aidrawTimer);return __aidrawTimer})()`),
  });
  structuralNegativeCases.push('crash-timer-indirect-call-cancellation');
  for (const [label, cancellation] of [
    ['crash-timer-clearInterval-cancellation', 'clearInterval(__aidrawTimer)'],
    ['crash-timer-handle-close-cancellation', '__aidrawTimer.close()'],
    ['crash-timer-object-alias-cancellation', '({clear:clearTimeout}).clear(__aidrawTimer)'],
    ['crash-timer-helper-cancellation', '((handle)=>clearTimeout(handle))(__aidrawTimer)'],
    ['crash-timer-prebound-cancellation', 'clearTimeout.bind(globalThis)(__aidrawTimer)'],
  ]) {
    expectContainmentControlRejected(label, {
      mainSource,
      workerSource: replaceNodeSource(
        workerSource,
        worker.sourceFile,
        worker.crashSchedulerCall,
        `(()=>{const __aidrawTimer=${schedulerText};${cancellation};return __aidrawTimer})()`,
      ),
    });
    structuralNegativeCases.push(label);
  }

  for (const [label, replacement] of [
    [
      'safe-unrelated-local-receiver-properties',
      'const __aidrawLocal={};__aidrawLocal.crash=()=>{};__aidrawLocal.parentPort={};Object.defineProperty(__aidrawLocal,"Promise",{value:class{}});const __aidrawLocalGetter=__aidrawLocal.__defineGetter__;void __aidrawLocalGetter;',
    ],
  ]) {
    expectContainmentControlRejected(`safe worker drift still requires review: ${label}`, {
      mainSource,
      workerSource: insertAfterStrictDirective(workerSource, replacement),
    });
    safeDriftCasesRequiringReview.push(`worker:${label}`);
  }
  for (const [label, replacement] of [
    [
      'safe-statically-dead-crash-timer-cancellation',
      `(()=>{const __aidrawTimer=${schedulerText};if(false){clearTimeout(__aidrawTimer)}return __aidrawTimer})()`,
    ],
    [
      'safe-post-crash-timer-cancellation',
      `(()=>{const __aidrawTimer=${schedulerText};setTimeout(()=>clearTimeout(__aidrawTimer),200);return __aidrawTimer})()`,
    ],
  ]) {
    expectContainmentControlRejected(`safe worker drift still requires review: ${label}`, {
      mainSource,
      workerSource: replaceNodeSource(workerSource, worker.sourceFile, worker.crashSchedulerCall, replacement),
    });
    safeDriftCasesRequiringReview.push(`worker:${label}`);
  }

  const globalMutationControls = [
    ['aliased process.crash overwrite', 'const __aidrawProcess=process;__aidrawProcess.crash=()=>{};'],
    ['logical aliased global setTimeout overwrite', 'const __aidrawGlobal=globalThis;__aidrawGlobal.setTimeout&&=(()=>{});'],
    ['Object.defineProperty Promise overwrite', 'Object.defineProperty(globalThis,"Promise",{value:class{}});'],
    ['Reflect.set process.crash overwrite', 'Reflect.set(process,"crash",()=>{});'],
    ['aliased Object.defineProperty process.crash overwrite', 'const __aidrawDefine=Object.defineProperty;__aidrawDefine(process,"crash",{value:()=>{}});'],
    ['destructured Object.defineProperty process.crash overwrite', 'const {defineProperty:__aidrawDefine}=Object;__aidrawDefine(process,"crash",{value:()=>{}});'],
    ['conditional reflective process.crash overwrite', 'const __aidrawDefine=true?Object.defineProperty:()=>{};__aidrawDefine(process,"crash",{value:()=>{}});'],
    ['Reflect.set process.parentPort overwrite', 'Reflect.set(process,"parentPort",{on(){},postMessage(){}});'],
    ['array-destructured process.crash overwrite', 'const [__aidrawProcess]=[process];__aidrawProcess.crash=()=>{};'],
    ['Reflect.apply Object.defineProperty process.crash overwrite', 'Reflect.apply(Object.defineProperty,Object,[process,"crash",{value:()=>{}}]);'],
    ['Object.defineProperty.call process.crash overwrite', 'Object.defineProperty.call(Object,process,"crash",{value:()=>{}});'],
    ['bound Object.defineProperty process.crash overwrite', 'const __aidrawBoundDefine=Object.defineProperty.bind(Object);__aidrawBoundDefine(process,"crash",{value:()=>{}});'],
    ['Function.prototype.call.call process.crash overwrite', 'Function.prototype.call.call(Object.defineProperty,Object,process,"crash",{value:()=>{}});'],
    ['Reflect.apply Reflect.set process.crash overwrite', 'Reflect.apply(Reflect.set,Reflect,[process,"crash",()=>{}]);'],
    ['process prototype replacement', 'process.__proto__={};'],
    ['process legacy crash getter', 'process.__defineGetter__("crash",()=>()=>{});'],
    ['global legacy Promise getter', 'globalThis.__defineGetter__("Promise",()=>class{});'],
    ['escaped process legacy getter alias', 'const __aidrawGetter=process.__defineGetter__;__aidrawGetter.call(process,"crash",()=>()=>{});'],
    ['Object prototype legacy getter call', 'Object.prototype.__defineGetter__.call(process,"crash",()=>()=>{});'],
    ['nested Reflect.apply Function.call defineProperty', 'Reflect.apply(Function.prototype.call,Function.prototype,[Object.defineProperty,Object,process,"crash",{value:()=>{}}]);'],
    ['object-aliased Object.defineProperty process.crash overwrite', 'const __aidrawMethods={define:Object.defineProperty};__aidrawMethods.define(process,"crash",{value:()=>{}});'],
    ['array-aliased Object.defineProperty process.crash overwrite', 'const __aidrawMethods=[Object.defineProperty];__aidrawMethods[0](process,"crash",{value:()=>{}});'],
    ['destructured Reflect.apply process.crash overwrite', 'const {apply:__aidrawApply}=Reflect;__aidrawApply(Object.defineProperty,Object,[process,"crash",{value:()=>{}}]);'],
    ['Function.prototype.apply.call process.crash overwrite', 'Function.prototype.apply.call(Object.defineProperty,Object,[process,"crash",{value:()=>{}}]);'],
    ['destructuring assignment global process overwrite', '[globalThis.process]=[{}];'],
    ['indirect eval global process overwrite', '(0,eval)("globalThis.process={}");'],
    ['Function constructor global process overwrite', 'Function("globalThis.process={}")();'],
    ['Promise.resolve overwrite', 'Promise.resolve=()=>new Promise(()=>{});'],
    ['Promise.prototype.then overwrite', 'Promise.prototype.then=()=>new Promise(()=>{});'],
    ['AbortSignal registration overwrite', 'AbortSignal.prototype.addEventListener=()=>{};'],
    ['parentPort listener overwrite', 'process.parentPort.on=()=>{};'],
    ['parentPort response overwrite', 'process.parentPort.postMessage=()=>{};'],
    ['global clearTimeout overwrite', 'globalThis.clearTimeout=()=>{};'],
  ];
  for (const [label, mutation] of globalMutationControls) {
    expectContainmentControlRejected(label, {
      mainSource,
      workerSource: insertAfterStrictDirective(workerSource, mutation),
    });
  }
  return {
    assurance: 'exact-emitted-subject-drift-controls',
    rejectionBoundary: 'complete-main-or-worker-byte-drift-from-the-reviewed-subject',
    semanticClaim: 'mutation-rejection-by-exact-identity-not-general-javascript-interpretation',
    reachabilityNegativeCasesPerChunk: NEGATIVE_REACHABILITY_CONTROLS.map(([name]) => name),
    reachabilityNegativeMainCases: NEGATIVE_MAIN_REACHABILITY_CONTROLS.map(([name]) => name),
    reachabilityNegativeWorkerCases: NEGATIVE_WORKER_REACHABILITY_CONTROLS.map(([name]) => name),
    reachabilityChunks: ['main', 'worker'],
    structuralNegativeCases: [
      'cancellation-kill-decoy-receiver',
      'timeout-kill-decoy-receiver',
      'cancellation-kill-overwrite',
      'timeout-kill-overwrite',
      'cancellation-mutually-exclusive-kill-pump',
      'timeout-mutually-exclusive-kill-pump',
      'cancellation-finish-without-failure',
      'timeout-finish-without-failure',
      'fork-listener-decoy-receiver',
      'crash-decoy-receiver',
      'process-crash-direct-overwrite',
      'promise-direct-overwrite',
      'promise-lexical-shadow',
      'crash-literal-false-guard',
      'crash-negated-mode-guard',
      'crash-immediately-cancelled-timer',
      ...structuralNegativeCases,
      ...globalMutationControls.map(([label]) => label),
    ],
    safeDriftCasesRequiringReview,
    unchangedReviewedSubjectReadmitted: true,
  };
}
