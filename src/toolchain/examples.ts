/** Built-in example projects for the C toolchain mode. */
import type { Stage } from './diagnostics'
import type { SourceFile } from './project'

export interface ToolchainExample {
  id: string
  title: string
  /** The stage the example is about (opened when it is loaded). */
  stage: Stage
  files: SourceFile[]
}

const f = (name: string, text: string): SourceFile => ({ name, text })

export const TOOLCHAIN_EXAMPLES: ToolchainExample[] = [
  {
    id: 'comments',
    title: '1. Comments and line continuation',
    stage: 'pp',
    files: [
      f('main.c', `/* Pass 1 of the preprocessor removes comments
   and joins lines that end in a backslash. */
#include <stdio.h>

// A macro that is too long for one line:
#define GREETING "Hello, " \\
                 "world!"

int main(void) {
    puts(GREETING);   // print it
    return /* the exit code */ 0;
}
`),
    ],
  },
  {
    id: 'tokens',
    title: '2. Tokenizer traps',
    stage: 'pp',
    files: [
      f('main.c', `/* Pass 2 splits every line into tokens. The tokenizer is greedy:
   it always takes the longest token that fits. */
#define X 5

int main(void) {
    int a = 1, b = 2;
    int c = a++ + ++b;   /* a ++ + ++ b */
#if 0
    /* Look at these lines in pass 2 (they are skipped in pass 3). */
    c = a+++++b;         /* a ++ ++ + b: ++ cannot be applied to a++ */
    c = 0xE+12;          /* ONE preprocessor number, not 0xE + 12 */
#endif
    c = 123.X;           /* ONE preprocessor number: X is not replaced,
                            and the compiler rejects it */
    return c + X;
}
`),
    ],
  },
  {
    id: 'macros',
    title: '3. Macro replacement',
    stage: 'pp',
    files: [
      f('main.c', `#include <stdio.h>

/* Repeated replacement: ABC -> XYZ -> 123 */
#define XYZ 123
#define ABC XYZ

/* A macro may use its own name: it is NOT replaced again. */
int value = 5;
#define value value + 1

/* The classic bug: missing parentheses. */
#define SQ(x) x*x
#define SQ_OK(x) ((x)*(x))

int main(void) {
    int y = ABC;
    print_int(y);  putchar('\\n');
    print_int(value);  putchar('\\n');        /* value + 1 = 6 */
    print_int(SQ(1+2));  putchar('\\n');      /* 1+2*1+2 = 5, not 9! */
    print_int(SQ_OK(1+2));  putchar('\\n');   /* 9 */
    return 0;
}
`),
    ],
  },
  {
    id: 'uebung4',
    title: '4. Übung 4: #define, #include, printf',
    stage: 'pp',
    files: [
      f('main.c', `#include <stdio.h>
#define XYZ 1.2
#define ABC printf("Wert: %f\\n", \\
                   XYZ)

int main(void) {
    ABC;
    return 0;
}
`),
    ],
  },
  {
    id: 'globals',
    title: '5. Global variables become labels',
    stage: 'cc',
    files: [
      f('main.c', `/* Initialised globals go to .data, uninitialised ones to .bss.
   int x = 15; is not an assignment: it becomes  x: dd 15  */
int x = 15;
long big = 1000000000000;
char letter = 'A';
short table[4] = {1, 2, 3};
int counter;               /* .bss: zero when the program starts */
char buffer[16];
static int hidden = 7;     /* static: a local symbol (l), not global (g) */

int main(void) {
    counter = x + hidden;
    buffer[0] = letter;
    return counter + table[2];
}
`),
    ],
  },
  {
    id: 'signed',
    title: '6. Signed vs. unsigned',
    stage: 'cc',
    files: [
      f('main.c', `#include <stdio.h>
/* Same C code, different instructions: the type decides. */

int s_less(int a, int b)                { return a < b; }      /* setl  */
int u_less(unsigned a, unsigned b)      { return a < b; }      /* setb  */

int s_div(int a, int b)                 { return a / b; }      /* cdq + idiv */
unsigned u_div(unsigned a, unsigned b)  { return a / b; }      /* xor edx + div */

int s_shift(int a)                      { return a >> 1; }     /* sar */
unsigned u_shift(unsigned a)            { return a >> 1; }     /* shr */

int main(void) {
    print_int(s_less(-1, 1));   putchar(' ');   /* 1 */
    print_int(u_less(-1, 1));   putchar('\\n'); /* 0: -1 is 4294967295 */
    print_int(s_div(-10, 3));   putchar(' ');   /* -3 */
    print_int(u_div(-10, 3));   putchar('\\n'); /* 1431655762 */
    print_int(s_shift(-8));     putchar(' ');   /* -4 */
    print_int(u_shift(-8));     putchar('\\n'); /* 2147483644 */
    return 0;
}
`),
    ],
  },
  {
    id: 'for',
    title: '7. for loop summing an array',
    stage: 'cc',
    files: [
      f('main.c', `int numbers[5] = {3, 1, 4, 1, 5};

int main(void) {
    int sum = 0;
    for (int i = 0; i < 5; i++) {
        sum += numbers[i];
    }
    return sum;   /* 14 */
}
`),
    ],
  },
  {
    id: 'recursion',
    title: '8. Recursion: sum of 1..n',
    stage: 'cc',
    files: [
      f('main.c', `/* Every call gets its own stack frame with its own n.
   Run it in the CPU simulator and watch the stack grow. */
int sum(int n) {
    if (n == 0) {
        return 0;
    }
    return n + sum(n - 1);
}

int main(void) {
    return sum(4);   /* 10 */
}
`),
    ],
  },
  {
    id: 'two-units',
    title: '9. Two translation units',
    stage: 'ld',
    files: [
      f('main.c', `#include <stdio.h>
#include "util.h"

int main(void) {
    int r = square(7);       /* defined in util.c: *UND* in main.o */
    print_int(r);
    putchar('\\n');
    return calls;            /* a global variable from util.c */
}
`),
      f('util.h', `#ifndef UTIL_H
#define UTIL_H

int square(int x);    /* declaration: the definition is in util.c */
extern int calls;     /* declaration of a variable defined elsewhere */

#endif
`),
      f('util.c', `#include "util.h"

int calls = 0;

int square(int x) {
    calls = calls + 1;
    return x * x;
}
`),
    ],
  },
  {
    id: 'broken-link',
    title: '10. Broken link: undefined reference',
    stage: 'ld',
    files: [
      f('main.c', `#include "util.h"

int main(void) {
    return cube(3);   /* declared in util.h, but defined nowhere */
}
`),
      f('util.h', `int square(int x);
int cube(int x);      /* declared ... but util.c has no definition */
`),
      f('util.c', `#include "util.h"

int square(int x) {
    return x * x;
}
`),
    ],
  },
]
