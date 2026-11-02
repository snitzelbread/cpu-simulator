import type { Size } from './util'

/** Hardware number of each 64-bit general-purpose register (as used in ModRM/REX). */
export const GPR64 = [
  'rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
] as const

/** Display order used by the register file (matches how the lecture lists them). */
export const DISPLAY_ORDER = [0, 3, 1, 2, 6, 7, 5, 4, 8, 9, 10, 11, 12, 13, 14, 15]

export interface RegInfo {
  name: string
  /** GPR number 0..15 */
  index: number
  size: Size
  /** AH/CH/DH/BH: bits 15..8 of the register. */
  high8: boolean
  /** SPL/BPL/SIL/DIL and R8B..R15B etc. can only be encoded with a REX prefix. */
  needsRex: boolean
}

const table = new Map<string, RegInfo>()

function add(name: string, index: number, size: Size, high8 = false, needsRex = false) {
  table.set(name, { name, index, size, high8, needsRex: needsRex || index >= 8 })
}

const legacy = [
  ['rax', 'eax', 'ax', 'al', 'ah'],
  ['rcx', 'ecx', 'cx', 'cl', 'ch'],
  ['rdx', 'edx', 'dx', 'dl', 'dh'],
  ['rbx', 'ebx', 'bx', 'bl', 'bh'],
  ['rsp', 'esp', 'sp', 'spl'],
  ['rbp', 'ebp', 'bp', 'bpl'],
  ['rsi', 'esi', 'si', 'sil'],
  ['rdi', 'edi', 'di', 'dil'],
]
legacy.forEach((names, i) => {
  add(names[0], i, 8)
  add(names[1], i, 4)
  add(names[2], i, 2)
  add(names[3], i, 1, false, i >= 4)
  if (names[4]) add(names[4], i, 1, true)
})
for (let i = 8; i < 16; i++) {
  add(`r${i}`, i, 8)
  add(`r${i}d`, i, 4)
  add(`r${i}w`, i, 2)
  add(`r${i}b`, i, 1)
  add(`r${i}l`, i, 1) // NASM alias
}

export function lookupRegister(name: string): RegInfo | undefined {
  return table.get(name.toLowerCase())
}

export function regName(index: number, size: Size, high8 = false): string {
  if (high8) return 'abcd'[index] + 'h'
  if (index >= 8) return size === 8 ? `r${index}` : size === 4 ? `r${index}d` : size === 2 ? `r${index}w` : `r${index}b`
  const names = legacy[index]
  return size === 8 ? names[0] : size === 4 ? names[1] : size === 2 ? names[2] : names[3]
}

/** All views of a 64-bit register, used by the bit-layout display. */
export function registerViews(index: number): { name: string; size: Size; high8: boolean }[] {
  const views: { name: string; size: Size; high8: boolean }[] = [
    { name: regName(index, 8), size: 8, high8: false },
    { name: regName(index, 4), size: 4, high8: false },
    { name: regName(index, 2), size: 2, high8: false },
  ]
  if (index < 4) views.push({ name: regName(index, 1, true), size: 1, high8: true })
  views.push({ name: regName(index, 1), size: 1, high8: false })
  return views
}
