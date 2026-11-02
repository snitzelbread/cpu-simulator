/** C types of the supported subset. After compilation only sizes and instruction choices remain. */
export type CType =
  | { k: 'void' }
  | { k: 'int'; size: 1 | 2 | 4 | 8; unsigned: boolean }
  | { k: 'ptr'; to: CType }
  | { k: 'array'; of: CType; len: number }
  | { k: 'func'; ret: CType; params: CType[]; variadic: boolean }

export const VOID: CType = { k: 'void' }
export const CHAR: CType = { k: 'int', size: 1, unsigned: false }
export const INT: CType = { k: 'int', size: 4, unsigned: false }
export const UINT: CType = { k: 'int', size: 4, unsigned: true }
export const LONG: CType = { k: 'int', size: 8, unsigned: false }
export const ULONG: CType = { k: 'int', size: 8, unsigned: true }

export const ptrTo = (to: CType): CType => ({ k: 'ptr', to })

export function sizeOf(t: CType): number {
  switch (t.k) {
    case 'void': return 1
    case 'int': return t.size
    case 'ptr': return 8
    case 'array': return t.len * sizeOf(t.of)
    case 'func': return 1
  }
}

export function alignOf(t: CType): number {
  return t.k === 'array' ? alignOf(t.of) : Math.max(1, Math.min(8, sizeOf(t)))
}

export const isInt = (t: CType): t is Extract<CType, { k: 'int' }> => t.k === 'int'
export const isPtr = (t: CType): t is Extract<CType, { k: 'ptr' }> => t.k === 'ptr'
export const isScalar = (t: CType) => t.k === 'int' || t.k === 'ptr'
/** Pointers compare unsigned, like unsigned integers. */
export const isUnsigned = (t: CType) => (t.k === 'int' && t.unsigned) || t.k === 'ptr'

/** Arrays decay to a pointer to their first element; functions to function pointers (unsupported). */
export function decay(t: CType): CType {
  return t.k === 'array' ? ptrTo(t.of) : t
}

/** Integer promotion: char and short become int. */
export function promote(t: CType): CType {
  return t.k === 'int' && t.size < 4 ? INT : t
}

/** Usual arithmetic conversions for two integer operands. */
export function usualArith(a: CType, b: CType): CType {
  const x = promote(a) as Extract<CType, { k: 'int' }>
  const y = promote(b) as Extract<CType, { k: 'int' }>
  if (x.size === 8 || y.size === 8) {
    if ((x.size === 8 && x.unsigned) || (y.size === 8 && y.unsigned)) return ULONG
    return LONG // long can represent every unsigned int
  }
  return x.unsigned || y.unsigned ? UINT : INT
}

export function sameType(a: CType, b: CType): boolean {
  if (a.k !== b.k) return false
  switch (a.k) {
    case 'void': return true
    case 'int': return a.size === (b as typeof a).size && a.unsigned === (b as typeof a).unsigned
    case 'ptr': return sameType(a.to, (b as typeof a).to)
    case 'array': return a.len === (b as typeof a).len && sameType(a.of, (b as typeof a).of)
    case 'func': {
      const f = b as typeof a
      return sameType(a.ret, f.ret) && a.variadic === f.variadic && a.params.length === f.params.length && a.params.every((p, i) => sameType(p, f.params[i]))
    }
  }
}

const INT_NAMES: Record<number, string> = { 1: 'char', 2: 'short', 4: 'int', 8: 'long' }

/** C spelling: "unsigned int", "char *", "int [10]". */
export function typeName(t: CType): string {
  switch (t.k) {
    case 'void': return 'void'
    case 'int': return (t.unsigned ? 'unsigned ' : '') + INT_NAMES[t.size]
    case 'ptr': return t.to.k === 'func' ? 'function pointer' : typeName(t.to) + ' *'
    case 'array': return `${typeName(t.of)} [${t.len}]`
    case 'func': return `${typeName(t.ret)} (${t.params.map(typeName).join(', ')}${t.variadic ? ', ...' : ''})`
  }
}

/** A declaration with a name: "int x[10]", "char *s". */
export function declText(t: CType, name: string): string {
  if (t.k === 'array') return `${declText(t.of, name)}[${t.len}]`.replace(/ \[/, '[')
  if (t.k === 'ptr') return `${typeName(t.to)} *${name}`
  return `${typeName(t)} ${name}`
}
