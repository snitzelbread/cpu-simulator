import type { AluInfo } from '../../../core/cpu/state'
import type { Size } from '../../../core/util'
import { t } from '../../../i18n'

/**
 * Column-wise binary addition/subtraction with the carry (borrow) row, like on paper.
 * For 32/64-bit operands only the top and bottom byte are shown: CF/OF come from the
 * top, PF/ZF hints from the bottom.
 */
export function BinaryCalc({ alu, op }: { alu: AluInfo; op: 'add' | 'sub' }) {
  const size = alu.size as Size
  const W = size * 8
  const bit = (v: bigint, i: number) => Number((v >> BigInt(i)) & 1n)
  const a = alu.a
  const b = alu.b ?? 0n
  // carry[i] = carry/borrow INTO bit i; carry[W] = out of the MSB
  const carry: number[] = [alu.carryIn ? 1 : 0]
  for (let i = 0; i < W; i++) {
    const x = bit(a, i)
    const y = bit(b, i)
    const c = carry[i]
    carry.push(op === 'add' ? (x & y) | (x & c) | (y & c) : ((1 - x) & y) | ((1 - (x ^ y)) & c))
  }
  const cols: (number | null)[] = []
  if (W <= 16) for (let i = W - 1; i >= 0; i--) cols.push(i)
  else {
    for (let i = W - 1; i >= W - 8; i--) cols.push(i)
    cols.push(null)
    for (let i = 7; i >= 0; i--) cols.push(i)
  }
  const cell = (v: number | null, key: string | number, cls = '') => (
    <span key={key} className={'bc-cell ' + cls}>
      {v === null ? '…' : v}
    </span>
  )
  const row = (label: string, f: (i: number) => number, cls: string, out?: number | string) => (
    <div className={'bc-row ' + cls}>
      <span className="bc-label">{label}</span>
      {cell(out === undefined ? null : (out as number), 'out', out === undefined ? 'bc-blank' : 'bc-out')}
      {cols.map((i, k) => (i === null ? cell(null, k, 'bc-gap') : cell(f(i), k, i % 8 === 0 && i > 0 ? 'bc-byte' : '')))}
    </div>
  )
  const opSym = op === 'add' ? '+' : '−'
  return (
    <div className="binary-calc mono" aria-label={t().ui.binaryCalc}>
      <div className="bc-row bc-bits">
        <span className="bc-label" />
        <span className="bc-cell bc-out-h">CF</span>
        {cols.map((i, k) => (
          <span key={k} className="bc-cell bc-idx">
            {i === null ? '' : i === W - 1 || i === 0 || i % 8 === 0 || i % 8 === 7 ? i : ''}
          </span>
        ))}
      </div>
      {row(op === 'add' ? t().ui.carry : t().ui.borrow, (i) => carry[i], 'bc-carry', undefined)}
      {row('A', (i) => bit(a, i), '')}
      {row(opSym + ' B', (i) => bit(b, i), 'bc-b')}
      {row('=', (i) => bit(alu.result, i), 'bc-result', carry[W])}
    </div>
  )
}
