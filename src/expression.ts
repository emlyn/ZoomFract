// Arithmetic expressions for numeric scene values, such as `1/sqrt(2)` or
// `log(8) / log(3)`. Parsing produces a syntax tree so the same expression
// can be evaluated now and rendered as mathematics later.

import { boolean, checkValue, colourComponents, colourValue, combine, component, equalValues, hsl, huePath, interpolate, isGradient, mixingSpace, numeric, oklab, oklch, parseCssColour, pointValue, rgb, sample, scale, type MixingSpace, type Value } from './values';

export type Expression =
  | { kind: 'number'; value: number; text: string }
  | { kind: 'constant'; name: ConstantName }
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: string | boolean }
  | { kind: 'component'; value: Expression; name: string }
  | { kind: 'not'; operand: Expression }
  | { kind: 'conditional'; condition: Expression; yes: Expression; no: Expression }
  | { kind: 'negate'; operand: Expression }
  | { kind: 'binary'; operator: BinaryOperator; left: Expression; right: Expression }
  | { kind: 'call'; name: FunctionName; args: Expression[] };

// Looks up a variable's value, or returns undefined if it does not exist.
export type Variables = ((name: string) => Value | undefined) & { space?: MixingSpace };

export const NO_VARIABLES: Variables = () => undefined;

type BinaryOperator = '+' | '-' | '*' | '/' | '^' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||';

const CONSTANTS = {
  pi: Math.PI,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
};

type ConstantName = keyof typeof CONSTANTS;

// Odd integer roots of negative numbers stay real, e.g. root(3, -8) = -2.
const root = (degree: number, value: number) => value < 0 && Number.isInteger(degree) && degree % 2 !== 0
  ? -Math.pow(-value, 1 / degree)
  : Math.pow(value, 1 / degree);

// Trigonometric functions use radians.
const FUNCTIONS = {
  sqrt: Math.sqrt,
  root,
  log: Math.log,
  ln: Math.log,
  exp: Math.exp,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
} satisfies Record<string, (...args: number[]) => number>;

const VALUE_FUNCTIONS = ['point', 'colour', 'srgb', 'hsl', 'oklab', 'oklch', 'toRgb', 'toHsl', 'toOklch',
  'number', 'length', 'distance', 'dot', 'rotate', 'lerp', 'mix', 'clamp', 'sample'] as const;
type FunctionName = keyof typeof FUNCTIONS | typeof VALUE_FUNCTIONS[number];

const isConstant = (name: string): name is ConstantName => Object.hasOwn(CONSTANTS, name);
const isFunction = (name: string): name is FunctionName => Object.hasOwn(FUNCTIONS, name) || VALUE_FUNCTIONS.some((f) => f === name);

// Constants and functions cannot be redefined as variables.
export const isReservedName = (name: string) => isConstant(name) || isFunction(name) || name === 'true' || name === 'false';

export const isIdentifier = (text: string) => /^[A-Za-z_]\w*$/.test(text);

type Token = { type: 'number' | 'name' | 'symbol' | 'string'; text: string; position: number };

