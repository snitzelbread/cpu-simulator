/**
 * Test helper: assemble a program with the real `nasm -f bin` using the simulator's
 * memory layout, and return the bytes of the .text section.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Program } from '../assembler'

export const hasNasm = (() => {
  try {
    execFileSync('nasm', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

export function nasmText(source: string, program: Pick<Program, 'sections'>): number[] {
  return nasmImage(source, program).text
}

/** Text and data bytes. In bin format .data follows .text in the file at a 4-byte aligned offset. */
export function nasmImage(source: string, program: Pick<Program, 'sections'>): { text: number[]; data: number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'cpusim-'))
  const lines = source.split('\n').map((l) => {
    const t = l.replace(/;.*/, '').trim().toLowerCase()
    if (/^global\b/.test(t)) return ''
    if (/^section\s+\.data\b/.test(t)) return `section .data vstart=${program.sections.data.start}`
    if (/^section\s+\.bss\b/.test(t)) return `section .bss nobits vstart=${program.sections.bss.start}`
    return l
  })
  const src = `BITS 64\norg 0x401000\nsection .text\n${lines.join('\n')}\n`
  writeFileSync(join(dir, 'in.asm'), src)
  execFileSync('nasm', ['-f', 'bin', '-o', join(dir, 'out.bin'), join(dir, 'in.asm')], { stdio: 'pipe' })
  const out = readFileSync(join(dir, 'out.bin'))
  const t = program.sections.text.size
  const dOff = Math.ceil(t / 4) * 4
  return {
    text: Array.from(out.subarray(0, t)),
    data: Array.from(out.subarray(dOff, dOff + program.sections.data.size)),
  }
}

export const toHex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')
