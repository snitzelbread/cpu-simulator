import { describe, expect, it } from 'vitest'
import { build } from '../pipeline'
import { buildError, evalC, project, runC } from './helpers'

const asmOf = (src: string) => build(project({ 'main.c': src })).units[0].cc!.asm
const code = (asm: string) => asm.split('\n').map((l) => l.replace(/;.*/, '').trim()).filter(Boolean)

describe('expressions (compiled and run in the emulator)', () => {
  it('arithmetic and precedence', () => {
    expect(evalC('2 + 3 * 4')).toBe(14)
    expect(evalC('(2 + 3) * 4')).toBe(20)
    expect(evalC('17 / 5 * 10 + 17 % 5')).toBe(32)
    expect(evalC('-7 / 2 + 10')).toBe(7) // C truncates toward zero: -3
    expect(evalC('-7 % 3 + 10')).toBe(9) // remainder has the sign of the dividend: -1
    expect(evalC('100 - 1 - 1')).toBe(98)
  })
  it('bitwise and shifts', () => {
    expect(evalC('(0xF0 | 0x0F) & 0x3C ^ 1')).toBe(0x3d)
    expect(evalC('(1 << 6) + (~0 & 3)')).toBe(67)
    expect(evalC('(-16 >> 2) + 10')).toBe(6) // arithmetic shift for signed
    expect(evalC('(int)(0x80000000u >> 28)')).toBe(8) // logical shift for unsigned
  })
  it('comparisons and logical operators produce 0/1', () => {
    expect(evalC('(3 < 5) + (5 < 3) * 2 + (4 == 4) * 4 + (4 != 4) * 8 + (2 >= 2) * 16')).toBe(21)
    expect(evalC('(1 && 2) + (0 || 0) * 2 + (!5) * 4 + (!0) * 8')).toBe(9)
  })
  it('signed vs unsigned comparison', () => {
    expect(evalC('-1 < 1')).toBe(1)
    expect(evalC('-1 < 1u')).toBe(0) // -1 becomes 0xFFFFFFFF
    expect(evalC('x < y', 'int x = -1; unsigned int y = 1;')).toBe(0)
    expect(evalC('(long)-1 < 1u')).toBe(1) // long can hold all unsigned ints
  })
  it('signed vs unsigned division and multiplication', () => {
    expect(evalC('a / 2 + 100', 'int a = -10;')).toBe(95)
    expect(evalC('(int)(b / 2u >> 24)', 'unsigned b = 0xFFFFFFF6;')).toBe(0x7f)
    expect(evalC('(int)((unsigned)a * 2u == 0xFFFFFFECu)', 'int a = -10;')).toBe(1)
  })
  it('short-circuit: the right side is not evaluated', () => {
    const r = runC('int n = 0;\nint inc(void) { n = n + 1; return 1; }\nint main(void) { if (0 && inc()) n = 50; if (1 || inc()) n = n + 10; return n; }')
    expect(r.exitCode).toBe(10)
  })
  it('conditional operator', () => expect(evalC('a > 3 ? 7 : 9', 'int a = 5;')).toBe(7))
  it('assignment operators and increment/decrement', () => {
    const src = `int main(void) {
      int a = 10; int b;
      a += 5; a -= 3; a *= 2; a /= 4; a %= 4;
      b = a++; b = b + ++a;
      a <<= 3; a |= 1; a ^= 3; a &= 0xFE; a >>= 1;
      return a * 10 + b;
    }`
    expect(runC(src).exitCode).toBe(176) // a: 10→15→12→24→6→2, b=2, a=3; a=4, b=6; a=32→33→34→34→17
  })
  it('char, short, long and casts', () => {
    expect(evalC('c + 1', 'char c = 127;')).toBe(128) // promoted to int before adding
    expect(evalC('(c = 127, c = c + 1, c == -128)', 'char c;')).toBe(1) // stored back into a signed char
    expect(evalC('u == 255', 'unsigned char u = -1;')).toBe(1)
    expect(evalC('(int)(s * 2)', 'short s = -300;') & 0xff).toBe(-600 & 0xff)
    expect(evalC('(int)(big >> 32)', 'long big = 0x500000000;')).toBe(5)
    expect(evalC('(int)((l = i) == -1)', 'int i = -1; long l;')).toBe(1)
  })
  it('sizeof', () => {
    expect(evalC('sizeof(char) + sizeof(short) * 10 + sizeof(int) * 100')).toBe((1 + 20 + 400) & 0xff)
    expect(evalC('sizeof(long) + sizeof(char *) + sizeof a', 'int a[10];')).toBe(56)
  })
})

