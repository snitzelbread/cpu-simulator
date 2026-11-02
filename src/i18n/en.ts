/**
 * All user-visible text. To add a language, copy this file (e.g. de.ts), translate
 * it and register it in ./index.ts. `tsc` checks that every key is present.
 *
 * Inline code in sentences is written in `backticks`; the UI renders it monospaced.
 */
import type { ErrorCode } from '../core/errors'
import type { FaultCode, FlagName } from '../core/cpu/state'

type P = Record<string, string | number>
type Msg = (p: P) => string

const errors: Record<ErrorCode, Msg> = {
  syntax: () => 'Syntax error.',
  unexpectedToken: (p) => `Unexpected \`${p.token}\`.`,
  unterminatedString: () => 'String is missing its closing quote.',
  badNumber: (p) => `\`${p.text}\` is not a valid number.`,
  unknownInstruction: (p) =>
    `Unknown instruction \`${p.name}\`.` + (p.suggestion ? ` Did you mean \`${p.suggestion}\`?` : ''),
  unsupportedInstruction: (p) => `\`${p.name}\` is not supported by this simulator.`,
  unsupportedDirective: (p) => `The directive \`${p.name}\` is not supported by this simulator.`,
  ptrKeyword: () => 'NASM does not use `ptr`. Write e.g. `qword [rbx]` instead of `qword ptr [rbx]`.',
  operandCount: (p) => `Wrong number of operands: expected ${p.expected}, got ${p.got}.`,
  invalidOperands: (p) => `This operand combination is not valid for \`${p.name}\`.`,
  sizeUnknown: () => 'Operand size unknown. Add `byte`, `word`, `dword` or `qword`, e.g. `mov qword [rbx], 5`.',
  sizeMismatch: () => 'Operand sizes do not match.',
  immOutOfRange: (p) => `The value \`${p.value}\` does not fit into ${p.size} byte(s).`,
  imm64NotAllowed: (p) =>
    `\`${p.value}\` does not fit into a sign-extended 32-bit immediate. Only \`mov\` accepts 64-bit immediates: load the value into a register first.`,
  badAddress: () => 'Invalid address. Allowed: base + index·scale + displacement, with scale 1, 2, 4 or 8.',
  address32: (p) => `\`${p.name}\` cannot be used in an address here. Use 64-bit registers in addresses (e.g. \`[rbx]\`).`,
  addressTooLarge: (p) => `The address \`${p.value}\` does not fit into a 32-bit displacement.`,
  highByteWithRex: () =>
    '`AH`, `BH`, `CH`, `DH` cannot be combined with registers that need a REX prefix (`SIL`, `DIL`, `SPL`, `BPL`, `R8`–`R15`, or 64-bit operands).',
  undefinedSymbol: (p) => `Undefined symbol \`${p.name}\`.`,
  duplicateSymbol: (p) => `The label \`${p.name}\` is defined more than once.`,
  instrOutsideText: () => 'Instructions belong in `section .text`.',
  dataInText: () => 'Data definitions are not allowed here.',
  resInData: () => '`.bss` can only contain reserved (uninitialised) space such as `resb`/`resq`.',
  jumpOutOfRange: () => 'Jump target is too far away for this instruction (`loop` reaches only −128…127 bytes).',
  noInstructions: () => 'The program contains no instructions.',
  notConstant: (p) => `\`${p.name}\` must be a constant expression.`,
  segmentOverride: () => 'Segment overrides (e.g. `fs:`) are not supported.',
  noConvergence: () => 'Could not determine instruction sizes (the program layout did not settle).',
  badEqu: () => '`equ` needs a label in front of it, e.g. `len equ 5`.',
  divByZeroExpr: () => 'Division by zero in an expression.',
  movzx32: () => '`movzx` cannot read a 32-bit source. Use `mov r32, r/m32`, which zero-extends automatically.',
  pushSize: () => '`push`/`pop` only work with 64-bit operands in 64-bit mode.',
}

