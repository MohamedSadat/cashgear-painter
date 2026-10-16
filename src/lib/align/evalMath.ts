/**
 * The value of an arithmetic expression typed into a number field, such as `200/3` or
 * `(120 + 8) * 2`: numbers with an optional decimal point, + - * / (× and ÷ too), unary signs and
 * parentheses. Null for anything else, and for a result that isn't a finite number.
 */
export function evalMath(text: string): number | null {
  const tokens =
    text
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .match(/\d+(?:\.\d*)?|\.\d+|\S/g) ?? []
  if (tokens.length === 0) return null
  let pos = 0
  const peek = () => tokens[pos]

  // expression := term (('+' | '-') term)*
  function expression(): number {
    let value = term()
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos++]
      const right = term()
      value = op === '+' ? value + right : value - right
    }
    return value
  }

  // term := factor (('*' | '/') factor)*
  function term(): number {
    let value = factor()
    while (peek() === '*' || peek() === '/') {
      const op = tokens[pos++]
      const right = factor()
      value = op === '*' ? value * right : value / right
    }
    return value
  }

  // factor := ('+' | '-') factor | number | '(' expression ')'
  function factor(): number {
    const token = tokens[pos++]
    if (token === '+') return factor()
    if (token === '-') return -factor()
    if (token === '(') {
      const value = expression()
      if (tokens[pos++] !== ')') return NaN
      return value
    }
    return token !== undefined && /^(\d+(\.\d*)?|\.\d+)$/.test(token) ? Number(token) : NaN
  }

  const value = expression()
  return pos === tokens.length && Number.isFinite(value) ? value : null
}