// Names may be dotted, such as view.left, to refer to scene values.
const TOKEN_PATTERN = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)|("(?:[^"\\]|\\.)*")|(&&|\|\||==|!=|<=|>=|[-+*/^(),.!<>?:]))/y;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  while (TOKEN_PATTERN.lastIndex < text.length) {
    const start = TOKEN_PATTERN.lastIndex;
    const match = TOKEN_PATTERN.exec(text);
    if (!match) {
      if (text.slice(start).trim() === '') {
        break;
      }
      const position = start + text.slice(start).search(/\S/);
      throw new Error(`unexpected "${text[position]}" at position ${position + 1}`);
    }
    const [whole, number, name, string, symbol] = match;
    const position = start + whole.length - (number ?? name ?? string ?? symbol).length;
    tokens.push(number !== undefined
      ? { type: 'number', text: number, position }
      : name !== undefined
        ? { type: 'name', text: name, position }
        : string !== undefined ? { type: 'string', text: string, position }
          : { type: 'symbol', text: symbol, position });
  }
  return tokens;
}
export function parseExpression(text: string): Expression {
  const tokens = tokenize(text);
  let index = 0;

  const peek = () => tokens[index];
  const describe = (token: Token | undefined) => token
    ? `"${token.text}" at position ${token.position + 1}`
    : 'end of expression';
  const accept = (symbol: string) => {
    if (peek()?.type === 'symbol' && peek().text === symbol) {
      index += 1;
      return true;
    }
    return false;
  };
  const expect = (symbol: string) => {
    if (!accept(symbol)) {
      throw new Error(`expected "${symbol}" but found ${describe(peek())}`);
    }
  };
  const conditional = (): Expression => {
    const condition = logicalOr();
    if (!accept('?')) return condition;
    const yes = conditional();
    expect(':');
    return { kind: 'conditional', condition, yes, no: conditional() };
  };
  const chain = (next: () => Expression, operators: BinaryOperator[]): Expression => {
    let left = next();
    for (let operator = peekOperator(...operators); operator; operator = peekOperator(...operators)) {
      index += 1;
      left = { kind: 'binary', operator, left, right: next() };
    }
    return left;
  };
  const logicalOr = (): Expression => chain(logicalAnd, ['||']);
  const logicalAnd = (): Expression => chain(comparison, ['&&']);
  const comparison = (): Expression => chain(additive, ['==', '!=', '<', '<=', '>', '>=']);

  // Precedence from loosest to tightest: + -, * /, unary minus, ^.
  // Powers are right associative and bind tighter than unary minus, so
  // -2^2 is -4 and 2^-1 is 0.5.
  const additive = (): Expression => {
    let left = multiplicative();
    for (let operator = peekOperator('+', '-'); operator; operator = peekOperator('+', '-')) {
      index += 1;
      left = { kind: 'binary', operator, left, right: multiplicative() };
    }
    return left;
  };

  const multiplicative = (): Expression => {
    let left = unary();
    for (let operator = peekOperator('*', '/'); operator; operator = peekOperator('*', '/')) {
      index += 1;
      left = { kind: 'binary', operator, left, right: unary() };
    }
    return left;
  };

  const unary = (): Expression => {
    if (accept('!')) return { kind: 'not', operand: unary() };
    if (accept('-')) {
      return { kind: 'negate', operand: unary() };
    }
    if (accept('+')) {
      return unary();
    }
    return power();
  };

  const power = (): Expression => {
    let base = primary();
    while (accept('.')) {
      const name = peek();
      if (name?.type !== 'name') throw new Error('Expected a component name');
      index += 1;
      base = { kind: 'component', value: base, name: name.text };
    }
    return accept('^') ? { kind: 'binary', operator: '^', left: base, right: unary() } : base;
  };

  const primary = (): Expression => {
    const token = peek();
    if (!token) {
      throw new Error('expression is incomplete');
    }
    index += 1;
    if (token.type === 'number') {
      return { kind: 'number', value: Number(token.text), text: token.text };
    }
    if (token.type === 'string') return { kind: 'literal', value: JSON.parse(token.text) as string };
    if (token.type === 'name') {
      if (token.text === 'true' || token.text === 'false') return { kind: 'literal', value: token.text === 'true' };
      if (accept('(')) {
        if (!isFunction(token.text)) {
          throw new Error(`unknown function "${token.text}"`);
        }
        const args = [conditional()];
        while (accept(',')) {
          args.push(conditional());
        }
        expect(')');
        const arity = Object.hasOwn(FUNCTIONS, token.text) ? FUNCTIONS[token.text as keyof typeof FUNCTIONS].length : undefined;
        if (arity !== undefined && token.text !== 'min' && token.text !== 'max' && args.length !== arity) {
          throw new Error(`${token.text} takes ${arity} argument${arity === 1 ? '' : 's'}, not ${args.length}`);
        }
        return { kind: 'call', name: token.text, args };
      }
      if (isFunction(token.text)) {
        throw new Error(`function "${token.text}" needs parentheses`);
      }
      return isConstant(token.text)
        ? { kind: 'constant', name: token.text }
        : { kind: 'variable', name: token.text };
    }
    if (token.text === '(') {
      const inner = conditional();
      expect(')');
      return inner;
    }
    throw new Error(`unexpected ${describe(token)}`);
  };

  function peekOperator<T extends BinaryOperator>(...operators: T[]): T | undefined {
    const token = peek();
    return token?.type === 'symbol' ? operators.find((operator) => operator === token.text) : undefined;
  }

  if (tokens.length === 0) {
    throw new Error('expression is empty');
  }
  const expression = conditional();
  if (index < tokens.length) {
    throw new Error(`unexpected ${describe(peek())}`);
  }
  return expression;
}