const faults: Record<FaultCode, Msg> = {
  divideError: () => '#DE (divide error): division by zero.',
  divideOverflow: (p) => `#DE (divide error): the quotient ${p.quotient} does not fit into the destination register.`,
  noInstruction: (p) => `RIP = ${p.address} does not point to an instruction (segmentation fault).`,
  endOfCode: () => 'The program ran past its last instruction without calling `exit`. A real process would crash here.',
  writeToCode: (p) => `Write to the code section at ${p.address}: .text is read-only (segmentation fault).`,
  unsupportedSyscall: (p) =>
    `System call ${p.number}${p.name !== '?' ? ` (${p.name})` : ''} is not supported by this simulator. Supported: 1 (write), 60 (exit), 231 (exit_group).`,
  writeTooLong: (p) => `write() with ${p.count} bytes: the simulator allows at most ${p.max} bytes per call.`,
  retEmptyStack: () =>
    '`ret` with an empty stack: there is no return address. Programs must end with the `exit` system call (RAX = 60).',
}

const flagInfo: Record<FlagName, { name: string; desc: string }> = {
  CF: { name: 'Carry Flag', desc: 'Carry out of (or borrow into) the most significant bit. Signals unsigned overflow.' },
  PF: { name: 'Parity Flag', desc: 'Set if the lowest byte of the result has an even number of 1 bits.' },
  ZF: { name: 'Zero Flag', desc: 'Set if the result is zero.' },
  SF: { name: 'Sign Flag', desc: 'Copy of the most significant bit of the result: 1 = negative (signed).' },
  OF: { name: 'Overflow Flag', desc: 'Signed overflow: the result does not fit into the signed range.' },
}

/** How each condition is evaluated, for jcc/setcc/cmovcc explanations. */
const conditions: Record<string, { meaning: string; formula: string }> = {
  o: { meaning: 'overflow', formula: 'OF = 1' },
  no: { meaning: 'no overflow', formula: 'OF = 0' },
  b: { meaning: 'below (unsigned <)', formula: 'CF = 1' },
  ae: { meaning: 'above or equal (unsigned ≥)', formula: 'CF = 0' },
  e: { meaning: 'equal / zero', formula: 'ZF = 1' },
  ne: { meaning: 'not equal / not zero', formula: 'ZF = 0' },
  be: { meaning: 'below or equal (unsigned ≤)', formula: 'CF = 1 or ZF = 1' },
  a: { meaning: 'above (unsigned >)', formula: 'CF = 0 and ZF = 0' },
  s: { meaning: 'sign (negative)', formula: 'SF = 1' },
  ns: { meaning: 'not sign (positive or zero)', formula: 'SF = 0' },
  p: { meaning: 'parity even', formula: 'PF = 1' },
  np: { meaning: 'parity odd', formula: 'PF = 0' },
  l: { meaning: 'less (signed <)', formula: 'SF ≠ OF' },
  ge: { meaning: 'greater or equal (signed ≥)', formula: 'SF = OF' },
  le: { meaning: 'less or equal (signed ≤)', formula: 'ZF = 1 or SF ≠ OF' },
  g: { meaning: 'greater (signed >)', formula: 'ZF = 0 and SF = OF' },
}

