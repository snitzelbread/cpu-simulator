/**
 * A simple static linker: lays out the sections of all object files one after another,
 * resolves every undefined (*UND*) symbol to its definition in another object file and
 * patches the relocations. The result is a program image the CPU simulator can run,
 * plus a flat assembly listing of the whole program at its final addresses.
 */
import type { DataItemInfo, Program, SectionName, SourceMap, SymbolInfo } from '../core/assembler'
import { alignUp, bssBase, dataBase, STACK_TOP, TEXT_BASE } from '../core/layout'
import type { ObjectFile, Relocation } from '../core/object'
import type { Instruction, Operand, SymTerm } from '../core/types'
import type { Diagnostic } from './diagnostics'

const SECTIONS: SectionName[] = ['text', 'data', 'bss']
const DATA_ALIGN = 8

export interface Placement {
  obj: number
  section: SectionName
  start: number
  size: number
}

export interface GlobalSymbol {
  name: string
  address: number
  obj: number
  section: SectionName | 'ABS'
}

export interface Resolution {
  obj: number
  name: string
  /** Object file that defines the symbol (-1: undefined). */
  definedIn: number
  address?: number
}

export interface Patch {
  obj: number
  reloc: Relocation
  /** Final address of the patched field. */
  address: number
  /** Value computed from S + A (- P). */
  value: bigint
  bytes: number[]
}

export type LinkStep =
  | { kind: 'layout'; placement: Placement }
  | { kind: 'symbol'; symbol: GlobalSymbol }
  | { kind: 'resolve'; resolution: Resolution }
  | { kind: 'patch'; patch: Patch }
  | { kind: 'entry'; address: number }

export interface LinkResult {
  program: Program | null
  placements: Placement[]
  globals: GlobalSymbol[]
  resolutions: Resolution[]
  patches: Patch[]
  steps: LinkStep[]
  /** The whole program as one assembly listing at its final addresses. */
  listing: string
  /** For each listing line (index = line - 1): the object file and its source line, if any. */
  listingOrigin: ({ obj: number; line: number } | null)[]
  /** Local symbols renamed because two object files use the same name (old → new, per object). */
  renames: Map<string, string>[]
  errors: Diagnostic[]
}

