import { BLOCK_SIZE } from "./parser.js";

export interface FixtureEntry {
  name: string;
  prefix?: string;
  typeflag?: string;
  content?: Buffer | string;
}

function writeString(buf: Buffer, str: string, offset: number, maxLen: number): void {
  const b = Buffer.from(str, "utf8");
  b.copy(buf, offset, 0, Math.min(b.length, maxLen));
}

function writeOctal(buf: Buffer, value: number, offset: number, len: number): void {
  const s = value.toString(8).padStart(len - 1, "0");
  buf.write(s, offset, len - 1, "ascii");
  buf[offset + len - 1] = 0;
}

export function buildHeader(entry: FixtureEntry): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  writeString(header, entry.name, 0, 100);
  writeOctal(header, 0o644, 100, 8); // mode
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  const content = entry.content === undefined
    ? Buffer.alloc(0)
    : Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
  writeOctal(header, content.length, 124, 12);
  writeOctal(header, 0, 136, 12); // mtime
  // 校验和字段先填空格再计算
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header[156] = (entry.typeflag ?? "0").charCodeAt(0);
  writeString(header, "ustar", 257, 6);
  header[263] = 0x30; // version "00"
  header[264] = 0x30;
  if (entry.prefix) writeString(header, entry.prefix, 345, 155);
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  const chk = sum.toString(8).padStart(6, "0");
  header.write(chk, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/** 构造完整 tar 字节：头部 + 载荷 + 填充，结尾两个零块。 */
export function buildTar(entries: FixtureEntry[], options?: { endBlocks?: 0 | 1 | 2 }): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const content = e.content === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, "utf8");
    parts.push(buildHeader(e));
    parts.push(content);
    const pad = (BLOCK_SIZE - (content.length % BLOCK_SIZE)) % BLOCK_SIZE;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  const endBlocks = options?.endBlocks ?? 2;
  for (let i = 0; i < endBlocks; i++) parts.push(Buffer.alloc(BLOCK_SIZE, 0));
  return Buffer.concat(parts);
}