export function evaluate(expression: Expression, lookup: (name: string) => Value, space: MixingSpace = 'linear-srgb'): Value {
  const run = (node: Expression) => evaluate(node, lookup, space);
  switch (expression.kind) {
    case 'number':
      return expression.value;
    case 'constant':
      return CONSTANTS[expression.name];
    case 'variable':
      return lookup(expression.name);
    case 'literal': return expression.value;
    case 'component': return component(run(expression.value), expression.name);
    case 'not': return !boolean(run(expression.operand));
    case 'conditional': return run(boolean(run(expression.condition)) ? expression.yes : expression.no);
    case 'negate':
      return scale(run(expression.operand), -1);
    case 'call': {
      const args = expression.args.map(run);
      return checkValue(callFunction(expression.name, args, space));
    }
    case 'binary': {
      const left = run(expression.left);
      if (expression.operator === '&&') return boolean(left) && boolean(run(expression.right));
      if (expression.operator === '||') return boolean(left) || boolean(run(expression.right));
      const right = run(expression.right);
      switch (expression.operator) {
        case '+': case '-': return checkValue(combine(left, right, expression.operator));
        case '*': return checkValue(typeof left === 'number' ? scale(right, left) : scale(left, numeric(right)));
        case '/': {
          const divisor = numeric(right);
          if (divisor === 0) throw new Error('Division by zero');
          return checkValue(scale(left, 1 / divisor));
        }
        case '^': return checkValue(Math.pow(numeric(left), numeric(right)));
        case '==': return equalValues(left, right);
        case '!=': return !equalValues(left, right);
        case '<': return numeric(left) < numeric(right);
        case '<=': return numeric(left) <= numeric(right);
        case '>': return numeric(left) > numeric(right);
        case '>=': return numeric(left) >= numeric(right);
      }

    }
  }
}

function callFunction(name: FunctionName, args: Value[], space: MixingSpace): Value {
  const count = (min: number, max = min) => {
    if (args.length < min || args.length > max) throw new Error(`${name} needs ${min === max ? min : `${min} to ${max}`} arguments`);
  };
  const n = (index: number) => numeric(args[index]);
  if (Object.hasOwn(FUNCTIONS, name)) {
    const call: (...args: number[]) => number = FUNCTIONS[name as keyof typeof FUNCTIONS];
    return call(...args.map(numeric));
  }
  switch (name) {
    case 'point': count(2); return { x: n(0), y: n(1) };
    case 'colour':
      count(1);
      if (typeof args[0] !== 'string') throw new Error('colour needs a CSS colour string');
      return parseCssColour(args[0]);
    case 'srgb': case 'hsl': case 'oklab': case 'oklch': {
      count(3, 4);
      const constructor = { srgb: rgb, hsl, oklab, oklch }[name];
      return constructor(n(0), n(1), n(2), args.length === 4 ? n(3) : 1);
    }
    case 'toRgb': case 'toHsl': case 'toOklch':
      count(1); return colourComponents(colourValue(args[0]), name === 'toRgb' ? 'rgb' : name === 'toHsl' ? 'hsl' : 'oklch');
    case 'number':
      count(1);
      if (typeof args[0] !== 'boolean' && typeof args[0] !== 'number') throw new Error('number needs a boolean or number');
      return Number(args[0]);
    case 'length': {
      count(1); const p = pointValue(args[0]); return Math.hypot(p.x, p.y);
    }
    case 'distance': case 'dot': {
      count(2); const p = pointValue(args[0]), q = pointValue(args[1]);
      return name === 'distance' ? Math.hypot(q.x - p.x, q.y - p.y) : p.x * q.x + p.y * q.y;
    }
    case 'rotate': {
      count(2); const p = pointValue(args[0]), angle = -n(1) * Math.PI / 180;
      return { x: p.x * Math.cos(angle) - p.y * Math.sin(angle), y: p.x * Math.sin(angle) + p.y * Math.cos(angle) };
    }
    case 'clamp': count(3); if (n(1) > n(2)) throw new Error('clamp min exceeds max'); return Math.max(n(1), Math.min(n(2), n(0)));
    case 'lerp': case 'mix':
      count(3, 5); return interpolate(args[0], args[1], n(2), args.length >= 4 ? mixingSpace(args[3]) : space, args.length === 5 ? huePath(args[4]) : 'shorter');
    case 'sample':
      count(2);
      if (!isGradient(args[0])) throw new Error('sample needs a gradient');
      return sample(args[0], n(1));
  }
  throw new Error(`Unknown function "${name}"`);
}

// Parses and evaluates, rejecting results such as division by zero. Errors
// raised while looking up a variable pass through unchanged, so a problem in
// a variable's own definition is reported once, against that variable.
export function evaluateValue(text: string, variables: Variables = NO_VARIABLES, space: MixingSpace = variables.space ?? 'linear-srgb'): Value {
  let expression: Expression;
  try {
    expression = parseExpression(text);
  } catch (error) {
    throw new Error(`Invalid expression "${text}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = evaluate(expression, (name) => {
    let found = variables(name);
    if (found === undefined && name.includes('.')) {
      const parts = name.split('.');
      found = variables(parts.shift()!);
      for (const part of parts) {
        if (found === undefined) break;
        found = component(found, part);
      }
    }
    if (found === undefined) {
      throw new Error(`Expression "${text}" uses unknown name "${name}"`);
    }
    return found;
  }, space);
  return checkValue(value);
}

export const evaluateExpression = (text: string, variables: Variables = NO_VARIABLES): number =>
  numeric(evaluateValue(text, variables));