export function link(objects: ObjectFile[]): LinkResult {
  const errors: Diagnostic[] = []
  const steps: LinkStep[] = []

  // 1. layout: all .text sections, then all .data, then all .bss
  const base: Record<SectionName, number>[] = objects.map(() => ({ text: 0, data: 0, bss: 0 }))
  const pad: Record<SectionName, number>[] = objects.map(() => ({ text: 0, data: 0, bss: 0 }))
  const placements: Placement[] = []
  const totals: Record<SectionName, number> = { text: 0, data: 0, bss: 0 }
  const starts: Record<SectionName, number> = { text: TEXT_BASE, data: 0, bss: 0 }
  for (const sec of SECTIONS) {
    if (sec === 'data') starts.data = dataBase(totals.text)
    if (sec === 'bss') starts.bss = bssBase(starts.data, totals.data)
    let off = 0
    objects.forEach((o, i) => {
      const size = o.sections[sec].size
      if (sec !== 'text' && size > 0) {
        const aligned = alignUp(off, DATA_ALIGN)
        pad[i][sec] = aligned - off
        off = aligned
      }
      base[i][sec] = starts[sec] + off
      if (size > 0) {
        const p = { obj: i, section: sec, start: starts[sec] + off, size }
        placements.push(p)
        steps.push({ kind: 'layout', placement: p })
      }
      off += size
    })
    totals[sec] = off
  }

  // 2. global symbols
  const globals: GlobalSymbol[] = []
  const defs = new Map<string, GlobalSymbol>()
  objects.forEach((o, i) => {
    for (const s of o.symbols) {
      if (s.binding !== 'global' || s.section === 'UND') continue
      const address = s.section === 'ABS' ? Number(s.value) : base[i][s.section] + Number(s.value)
      const g: GlobalSymbol = { name: s.name, address, obj: i, section: s.section }
      const prev = defs.get(s.name)
      if (prev) {
        errors.push({ stage: 'ld', code: 'duplicateSymbol', file: o.name, params: { name: s.name, first: objects[prev.obj].name, second: o.name } })
        continue
      }
      defs.set(s.name, g)
      globals.push(g)
      steps.push({ kind: 'symbol', symbol: g })
    }
  })

  // 3. resolve undefined symbols (only those that are actually used need a definition)
  const resolutions: Resolution[] = []
  objects.forEach((o, i) => {
    const used = new Set(o.relocations.filter((r) => r.target.kind === 'extern').map((r) => (r.target as { name: string }).name))
    for (const s of o.symbols) {
      if (s.section !== 'UND') continue
      const d = defs.get(s.name)
      const r: Resolution = { obj: i, name: s.name, definedIn: d ? d.obj : -1, address: d?.address }
      resolutions.push(r)
      steps.push({ kind: 'resolve', resolution: r })
      if (!d && used.has(s.name)) {
        const reloc = o.relocations.find((x) => x.target.kind === 'extern' && x.target.name === s.name)!
        errors.push({
          stage: 'ld', code: 'undefinedReference', file: o.name,
          params: { name: s.name, obj: o.name, func: containingLabel(o, reloc) ?? '?' },
        })
      }
    }
  })
  const entry = defs.get('_start')
  if (!entry) errors.push({ stage: 'ld', code: 'noEntry', params: { name: '_start' } })

  // 4. patch relocations
  const image: Record<SectionName, Uint8Array> = {
    text: new Uint8Array(totals.text),
    data: new Uint8Array(totals.data),
    bss: new Uint8Array(totals.bss),
  }
  objects.forEach((o, i) => {
    for (const sec of ['text', 'data'] as const) image[sec].set(o.sections[sec].bytes, base[i][sec] - starts[sec])
  })
  const termBase = (i: number, t: SymTerm): number | undefined => (t.kind === 'section' ? base[i][t.section] : defs.get(t.name)?.address)
  const patches: Patch[] = []
  objects.forEach((o, i) => {
    for (const r of o.relocations) {
      const S = termBase(i, r.target)
      if (S === undefined) continue
      const P = base[i][r.section] + r.offset
      const value = BigInt(S) + r.addend - (r.pcRel ? BigInt(P) : 0n)
      const ok =
        r.type === 'R_X86_64_PC32' || r.type === 'R_X86_64_32S' ? value >= -(1n << 31n) && value < 1n << 31n
        : r.type === 'R_X86_64_32' ? value >= 0n && value < 1n << 32n
        : r.type === 'R_X86_64_16' ? value >= -(1n << 15n) && value < 1n << 16n
        : r.type === 'R_X86_64_8' ? value >= -128n && value < 256n
        : true
      if (!ok) errors.push({ stage: 'ld', code: 'relocOverflow', file: o.name, line: r.line, params: { type: r.type } })
      const bytes: number[] = []
      let v = BigInt.asUintN(64, value)
      for (let k = 0; k < r.size; k++) {
        bytes.push(Number(v & 0xffn))
        v >>= 8n
      }
      image[r.section].set(bytes, P - starts[r.section])
      const p: Patch = { obj: i, reloc: r, address: P, value, bytes }
      patches.push(p)
      steps.push({ kind: 'patch', patch: p })
    }
  })
  if (entry) steps.push({ kind: 'entry', address: entry.address })

  // 5. listing (with local symbols renamed where two objects use the same name)
  const renames = localRenames(objects)
  const { listing, origin, lineOf } = buildListing(objects, pad, renames)

  if (errors.length) return { program: null, placements, globals, resolutions, patches, steps, listing, listingOrigin: origin, renames, errors }

  // 6. relocated instructions for the emulator
  const instructions: Instruction[] = []
  objects.forEach((o, i) => {
    const rn = (s: string) => renameText(s, renames[i])
    for (const ins of o.instructions) {
      const address = base[i].text + ins.address
      const operands = ins.operands.map((op): Operand => {
        if (op.k === 'reg') return op
        const b = op.term ? termBase(i, op.term)! : 0
        if (op.k === 'imm') {
          const { term: _t, ...rest } = op
          void _t
          return { ...rest, value: op.value + BigInt(b), text: rn(op.text) }
        }
        const { term: _t, ...rest } = op
        void _t
        return { ...rest, disp: op.disp + BigInt(b), text: rn(op.text) }
      })
      const isBranch = ['jmp', 'jcc', 'call', 'loop'].includes(ins.op)
      instructions.push({
        ...ins,
        id: instructions.length,
        operands,
        text: rn(ins.text),
        address,
        bytes: Array.from(image.text.subarray(address - TEXT_BASE, address - TEXT_BASE + ins.length)),
        line: lineOf(i, ins.line),
        target: isBranch && operands[0]?.k === 'imm' ? Number(operands[0].value) : undefined,
      })
    }
  })

  const symbols: SymbolInfo[] = []
  objects.forEach((o, i) => {
    for (const s of o.symbols) {
      if (s.section === 'UND') continue
      const name = renames[i].get(s.name) ?? renameQualified(s.name, renames[i])
      if (s.section === 'ABS') symbols.push({ name, value: s.value, kind: 'equ', line: lineOf(i, s.line) })
      else symbols.push({ name, value: BigInt(base[i][s.section] + Number(s.value)), kind: 'label', section: s.section, line: lineOf(i, s.line) })
    }
  })
  const dataItems: DataItemInfo[] = []
  objects.forEach((o, i) => {
    for (const d of o.dataItems) {
      const loc = o.lineToOffset.get(d.line)
      const sec = loc?.section ?? 'data'
      dataItems.push({ ...d, line: lineOf(i, d.line), address: base[i][sec] + d.address })
    }
  })
  const sourceMap: SourceMap = { lineToAddress: new Map(), addressToLine: new Map(), lineToInstr: new Map() }
  objects.forEach((o, i) => {
    for (const [line, { section, offset }] of o.lineToOffset) sourceMap.lineToAddress.set(lineOf(i, line), base[i][section] + offset)
  })
  for (const ins of instructions) {
    sourceMap.addressToLine.set(ins.address, ins.line)
    sourceMap.lineToInstr.set(ins.line, ins.id)
  }
  const program: Program = {
    instructions,
    byAddress: new Map(instructions.map((x) => [x.address, x])),
    sections: {
      text: { name: 'text', start: starts.text, size: totals.text, bytes: image.text },
      data: { name: 'data', start: starts.data, size: totals.data, bytes: image.data },
      bss: { name: 'bss', start: starts.bss, size: totals.bss, bytes: image.bss },
    },
    entry: entry!.address,
    stackTop: STACK_TOP,
    symbols,
    dataItems,
    sourceMap,
  }
  return { program, placements, globals, resolutions, patches, steps, listing, listingOrigin: origin, renames, errors }
}

