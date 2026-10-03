export type ErrorCode =
  | "E_BAD_CHECKSUM"
  | "E_BAD_OCTAL"
  | "E_BAD_HEADER"
  | "E_UNSUPPORTED_TYPE"
  | "E_UNSUPPORTED_ENCODING"
  | "E_TRUNCATED"
  | "E_PATH_UNSAFE"
  | "E_DUPLICATE_TARGET"
  | "E_TARGET_EXISTS"
  | "E_LIMIT_EXCEEDED"
  | "E_NOT_FOUND"
  | "E_INVALID_ARG"
  | "E_IO"
  | "E_PLAN_NOT_READY"
  | "E_INTERNAL";

export class AppError extends Error {
  code: ErrorCode;
  status: number;
  details?: unknown;
  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
