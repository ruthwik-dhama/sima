/** Small arithmetic evaluator so model-written calculations are checked without any eval. */
const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  abs: Math.abs,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function evaluateExpression(source: string): number {
  const text = source.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  let pos = 0;
  const fail = (): never => {
    throw new Error(`Cannot evaluate "${source}"`);
  };
  const peek = () => text[pos];
  const expression = (): number => {
    let value = term();
    while (peek() === '+' || peek() === '-') {
      value = text[pos++] === '+' ? value + term() : value - term();
    }
    return value;
  };
  const term = (): number => {
    let value = unary();
    while (peek() === '*' || peek() === '/') {
      value = text[pos++] === '*' ? value * unary() : value / unary();
    }
    return value;
  };
  const unary = (): number => {
    if (peek() === '-') {
      pos++;
      return -unary();
    }
    if (peek() === '+') {
      pos++;
      return unary();
    }
    return power();
  };
  const power = (): number => {
    const base = atom();
    if (peek() === '^') {
      pos++;
      return base ** unary();
    }
    return base;
  };
  const atom = (): number => {
    if (peek() === '(') {
      pos++;
      const value = expression();
      if (text[pos++] !== ')') fail();
      return value;
    }
    const number = text.slice(pos).match(/^\d*\.?\d+(?:[eE][+-]?\d+)?/);
    if (number) {
      pos += number[0].length;
      return Number(number[0]);
    }
    const word = text.slice(pos).match(/^[a-zA-Z]+/);
    if (!word) return fail();
    pos += word[0].length;
    const fn = FUNCTIONS[word[0].toLowerCase()];
    if (fn) {
      if (text[pos++] !== '(') fail();
      const value = expression();
      if (text[pos++] !== ')') fail();
      return fn(value);
    }
    const constant = CONSTANTS[word[0].toLowerCase()];
    return constant ?? fail();
  };
  const result = expression();
  if (pos !== text.length || !Number.isFinite(result)) fail();
  return result;
}

export function parseNumericAnswer(value: string): number | null {
  const match = value
    .trim()
    .replace(/,(?=\d{3}\b)/g, '')
    .match(/^[-+−]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0].replace('−', '-'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function countSignificantFigures(value: string): number | null {
  const match = value.trim().match(/^[-+−]?(\d*)(?:\.(\d*))?(?:[eE][-+]?\d+)?/);
  if (!match || (!match[1] && !match[2])) return null;
  const whole = match[1] ?? '';
  const fraction = match[2];
  if (fraction !== undefined) {
    const digits = (whole + fraction).replace(/^0+/, '');
    return digits.length;
  }
  return whole.replace(/^0+/, '').replace(/0+$/, '').length || 1;
}

/** Tolerance follows the precision of the stated answer, so rounding passes and wrong values fail. */
export function numbersAgree(answer: string, computed: number): boolean {
  const parsed = parseNumericAnswer(answer);
  if (parsed === null) return false;
  const decimals = answer.match(/\.(\d+)/)?.[1]?.length ?? 0;
  const tolerance = Math.max(0.5 * 10 ** -decimals, Math.abs(computed) * 1e-9);
  return Math.abs(parsed - computed) <= tolerance * (1 + 1e-9);
}

const NUMERIC_PREFIX = /^\s*[-+−]?\d*\.?\d+(?:[eE][-+]?\d+)?/;

/** Swaps the number at the start of an answer, keeping anything after it such as a unit. */
export function replaceNumber(answer: string, value: string): string {
  return NUMERIC_PREFIX.test(answer) ? answer.replace(NUMERIC_PREFIX, value) : value;
}

/** Shows a computed value at the precision the stated answer used. */
export function formatLike(answer: string, computed: number): string {
  const decimals = answer.match(NUMERIC_PREFIX)?.[0].match(/\.(\d+)/)?.[1]?.length ?? 0;
  return decimals > 0 ? computed.toFixed(decimals) : String(Number(computed.toPrecision(10)));
}

export function toSignificantFigures(value: number, figures: number): string {
  const text = value.toPrecision(figures);
  return text.includes('e') ? String(Number(text)) : text;
}
