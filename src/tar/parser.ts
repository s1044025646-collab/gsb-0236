import { createHash } from "node:crypto";
import { AppError } from "../errors.js";

export const BLOCK_SIZE = 512;

export const LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntries: 10000,
  maxPathLength: 255,
  maxFileBytes: 512 * 1024 * 1024,
} as const;

export type EntryType = "file" | "directory" | "unsupported";

export interface TarEntry {
  index: number;
  name: string;
  type: EntryType;
  typeflag: string;
  size: number;
  headerOffset: number;
  dataOffset: number;
  sha256: string | null;
  unsupportedReason?: string;
}

export interface ParseDiagnostic {
  severity: "warning" | "error";
  code: string;
  message: string;
  offset?: number;
}

export interface ParseResult {
  entries: TarEntry[];
  diagnostics: ParseDiagnostic[];
  endMarker: "clean" | "single-zero-block" | "missing";
  archiveSha256: string;
  totalBytes: number;
}

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (buf[offset + i] !== 0) return false;
  }
  return true;
}

function readString(buf: Buffer, start: number, len: number): string {
  let end = start;
  const limit = start + len;
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString("utf8", start, end);
}

/** 严格八进制解析：允许前导空格/NUL，数字 0-7，以 NUL 或空格结尾。 */
export function parseOctal(buf: Buffer, start: number, len: number): number {
  let i = start;
  const limit = start + len;
  while (i < limit && (buf[i] === 0x20 || buf[i] === 0)) i++;
  let value = 0;
  let digits = 0;
  while (i < limit && buf[i] >= 0x30 && buf[i] <= 0x37) {
    value = value * 8 + (buf[i] - 0x30);
    digits++;
    i++;
    if (value > Number.MAX_SAFE_INTEGER / 8) {
      throw new AppError("TAR_BAD_OCTAL", `八进制字段溢出 (offset ${start})`);
    }
  }
  if (digits === 0) {
    throw new AppError("TAR_BAD_OCTAL", `八进制字段为空或非法 (offset ${start})`);
  }
  while (i < limit) {
    if (buf[i] !== 0 && buf[i] !== 0x20) {
      throw new AppError(
        "TAR_BAD_OCTAL",
        `八进制字段含非法字符 0x${buf[i].toString(16)} (offset ${start})`
      );
    }
    i++;
  }
  return value;
}

function verifyChecksum(header: Buffer, offset: number): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[offset + i];
  }
  const stored = parseOctal(header, offset + 148, 8);
  return sum === stored;
}

const SUPPORTED_TYPEFLAGS = new Set(["0", "", "5"]);

