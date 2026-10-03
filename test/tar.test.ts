import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTar, sanitizePath, BLOCK } from "../src/tar";
import { buildTar, headerBlock } from "../src/sample";
import { AppError } from "../src/errors";

function fixChecksum(h: Buffer): Buffer {
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

test("解析目录、空文件、511/512/513 字节载荷与 prefix 路径", () => {
  const p511 = Buffer.alloc(511, 1);
  const p512 = Buffer.alloc(512, 2);
  const p513 = Buffer.alloc(513, 3);
  const tar = buildTar([
    { name: "dir1", type: "dir" },
    { name: "empty.bin", prefix: "dir1", data: Buffer.alloc(0) },
    { name: "a.bin", data: p511 },
    { name: "b.bin", data: p512 },
    { name: "c.bin", data: p513 },
  ]);
  const r = parseTar(tar);
  assert.equal(r.entries.length, 5);
  assert.equal(r.entries[0].type, "dir");
  assert.equal(r.entries[1].path, "dir1/empty.bin");
  assert.equal(r.entries[1].size, 0);
  assert.equal(r.entries[1].type, "file");
  assert.equal(r.entries[2].size, 511);
  assert.equal(r.entries[3].size, 512);
  assert.equal(r.entries[4].size, 513);
  assert.equal(r.entries[3].headerOffset % BLOCK, 0);
  assert.equal(r.entries[3].headerOffset, r.entries[2].headerOffset + BLOCK + BLOCK);
  assert.equal(r.entries[4].headerOffset, r.entries[3].headerOffset + BLOCK + BLOCK);
  assert.equal(r.diagnostics.length, 0);
});

test("校验和不匹配被拒绝", () => {
  const tar = Buffer.from(buildTar([{ name: "x.txt", data: Buffer.from("hi") }]));
  tar[0] = 0x7f;
  assert.throws(() => parseTar(tar), (e: AppError) => e.code === "E_BAD_CHECKSUM");
});

test("坏八进制 size 字段被拒绝", () => {
  const h = headerBlock({ name: "x", size: 1, type: "file" });
  h[124] = 0x39;
  fixChecksum(h);
  const tar = Buffer.concat([h, Buffer.alloc(BLOCK, 0), Buffer.alloc(BLOCK * 2, 0)]);
  assert.throws(() => parseTar(tar), (e: AppError) => e.code === "E_BAD_OCTAL");
});

test("base-256 长度编码被拒绝", () => {
  const h = headerBlock({ name: "x", size: 1, type: "file" });
  h[124] = 0x80;
  fixChecksum(h);
  const tar = Buffer.concat([h, Buffer.alloc(BLOCK, 0), Buffer.alloc(BLOCK * 2, 0)]);
  assert.throws(() => parseTar(tar), (e: AppError) => e.code === "E_UNSUPPORTED_ENCODING");
});

test("截断：声明大小超出归档末尾", () => {
  const tar = buildTar([{ name: "big.bin", data: Buffer.alloc(1024, 7) }]);
  const truncated = Buffer.from(tar.subarray(0, BLOCK * 2));
  assert.throws(() => parseTar(truncated), (e: AppError) => e.code === "E_TRUNCATED");
});

test("截断：总大小不是 512 的倍数", () => {
  const tar = buildTar([{ name: "a", data: Buffer.from("x") }]);
  assert.throws(() => parseTar(tar.subarray(0, tar.length - 1)), (e: AppError) => e.code === "E_TRUNCATED");
});

test("缺失结束块：导入成功但带诊断", () => {
  const full = buildTar([{ name: "a.txt", data: Buffer.from("abc") }]);
  const noEnd = Buffer.from(full.subarray(0, full.length - BLOCK * 2));
  const r = parseTar(noEnd);
  assert.equal(r.entries.length, 1);
  assert.ok(r.diagnostics.some((d) => d.includes("结束标记")));
});

test("链接与不支持的类型被拒绝", () => {
  const h = headerBlock({ name: "ln", size: 0, type: "file" });
  h[156] = 0x32;
  fixChecksum(h);
  const tar = Buffer.concat([h, Buffer.alloc(BLOCK * 2, 0)]);
  assert.throws(() => parseTar(tar), (e: AppError) => e.code === "E_UNSUPPORTED_TYPE");
});

test("越界路径被拒绝", () => {
  for (const bad of ["../evil", "a/../../b", "/abs/path", "C:/win/evil", "c:\\win", "a//../b"]) {
    assert.throws(() => sanitizePath(bad), (e: AppError) => e.code === "E_PATH_UNSAFE", bad);
  }
  assert.equal(sanitizePath("a/./b//c"), "a/b/c");
  assert.equal(sanitizePath("a\\b\\c"), "a/b/c");
});

test("归档内含越界路径条目时导入失败", () => {
  const tar = buildTar([{ name: "../escape.txt", data: Buffer.from("x") }]);
  assert.throws(() => parseTar(tar), (e: AppError) => e.code === "E_PATH_UNSAFE");
});

test("零长度归档被拒绝", () => {
  assert.throws(() => parseTar(Buffer.alloc(0)), (e: AppError) => e.code === "E_TRUNCATED");
});
