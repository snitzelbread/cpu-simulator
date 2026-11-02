/**
 * Test helper: assemble with the real `nasm -f elf64` and read the relocatable ELF64 file
 * (section bytes, symbol table, RELA relocations). Only what the comparison tests need.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { assembleObject } from '../assembler'
import type { ObjectFile } from '../object'
import { toHex } from './nasm'

export interface ElfSymbol {
  name: string
  value: number
  section: string // section name, 'UND' or 'ABS'
  binding: 'local' | 'global'
  type: number
}

export interface ElfReloc {
  section: string
  offset: number
  type: string
  symbol: ElfSymbol
  addend: bigint
}

export interface Elf {
  sections: Record<string, { size: number; bytes: number[] }>
  symbols: ElfSymbol[]
  relocations: ElfReloc[]
}

const RELOC_NAMES: Record<number, string> = {
  1: 'R_X86_64_64', 2: 'R_X86_64_PC32', 4: 'R_X86_64_PLT32', 10: 'R_X86_64_32', 11: 'R_X86_64_32S', 12: 'R_X86_64_16', 14: 'R_X86_64_8',
}

export function nasmElf(source: string): Elf {
  const dir = mkdtempSync(join(tmpdir(), 'cpusim-elf-'))
  writeFileSync(join(dir, 'in.asm'), source)
  execFileSync('nasm', ['-f', 'elf64', '-o', join(dir, 'out.o'), join(dir, 'in.asm')], { stdio: 'pipe' })
  return readElf(readFileSync(join(dir, 'out.o')))
}

export function readElf(buf: Buffer): Elf {
  const shoff = Number(buf.readBigUInt64LE(0x28))
  const shentsize = buf.readUInt16LE(0x3a)
  const shnum = buf.readUInt16LE(0x3c)
  const shstrndx = buf.readUInt16LE(0x3e)
  const sh = Array.from({ length: shnum }, (_, i) => {
    const o = shoff + i * shentsize
    return {
      name: buf.readUInt32LE(o),
      type: buf.readUInt32LE(o + 4),
      offset: Number(buf.readBigUInt64LE(o + 0x18)),
      size: Number(buf.readBigUInt64LE(o + 0x20)),
      link: buf.readUInt32LE(o + 0x28),
      info: buf.readUInt32LE(o + 0x2c),
      entsize: Number(buf.readBigUInt64LE(o + 0x38)),
    }
  })
  const str = (secIdx: number, off: number) => {
    const s = sh[secIdx]
    let end = s.offset + off
    while (buf[end] !== 0) end++
    return buf.toString('latin1', s.offset + off, end)
  }
  const names = sh.map((s) => str(shstrndx, s.name))
  const sections: Elf['sections'] = {}
  sh.forEach((s, i) => {
    if (s.type === 1 || s.type === 8) {
      sections[names[i]] = { size: s.size, bytes: s.type === 8 ? new Array(s.size).fill(0) : Array.from(buf.subarray(s.offset, s.offset + s.size)) }
    }
  })
  const symtabIdx = sh.findIndex((s) => s.type === 2)
  const symbols: ElfSymbol[] = []
  if (symtabIdx >= 0) {
    const st = sh[symtabIdx]
    for (let o = st.offset; o < st.offset + st.size; o += 24) {
      const info = buf[o + 4]
      const shndx = buf.readUInt16LE(o + 6)
      const type = info & 0xf
      symbols.push({
        name: type === 3 ? names[shndx] : str(st.link, buf.readUInt32LE(o)),
        value: Number(buf.readBigUInt64LE(o + 8)),
        section: shndx === 0 ? 'UND' : shndx === 0xfff1 ? 'ABS' : names[shndx] ?? '?',
        binding: info >> 4 === 0 ? 'local' : 'global',
        type,
      })
    }
  }
  const relocations: ElfReloc[] = []
  sh.forEach((s) => {
    if (s.type !== 4) return
    for (let o = s.offset; o < s.offset + s.size; o += 24) {
      const info = buf.readBigUInt64LE(o + 8)
      relocations.push({
        section: names[s.info],
        offset: Number(buf.readBigUInt64LE(o)),
        type: RELOC_NAMES[Number(info & 0xffffffffn)] ?? String(info & 0xffffffffn),
        symbol: symbols[Number(info >> 32n)],
        addend: buf.readBigInt64LE(o + 16),
      })
    }
  })
  return { sections, symbols, relocations }
}

/** Effective relocation target, independent of whether a section symbol or a named symbol is used. */
function effNasm(elf: Elf) {
  return elf.relocations
    .map((r) => {
      const s = r.symbol
      const tgt = s.section === 'UND' ? `${s.name}${fmt(r.addend)}` : `${s.section}${fmt(BigInt(s.value) + r.addend)}`
      return `${r.section} ${r.offset} ${r.type} ${tgt}`
    })
    .sort()
}

function effOurs(o: ObjectFile) {
  return o.relocations
    .map((r) => {
      const tgt = r.target.kind === 'extern' ? `${r.target.name}${fmt(r.addend)}` : `.${r.target.section}${fmt(r.addend)}`
      return `.${r.section} ${r.offset} ${r.type} ${tgt}`
    })
    .sort()
}

const fmt = (a: bigint) => (a < 0n ? `-${-a}` : `+${a}`)

/** Assemble with both and expect identical bytes, relocations (effective targets) and symbols. */
export function checkAgainstNasm(src: string) {
  const ours = assembleObject(src, 't.o')
  expect(ours.errors).toEqual([])
  const o = ours.object!
  const elf = nasmElf(src)
  expect(toHex(o.sections.text.bytes)).toBe(toHex(elf.sections['.text']?.bytes ?? []))
  expect(toHex(o.sections.data.bytes)).toBe(toHex(elf.sections['.data']?.bytes ?? []))
  expect(o.sections.bss.size).toBe(elf.sections['.bss']?.size ?? 0)
  expect(effOurs(o)).toEqual(effNasm(elf))
  const sym = (s: { name: string; value: number | bigint; section: string; binding: string }) =>
    `${s.name} ${s.section === 'UND' || s.section === 'ABS' ? s.section : s.section.replace(/^\./, '')} ${s.section === 'UND' ? 0 : s.value} ${s.binding}`
  const theirs = elf.symbols.filter((s) => s.type !== 3 && s.type !== 4 && s.name !== '').map(sym).sort()
  expect(o.symbols.map(sym).sort()).toEqual(theirs)
}