export function parseTar(buf: Buffer): ParseResult {
  if (buf.length > LIMITS.maxArchiveBytes) {
    throw new AppError(
      "LIMIT_ARCHIVE_SIZE",
      `归档大小 ${buf.length} 超过上限 ${LIMITS.maxArchiveBytes}`
    );
  }
  const archiveSha256 = createHash("sha256").update(buf).digest("hex");
  const entries: TarEntry[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  let offset = 0;
  let endMarker: ParseResult["endMarker"] = "missing";

  outer: while (true) {
    if (offset + BLOCK_SIZE > buf.length) {
      if (entries.length === 0 && offset === 0 && buf.length === 0) {
        diagnostics.push({
          severity: "error",
          code: "TAR_TRUNCATED",
          message: "归档为空，没有任何头部块",
        });
      } else {
        diagnostics.push({
          severity: "warning",
          code: "TAR_MISSING_END",
          message: `归档在 offset ${offset} 处结束，未找到零结束块`,
        });
      }
      break;
    }
    if (isZeroBlock(buf, offset)) {
      if (offset + 2 * BLOCK_SIZE <= buf.length && isZeroBlock(buf, offset + BLOCK_SIZE)) {
        endMarker = "clean";
      } else {
        endMarker = "single-zero-block";
        diagnostics.push({
          severity: "warning",
          code: "TAR_MISSING_END",
          message: `offset ${offset} 处只有一个零块，标准应为两个`,
          offset,
        });
      }
      const trailing = buf.length - offset - (endMarker === "clean" ? 2 * BLOCK_SIZE : BLOCK_SIZE);
      if (trailing > 0) {
        diagnostics.push({
          severity: "warning",
          code: "TAR_TRAILING_DATA",
          message: `结束块之后还有 ${trailing} 字节数据，已忽略`,
          offset,
        });
      }
      break;
    }

    // 非零块：必须是一个合法头部
    let checksumOk = false;
    try {
      checksumOk = verifyChecksum(buf, offset);
    } catch (err) {
      throw new AppError(
        "TAR_BAD_CHECKSUM",
        `offset ${offset} 处头部校验和字段非法，无法定位下一个条目`,
        { offset }
      );
    }
    if (!checksumOk) {
      throw new AppError(
        "TAR_BAD_CHECKSUM",
        `offset ${offset} 处头部校验和不匹配，解析终止（不做盲目扫描）`,
        { offset }
      );
    }

    const magic = readString(buf, offset + 257, 5);
    if (magic !== "ustar") {
      throw new AppError(
        "TAR_BAD_MAGIC",
        `offset ${offset} 处不是 USTAR 头部 (magic=${JSON.stringify(magic)})，不支持该方言`,
        { offset }
      );
    }

    const size = parseOctal(buf, offset + 124, 12);
    if (size > LIMITS.maxFileBytes) {
      throw new AppError("LIMIT_ARCHIVE_SIZE", `条目大小 ${size} 超过单文件上限`, { offset });
    }
    const typeflagRaw = String.fromCharCode(buf[offset + 156]);
    const name = readString(buf, offset, 100);
    const prefix = readString(buf, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (!fullName) {
      throw new AppError("TAR_EMPTY_NAME", `offset ${offset} 处条目名为空`, { offset });
    }
    if (fullName.length > LIMITS.maxPathLength) {
      throw new AppError("LIMIT_PATH_LENGTH", `条目路径超过 ${LIMITS.maxPathLength} 字符: ${fullName}`);
    }
    if (entries.length >= LIMITS.maxEntries) {
      throw new AppError("LIMIT_ENTRY_COUNT", `条目数超过上限 ${LIMITS.maxEntries}`);
    }

    const dataOffset = offset + BLOCK_SIZE;
    if (dataOffset + size > buf.length) {
      throw new AppError(
        "TAR_TRUNCATED",
        `条目 "${fullName}" 声明大小 ${size}，但归档在 offset ${buf.length} 处被截断`,
        { offset, name: fullName, size }
      );
    }

    let type: EntryType;
    let unsupportedReason: string | undefined;
    let sha256: string | null = null;
    if (typeflagRaw === "0" || typeflagRaw === "") {
      type = "file";
      sha256 = createHash("sha256")
        .update(buf.subarray(dataOffset, dataOffset + size))
        .digest("hex");
    } else if (typeflagRaw === "5") {
      type = "directory";
    } else {
      type = "unsupported";
      unsupportedReason = `不支持的类型标记 '${typeflagRaw === "" ? "\\0" : typeflagRaw}'（链接/设备/PAX/GNU 扩展等）`;
      diagnostics.push({
        severity: "warning",
        code: "TAR_UNSUPPORTED_TYPE",
        message: `条目 "${fullName}" 类型 '${typeflagRaw}' 不受支持，仅记录不解包`,
        offset,
      });
    }

    entries.push({
      index: entries.length,
      name: fullName,
      type,
      typeflag: typeflagRaw === "" ? "0" : typeflagRaw,
      size,
      headerOffset: offset,
      dataOffset,
      sha256,
      unsupportedReason,
    });

    // 前进到下一个头部：头部 1 块 + 载荷按 512 向上取整（填充不计入文件大小）
    const dataBlocks = Math.ceil(size / BLOCK_SIZE);
    offset = dataOffset + dataBlocks * BLOCK_SIZE;
    continue outer;
  }

  return { entries, diagnostics, endMarker, archiveSha256, totalBytes: buf.length };
}
