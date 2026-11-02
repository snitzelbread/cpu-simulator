# x86-64 CPU Visualizer

An interactive learning aid for **Betriebssysteme 1** (OST). Two modes:

- **CPU**: paste NASM assembly (Intel syntax, destination first), then step through it and watch
  exactly what the CPU does: registers and sub-registers, flags, stack, memory and the instruction
  pointer. Every step is explained in a plain-language sentence.
- **C Toolchain**: write a small multi-file C project and follow it through
  **preprocessor → compiler → assembler → linker**, step by step, then run the result in the CPU view.

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

## C Toolchain mode

Everything runs in the browser with a small, educational toolchain written in TypeScript (not clang).
Its output is deliberately simple and predictable; real compilers (`clang -masm=intel -S prog.c`)
produce different, optimised code.

- **Project**: file tabs for `.c` and `.h` files (add, rename, delete; saved in the browser), plus the
  read-only system headers `<stdio.h>` (`puts`, `putchar`, `print_int`; `printf` is only declared),
  `<stdlib.h>` (`exit`) and `<unistd.h>` (`write`). Each `.c` file is its own translation unit.
- **Pipeline bar**: `.c` → translation unit → `.s` → `.o` → executable. Click a stage to open it.
  A stage with errors stops the pipeline visibly; **Run in CPU simulator** loads the linked program.
- **Step controls** work like in the CPU view: `F10` step, `Shift+F10` back, `F5` play/pause,
  `Shift+F5` back to the start. Without stepping you always see the finished result.
- **Preprocessor**, three passes as in the lecture:
  1. comments removed and `\` lines joined (line numbers stay stable),
  2. tokens as coloured chips (greedy: `a+++++b` → `a ++ ++ + b`; `0xE+12` and `123.X` are one
     preprocessor number each),
  3. directives (`#include`, `#define` object/function-like with `#` and `##`, `#undef`,
     `#if/#ifdef/#ifndef/#elif/#else/#endif`, `defined`, `#error`, `#pragma once`) and macro replacement,
     animated one replacement at a time. A macro inside its own expansion is shown as not replaced.
     Included lines carry a coloured band per header; the gutter shows each line's origin.
- **Compiler** (C subset): `char/short/int/long` (+`unsigned`), pointers, 1-D arrays, `sizeof`, globals
  (initialised → `.data`, uninitialised → `.bss`, `static` → local symbol), locals, parameters,
  `extern`, all arithmetic/bitwise/logical/comparison operators (`&&`/`||` short-circuit), assignment and
  compound assignment, `++/--`, `&`, `*`, `[]`, casts, `?:`, calls with up to 6 register arguments,
  `if/else`, `while`, `do-while`, `for`, `break`, `continue`, `return`. System V AMD64 calling
  convention with a standard `rbp` frame; every local lives at `[rbp - n]`. Signed/unsigned choose
  `imul/mul`, `idiv/div`, `sar/shr`, `jl/jb`, `movsx/movzx`. Hover a C line to see its assembly (and
  vice versa); the AST and a table of all variables with their sizes are one click away.
  Not supported (with a clear error): structs, unions, enums, typedef, floating point, switch, goto,
  variadic calls, function pointers, multi-dimensional arrays.
- **Assembler**: one object file per translation unit, sections starting at 0, unknown addresses as
  `?? ?? ?? ??`, a symbol table like `objdump -t` (`l`/`g`, `*UND*`) and the relocation list.
- **Linker**: places `crt0.o` (the `_start` code that calls `main` and exits with its return value),
  every unit's `.o` and `libc.o` one after another, connects each `*UND*` symbol to its definition with
  an arrow, and patches the relocations. Undefined references and duplicate definitions are reported
  like `ld` does. In the CPU view the linked listing is read-only (**Edit as assembly** turns it into
  normal assembly, **My program** brings back your own) and the current C line is highlighted.

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
  core/object.ts        object files: symbols, relocations (assembleObject in assembler.ts)
  toolchain/         the C toolchain, pure TypeScript
    pp/                   preprocessor: pass1 (comments/lines), tokens (pass 2), pass3 (directives, macros)
    cc/                   compiler: lexer, parser (+ type checking), codegen (→ NASM), AST tree
    linker.ts             layout, symbol resolution, relocation patching, linked listing
    runtime.ts            crt0.o and libc.o (assembly)
    pipeline.ts           build(project): all four stages, stops at the first stage with errors
    examples.ts           the 10 C examples
  app/               app shell, mode switch (CPU | C Toolchain), shared settings
  features/cpu/      the CPU view (editor, CPU diagram, stack, memory, explanation, console)
  features/toolchain the toolchain view (pipeline bar, one view per stage)
```

- **Every stage records its steps** (rewrites, emitted statements, patches), so the UI only replays them.
- **Object files** are compared with real `nasm -f elf64` output (bytes, symbol table, relocation
  targets). The linked program is checked to be byte-identical to assembling the flat listing as one
  program, instruction by instruction.

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

`npm test` runs about 550 tests:

- flag edge cases (`0x7F+1`, `0−1`, `MIN/−1` in `idiv`, shift by 0, rotate, `neg`), sub-register
  writes, little-endian memory, every addressing mode, `call`/`ret`, faults, undo
- every condition code checked against an independent formula for all 32 flag combinations
- every example program: a test asserting its final register/memory state
- explanation sentences
- **byte-for-byte comparison with real `nasm -f bin`** for about 200 instruction forms, several
  whole programs and all 8 examples. These tests are skipped automatically when `nasm` is not
  installed; fixed reference vectors still check the encoder in that case. Only `-f bin` is used,
  so the comparison doesn't depend on the host OS's object format (macOS Mach-O quirks don't matter).
- object files (hand-written and compiled C) against `nasm -f elf64`, read with a small ELF64 reader
- preprocessor token streams against `clang -E -P -undef -nostdinc` (skipped without clang)
- every C construct compiled, linked and run in the emulator (exit code / output), signed vs unsigned
  instruction choice, error messages with file:line, linker errors, all 10 C examples
- robustness: every prefix and every one-line deletion of every example builds without crashing

## Adding a language

Copy `src/i18n/en.ts` to e.g. `de.ts`, translate it, and register it in `src/i18n/index.ts`.
TypeScript reports any key you forgot.
