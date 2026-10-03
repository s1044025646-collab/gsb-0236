// 自研 USTAR 子集解析器：严格按 512 字节块解析头部与载荷边界。
// 不支持 gzip / PAX / GNU 扩展 / 稀疏文件 / 链接 / base-256 长度编码。
import { createHash } from "node:crypto";
import { AppError } from "./errors";

export const BLOCK = 512;
export const MAX_ARCHIVE_SIZE = 64 * 1024 * 1024; // 64 MiB
export const MAX_ENTRIES = 10000;
export const MAX_PATH_LEN = 255;
export const MAX_FILE_SIZE = 32 * 1024 * 1024;

export type EntryType = "file" | "dir";

export interface TarEntry {
  index: number;
  path: string; // 规范化后的相对路径（POSIX 分隔符）
  type: EntryType;
  size: number;
  headerOffset: number;
  dataOffset: number; // 目录为 -1
  sha256: string | null; // 仅普通文件
}

export interface ParseResult {
  entries: TarEntry[];
  diagnostics: string[];
  size: number;
  sha256: string;
}

function isZeroBlock(buf: Buffer, off: number): boolean {
  for (let i = 0; i < BLOCK; i++) if (buf[off + i] !== 0) return false;
  return true;
}

// 严格八进制字段：允许前导空格/NUL，数字间不得有非法字符，以空格或 NUL 结尾。
export function parseOctalField(buf: Buffer, off: number, len: number, fieldName: string): number {
  // 拒绝 GNU base-256 编码（最高位置 1）
  if (buf[off] & 0x80) {
    throw new AppError("E_UNSUPPORTED_ENCODING", `字段 ${fieldName} 使用了不支持的 base-256 编码`);
  }
  let i = 0;
  while (i < len && (buf[off + i] === 0x20 || buf[off + i] === 0)) i++;
  let val = 0;
  let digits = 0;
  for (; i < len; i++) {
    const c = buf[off + i];
    if (c === 0 || c === 0x20) break;
    if (c < 0x30 || c > 0x37) {
      throw new AppError("E_BAD_OCTAL", `字段 ${fieldName} 含非法八进制字符 0x${c.toString(16)}`);
    }
    val = val * 8 + (c - 0x30);
    digits++;
    if (val > Number.MAX_SAFE_INTEGER / 8) {
      throw new AppError("E_BAD_OCTAL", `字段 ${fieldName} 数值过大`);
    }
  }
  if (digits === 0) {
    throw new AppError("E_BAD_OCTAL", `字段 ${fieldName} 缺少八进制数字`);
  }
  return val;
}

function readString(buf: Buffer, off: number, len: number): string {
  let end = off;
  const limit = off + len;
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString("utf8", off, end);
}

function verifyChecksum(buf: Buffer, off: number): void {
  const stored = parseOctalField(buf, off + 148, 8, "chksum");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : buf[off + i];
  }
  if (sum !== stored) {
    throw new AppError("E_BAD_CHECKSUM", `头部校验和不匹配：存储 ${stored}，计算 ${sum}`);
  }
}

// 路径规范化与安全校验：拒绝绝对路径、盘符、向上越界、NUL、反斜杠混淆。
export function sanitizePath(raw: string): string {
  if (raw.length === 0) throw new AppError("E_PATH_UNSAFE", "条目路径为空");
  if (/\0/.test(raw)) throw new AppError("E_PATH_UNSAFE", `路径含 NUL 字符: ${JSON.stringify(raw)}`);
  if (raw.length > MAX_PATH_LEN) throw new AppError("E_PATH_UNSAFE", `路径超长: ${raw.slice(0, 64)}...`);
  if (/^[a-zA-Z]:/.test(raw)) throw new AppError("E_PATH_UNSAFE", `路径含盘符: ${raw}`);
  const norm = raw.replace(/\\/g, "/");
  if (norm.startsWith("/") || norm.startsWith("//")) {
    throw new AppError("E_PATH_UNSAFE", `绝对路径被拒绝: ${raw}`);
  }
  const parts = norm.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") throw new AppError("E_PATH_UNSAFE", `路径向上越界: ${raw}`);
    out.push(p);
  }
  if (out.length === 0) throw new AppError("E_PATH_UNSAFE", `路径规范化后为空: ${raw}`);
  const joined = out.join("/");
  if (joined.length > MAX_PATH_LEN) throw new AppError("E_PATH_UNSAFE", `路径超长: ${joined}`);
  return joined;
}

