// 生成演示用 USTAR 归档：目录、空文件、不同长度载荷、prefix 长路径、跨块填充。
import fs from "node:fs";
import path from "node:path";
import { BLOCK } from "./tar";

function octalField(value: number, len: number): Buffer {
  const s = value.toString(8).padStart(len - 1, "0");
  const b = Buffer.alloc(len, 0);
  b.write(s, 0, "ascii");
  return b;
}

function strField(s: string, len: number): Buffer {
  const b = Buffer.alloc(len, 0);
  b.write(s, 0, "utf8");
  return b;
}

export function headerBlock(opts: { name: string; prefix?: string; size: number; type: "file" | "dir" }): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  strField(opts.name, 100).copy(h, 0);
  octalField(0o644, 8).copy(h, 100);
  octalField(0, 8).copy(h, 108);
  octalField(0, 8).copy(h, 116);
  octalField(opts.size, 12).copy(h, 124);
  octalField(Math.floor(Date.now() / 1000), 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h[156] = opts.type === "dir" ? 0x35 : 0x30;
  strField("ustar", 6).copy(h, 257);
  strField("00", 2).copy(h, 263);
  if (opts.prefix) strField(opts.prefix, 155).copy(h, 345);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  const chk = sum.toString(8).padStart(6, "0");
  h.write(chk, 148, "ascii");
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

export function buildTar(
  entries: Array<{ name: string; prefix?: string; data?: Buffer; type?: "file" | "dir" }>
): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "file";
    const data = type === "dir" ? Buffer.alloc(0) : e.data ?? Buffer.alloc(0);
    parts.push(headerBlock({ name: e.name, prefix: e.prefix, size: data.length, type }));
    if (type === "file" && data.length > 0) {
      parts.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad > 0) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

export function writeSample(outPath: string): string {
  const abs = path.resolve(outPath);
  const payload511 = Buffer.alloc(511);
  for (let i = 0; i < 511; i++) payload511[i] = 65 + (i % 26);
  const payload512 = Buffer.alloc(512);
  for (let i = 0; i < 512; i++) payload512[i] = 97 + (i % 26);
  const payload513 = Buffer.alloc(513);
  for (let i = 0; i < 513; i++) payload513[i] = 48 + (i % 10);
  const tar = buildTar([
    { name: "docs", type: "dir" },
    { name: "empty.txt", prefix: "docs", data: Buffer.alloc(0) },
    { name: "hello.txt", prefix: "docs", data: Buffer.from("你好，USTAR！\n", "utf8") },
    { name: "payload-511.bin", data: payload511 },
    { name: "payload-512.bin", data: payload512 },
    { name: "payload-513.bin", data: payload513 },
    {
      name: "deep-file.txt",
      prefix: "a/very/long/prefix/path/that/demonstrates/ustar/prefix/joining/for/long/names",
      data: Buffer.from("prefix path content\n", "utf8"),
    },
  ]);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, tar);
  return abs;
}
