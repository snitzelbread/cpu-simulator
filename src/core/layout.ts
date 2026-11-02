/**
 * Process image of a simulated Linux x86-64 program.
 *
 *   0x00401000  .text   (code, read-only)
 *   next page   .data   (initialised data)
 *   after data  .bss    (zero-initialised, 16-byte aligned)
 *   ...
 *   0x7FFFF000  initial RSP; the stack grows downwards from here
 */
export const TEXT_BASE = 0x401000
export const PAGE = 0x1000
export const STACK_TOP = 0x7ffff000
/** Size of the region below STACK_TOP shown/treated as stack. */
export const STACK_SIZE = 0x10000

export function alignUp(v: number, a: number): number {
  return Math.ceil(v / a) * a
}

export function dataBase(textSize: number): number {
  return alignUp(TEXT_BASE + Math.max(textSize, 1), PAGE)
}

export function bssBase(dataStart: number, dataSize: number): number {
  return alignUp(dataStart + dataSize, 16)
}
