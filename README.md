# x86-64 CPU Visualizer

An interactive learning aid for **Betriebssysteme 1** (OST). Paste NASM assembly (Intel
syntax, destination first), then step through it and watch exactly what the CPU does:
registers and sub-registers, flags, stack, memory and the instruction pointer.
Every step is explained in a plain-language sentence.

Runs entirely in the browser. There is no backend.

```bash
npm install
npm run dev        # open the printed URL (a 1920×1080 screen shows everything without scrolling)
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm test` | All unit tests (Vitest) |
| `npm run build` | Type-check + production build into `dist/` |
| `npm run lint` | oxlint |

## Using it

- Pick a program from **Load example…** or type your own. The code is assembled as you type.
  Errors are marked on the line with a message such as "`cpuid` is not supported by this simulator".
- **Step** `F10`, **Step back** `Shift+F10`, **Step over** `F8` (a `call` counts as one step),
  **Run / Pause** `F5`, **Run to cursor** `Ctrl+F10`, **Reset** `Shift+F5`,
  **Micro-steps** `Ctrl+Shift+M`.
- Click the editor gutter or press `F9` (on the cursor line) to toggle **breakpoints**. Run stops there.
- **Micro-steps** split each instruction into Fetch → Decode → Execute → Write-back. RIP is
  advanced in Decode, *before* the instruction executes, which is why relative jumps count
  from the next instruction.
- Click a register to see its bit layout (RAX / EAX / AX / AH / AL). Hover over a changed
  register to see its previous value; hover over a flag to read what it means.
- **Bytes** shows the machine code of each instruction next to the source.
- Header: number format (hex / unsigned / signed / binary), animations on/off, dark/light theme.

## What is emulated

- NASM syntax: labels (including `.local` labels), `;` comments, `BITS 64`, `global`, `default rel`,
  `section .text/.data/.bss`, `db/dw/dd/dq` (with strings), `resb/resw/resd/resq`, `times`,
  `equ`, `$`, `$$`, `byte/word/dword/qword`, numbers in decimal, hex (`0x1F`, `1Fh`), binary
  (`0b101`, `101b`) and octal, plus character literals.
- All 16 general-purpose registers with every sub-register view, using real x86-64 write
  semantics: a 32-bit write zero-extends, 8/16-bit writes merge.
- CF, PF, ZF, SF, OF, set exactly as the Intel SDM specifies. Flags the SDM calls *undefined*
  (for example SF/ZF/PF after `mul`, everything after `div`) keep their old value and are marked "undefined".
- Addressing: `[disp]`, `[base]`, `[index*scale]` and any sum of these. Memory is little-endian.
- Instructions: `mov movzx movsx movsxd lea xchg push pop add sub inc dec neg adc sbb mul imul
  div idiv and or xor not shl sal shr sar rol ror cmp test jmp jcc setcc cmovcc call ret loop
  nop hlt syscall`. `div`/`idiv` raise #DE on division by zero or quotient overflow.
- `syscall` with Linux semantics: `write` (1) to the console panel, `exit` (60) and `exit_group` (231).
  Like the real instruction, it overwrites RCX and R11.
- Process image: `.text` at `0x401000`, `.data` on the next page, `.bss` right after it, and the stack
  growing down from `0x7FFFF000`.
- Guard rails: Run stops after 100,000 steps with a message (possible infinite loop). Writing
  into `.text`, jumping to a non-instruction, running past the end, or `ret` on an empty stack
  all stop with an explanation.

Not included: pipelining, caches, privilege rings, interrupts, floating point, SIMD, AT&T syntax.

## Architecture

```
src/
  core/              pure TypeScript, no UI dependencies (unit-tested in isolation)
    lexer, expr, parser   NASM source → statements
    encoder.ts            instructions → machine code (own module)
    assembler.ts          assemble(source) → { program, symbols, sourceMap, errors }
    cpu/machine.ts        the emulator; every step yields a StepTrace (also used for undo)
    symbols.ts            address → "main+0x12"
  explain/           StepTrace → plain-language explanation (via i18n)
  i18n/en.ts         every user-visible string (add de.ts etc. here)
  examples/          the 8 built-in example programs
  app/               app shell, mode switch (CPU | C Toolchain), shared settings
  features/cpu/      the CPU view (editor, CPU diagram, stack, memory, explanation, console)
  features/toolchain placeholder for the planned C → assembly mode
```

- **Assembler API.** `assemble(source)` is a pure function. Each `Instruction` carries its source
  `line`, `address`, `length` and `bytes`. The `sourceMap` maps line ↔ address in both directions,
  so a future C → ASM mapping can be chained in front of it.
- **Encoder.** The encoder covers the whole supported subset, because real instruction lengths are
  needed for meaningful RIP and jump-target values. Where several encodings are legal, it picks
  what NASM emits (for example `mov rax, 1` → `mov eax, 1`, and short jumps when they reach).
- **Emulator.** The machine is mutable and lives outside React. Each step records every change
  (registers, memory bytes, flags, RIP, console), which drives both the visualisation and
  unlimited Step back.

## Tests

`npm test` runs about 390 tests:

- flag edge cases (`0x7F+1`, `0−1`, `MIN/−1` in `idiv`, shift by 0, rotate, `neg`), sub-register
  writes, little-endian memory, every addressing mode, `call`/`ret`, faults, undo
- every condition code checked against an independent formula for all 32 flag combinations
- every example program: a test asserting its final register/memory state
- explanation sentences
- **byte-for-byte comparison with real `nasm -f bin`** for about 200 instruction forms, several
  whole programs and all 8 examples. These tests are skipped automatically when `nasm` is not
  installed; fixed reference vectors still check the encoder in that case. Only `-f bin` is used,
  so the comparison doesn't depend on the host OS's object format (macOS Mach-O quirks don't matter).

## Adding a language

Copy `src/i18n/en.ts` to e.g. `de.ts`, translate it, and register it in `src/i18n/index.ts`.
TypeScript reports any key you forgot.
