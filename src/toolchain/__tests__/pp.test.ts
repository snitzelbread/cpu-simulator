import { describe, expect, it } from 'vitest'
import { pass1, pass2, preprocess, tokenizeLine, type PPStep } from '../pp'
import type { Project } from '../project'
import { clangE, hasClang } from './clang'

const toks = (s: string) => tokenizeLine('t.c', 1, s).tokens.map((t) => t.text)
const kinds = (s: string) => tokenizeLine('t.c', 1, s).tokens.map((t) => t.kind)
const proj = (main: string, extra: Record<string, string> = {}): Project => ({
  files: [{ name: 'main.c', text: main }, ...Object.entries(extra).map(([name, text]) => ({ name, text }))],
})
const pp = (main: string, extra?: Record<string, string>) => preprocess(proj(main, extra), 'main.c')
const tu = (main: string, extra?: Record<string, string>) =>
  pp(main, extra).lines.map((l) => l.text).filter((l) => l.trim()).join('\n')

describe('pass 1: comments and line continuation', () => {
  it('removes // and /* */ comments, keeping the line count', () => {
    const r = pass1('t.c', 'int a; // one\nint /* two */ b;\n/* three\n   lines */ int c;\nint d;')
    expect(r.lines).toEqual(['int a;', 'int   b;', '  int c;', '', 'int d;'])
    expect(r.changes.map((c) => c.kind)).toEqual(['lineComment', 'blockComment', 'blockComment'])
  })
  it('joins lines ending in a backslash and leaves blank lines', () => {
    const r = pass1('t.c', '#define ABC 1 + \\\n  2\nint x;')
    expect(r.lines).toEqual(['#define ABC 1 +   2', '', 'int x;'])
    expect(r.changes[0]).toMatchObject({ kind: 'splice', line: 1, endLine: 2 })
  })
  it('does not treat comment markers inside strings as comments', () => {
    expect(pass1('t.c', 'char *s = "a // b /* c */";').lines[0]).toBe('char *s = "a // b /* c */";')
  })
  it('reports an unterminated block comment', () => {
    expect(pass1('t.c', 'int a; /* oops').errors[0].code).toBe('unterminatedComment')
  })
})

describe('pass 2: tokenization', () => {
  it('is greedy: a+++++b → a ++ ++ + b', () => expect(toks('a+++++b')).toEqual(['a', '++', '++', '+', 'b']))
  it('preprocessor numbers: 0xE+12 and 123.X are single tokens', () => {
    expect(toks('0xE+12')).toEqual(['0xE+12'])
    expect(toks('123.X')).toEqual(['123.X'])
    expect(toks('1.5e-3f')).toEqual(['1.5e-3f'])
    expect(toks('0x1+2')).toEqual(['0x1', '+', '2'])
  })
  it('categories', () => {
    expect(kinds('x = "s" + \'c\' ; 12')).toEqual(['ident', 'punct', 'string', 'punct', 'char', 'punct', 'number'])
  })
  it('punctuators including # ## ... <<= ->', () => {
    expect(toks('# ## ... <<= -> %:%:')).toEqual(['#', '##', '...', '<<=', '->', '%:%:'])
    expect(toks('a->b>>=c')).toEqual(['a', '->', 'b', '>>=', 'c'])
  })
  it('header names after #include', () => {
    expect(tokenizeLine('t.c', 1, '#include <stdio.h>').tokens.map((t) => t.kind)).toEqual(['punct', 'ident', 'header'])
  })
  it('pass2 keeps one token list per line', () => expect(pass2('t.c', ['int a;', '', 'b']).lines.map((l) => l.length)).toEqual([3, 0, 1]))
})