/** The function (label) a relocation lies in, for "in function main: undefined reference". */
function containingLabel(o: ObjectFile, r: Relocation): string | undefined {
  let best: { name: string; value: bigint } | undefined
  for (const s of o.symbols) {
    if (s.section !== r.section || s.name.includes('.')) continue
    if (s.value <= BigInt(r.offset) && (!best || s.value >= best.value)) best = s
  }
  return best?.name
}

/** Top-level local labels that clash with a label of another object file get a suffix. */
function localRenames(objects: ObjectFile[]): Map<string, string>[] {
  const owners = new Map<string, number[]>()
  objects.forEach((o, i) => {
    for (const s of o.symbols) {
      if (s.section === 'UND' || s.name.includes('.')) continue
      const list = owners.get(s.name) ?? []
      if (!list.includes(i)) list.push(i)
      owners.set(s.name, list)
    }
  })
  return objects.map((o) => {
    const m = new Map<string, string>()
    for (const s of o.symbols) {
      if (s.section === 'UND' || s.binding === 'global' || s.name.includes('.')) continue
      if ((owners.get(s.name)?.length ?? 0) > 1) m.set(s.name, `${s.name}@${o.name.replace(/\.o$/, '').replace(/[^A-Za-z0-9_]/g, '_')}`)
    }
    return m
  })
}

function renameQualified(name: string, m: Map<string, string>): string {
  const dot = name.indexOf('.')
  if (dot <= 0) return name
  const parent = m.get(name.slice(0, dot))
  return parent ? parent + name.slice(dot) : name
}

const IDENT = /[A-Za-z_.?@][A-Za-z0-9_.?@$#~]*/g

/** Rename identifiers in the code part of a line (not in strings or comments). */
export function renameText(line: string, m: Map<string, string>): string {
  if (!m.size) return line
  let out = ''
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === ';') return out + line.slice(i)
    if (c === '"' || c === "'" || c === '`') {
      const end = line.indexOf(c, i + 1)
      const j = end < 0 ? line.length : end + 1
      out += line.slice(i, j)
      i = j
      continue
    }
    IDENT.lastIndex = i
    const mm = IDENT.exec(line)
    if (mm && mm.index === i) {
      const w = mm[0]
      out += m.get(w) ?? renameQualified(w, m)
      i += w.length
      continue
    }
    out += c
    i++
  }
  return out
}

/** Concatenate the object sources into one listing at the linked addresses. */
function buildListing(objects: ObjectFile[], pad: Record<SectionName, number>[], renames: Map<string, string>[]) {
  const lines: string[] = []
  const origin: ({ obj: number; line: number } | null)[] = []
  const starts: number[] = []
  const add = (text: string, o: { obj: number; line: number } | null) => {
    lines.push(text)
    origin.push(o)
  }
  add('; Linked program: every object file at its final address (generated by the linker)', null)
  objects.forEach((o, i) => {
    add('', null)
    add(`; ======== ${o.name} ========`, null)
    if (pad[i].data) {
      add('section .data', null)
      add(`    times ${pad[i].data} db 0     ; alignment padding`, null)
    }
    if (pad[i].bss) {
      add('section .bss', null)
      add(`    resb ${pad[i].bss}            ; alignment padding`, null)
    }
    add('section .text', null)
    starts.push(lines.length)
    o.source.replace(/\n$/, '').split('\n').forEach((l, k) => {
      const t = l.replace(/;.*/, '').trim().toLowerCase()
      // global/extern are only meaningful for the linker; in the linked program every symbol is known
      const text = /^(global|extern)\b/.test(t) ? `; ${l.trim()}   (resolved by the linker)` : renameText(l, renames[i])
      add(text, { obj: i, line: k + 1 })
    })
  })
  const lineOf = (obj: number, line: number) => starts[obj] + line
  return { listing: lines.join('\n') + '\n', origin, lineOf }
}