export const en = {
  appTitle: 'x86-64 CPU Visualizer',
  ui: {
    modeNav: 'Mode',
    controlsLabel: 'Execution controls',
    bytes: 'Bytes',
    bytesTitle: 'Show the machine-code bytes of each instruction (verified against nasm)',
    aluIdle: 'idle',
    discarded: 'discarded',
    irTitle: 'Instruction register: the instruction the CPU executes next',
    breakpoint: 'Breakpoint',
    binaryCalc: 'Binary calculation',
    carry: 'carry',
    borrow: 'borrow',
    access: (kind: 'read' | 'write', size: number, addr: string) => `${kind === 'read' ? 'Read' : 'Write'} of ${size} bytes at ${addr}`,
    crashTitle: 'Something went wrong in the user interface.',
    crashSaved: 'Your code is saved in this browser.',
    reload: 'Reload',
  },
  modes: { cpu: 'CPU', toolchain: 'C Toolchain' },
  toolchainSoon: 'Coming later: write C, see the generated assembly, and run it in the CPU view.',

  controls: {
    step: 'Step',
    stepBack: 'Step back',
    stepOver: 'Step over',
    run: 'Run',
    pause: 'Pause',
    reset: 'Reset',
    runToCursor: 'Run to cursor',
    speed: 'Speed',
    microStep: 'Micro-steps',
    animations: 'Animations',
    theme: 'Theme',
    themeDark: 'Dark',
    themeLight: 'Light',
    format: 'Number format',
    examples: 'Examples',
    chooseExample: 'Load example…',
    edit: 'Edit',
    assemble: 'Assemble',
    stepsPerSecond: (n: number) => (n >= 1000 ? 'max' : `${n}/s`),
  },
  shortcutHint: (label: string, key: string) => `${label} (${key})`,

  formats: { hex: 'Hex', udec: 'Unsigned', sdec: 'Signed', bin: 'Binary' },

  panels: {
    code: 'Code',
    cpu: 'CPU',
    registers: 'Registers',
    flags: 'Flags',
    stack: 'Stack',
    memory: 'Memory',
    explanation: 'What just happened',
    console: 'Console',
    alu: 'ALU',
    bus: 'Bus',
  },

  status: {
    ready: 'Ready',
    running: 'Running',
    paused: 'Paused',
    halted: 'Halted (hlt)',
    exited: (code: number) => `Exited with code ${code}`,
    faulted: 'Fault',
    editing: 'Editing',
    errors: (n: number) => (n === 1 ? '1 error' : `${n} errors`),
    step: (n: number) => `Step ${n}`,
  },

  editor: {
    breakpointHint: 'Breakpoint: click gutter or F9',
    lineError: (line: number, msg: string) => `Line ${line}: ${msg}`,
    lockedHint: 'The program is running. Press Reset or Edit to change the code.',
  },

  registers: {
    previous: (v: string) => `Previous value: ${v}`,
    expand: (name: string) => `Show bit layout of ${name}`,
    zeroExtended: 'Upper 32 bits cleared by the 32-bit write',
    bits: 'Bits',
    rip: 'Instruction pointer: address of the next instruction',
    rflags: 'Flags register',
  },

  flags: flagInfo,
  flagUndefined: 'undefined (Intel SDM). The simulator keeps the old value.',
  flagUnchanged: 'unchanged',

  stack: {
    returnAddress: (sym: string) => `Return address → ${sym}`,
    pushedBy: (text: string) => `from \`${text}\``,
    empty: 'Stack is empty (RSP is at the top).',
    top: 'Stack top',
    growsDown: 'grows downward ↓',
  },

  memory: {
    address: 'Address',
    ascii: 'ASCII',
    goto: 'Go to address',
    sections: { text: '.text', data: '.data', bss: '.bss', stack: 'Stack' },
    noData: 'This program has no .data or .bss section.',
    littleEndian: 'Little-endian: the least significant byte is stored at the lowest address.',
    lastAccess: 'Last access',
  },

  console: {
    empty: 'Output of the write system call appears here.',
    exit: (code: number) => `Process exited with code ${code}.`,
    stderr: 'stderr',
  },

  micro: {
    fetch: 'Fetch',
    decode: 'Decode',
    execute: 'Execute',
    writeback: 'Write-back',
    fetchText: (addr: string, len: number, bytes: string) =>
      `Fetch: the CPU reads ${len} byte(s) at RIP = ${addr} over the bus: ${bytes}.`,
    decodeText: (text: string, next: string, len: number) =>
      `Decode: the bytes are \`${text}\`. RIP is advanced by ${len} to ${next} now, before execution, so relative jumps count from the next instruction.`,
    executeText: 'Execute: the ALU computes the result.',
    writebackText: 'Write-back: results are stored in registers / memory and flags are updated.',
  },

  errorsTitle: 'The program could not be assembled',
  errors,
  faults,
  faultTitle: 'Execution stopped',
  codeChanged: 'The code was changed, so the program was assembled again and reset.',
  stepLimit: (n: number) =>
    `The program ran ${n.toLocaleString('en')} steps without ending. It might be stuck in an infinite loop. Press Run to continue.`,
  conditions,

  explain: {
    fixErrors: 'The program could not be assembled. Fix the lines marked with ! in the code panel; every message names the problem.',
    initial: 'Press Step (F10) to execute the first instruction. The highlighted line is what the CPU will run next.',
    ended: 'The program has ended. Step back (Shift+F10) to go back, or Reset to start over.',
    zeroExtend: (r64: string) => `32-bit write → the upper 32 bits of ${r64} are set to 0.`,
    partialWrite: (bitsN: number, r64: string, rest: number) =>
      `${bitsN}-bit write → the other ${rest} bits of ${r64} stay unchanged.`,
    memRead: (size: number, addr: string) => `Reads ${size} byte(s) from memory at ${addr} (little-endian).`,
    memWrite: (size: number, addr: string) => `Writes ${size} byte(s) to memory at ${addr} (little-endian).`,
    assign: (dst: string, value: string) => `${dst} ← ${value}.`,
    mov: (ins: string, dst: string, value: string) => `\`${ins}\` copies the value ${value} into ${dst}.`,
    movzx: (ins: string, dst: string, value: string) => `\`${ins}\` copies ${value} into ${dst} and fills the upper bits with 0 (zero-extension).`,
    movsx: (ins: string, dst: string, value: string, sign: string) =>
      `\`${ins}\` copies ${value} into ${dst} and fills the upper bits with the sign bit ${sign} (sign-extension).`,
    lea: (ins: string, expr: string, value: string, dst: string) =>
      `\`${ins}\` computes the address ${expr} = ${value} without accessing memory. ${dst} ← ${value}.`,
    xchg: (ins: string, a: string, b: string) => `\`${ins}\` swaps the values of ${a} and ${b}.`,
    push: (ins: string, value: string, rsp: string, addr: string) =>
      `\`${ins}\`: RSP ← RSP − 8 = ${rsp}, then ${value} is stored at [${addr}].`,
    pop: (ins: string, value: string, dst: string, rsp: string) =>
      `\`${ins}\` reads ${value} from the top of the stack into ${dst}, then RSP ← RSP + 8 = ${rsp}.`,
    arith: (ins: string, expr: string, calc: string) => `\`${ins}\` computes ${expr} = ${calc}.`,
    discard: 'The result is discarded; only the flags are updated.',
    store: (dst: string) => `The result is stored in ${dst}.`,
    incdecCF: '`inc`/`dec` do not change CF.',
    neg: (ins: string, calc: string) => `\`${ins}\` computes the two's complement: ${calc}.`,
    not: (ins: string, calc: string) => `\`${ins}\` inverts every bit: ${calc}. No flags are changed.`,
    shift: (ins: string, dir: string, n: number, kind: string) => `\`${ins}\` shifts ${n} bit(s) to the ${dir}${kind}.`,
    shiftLeft: 'left',
    shiftRight: 'right',
    shiftLogical: ', filling with 0 (logical)',
    shiftArith: ', copying the sign bit (arithmetic)',
    shiftZero: 'The shift count is 0: nothing changes and no flags are affected.',
    shiftMasked: (raw: number, n: number) => `The count ${raw} is masked to ${n} (only the low 5 or 6 bits are used).`,
    rotate: (ins: string, dir: string, n: number) => `\`${ins}\` rotates by ${n} bit(s) to the ${dir}; bits leaving one end come back in at the other.`,
    mul: (ins: string, dst: string, calc: string) => `\`${ins}\`: ${dst} ← ${calc}.`,
    mulHalves: (hi: string, lo: string) => `${hi} receives the upper half, ${lo} the lower half of the product.`,
    imul: (ins: string, dst: string, calc: string) => `\`${ins}\`: ${dst} ← ${calc} (signed; only the low half is kept).`,
    remainder: 'R',
    div: (ins: string, dividend: string, calc: string, q: string, r: string) =>
      `\`${ins}\` divides ${dividend}: ${calc}. Quotient → ${q}, remainder → ${r}.`,
    jmp: (ins: string, target: string) => `\`${ins}\`: unconditional jump. RIP ← ${target}.`,
    jcc: (ins: string, cc: string, formula: string, values: string, taken: boolean, target: string) =>
      `\`${ins}\`: condition ${cc.toUpperCase()} means ${formula} → ${values} → ` +
      (taken ? `jump is taken. RIP ← ${target}.` : `jump is not taken; execution continues with the next instruction.`),
    loop: (ins: string, rcx: string, taken: boolean, target: string) =>
      `\`${ins}\`: RCX ← RCX − 1 = ${rcx}. ` + (taken ? `RCX ≠ 0 → jump to ${target}.` : 'RCX = 0 → loop ends, continue with the next instruction.'),
    setcc: (ins: string, cc: string, formula: string, values: string, v: boolean, dst: string) =>
      `\`${ins}\`: condition ${cc.toUpperCase()} means ${formula} → ${values} → ${dst} ← ${v ? 1 : 0}.`,
    cmov: (ins: string, cc: string, formula: string, values: string, v: boolean, dst: string, value: string) =>
      `\`${ins}\`: condition ${cc.toUpperCase()} means ${formula} → ${values} → ` + (v ? `${dst} ← ${value}.` : `${dst} is not changed.`),
    cmovZeroExtend: (r64: string) => `Caution: a 32-bit \`cmov\` clears the upper 32 bits of ${r64} even when the condition is false.`,
    call: (ins: string, ret: string, retSym: string, rsp: string, target: string) =>
      `\`${ins}\` pushes the return address ${ret}${retSym} (RSP ← ${rsp}) and jumps to ${target}.`,
    ret: (ins: string, target: string, sym: string, rsp: string) =>
      `\`${ins}\` pops the return address ${target}${sym} from the stack (RSP ← ${rsp}) and jumps there.`,
    retImm: (n: string) => `Then RSP is increased by ${n} to remove the arguments.`,
    nop: (ins: string) => `\`${ins}\` does nothing; only RIP moves on.`,
    hlt: (ins: string) => `\`${ins}\` stops the processor. (In a real user program \`hlt\` is privileged and would cause a fault; the simulator simply stops.)`,
    syscallWrite: (n: number, addr: string, fd: number, text: string) =>
      `\`syscall\` 1 (write): writes ${n} byte(s) from ${addr} to file descriptor ${fd}${fd === 1 ? ' (stdout)' : fd === 2 ? ' (stderr)' : ''}: ${text}. Return value in RAX = ${n}.`,
    syscallWriteBadFd: (fd: number) => `\`syscall\` 1 (write) to file descriptor ${fd}: not open, so RAX = −9 (EBADF).`,
    syscallExit: (code: number) => `\`syscall\` 60 (exit): the program terminates with exit code ${code}.`,
    syscallClobber: '`syscall` itself overwrites RCX (return address) and R11 (saved RFLAGS).',
    fault: (ins: string) => `\`${ins}\` could not be executed.`,
    flagsHeading: 'Flags',
    flagReason: {
      ZF: (v: boolean) => (v ? 'result is zero' : 'result is not zero'),
      SF: (v: boolean) => (v ? 'MSB is 1 → negative' : 'MSB is 0 → not negative'),
      PF: (v: boolean, ones: number) => `low byte has ${ones} one-bit(s) → ${v ? 'even' : 'odd'}`,
      CFadd: (v: boolean) => (v ? 'carry out of the MSB → unsigned overflow' : 'no carry out of the MSB'),
      CFsub: (v: boolean, a: string, b: string) => (v ? `unsigned: ${a} < ${b} → borrow` : `unsigned: ${a} ≥ ${b} → no borrow`),
      CFlogic: 'always cleared by and/or/xor/test',
      CFshift: (v: boolean) => `last bit shifted out was ${v ? 1 : 0}`,
      CFneg: (v: boolean) => (v ? 'operand is not 0' : 'operand is 0'),
      CFmul: (v: boolean) => (v ? 'upper half is needed' : 'result fits into the lower half'),
      OFadd: (v: boolean) => (v ? 'both operands have the same sign but the result has the other → signed overflow' : 'no signed overflow'),
      OFsub: (v: boolean) => (v ? 'operands have different signs and the result has the wrong sign → signed overflow' : 'no signed overflow'),
      OFlogic: 'always cleared by and/or/xor/test',
      OFshift: (v: boolean) => (v ? 'sign bit changed' : 'sign bit unchanged'),
      OFneg: (v: boolean) => (v ? 'the most negative value has no positive counterpart' : 'no signed overflow'),
      OFmul: (v: boolean) => (v ? 'the signed result does not fit' : 'the signed result fits'),
    },
  },
}

export type Strings = typeof en
