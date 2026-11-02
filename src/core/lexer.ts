import { fail } from './errors'

export type Token =
  | { t: 'id'; v: string; col: number }
  | { t: 'num'; v: bigint; col: number }
  | { t: 'str'; v: number[]; col: number }
  | { t: 'op'; v: string; col: number }

const OPS = ['<<', '>>', '$$', '+', '-', '*', '/', '%', '(', ')', '[', ']', ',', ':', '~', '&', '|', '^', '$']

/** Remove a trailing `;` comment, respecting quotes. */
export function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (quote === '`' && c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === ';') return line.slice(0, i)
  }
  return line
}

export function parseNumber(text: string): bigint {
  const s = text.replace(/_/g, '').toLowerCase()
  let m: RegExpMatchArray | null
  const parse = (digits: string, radix: number, re: RegExp) => {
    if (!digits || !re.test(digits)) fail('badNumber', { text })
    let v = 0n
    for (const d of digits) v = v * BigInt(radix) + BigInt(parseInt(d, radix))
    return v
  }
  // Order verified against nasm: an 'h' suffix wins (0dh = 13, 0bh = 11), then prefixes, then other suffixes.
  if ((m = s.match(/^([0-9][0-9a-f]*)h$/))) return parse(m[1], 16, /^[0-9a-f]+$/)
  if ((m = s.match(/^0[xh](.*)$/))) return parse(m[1], 16, /^[0-9a-f]+$/)
  if ((m = s.match(/^0[by](.*)$/))) return parse(m[1], 2, /^[01]+$/)
  if ((m = s.match(/^0[oq](.*)$/))) return parse(m[1], 8, /^[0-7]+$/)
  if ((m = s.match(/^0[dt](.*)$/))) return parse(m[1], 10, /^[0-9]+$/)
  if ((m = s.match(/^(.*)x$/))) return parse(m[1], 16, /^[0-9a-f]+$/)
  if ((m = s.match(/^(.*)[by]$/))) return parse(m[1], 2, /^[01]+$/)
  if ((m = s.match(/^(.*)[oq]$/))) return parse(m[1], 8, /^[0-7]+$/)
  if ((m = s.match(/^(.*)[dt]$/))) return parse(m[1], 10, /^[0-9]+$/)
  return parse(s, 10, /^[0-9]+$/)
}

const ESCAPES: Record<string, number> = {
  n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34, '`': 96, a: 7, b: 8, f: 12, v: 11, e: 27,
}

function encodeUtf8(s: string): number[] {
  return Array.from(new TextEncoder().encode(s))
}

export function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    const col = i + 1
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      const bytes: number[] = []
      let closed = false
      while (j < src.length) {
        const d = src[j]
        if (d === c) {
          closed = true
          j++
          break
        }
        if (c === '`' && d === '\\' && j + 1 < src.length) {
          const e = src[j + 1]
          if (e === 'x') {
            const hx = src.slice(j + 2, j + 4).match(/^[0-9a-fA-F]{1,2}/)
            if (!hx) fail('syntax')
            bytes.push(parseInt(hx[0], 16))
            j += 2 + hx[0].length
            continue
          }
          if (e in ESCAPES) {
            bytes.push(ESCAPES[e])
            j += 2
            continue
          }
          bytes.push(e.charCodeAt(0))
          j += 2
          continue
        }
        bytes.push(...encodeUtf8(d))
        j++
      }
      if (!closed) fail('unterminatedString')
      out.push({ t: 'str', v: bytes, col })
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      const m = src.slice(i).match(/^[0-9][0-9a-zA-Z_]*/)!
      out.push({ t: 'num', v: parseNumber(m[0]), col })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_.?@]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-z_.?@][A-Za-z0-9_.?@$#~]*/)!
      out.push({ t: 'id', v: m[0], col })
      i += m[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) fail('unexpectedToken', { token: c })
    out.push({ t: 'op', v: op, col })
    i += op.length
  }
  return out
}