describe('pointers and arrays', () => {
  it('address-of, dereference, pointer arithmetic', () => {
    const src = `int main(void) {
      int a[4]; int *p = a; int i;
      for (i = 0; i < 4; i++) a[i] = i * 10;
      p = p + 2; *p = *p + 1;
      return a[2] + (int)(p - a) + *(a + 3);
    }`
    expect(runC(src).exitCode).toBe(21 + 2 + 30)
  })
  it('pointer parameters change the caller\'s variable', () => {
    expect(runC('void set(int *p, int v) { *p = v; }\nint main(void) { int x = 1; set(&x, 42); return x; }').exitCode).toBe(42)
  })
  it('char arrays and strings', () => {
    const src = `#include <stdio.h>
      char msg[] = "Hi!";
      int len(char *s) { int n = 0; while (s[n]) n++; return n; }
      int main(void) { char local[6] = "abc"; puts(msg); puts(local); return len(msg) * 10 + len(local); }`
    const r = runC(src)
    expect(r.output).toBe('Hi!\nabc\n')
    expect(r.exitCode).toBe(33)
  })
  it('global initialisers with addresses', () => {
    const src = `int data[3] = {5, 6, 7};\nint *p = &data[1];\nchar *s = "xyz";\nint main(void) { return *p + s[2]; }`
    expect(runC(src).exitCode).toBe(6 + 122)
  })
  it('local array initialiser fills the rest with 0', () => {
    expect(runC('int main(void) { int a[5] = {1, 2}; return a[0] + a[1] + a[4] + 10; }').exitCode).toBe(13)
  })
})

describe('statements', () => {
  it('if / else if / else', () => {
    const src = (x: number) => `int f(int x) { if (x < 0) return 1; else if (x == 0) return 2; else return 3; }\nint main(void) { return f(${x}); }`
    expect([runC(src(-5)).exitCode, runC(src(0)).exitCode, runC(src(9)).exitCode]).toEqual([1, 2, 3])
  })
  it('while, do-while, for with break and continue', () => {
    const src = `int main(void) {
      int s = 0; int i = 0;
      while (1) { i++; if (i > 10) break; if (i % 2) continue; s += i; }
      do { s += 100; } while (0);
      for (int k = 0; ; k++) { if (k == 3) break; s += 1000; }
      return s / 10;
    }`
    expect(runC(src).exitCode).toBe(Math.floor((30 + 100 + 3000) / 10) & 0xff)
  })
  it('nested loops', () => {
    expect(runC('int main(void) { int n = 0; for (int i = 0; i < 5; i++) for (int j = 0; j < i; j++) n++; return n; }').exitCode).toBe(10)
  })
  it('recursion', () => {
    expect(runC('int sum(int n) { if (n == 0) return 0; return n + sum(n - 1); }\nint main(void) { return sum(10); }').exitCode).toBe(55)
    expect(runC('long fib(long n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }\nint main(void) { return (int)fib(12); }').exitCode).toBe(144)
  })
  it('six arguments in registers', () => {
    expect(runC('int f(int a, int b, int c, int d, int e, int g) { return a - b + c * d - e + g; }\nint main(void) { return f(1, 2, 3, 4, 5, 6); }').exitCode).toBe(12)
  })
  it('main without return returns 0', () => expect(runC('int main(void) { int x = 5; x++; }').exitCode).toBe(0))
  it('exit() from the library', () => expect(runC('#include <stdlib.h>\nint main(void) { exit(7); return 1; }').exitCode).toBe(7))
  it('print_int prints negative and large numbers', () => {
    expect(runC('#include <stdio.h>\nint main(void) { print_int(0); putchar(32); print_int(-9223372036854775807L - 1); putchar(32); print_int(1234567); return 0; }').output).toBe('0 -9223372036854775808 1234567')
  })
})