export function parseTar(buf: Buffer): ParseResult {
  if (buf.length > MAX_ARCHIVE_SIZE) {
    throw new AppError("E_LIMIT_EXCEEDED", `归档超过大小上限 ${MAX_ARCHIVE_SIZE} 字节`);
  }
  if (buf.length % BLOCK !== 0) {
    throw new AppError("E_TRUNCATED", `归档大小 ${buf.length} 不是 512 的整数倍（可能被截断）`);
  }
  const entries: TarEntry[] = [];
  const diagnostics: string[] = [];
  let off = 0;
  let zeroBlocks = 0;
  let sawEnd = false;

  while (off < buf.length) {
    if (isZeroBlock(buf, off)) {
      zeroBlocks++;
      off += BLOCK;
      if (zeroBlocks >= 2) {
        sawEnd = true;
        break;
      }
      continue;
    }
    zeroBlocks = 0;
    if (entries.length >= MAX_ENTRIES) {
      throw new AppError("E_LIMIT_EXCEEDED", `条目数超过上限 ${MAX_ENTRIES}`);
    }
    verifyChecksum(buf, off);
    const magic = readString(buf, off + 257, 5);
    if (magic !== "ustar") {
      throw new AppError("E_BAD_HEADER", `非 USTAR 归档（magic=${JSON.stringify(magic)}），仅支持标准 USTAR 子集`);
    }
    const name = readString(buf, off, 100);
    const prefix = readString(buf, off + 345, 155);
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const size = parseOctalField(buf, off + 124, 12, "size");
    const typeflag = buf[off + 156];

    let type: EntryType;
    if (typeflag === 0x30 || typeflag === 0) {
      type = "file";
    } else if (typeflag === 0x35) {
      type = "dir";
    } else {
      throw new AppError(
        "E_UNSUPPORTED_TYPE",
        `条目 ${JSON.stringify(rawPath)} 类型 typeflag=0x${typeflag.toString(16)} 不受支持（链接/设备/PAX/GNU 扩展均被拒绝）`
      );
    }
    const path = sanitizePath(rawPath);

    const headerOffset = off;
    let dataOffset = -1;
    let sha256: string | null = null;
    if (type === "file") {
      if (size > MAX_FILE_SIZE) {
        throw new AppError("E_LIMIT_EXCEEDED", `文件 ${path} 大小 ${size} 超过上限`);
      }
      dataOffset = off + BLOCK;
      const dataEnd = dataOffset + size;
      if (dataEnd > buf.length) {
        throw new AppError("E_TRUNCATED", `文件 ${path} 声明大小 ${size} 超出归档剩余数据（截断）`);
      }
      sha256 = createHash("sha256").update(buf.subarray(dataOffset, dataEnd)).digest("hex");
      // 载荷按 512 向上取整跳过填充；填充字节不计入文件大小
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (dataOffset + padded > buf.length) {
        throw new AppError("E_TRUNCATED", `文件 ${path} 的填充区超出归档末尾（截断）`);
      }
      off = dataOffset + padded;
    } else {
      off += BLOCK;
    }
    entries.push({
      index: entries.length,
      path,
      type,
      size: type === "file" ? size : 0,
      headerOffset,
      dataOffset,
      sha256,
    });
  }

  if (!sawEnd) {
    if (entries.length === 0 && buf.length === 0) {
      throw new AppError("E_TRUNCATED", "归档为空");
    }
    diagnostics.push("缺少双零块结束标记（归档可能被截断或未正确收尾），已按已解析条目导入");
  } else {
    const trailing = buf.length - off;
    if (trailing > 0) diagnostics.push(`结束标记后存在 ${trailing} 字节尾部数据，已忽略`);
  }

  return {
    entries,
    diagnostics,
    size: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}
