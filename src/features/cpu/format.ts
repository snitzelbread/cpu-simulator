import type { NumberFormat } from '../../app/settings'
import { toSigned, trunc, type Size } from '../../core/util'

/** Format a register/memory value in the chosen number format. */
export function formatValue(v: bigint, size: Size, format: NumberFormat): string {
  const u = trunc(v, size)
  switch (format) {
    case 'hex':
      return '0x' + u.toString(16).toUpperCase().padStart(size * 2, '0')
    case 'udec':
      return u.toString()
    case 'sdec':
      return toSigned(u, size).toString().replace('-', '−')
    case 'bin': {
      const s = u.toString(2).padStart(size * 8, '0')
      return s.replace(/(.{8})(?=.)/g, '$1 ')
    }
  }
}

export function hexByte(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0')
}

export function hexAddr(a: number | bigint, digits = 0): string {
  return '0x' + a.toString(16).toUpperCase().padStart(digits, '0')
}
