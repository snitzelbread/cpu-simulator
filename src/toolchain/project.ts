/** A virtual multi-file C project, plus the built-in system headers. */
export interface SourceFile {
  name: string
  text: string
}

export interface Project {
  files: SourceFile[]
}

/**
 * The simulator's tiny C library. The functions are implemented in assembly in libc.o
 * (see runtime.ts); there is no real libc, no floating point and no printf implementation.
 */
export const SYSTEM_HEADERS: Record<string, string> = {
  'stdio.h': `#ifndef _STDIO_H
#define _STDIO_H
/* Tiny educational <stdio.h>. The functions live in libc.o (written in assembly). */
#define NULL ((void *)0)
#define EOF (-1)

int puts(const char *s);        /* prints s and a newline */
int putchar(int c);             /* prints one character */
void print_int(long n);         /* prints n in decimal (not standard C) */
int printf(const char *format, ...); /* declared only: variadic calls are not supported */
#endif
`,
  'stdlib.h': `#ifndef _STDLIB_H
#define _STDLIB_H
#define NULL ((void *)0)
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1

void exit(int status);          /* ends the program (syscall 60) */
#endif
`,
  'unistd.h': `#ifndef _UNISTD_H
#define _UNISTD_H
#define STDOUT_FILENO 1

long write(int fd, const char *buf, long count); /* syscall 1 */
#endif
`,
}

export const isSourceFile = (name: string) => name.endsWith('.c')
export const isHeader = (name: string) => name.endsWith('.h')

/** Valid project file name: letters, digits, '_', '-', '.', ending in .c or .h. */
export function validFileName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*\.(c|h)$/.test(name)
}

export function stem(name: string): string {
  return name.replace(/\.[^.]*$/, '')
}
