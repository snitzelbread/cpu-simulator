import type { Instruction } from '../types'
import type { Size } from '../util'
import type { FlagSet } from '../isa'

export type FlagName = keyof FlagSet
export type Flags = FlagSet
export const FLAG_NAMES: FlagName[] = ['CF', 'PF', 'ZF', 'SF', 'OF']
/** Bit positions in RFLAGS. */
export const FLAG_BITS: Record<FlagName, number> = { CF: 0, PF: 2, ZF: 6, SF: 7, OF: 11 }

export type MachineStatus = 'ready' | 'halted' | 'exited' | 'faulted'

export type FaultCode =
  | 'divideError'
  | 'divideOverflow'
  | 'noInstruction'
  | 'endOfCode'
  | 'writeToCode'
  | 'unsupportedSyscall'
  | 'writeTooLong'
  | 'retEmptyStack'

export interface Fault {
  code: FaultCode
  params?: Record<string, string | number>
}

export interface RegChange {
  index: number
  before: bigint
  after: bigint
  /** Name of the register view that was written (e.g. 'eax') */
  name: string
  size: Size
  high8: boolean
  /** A 32-bit write cleared bits 63..32. */
  zeroExtended: boolean
}

export interface StackOrigin {
  kind: 'push' | 'call' | 'write'
  /** Source line of the instruction that wrote the slot */
  line: number
  text: string
}

export interface MemAccess {
  kind: 'read' | 'write'
  address: number
  size: number
  value: bigint
  /** Previous bytes, for undo (writes only) */
  before?: Uint8Array
  /** Previous stack origin of the slot (writes only, for undo) */
  prevOrigin?: StackOrigin
  /** The access is an instruction fetch */
  fetch?: boolean
}

export interface AluInfo {
  /** Operation symbol: '+', '-', '&', '|', '^', '~', 'neg', '<<', '>>', '>>>', 'rol', 'ror', '*', '/', 'cmp', 'test' */
  op: string
  size: Size
  a: bigint
  b?: bigint
  carryIn?: boolean
  /** Truncated result (unsigned) */
  result: bigint
  /** Result is discarded (cmp/test) */
  discarded?: boolean
  /** For mul/imul/div/idiv: high half / remainder */
  high?: bigint
  signed?: boolean
}

export interface BranchInfo {
  cond?: string
  taken: boolean
  target?: number
}

export interface SyscallInfo {
  number: bigint
  name: string
  fd?: number
  bytes?: number[]
  result?: bigint
  exitCode?: number
}

export interface ConsoleEntry {
  fd: number
  bytes: number[]
}

export interface StepTrace {
  /** 0-based step number */
  step: number
  instr: Instruction
  ripBefore: number
  ripAfter: number
  regs: RegChange[]
  mem: MemAccess[]
  flagsBefore: Flags
  flagsAfter: Flags
  /** Flags the instruction defines (may still keep their value) */
  flagsAffected: FlagName[]
  /** Flags the Intel SDM leaves undefined; the simulator keeps their old value */
  flagsUndefined: FlagName[]
  alu?: AluInfo
  branch?: BranchInfo
  /** Effective address of the memory operand, if any */
  ea?: bigint
  syscall?: SyscallInfo
  fault?: Fault
  statusBefore: MachineStatus
  statusAfter: MachineStatus
  consoleBefore: number
  /** cmov whose condition was false but still zero-extended the 32-bit destination */
  cmovZeroExtend?: boolean
  /** Shift/rotate count after masking */
  count?: number
}
