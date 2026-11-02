/** C identifiers that are reserved words in NASM (registers, size keywords, directives, mnemonics). */
import { decodeMnemonic, KNOWN_UNSUPPORTED } from '../../core/isa'
import { lookupRegister } from '../../core/registers'

const NASM_WORDS = new Set([
  'byte', 'word', 'dword', 'qword', 'tword', 'oword', 'yword', 'zword', 'ptr', 'rel', 'abs', 'section', 'segment',
  'global', 'extern', 'common', 'default', 'bits', 'times', 'equ', 'db', 'dw', 'dd', 'dq', 'dt', 'resb', 'resw',
  'resd', 'resq', 'rest', 'short', 'near', 'far', 'strict', 'wrt', 'seg', 'org', 'align', 'alignb', 'incbin',
  'static', 'struc', 'endstruc', 'istruc', 'at', 'iend', 'absolute', 'cpu', 'use16', 'use32', 'use64', 'nosplit', 'to',
])

/**
 * The assembler name of a C identifier. Names that NASM would read as a register or keyword
 * are written as `$name` (NASM's escape); the symbol itself is still called `name`.
 */
export function asmName(name: string): string {
  const l = name.toLowerCase()
  if (lookupRegister(name) || NASM_WORDS.has(l) || decodeMnemonic(l) || KNOWN_UNSUPPORTED.has(l)) return '$' + name
  return name
}
