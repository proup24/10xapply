/** Number extraction and a safe arithmetic evaluator. Error text never holds a value. */

export class MathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MathError';
  }
}

const FULL_MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

export const MONTHS: Record<string, number> = {};
FULL_MONTHS.forEach((name, i) => {
  MONTHS[name] = i + 1;
  MONTHS[name.slice(0, 3)] = i + 1;
});
MONTHS['sept'] = 9;

const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
};

const NUMBER_TOKEN = new RegExp(
  String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\b(?:${Object.keys(NUMBER_WORDS).join('|')})\b`,
  'gi',
);

/** Every number in the text, in order of appearance. A `-` is never a minus sign. */
export function numbersIn(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const token = match[0];
    const word = NUMBER_WORDS[token.toLowerCase()];
    found.push(word ?? Number(token.replaceAll(',', '')));
  }
  return found;
}

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string };

const OPERATORS: Record<string, string> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '*': '*',
  '×': '*',
  '/': '/',
  '÷': '/',
  '(': '(',
  ')': ')',
};

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/\d|\./.test(ch)) {
      const m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(expression.slice(i));
      if (!m) throw new MathError('unsupported expression');
      tokens.push({ kind: 'num', value: Number(m[0]) });
      i += m[0].length;
    } else if (ch in OPERATORS) {
      tokens.push({ kind: 'op', value: OPERATORS[ch] });
      i++;
    } else {
      throw new MathError('unsupported expression');
    }
  }
  return tokens;
}

/** Evaluates + - * / (also × ÷ −), parentheses and decimals. No unary minus. */
export function evaluate(expression: string): number {
  const tokens = tokenize(expression);
  let pos = 0;
  const peekOp = (): string | undefined => {
    const t = tokens[pos];
    return t?.kind === 'op' ? t.value : undefined;
  };

  function expr(): number {
    let left = term();
    for (let op = peekOp(); op === '+' || op === '-'; op = peekOp()) {
      pos++;
      const right = term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function term(): number {
    let left = factor();
    for (let op = peekOp(); op === '*' || op === '/'; op = peekOp()) {
      pos++;
      const right = factor();
      if (op === '/' && right === 0) throw new MathError('division by zero');
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  function factor(): number {
    const t = tokens[pos];
    if (!t) throw new MathError('unsupported expression');
    if (t.kind === 'num') {
      pos++;
      return t.value;
    }
    if (t.value === '(') {
      pos++;
      const inner = expr();
      if (peekOp() !== ')') throw new MathError('unsupported expression');
      pos++;
      return inner;
    }
    throw new MathError('unsupported expression');
  }

  const result = expr();
  if (pos !== tokens.length) throw new MathError('unsupported expression');
  return result;
}

/** The numeric literals in an expression, in order. Throws MathError if it is not valid. */
export function expressionNumbers(expression: string): number[] {
  evaluate(expression);
  return tokenize(expression).flatMap((t) => (t.kind === 'num' ? [t.value] : []));
}

/** Whole years from the 1st of `month` (or 1 January) of `year` to `runDate` (YYYY-MM-DD), rounded down. */
export function yearsSince(spec: { year: number; month?: number }, runDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(runDate);
  if (!m) throw new MathError('invalid run date');
  const [runYear, runMonth] = [Number(m[1]), Number(m[2])];
  const month = spec.month ?? 1;
  if (!Number.isInteger(spec.year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new MathError('invalid start date');
  }
  if (spec.year > runYear || (spec.year === runYear && month > runMonth)) {
    throw new MathError('start date is after the run date');
  }
  let years = runYear - spec.year;
  if (runMonth < month) years--;
  return years;
}