describe('instruction selection (signed vs unsigned)', () => {
  const pick = (decl: string, expr: string) => code(asmOf(`${decl}\nint main(void) { return ${expr}; }`))
  it('division: cdq + idiv vs xor edx + div', () => {
    expect(pick('int a = 7, b = 2;', 'a / b')).toEqual(expect.arrayContaining(['cdq', 'idiv ecx']))
    expect(pick('unsigned a = 7, b = 2;', 'a / b')).toEqual(expect.arrayContaining(['xor edx, edx', 'div ecx']))
    expect(pick('long a = 7, b = 2;', '(int)(a / b)')).toEqual(expect.arrayContaining(['cqo', 'idiv rcx']))
  })
  it('multiplication: imul vs mul', () => {
    expect(pick('int a = 7, b = 2;', 'a * b')).toContain('imul eax, ecx')
    expect(pick('unsigned a = 7, b = 2;', 'a * b')).toContain('mul ecx')
  })
  it('right shift: sar vs shr', () => {
    expect(pick('int a = 7;', 'a >> 1')).toContain('sar eax, 1')
    expect(pick('unsigned a = 7;', 'a >> 1')).toContain('shr eax, 1')
  })
  it('comparison: setl vs setb, jl vs jb', () => {
    expect(pick('int a = 7, b = 2;', 'a < b')).toContain('setl al')
    expect(pick('unsigned a = 7, b = 2;', 'a < b')).toContain('setb al')
    expect(code(asmOf('int a, b;\nint main(void) { if (a < b) return 1; return 0; }'))).toContain('jge .endif_1')
    expect(code(asmOf('unsigned a, b;\nint main(void) { if (a < b) return 1; return 0; }'))).toContain('jae .endif_1')
  })
  it('loading small types: movsx vs movzx', () => {
    expect(pick('char c = 1;', 'c')).toContain('movsx eax, byte [rel c]')
    expect(pick('unsigned char c = 1;', 'c')).toContain('movzx eax, byte [rel c]')
    expect(pick('short s = 1;', 's')).toContain('movsx eax, word [rel s]')
  })
  it('int → long: movsxd; unsigned int → long: nothing (already zero-extended)', () => {
    expect(pick('int i = 1; long l;', '(int)(l = i)')).toContain('movsxd rax, eax')
    expect(pick('unsigned i = 1; long l;', '(int)(l = i)')).not.toContain('movsxd rax, eax')
  })
})

describe('globals become labels', () => {
  it('int x = 15; is data, not an assignment', () => {
    const asm = asmOf('int x = 15;\nint y;\nstatic char buf[10];\nlong arr[3] = {1, 2};\nint main(void) { return x; }')
    expect(code(asm)).toEqual(expect.arrayContaining(['x: dd 15', 'y: resd 1', 'buf: resb 10', 'arr: dq 1, 2, 0']))
    expect(asm).toContain('global main, x, y, arr')
    expect(asm).not.toMatch(/global.*buf/)
  })
  it('extern declarations of used symbols', () => {
    const asm = asmOf('extern int shared;\nint helper(int);\nint unused(void);\nint main(void) { return helper(shared); }')
    expect(asm).toContain('extern helper, shared')
    expect(asm).not.toContain('unused')
  })
  it('comments refer to the C source', () => {
    expect(asmOf('int main(void) {\n  int x = 1;\n  x = x + 2;\n  return x;\n}')).toContain('; x = x + 2;  (main.c:3)')
  })
})

describe('errors', () => {
  const cases: [string, string, number?][] = [
    ['struct point { int x; };', 'structUnsupported', 1],
    ['int main(void) {\n  float f = 1.5;\n}', 'floatUnsupported', 2],
    ['int main(void) { double d; }', 'floatUnsupported'],
    ['int main(void) { return y; }', 'undeclared'],
    ['int main(void) { return f(1); }', 'implicitDeclaration'],
    ['int f(int a);\nint main(void) { return f(); }', 'argCount'],
    ['int main(void) { break; }', 'breakOutside'],
    ['int main(void) { switch (1) { } }', 'switchUnsupported'],
    ['typedef int T;', 'typedefUnsupported'],
    ['int main(void) { int x; x + 1 = 2; }', 'notLvalue'],
    ['int main(void) { int *p; int x; p = x; }', 'intToPointer'],
    ['int main(void) { int x = 1 }', 'expected'],
    ['int f(int a) { return a; }\nint f(int b) { return b; }', 'redefinition'],
    ['int f(int a);\nlong f(int a);', 'conflictingTypes'],
    ['int main(void) { int a[2][3]; }', 'multiDimArray'],
    ['#include <stdio.h>\nint main(void) { printf("%d", 1); }', 'variadicCall'],
    ['int f(int a, int b, int c, int d, int e, int f, int g);', 'tooManyParams'],
    ['int x = 1;\nint y = x;', 'initNotConstant'],
  ]
  for (const [src, code, line] of cases) {
    it(code + (line ? ` (line ${line})` : ''), () => {
      const e = buildError(src)
      expect(e).toMatchObject({ stage: 'cc', code, file: 'main.c' })
      if (line) expect(e.line).toBe(line)
    })
  }
})