describe('pass 3: macros', () => {
  it('replaces repeatedly, one step at a time: ABC → XYZ → 123', () => {
    const r = pp('#define XYZ 123\n#define ABC XYZ\nint y = ABC;')
    expect(r.lines[2].text).toBe('int y = 123;')
    const ex = r.steps.filter((s) => s.kind === 'expand') as Extract<PPStep, { kind: 'expand' }>[]
    expect(ex.map((s) => s.after.map((t) => t.text).join(' '))).toEqual(['int y = XYZ ;', 'int y = 123 ;'])
  })
  it('a macro name inside its own expansion is not replaced', () => {
    const r = pp('#define foo foo + 1\nint x = foo;')
    expect(r.lines[1].text).toBe('int x = foo + 1;')
    expect(r.steps.some((s) => s.kind === 'blocked' && s.macro === 'foo')).toBe(true)
  })
  it('indirect self-reference stops too', () => {
    expect(tu('#define a b\n#define b a\nint x = a;')).toBe('int x = a;')
  })
  it('X inside 123.X is not replaced', () => {
    const r = pp('#define X 5\ndouble d = 123.X;')
    expect(r.lines[1].text).toBe('double d = 123.X;')
    expect(r.steps.some((s) => s.kind === 'ppnumber' && s.name === 'X')).toBe(true)
  })
  it('function-like macro: the classic missing-parentheses bug', () => {
    expect(tu('#define SQ(x) x*x\nint a = SQ(1+2);')).toBe('int a = 1+2*1+2;')
    expect(tu('#define SQ(x) ((x)*(x))\nint a = SQ(1+2);')).toBe('int a = ((1+2)*(1+2));')
  })
  it('a function-like macro name without ( is left alone', () => expect(tu('#define f(x) x\nint f;')).toBe('int f;'))
  it('arguments are expanded before substitution', () => {
    expect(tu('#define N 3\n#define TWICE(x) (2*(x))\nint a = TWICE(N);')).toBe('int a = (2*(3));')
  })
  it('nested calls and commas inside parentheses', () => {
    expect(tu('#define MAX(a,b) ((a)>(b)?(a):(b))\nint m = MAX(f(1,2), MAX(3,4));')).toBe('int m = ((f(1,2))>(((3)>(4)?(3):(4)))?(f(1,2)):(((3)>(4)?(3):(4))));')
  })
  it('# stringifies and ## pastes', () => {
    expect(tu('#define STR(x) #x\nchar *s = STR(a + "b");')).toBe('char *s = "a + \\"b\\"";')
    expect(tu('#define CAT(a,b) a##b\nint CAT(foo, 12) = 1;')).toBe('int foo12 = 1;')
  })
  it('a call can span several lines', () => {
    const r = pp('#define ADD(a,b) a+b\nint x = ADD(1,\n  2);\nint z;')
    expect(r.lines.map((l) => l.text)).toEqual(['', 'int x = 1+2;', '', 'int z;'])
  })
  it('wrong argument count is an error', () => expect(pp('#define F(a,b) a\nint x = F(1);').errors[0].code).toBe('macroArgCount'))
  it('#undef', () => expect(tu('#define A 1\n#undef A\nint x = A;')).toBe('int x = A;'))
})

describe('pass 3: conditional compilation', () => {
  it('#if / #elif / #else / #endif with defined', () => {
    const src = '#define V 2\n#if V == 1\nint a;\n#elif V == 2 && defined(V)\nint b;\n#else\nint c;\n#endif'
    expect(tu(src)).toBe('int b;')
  })
  it('#ifdef / #ifndef, nested', () => {
    expect(tu('#define A\n#ifdef A\n#ifndef B\nint ok;\n#else\nint no;\n#endif\n#endif')).toBe('int ok;')
  })
  it('undefined identifiers in #if are 0', () => expect(tu('#if FOO\nint a;\n#else\nint b;\n#endif')).toBe('int b;'))
  it('directives in skipped groups are ignored', () => expect(tu('#if 0\n#error never\n#define A 1\n#endif\nint A;')).toBe('int A;'))
  it('missing #endif and stray #else are errors', () => {
    expect(pp('#if 1\nint a;').errors[0].code).toBe('unterminatedIf')
    expect(pp('#else').errors[0].code).toBe('elseWithoutIf')
  })
  it('#error stops with its message', () => expect(pp('#error broken here').errors[0]).toMatchObject({ code: 'errorDirective', params: { text: 'broken here' } }))
})

