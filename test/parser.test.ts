import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseTar, BLOCK_SIZE } from "../src/tar/parser.js";
import { buildTar, buildHeader } from "../src/tar/builder.js";
import { AppError } from "../src/errors.js";

test("解析普通文件与目录，校验和正确", () => {
  const buf = buildTar([
    { name: "dir", typeflag: "5" },
    { name: "dir/a.txt", content: "hello" },
  ]);
  const r = parseTar(buf);
  assert.equal(r.endMarker, "clean");
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].type, "directory");
  assert.equal(r.entries[1].type, "file");
  assert.equal(r.entries[1].size, 5);
  assert.equal(r.entries[1].headerOffset, BLOCK_SIZE);
  assert.equal(r.entries[1].dataOffset, 2 * BLOCK_SIZE);
  assert.equal(
    r.entries[1].sha256,
    createHash("sha256").update("hello").digest("hex")
  );
});

test("511/512/513 字节载荷的填充边界", () => {
  const c511 = Buffer.alloc(511, 0x41);
  const c512 = Buffer.alloc(512, 0x42);
  const c513 = Buffer.alloc(513, 0x43);
  const buf = buildTar([
    { name: "f511", content: c511 },
    { name: "f512", content: c512 },
    { name: "f513", content: c513 },
  ]);
  const r = parseTar(buf);
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries[0].size, 511);
  assert.equal(r.entries[1].headerOffset, 2 * BLOCK_SIZE); // 511 -> 1 字节填充，仍占 1 块
  assert.equal(r.entries[1].size, 512);
  assert.equal(r.entries[2].headerOffset, 4 * BLOCK_SIZE); // 512 无填充
  assert.equal(r.entries[2].size, 513);
  assert.equal(r.entries[2].sha256, createHash("sha256").update(c513).digest("hex"));
});

test("零字节文件是独立条目", () => {
  const buf = buildTar([
    { name: "empty.txt", content: "" },
    { name: "after.txt", content: "x" },
  ]);
  const r = parseTar(buf);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].size, 0);
  assert.equal(r.entries[0].sha256, createHash("sha256").update("").digest("hex"));
  assert.equal(r.entries[1].headerOffset, BLOCK_SIZE);
});

test("prefix 与 name 组合路径", () => {
  const buf = buildTar([{ name: "file.txt", prefix: "some/long/prefix", content: "v" }]);
  const r = parseTar(buf);
  assert.equal(r.entries[0].name, "some/long/prefix/file.txt");
});

test("坏校验和导致解析终止", () => {
  const buf = buildTar([{ name: "a.txt", content: "a" }]);
  buf[0] = buf[0] === 0x61 ? 0x62 : 0x61; // 改 name 第一个字节，校验和失效
  assert.throws(() => parseTar(buf), (e: unknown) => e instanceof AppError && e.code === "TAR_BAD_CHECKSUM");
});

test("坏八进制 size 字段被拒绝", () => {
  const good = buildHeader({ name: "a.txt", content: "a" });
  const bad = Buffer.from(good);
  bad.write("12z4", 124, "ascii");
  // 重算校验和以隔离八进制错误
  for (let i = 148; i < 156; i++) bad[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += bad[i];
  bad.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  bad[154] = 0; bad[155] = 0x20;
  const buf = Buffer.concat([bad, Buffer.alloc(BLOCK_SIZE, 0), Buffer.alloc(2 * BLOCK_SIZE, 0)]);
  assert.throws(() => parseTar(buf), (e: unknown) => e instanceof AppError && e.code === "TAR_BAD_OCTAL");
});

test("截断的载荷被拒绝且不越界读取", () => {
  const full = buildTar([{ name: "big.bin", content: Buffer.alloc(1000, 0x5a) }]);
  const truncated = full.subarray(0, BLOCK_SIZE + 500); // 声明 1000，只有 500
  assert.throws(() => parseTar(truncated), (e: unknown) => e instanceof AppError && e.code === "TAR_TRUNCATED");
});

test("缺失结束块产生警告但仍给出清单", () => {
  const buf = buildTar([{ name: "a.txt", content: "a" }], { endBlocks: 0 });
  const r = parseTar(buf);
  assert.equal(r.endMarker, "missing");
  assert.equal(r.entries.length, 1);
  assert.ok(r.diagnostics.some((d) => d.code === "TAR_MISSING_END"));
});

test("单个零块标记为 single-zero-block", () => {
  const buf = buildTar([{ name: "a.txt", content: "a" }], { endBlocks: 1 });
  const r = parseTar(buf);
  assert.equal(r.endMarker, "single-zero-block");
});

test("不支持的类型被记录但不进入可解包清单", () => {
  const buf = buildTar([
    { name: "link", typeflag: "2", content: "" },
    { name: "real.txt", content: "ok" },
  ]);
  const r = parseTar(buf);
  assert.equal(r.entries[0].type, "unsupported");
  assert.ok(r.diagnostics.some((d) => d.code === "TAR_UNSUPPORTED_TYPE"));
  assert.equal(r.entries[1].type, "file");
});

test("非 USTAR magic 被拒绝", () => {
  const buf = buildTar([{ name: "a.txt", content: "a" }]);
  buf.write("notustar!", 257, "ascii");
  // 重算校验和
  for (let i = 148; i < 156; i++) buf[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buf[154] = 0; buf[155] = 0x20;
  assert.throws(() => parseTar(buf), (e: unknown) => e instanceof AppError && e.code === "TAR_BAD_MAGIC");
});
