/** Operand sizes in bytes. */
export type Size = 1 | 2 | 4 | 8

export const SIZES: readonly Size[] = [1, 2, 4, 8]

export function bits(size: Size): number {
  return size * 8
}

export function mask(size: Size): bigint {
  return (1n << BigInt(size * 8)) - 1n
}

/** Truncate to `size` bytes, result is the unsigned interpretation. */
export function trunc(v: bigint, size: Size): bigint {
  return v & mask(size)
}

/** Interpret the low `size` bytes of `v` as a two's-complement signed number. */
export function toSigned(v: bigint, size: Size): bigint {
  const b = BigInt(size * 8)
  const u = v & ((1n << b) - 1n)
  return u >= 1n << (b - 1n) ? u - (1n << b) : u
}

export function msb(v: bigint, size: Size): boolean {
  return ((v >> BigInt(size * 8 - 1)) & 1n) === 1n
}

/** PF: set if the least-significant byte contains an even number of 1 bits. */
export function parityEven(v: bigint): boolean {
  let b = Number(v & 0xffn)
  let ones = 0
  while (b) {
    ones += b & 1
    b >>= 1
  }
  return ones % 2 === 0
}

export function fitsSigned(v: bigint, size: Size): boolean {
  const b = BigInt(size * 8)
  return v >= -(1n << (b - 1n)) && v < 1n << (b - 1n)
}

/** True if `v` can be written as a `size`-byte value (signed or unsigned interpretation). */
export function fitsEither(v: bigint, size: Size): boolean {
  const b = BigInt(size * 8)
  return v >= -(1n << (b - 1n)) && v < 1n << b
}

export function hex(v: bigint | number, size?: Size): string {
  const n = typeof v === 'number' ? BigInt(v) : v
  const s = (n < 0n ? trunc(n, size ?? 8) : n).toString(16).toUpperCase()
  return '0x' + (size ? s.padStart(size * 2, '0') : s)
}

export function sizeName(size: Size): string {
  return size === 1 ? 'byte' : size === 2 ? 'word' : size === 4 ? 'dword' : 'qword'
}