describe('pass 3: #include', () => {
  it('copies the header text into the translation unit and marks its origin', () => {
    const r = pp('#include "util.h"\nint main;', { 'util.h': 'int util(int);\nint other;' })
    expect(r.lines.map((l) => [l.text, l.file, l.depth])).toEqual([
      ['int util(int);', 'util.h', 1],
      ['int other;', 'util.h', 1],
      ['int main;', 'main.c', 0],
    ])
  })
  it('nested includes and include guards', () => {
    const extra = { 'a.h': '#ifndef A_H\n#define A_H\n#include "b.h"\nint a;\n#endif', 'b.h': '#pragma once\nint b;' }
    expect(tu('#include "a.h"\n#include "a.h"\n#include "b.h"\nint m;', extra)).toBe('int b;\nint a;\nint m;')
  })
  it('system headers via <...>', () => expect(tu('#include <stdio.h>\n')).toContain('int puts(const char *s);'))
  it('missing files are errors', () => {
    expect(pp('#include "nope.h"').errors[0].code).toBe('includeNotFound')
    expect(pp('#include <nope.h>').errors[0].code).toBe('systemHeaderNotFound')
  })
  it('<...> does not search the project files', () => expect(pp('#include <util.h>', { 'util.h': 'int u;' }).errors[0].code).toBe('systemHeaderNotFound'))
  it('recursive includes are stopped', () => expect(pp('#include "main.c"').errors.some((e) => e.code === 'includeDepth')).toBe(true))
})

/** Compare the token stream with clang -E (whitespace and line breaks are ignored). */
const CLANG_CASES: Record<string, [string, Record<string, string>?]> = {
  'macro chain': ['#define XYZ 123\n#define ABC XYZ\nint y = ABC;\n'],
  'self reference': ['#define foo foo + 1\n#define a b\n#define b a\nint x = foo; int y = a;\n'],
  'function-like': ['#define SQ(x) x*x\n#define MAX(a,b) ((a)>(b)?(a):(b))\nint a = SQ(1+2), m = MAX(SQ(2), MAX(3,4));\n'],
  'stringify and paste': ['#define STR(x) #x\n#define XSTR(x) STR(x)\n#define CAT(a,b) a##b\n#define N 42\nchar *s = STR(N), *t = XSTR(N); int CAT(v, N) = CAT(,x);\n'],
  'conditionals': ['#define V 3\n#if V > 2 && !defined(W)\nint big;\n#elif V\nint small;\n#endif\n#ifdef V\nint d;\n#endif\n'],
  'comments and continuation': ['int a; // c\n#define LONG 1 + \\\n 2\nint b = LONG; /* x\n y */ int c;\n'],
  'tokenizer traps': ['#define X 7\nint r = a+++++b; double d = 0xE+12 + 123.X;\n'],
  'includes': ['#include "util.h"\n#include <stdio.h>\nint main(void) { return util(N); }\n', { 'util.h': '#ifndef UTIL_H\n#define UTIL_H\n#define N 5\nint util(int x);\n#endif\n' }],
  'multi-line call and rescanning': ['#define f(x) g(x)\n#define g(x) x+1\nint z = f(\n 2) + f\n (3);\n'],
  'uebung 4 style': ['#include <stdio.h>\n#define XYZ 1.2\n#define ABC \\\n  printf("%f\\n", \\\n         XYZ)\nint main(void) {\n  ABC;\n  return 0;\n}\n'],
}

describe.skipIf(!hasClang)('token stream matches clang -E', () => {
  for (const [name, [src, extra]] of Object.entries(CLANG_CASES)) {
    it(name, () => {
      const p = proj(src, extra)
      const ours = preprocess(p, 'main.c')
      expect(ours.errors).toEqual([])
      const theirs = tokenizeLine('x', 1, clangE(p, 'main.c').replace(/\n/g, ' ')).tokens.map((t) => t.text)
      expect(ours.tokens.map((t) => t.text)).toEqual(theirs)
    })
  }
})
