// Arithmetic expressions for numeric scene values, such as `1/sqrt(2)` or
// `log(8) / log(3)`. Parsing produces a syntax tree so the same expression
// can be evaluated now and rendered as mathematics later.

export type Expression =
  | { kind: 'number'; value: number; text: string }
  | { kind: 'constant'; name: ConstantName }
  | { kind: 'variable'; name: string }
  | { kind: 'negate'; operand: Expression }
  | { kind: 'binary'; operator: BinaryOperator; left: Expression; right: Expression }
  | { kind: 'call'; name: FunctionName; args: Expression[] };

// Looks up a variable's value, or returns undefined if it does not exist.
export type Variables = (name: string) => number | undefined;

export const NO_VARIABLES: Variables = () => undefined;

type BinaryOperator = '+' | '-' | '*' | '/' | '^';

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
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
} satisfies Record<string, (...args: number[]) => number>;

type FunctionName = keyof typeof FUNCTIONS;

const isConstant = (name: string): name is ConstantName => Object.hasOwn(CONSTANTS, name);
const isFunction = (name: string): name is FunctionName => Object.hasOwn(FUNCTIONS, name);

// Constants and functions cannot be redefined as variables.
export const isReservedName = (name: string) => isConstant(name) || isFunction(name);

export const isIdentifier = (text: string) => /^[A-Za-z_]\w*$/.test(text);

type Token = { type: 'number' | 'name' | 'symbol'; text: string; position: number };

// Names may be dotted, such as view.left, to refer to scene values.
const TOKEN_PATTERN = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)|([-+*/^(),]))/y;

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
    const [whole, number, name, symbol] = match;
    const position = start + whole.length - (number ?? name ?? symbol).length;
    tokens.push(number !== undefined
      ? { type: 'number', text: number, position }
      : name !== undefined
        ? { type: 'name', text: name, position }
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
    if (accept('-')) {
      return { kind: 'negate', operand: unary() };
    }
    if (accept('+')) {
      return unary();
    }
    return power();
  };

  const power = (): Expression => {
    const base = primary();
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
    if (token.type === 'name') {
      if (accept('(')) {
        if (!isFunction(token.text)) {
          throw new Error(`unknown function "${token.text}"`);
        }
        const args = [additive()];
        while (accept(',')) {
          args.push(additive());
        }
        expect(')');
        const arity = FUNCTIONS[token.text].length;
        if (args.length !== arity) {
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
      const inner = additive();
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
  const expression = additive();
  if (index < tokens.length) {
    throw new Error(`unexpected ${describe(peek())}`);
  }
  return expression;
}

export function evaluate(expression: Expression, lookup: (name: string) => number): number {
  switch (expression.kind) {
    case 'number':
      return expression.value;
    case 'constant':
      return CONSTANTS[expression.name];
    case 'variable':
      return lookup(expression.name);
    case 'negate':
      return -evaluate(expression.operand, lookup);
    case 'call': {
      const call: (...args: number[]) => number = FUNCTIONS[expression.name];
      return call(...expression.args.map((arg) => evaluate(arg, lookup)));
    }
    case 'binary': {
      const left = evaluate(expression.left, lookup);
      const right = evaluate(expression.right, lookup);
      switch (expression.operator) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '^': return Math.pow(left, right);
      }
    }
  }
}

// Parses and evaluates, rejecting results such as division by zero. Errors
// raised while looking up a variable pass through unchanged, so a problem in
// a variable's own definition is reported once, against that variable.
export function evaluateExpression(text: string, variables: Variables = NO_VARIABLES): number {
  let expression: Expression;
  try {
    expression = parseExpression(text);
  } catch (error) {
    throw new Error(`Invalid expression "${text}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = evaluate(expression, (name) => {
    const found = variables(name);
    if (found === undefined) {
      throw new Error(`Expression "${text}" uses unknown name "${name}"`);
    }
    return found;
  });
  if (!Number.isFinite(value)) {
    throw new Error(`Expression "${text}" does not evaluate to a finite number`);
  }
  return value;
}
