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

export function evalExpression(raw: string): number | null {
  const expr = normalize(raw ?? "").trim();
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
  return Number.isFinite(acc) ? acc : null;
}

// True when the string still has a pending operator (so the amount shown is an
// in-progress expression rather than a final value). Used to show a live "= result".
export function hasOperator(raw: string): boolean {
  const expr = normalize(raw ?? "");
  // Ignore a leading negative sign.
  const body = expr.startsWith("-") ? expr.slice(1) : expr;
  return /[+\-*/]/.test(body);
}
