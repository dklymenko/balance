// A tiny, safe calculator for the transaction amount field. Supports a plain
// number ("50", "12.5") or a chained arithmetic expression typed directly using
// + − × ÷ ("12+3", "100-5-5"). Evaluation is strict left-to-right (no operator
// precedence) -- matching how a simple pocket/phone calculator behaves, which is
// what users expect from quick entry.
//
// Returns null when the expression is empty or malformed, so callers can disable
// the Save button rather than submitting NaN. Never uses eval().

// Normalise the display operators (×, ÷, − minus sign) to their ASCII forms.
function normalize(expr: string): string {
  return expr.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
}

// Remove conventional comma thousands separators from every numeric operand.
// Grouping must be exact (1-3 leading digits, then groups of 3), so malformed
// input such as "15,53.41" stays invalid instead of being silently reinterpreted.
function normalizeThousandsSeparators(expr: string): string | null {
  let result = "";
  let number = "";

  const flushNumber = () => {
    if (number === "") return true;
    if (number.includes(",")) {
      if (!/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(number)) return false;
      result += number.replaceAll(",", "");
    } else {
      result += number;
    }
    number = "";
    return true;
  };

  for (const ch of expr) {
    if ((ch >= "0" && ch <= "9") || ch === "." || ch === ",") {
      number += ch;
    } else {
      if (!flushNumber()) return null;
      result += ch;
    }
  }

  return flushNumber() ? result : null;
}

export function evalExpression(raw: string): number | null {
  const expr = normalizeThousandsSeparators(normalize(raw ?? "").trim());
  if (expr === null) return null;
  if (expr === "") return null;

  // Tokenise into numbers and the operators + - * /. A leading '-' is treated as
  // a negative sign on the first number; other operators must sit between numbers.
  const tokens: (number | string)[] = [];
  let num = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch >= "0" && ch <= "9") {
      num += ch;
    } else if (ch === ".") {
      num += ch;
    } else if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      if (num === "" && ch === "-" && tokens.length === 0) {
        num = "-"; // leading negative
      } else if (num === "" || num === "-") {
        return null; // operator with no preceding operand
      } else {
        tokens.push(Number(num));
        num = "";
        tokens.push(ch);
      }
    } else {
      return null; // unexpected character
    }
  }
  if (num === "" || num === "-") return null; // trailing operator
  tokens.push(Number(num));

  // Fold left-to-right.
  let acc = tokens[0] as number;
  if (!Number.isFinite(acc)) return null;
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i] as string;
    const rhs = tokens[i + 1] as number;
    if (!Number.isFinite(rhs)) return null;
    if (op === "+") acc += rhs;
    else if (op === "-") acc -= rhs;
    else if (op === "*") acc *= rhs;
    else if (op === "/") acc = rhs === 0 ? NaN : acc / rhs;
  }
  // Remove ordinary IEEE-754 residue from decimal arithmetic (for example,
  // 1000 + 553.41 must remain 1553.41, not 1553.4099999999999).
  return Number.isFinite(acc) ? Number(acc.toFixed(12)) : null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
  "₴": "UAH",
};

export interface ParsedAmountInput {
  value: number | null;
  currencyError: string | null;
}

// Accept an optional leading currency symbol. A matching symbol is ignored for
// calculation; a symbol for another currency is surfaced as a clear validation
// error tied to the selected account.
export function parseAmountInput(raw: string, accountCurrency: string): ParsedAmountInput {
  const input = (raw ?? "").trim();
  const symbol = input[0];
  const symbolCurrency = CURRENCY_SYMBOLS[symbol];

  if (symbolCurrency && symbolCurrency !== accountCurrency) {
    return { value: null, currencyError: `${accountCurrency} only` };
  }

  const expression = symbolCurrency ? input.slice(1).trim() : input;
  return { value: evalExpression(expression), currencyError: null };
}

// True when the string still has a pending operator (so the amount shown is an
// in-progress expression rather than a final value). Used to show a live "= result".
export function hasOperator(raw: string): boolean {
  const expr = normalize(raw ?? "");
  // Ignore a leading negative sign.
  const body = expr.startsWith("-") ? expr.slice(1) : expr;
  return /[+\-*/]/.test(body);
}
