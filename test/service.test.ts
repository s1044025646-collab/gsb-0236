import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Service } from "../src/service";
import { writeSample, buildTar } from "../src/sample";
import { AppError } from "../src/errors";

let workDir: string;
let svc: Service;
let prevCwd: string;

before(() => {
  prevCwd = process.cwd();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ustar-test-"));
  process.chdir(workDir);
  svc = new Service({ dataDir: path.join(workDir, "data") });
  writeSample(path.join(workDir, "samples", "sample.tar"));
});

after(() => {
  svc.close();
  process.chdir(prevCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

test("导入样例并查看清单", () => {
  const imp = svc.importArchive("samples/sample.tar");
  assert.ok(imp.archiveId > 0);
  const { entries } = svc.manifest(imp.archiveId) as any;
  assert.equal(entries.length, 7);
  const empty = entries.find((e: any) => e.path === "docs/empty.txt");
  assert.equal(empty.size, 0);
  const deep = entries.find((e: any) => e.path.startsWith("a/very/long/prefix"));
  assert.ok(deep, "prefix 路径应被正确组合");
});

test("服务重启后可查询记录", () => {
  const svc2 = new Service({ dataDir: path.join(workDir, "data") });
  assert.ok(svc2.store.listArchives().length >= 1);
  svc2.close();
});

test("只解出指定普通文件并核对摘要", () => {
  const imp = svc.importArchive("samples/sample.tar");
  const { entries } = svc.manifest(imp.archiveId) as any;
  const file = entries.find((e: any) => e.path === "docs/hello.txt");
  const plan = svc.plan(imp.archiveId, "out-partial", [file.idx]);
  svc.execute(plan.planId);
  const v = svc.verify(plan.planId);
  assert.equal(v.ok, true);
  const outFile = path.join(workDir, "out-partial", "docs", "hello.txt");
  assert.equal(fs.readFileSync(outFile, "utf8"), "你好，USTAR！\n");
  assert.equal(fs.existsSync(path.join(workDir, "out-partial", "payload-511.bin")), false);
});

test("目标目录已存在时拒绝覆盖", () => {
  const imp = svc.importArchive("samples/sample.tar");
  fs.mkdirSync(path.join(workDir, "existing-dir"));
  assert.throws(
    () => svc.plan(imp.archiveId, "existing-dir"),
    (e: AppError) => e.code === "E_TARGET_EXISTS"
  );
});

test("重复目标路径被拒绝", () => {
  const tar = buildTar([
    { name: "dup.txt", data: Buffer.from("1") },
    { name: "./dup.txt", data: Buffer.from("2") },
  ]);
  fs.writeFileSync(path.join(workDir, "dup.tar"), tar);
  const imp = svc.importArchive("dup.tar");
  assert.throws(
    () => svc.plan(imp.archiveId, "out-dup"),
    (e: AppError) => e.code === "E_DUPLICATE_TARGET"
  );
});

test("解析失败不发布半份结果", () => {
  fs.writeFileSync(path.join(workDir, "bad.tar"), Buffer.from("junk".padEnd(512, " ")));
  const before = svc.store.listArchives().length;
  assert.throws(() => svc.importArchive("bad.tar"));
  assert.equal(svc.store.listArchives().length, before);
});

test("拒绝项目外路径与非 tar 文件", () => {
  assert.throws(() => svc.importArchive("../outside.tar"), (e: AppError) => e.code === "E_PATH_UNSAFE");
  fs.writeFileSync(path.join(workDir, "x.txt"), "hi");
  assert.throws(() => svc.importArchive("x.txt"), (e: AppError) => e.code === "E_INVALID_ARG");
});

test("导出报告", () => {
  const imp = svc.importArchive("samples/sample.tar");
  const { file } = svc.report(imp.archiveId);
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(report.archive.id, imp.archiveId);
  assert.ok(Array.isArray(report.entries));
});
