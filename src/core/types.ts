import type { Condition, Op } from './isa'
import type { RegInfo } from './registers'
import type { Size } from './util'

export type Scale = 1 | 2 | 4 | 8

/**
 * What an address in an object file is relative to: the start of one of the file's own
 * sections (local labels, as in ELF section symbols) or an external symbol.
 */
export type SymTerm = { kind: 'section'; section: 'text' | 'data' | 'bss'; label?: string } | { kind: 'extern'; name: string }

export interface RegOperand {
  k: 'reg'
  reg: RegInfo
  text: string
}

export interface MemOperand {
  k: 'mem'
  /** Explicit size specifier (byte/word/...) if given. */
  size?: Size
  base?: RegInfo
  index?: RegInfo
  scale: Scale
  disp: bigint
  /** RIP-relative encoding (via `rel` or `default rel`). The effective address is still `disp`. */
  ripRel: boolean
  text: string
  /** Object files only: `disp` is relative to this (section offset or extern symbol). */
  term?: SymTerm
}

export interface ImmOperand {
  k: 'imm'
  value: bigint
  size?: Size
  text: string
  /** Value not yet known (early assembler pass). */
  unresolved?: boolean
  /** Value is an address (depends on a label). NASM never shrinks such immediates. */
  reloc?: boolean
  /** Object files only: `value` is relative to this (section offset or extern symbol). */
  term?: SymTerm
}

export type Operand = RegOperand | MemOperand | ImmOperand

export interface Instruction {
  /** Index into Program.instructions */
  id: number
  op: Op
  cond?: Condition
  /** Mnemonic as written (lower case), e.g. 'jz' */
  mnemonic: string
  operands: Operand[]
  /** Operation size, if the instruction has one */
  opSize?: Size
  /** 1-based source line */
  line: number
  /** Source text of the instruction (without label/comment) */
  text: string
  address: number
  length: number
  bytes: number[]
  /** Jump/call target for direct branches */
  target?: number
}
