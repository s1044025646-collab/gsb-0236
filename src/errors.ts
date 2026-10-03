export type ErrorCode =
  | "TAR_BAD_CHECKSUM"
  | "TAR_BAD_OCTAL"
  | "TAR_BAD_MAGIC"
  | "TAR_TRUNCATED"
  | "TAR_MISSING_END"
  | "TAR_UNSUPPORTED_TYPE"
  | "TAR_EMPTY_NAME"
  | "LIMIT_ARCHIVE_SIZE"
  | "LIMIT_ENTRY_COUNT"
  | "LIMIT_PATH_LENGTH"
  | "PATH_ABSOLUTE"
  | "PATH_DRIVE"
  | "PATH_ESCAPE"
  | "PATH_DUPLICATE"
  | "PATH_LINK"
  | "PATH_INVALID"
  | "TARGET_EXISTS"
  | "ENTRY_NOT_FOUND"
  | "ARCHIVE_NOT_FOUND"
  | "PLAN_NOT_FOUND"
  | "EXTRACTION_NOT_FOUND"
  | "IO_ERROR"
  | "VALIDATION";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}
