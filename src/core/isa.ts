/**
 * The instruction subset understood by the simulator, plus condition codes.
 */

export interface Condition {
  /** Hardware condition number (low nibble of 0x70+cc / 0x0F 0x80+cc). */
  code: number
  /** Canonical suffix used for explanations (e.g. 'l' for jl/jnge). */
  key: string
}

/** Every suffix NASM accepts for jcc/setcc/cmovcc. */
export const CONDITIONS: Record<string, Condition> = {}
const condTable: [number, string, string[]][] = [
  [0x0, 'o', ['o']],
  [0x1, 'no', ['no']],
  [0x2, 'b', ['b', 'c', 'nae']],
  [0x3, 'ae', ['ae', 'nb', 'nc']],
  [0x4, 'e', ['e', 'z']],
  [0x5, 'ne', ['ne', 'nz']],
  [0x6, 'be', ['be', 'na']],
  [0x7, 'a', ['a', 'nbe']],
  [0x8, 's', ['s']],
  [0x9, 'ns', ['ns']],
  [0xa, 'p', ['p', 'pe']],
  [0xb, 'np', ['np', 'po']],
  [0xc, 'l', ['l', 'nge']],
  [0xd, 'ge', ['ge', 'nl']],
  [0xe, 'le', ['le', 'ng']],
  [0xf, 'g', ['g', 'nle']],
]
for (const [code, key, names] of condTable) for (const n of names) CONDITIONS[n] = { code, key }

export interface FlagSet {
  CF: boolean
  PF: boolean
  ZF: boolean
  SF: boolean
  OF: boolean
}

export function evalCondition(key: string, f: FlagSet): boolean {
  switch (key) {
    case 'o': return f.OF
    case 'no': return !f.OF
    case 'b': return f.CF
    case 'ae': return !f.CF
    case 'e': return f.ZF
    case 'ne': return !f.ZF
    case 'be': return f.CF || f.ZF
    case 'a': return !f.CF && !f.ZF
    case 's': return f.SF
    case 'ns': return !f.SF
    case 'p': return f.PF
    case 'np': return !f.PF
    case 'l': return f.SF !== f.OF
    case 'ge': return f.SF === f.OF
    case 'le': return f.ZF || f.SF !== f.OF
    case 'g': return !f.ZF && f.SF === f.OF
  }
  throw new Error('unknown condition ' + key)
}

export const BASE_MNEMONICS = [
  'mov', 'movzx', 'movsx', 'movsxd', 'lea', 'xchg', 'push', 'pop',
  'add', 'sub', 'inc', 'dec', 'neg', 'adc', 'sbb', 'mul', 'imul', 'div', 'idiv',
  'and', 'or', 'xor', 'not', 'shl', 'sal', 'shr', 'sar', 'rol', 'ror',
  'cmp', 'test', 'jmp', 'call', 'ret', 'loop', 'nop', 'hlt', 'syscall',
  'cbw', 'cwde', 'cdqe', 'cwd', 'cdq', 'cqo',
] as const

export type Op =
  | (typeof BASE_MNEMONICS)[number]
  | 'jcc'
  | 'setcc'
  | 'cmovcc'

export interface DecodedMnemonic {
  op: Op
  cond?: Condition
}

export function decodeMnemonic(m: string): DecodedMnemonic | null {
  const s = m.toLowerCase()
  if ((BASE_MNEMONICS as readonly string[]).includes(s)) return { op: s as Op }
  for (const [prefix, op] of [['j', 'jcc'], ['set', 'setcc'], ['cmov', 'cmovcc']] as const) {
    if (s.startsWith(prefix)) {
      const c = CONDITIONS[s.slice(prefix.length)]
      if (c) return { op, cond: c }
    }
  }
  return null
}

/** Mnemonics the editor highlights (all accepted spellings). */
export function allMnemonics(): string[] {
  const out: string[] = [...BASE_MNEMONICS]
  for (const c of Object.keys(CONDITIONS)) out.push('j' + c, 'set' + c, 'cmov' + c)
  return out
}

/** A few real x86 instructions students might try; used to tell "unsupported" from "typo". */
export const KNOWN_UNSUPPORTED = new Set([
  'cpuid', 'int', 'int3', 'iret', 'iretq', 'cli', 'sti', 'in', 'out', 'rdtsc', 'leave', 'enter',
  'movs', 'movsb', 'movsw', 'movsd', 'movsq', 'stosb', 'stosq', 'lodsb', 'rep', 'cmpxchg', 'xadd',
  'bswap', 'bt', 'bts', 'btr', 'btc', 'bsf', 'bsr', 'popcnt', 'lzcnt', 'tzcnt', 'rcl', 'rcr', 'shld',
  'shrd', 'pushf', 'popf', 'pushfq', 'popfq', 'lahf',
  'sahf', 'clc', 'stc', 'cmc', 'cld', 'std', 'jrcxz', 'jecxz', 'loope', 'loopne', 'loopz', 'loopnz',
  'sysenter', 'movaps', 'movq', 'movd', 'pause', 'ud2', 'xlat', 'lock',
])

export function suggestMnemonic(m: string): string | undefined {
  let best: string | undefined
  let bestD = 2
  for (const cand of allMnemonics()) {
    const d = levenshtein(m.toLowerCase(), cand)
    if (d < bestD) {
      bestD = d
      best = cand
    }
  }
  return best
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}
