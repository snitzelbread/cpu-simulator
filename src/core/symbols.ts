import type { Program } from './assembler'

/**
 * Turn an address into "label+0xOFF" using the nearest preceding label.
 * Non-local labels are preferred, so a return address reads "main+0x12".
 */
export function symbolize(program: Program, addr: number, preferGlobal = true): string | undefined {
  let best: { name: string; value: number } | undefined
  for (const s of program.symbols) {
    if (s.kind !== 'label') continue
    if (preferGlobal && s.name.includes('.')) continue
    const v = Number(s.value)
    if (v <= addr && (!best || v > best.value || (v === best.value && s.name.length < best.name.length))) best = { name: s.name, value: v }
  }
  if (!best) return preferGlobal ? symbolize(program, addr, false) : undefined
  const sec = Object.values(program.sections).find((x) => best!.value >= x.start && best!.value <= x.start + x.size)
  if (sec && addr >= sec.start + Math.max(sec.size, 1)) return undefined
  const off = addr - best.value
  return off === 0 ? best.name : `${best.name}+0x${off.toString(16).toUpperCase()}`
}

/** Label defined exactly at an address (for jump targets and memory view). */
export function labelsAt(program: Program, addr: number): string[] {
  return program.symbols.filter((s) => s.kind === 'label' && Number(s.value) === addr).map((s) => s.name)
}
