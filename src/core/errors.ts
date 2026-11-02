/**
 * Errors are reported as a code plus parameters. The UI turns them into text via
 * the i18n module, so the core stays language-neutral.
 */
export type ErrorCode =
  | 'syntax'
  | 'unexpectedToken'
  | 'unterminatedString'
  | 'badNumber'
  | 'unknownInstruction'
  | 'unsupportedInstruction'
  | 'unsupportedDirective'
  | 'ptrKeyword'
  | 'operandCount'
  | 'invalidOperands'
  | 'sizeUnknown'
  | 'sizeMismatch'
  | 'immOutOfRange'
  | 'imm64NotAllowed'
  | 'badAddress'
  | 'address32'
  | 'addressTooLarge'
  | 'highByteWithRex'
  | 'undefinedSymbol'
  | 'duplicateSymbol'
  | 'instrOutsideText'
  | 'dataInText'
  | 'resInData'
  | 'jumpOutOfRange'
  | 'noInstructions'
  | 'notConstant'
  | 'segmentOverride'
  | 'noConvergence'
  | 'badEqu'
  | 'divByZeroExpr'
  | 'movzx32'
  | 'pushSize'

export interface AsmError {
  /** 1-based source line */
  line: number
  code: ErrorCode
  params?: Record<string, string | number>
}

export class AsmException extends Error {
  readonly code: ErrorCode
  readonly params?: Record<string, string | number>
  constructor(code: ErrorCode, params?: Record<string, string | number>) {
    super(code + (params ? ' ' + JSON.stringify(params) : ''))
    this.code = code
    this.params = params
  }
}

export function fail(code: ErrorCode, params?: Record<string, string | number>): never {
  throw new AsmException(code, params)
}
