export type ArithmeticToken = string;

export function parseExpression(input: string): ArithmeticToken[] {
  const tokens: ArithmeticToken[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i] ?? "";

    if (//.test(char)) {
      i += 1;
      continue;
    }

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (/[+\-*/()]/.test(char)) {
      tokens.push(char);
      i += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let j = i + 1;
      while (j < input.length && /[0-9.]/.test(input[j]!)) {
        j += 1;
      }
      const text = input.slice(i, j);
      if (text === ".") {
        throw new Error(`invalid_number ${text}`);
      }
      if ((text.match(/\./g) || []).length > 1) {
        throw new Error(`invalid_number ${text}`);
      }
      tokens.push(text);
      i = j;
      continue;
    }

    throw new Error(`invalid_char ${char}`);
  }

  return tokens;
}

export function evaluateExpression(input: string | ArithmeticToken[]): number {
  const tokens = typeof input === "string" ? parseExpression(input) : [...input];
  const parsed = parseByPrecedence(tokens);

  if (!Number.isFinite(parsed)) {
    throw new Error("invalid_result");
  }
  return parsed;
}

export function formatResult(expression: string, value: number): string {
  return `${expression} = ${value}`;
}

function parseByPrecedence(tokens: ArithmeticToken[]): number {
  let index = 0;

  const peek = () => tokens[index];
  const next = () => tokens[index++];

  const parsePrimary = (): number => {
    const token = peek();
    if (token === undefined) {
      throw new Error("unexpected_end");
    }
    if (token === "(") {
      next();
      const value = parseAdditive();
      const closing = next();
      if (closing !== ")") {
        throw new Error("missing_closing_paren");
      }
      return value;
    }
    if (token === "+") {
      next();
      return parsePrimary();
    }
    if (token === "-") {
      next();
      return -parsePrimary();
    }
    if (isOperator(token)) {
      throw new Error(`unexpected_operator ${token}`);
    }
    next();
    const number = Number(token);
    if (Number.isNaN(number)) {
      throw new Error(`invalid_number ${token}`);
    }
    return number;
  };

  const parseMultiplicative = (): number => {
    let left = parsePrimary();
    while (peek() === "*" || peek() === "/") {
      const operator = next();
      const right = parsePrimary();
      if (operator === "*") {
        left *= right;
      } else {
        if (right === 0) {
          throw new Error("division_by_zero");
        }
        left /= right;
      }
    }
    return left;
  };

  const parseAdditive = (): number => {
    let left = parseMultiplicative();
    while (peek() === "+" || peek() === "-") {
      const operator = next();
      const right = parseMultiplicative();
      if (operator === "+") {
        left += right;
      } else {
        left -= right;
      }
    }
    return left;
  };

  const value = parseAdditive();
  if (index !== tokens.length) {
    throw new Error(`unexpected_token ${tokens[index]}`);
  }
  return value;
}

function isOperator(value: string): boolean {
  return value === "+" || value === "-" || value === "*" || value === "/";
}
