import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Store } from "../src/db.js";
import { UstarService } from "../src/service.js";
import { buildTar } from "../src/tar/builder.js";
import { AppError } from "../src/errors.js";

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ustar-test-"));
  const service = new UstarService(new Store(dir), dir);
  const tarPath = path.join(dir, "sample.tar");
  fs.writeFileSync(tarPath, buildTar([
    { name: "docs", typeflag: "5" },
    { name: "empty.txt", prefix: "docs", content: "" },
    { name: "hello.txt", prefix: "docs", content: "hello world" },
    { name: "evil/../../escape.txt", content: "x" },
    { name: "abs.txt", content: "y" },
    { name: "link", typeflag: "2" },
  ]));
  return { dir, service, tarPath };
}

test("导入-计划-解包-核对-报告 全流程", () => {
  const { service, tarPath } = makeEnv();
  const { archive } = service.importArchive(tarPath);
  const plan = service.previewPlan(archive.id, ["docs/hello.txt", "docs/empty.txt"], "out1");
  assert.equal(plan.items.length, 2);
  const ext = service.executePlan(plan.planId);
  assert.equal(ext.status, "done");
  const verify = service.verifyExtraction(ext.id);
  assert.equal(verify.allOk, true);
  const helloDisk = fs.readFileSync(path.join(ext.target_dir, "docs", "hello.txt"));
  assert.equal(helloDisk.toString(), "hello world");
  assert.ok(fs.existsSync(path.join(ext.target_dir, "docs", "empty.txt")));
  const report = service.exportReport(archive.id);
  assert.ok(fs.existsSync(report));
  service.store.close();
});

test("越界路径条目在计划阶段被拒绝", () => {
  const { service, tarPath } = makeEnv();
  const { archive } = service.importArchive(tarPath);
  assert.throws(
    () => service.previewPlan(archive.id, ["evil/../../escape.txt"], "out2"),
    (e: unknown) => e instanceof AppError && e.code === "PATH_ESCAPE"
  );
  service.store.close();
});

test("链接类型条目明确拒绝解包", () => {
  const { service, tarPath } = makeEnv();
  const { archive } = service.importArchive(tarPath);
  assert.throws(
    () => service.previewPlan(archive.id, ["link"], "out3"),
    (e: unknown) => e instanceof AppError && e.code === "PATH_LINK"
  );
  service.store.close();
});

test("目标目录已存在时拒绝覆盖", () => {
  const { dir, service, tarPath } = makeEnv();
  const { archive } = service.importArchive(tarPath);
  fs.mkdirSync(path.join(dir, "extracted", "taken"), { recursive: true });
  const plan = service.previewPlan(archive.id, ["docs/hello.txt"], "taken");
  assert.equal(plan.targetExists, true);
  assert.throws(
    () => service.executePlan(plan.planId),
    (e: unknown) => e instanceof AppError && e.code === "TARGET_EXISTS"
  );
  service.store.close();
});

test("重复目标路径被拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ustar-test-"));
  const service = new UstarService(new Store(dir), dir);
  const tarPath = path.join(dir, "dup.tar");
  fs.writeFileSync(tarPath, buildTar([
    { name: "a.txt", content: "1" },
    { name: "./a.txt", content: "2" },
  ]));
  const { archive } = service.importArchive(tarPath);
  assert.throws(
    () => service.previewPlan(archive.id, undefined, "dupout"),
    (e: unknown) => e instanceof AppError && e.code === "PATH_DUPLICATE"
  );
  service.store.close();
});

test("解包失败不发布半成品结果", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ustar-test-"));
  const service = new UstarService(new Store(dir), dir);
  const tarPath = path.join(dir, "s.tar");
  fs.writeFileSync(tarPath, buildTar([{ name: "f.txt", content: "data" }]));
  const { archive } = service.importArchive(tarPath);
  const plan = service.previewPlan(archive.id, ["f.txt"], "willfail");
  // 篡改留档归档内容，使执行前一致性检查失败
  fs.writeFileSync(archive.source_path, Buffer.alloc(1024, 1));
  assert.throws(() => service.executePlan(plan.planId));
  const exts = service.listExtractions(archive.id);
  assert.equal(exts.length, 1);
  assert.equal(exts[0].status, "failed");
  assert.equal(fs.existsSync(plan.targetDir), false); // 无半成品目录
  service.store.close();
});

test("重启后可查询历史记录", () => {
  const { dir, service, tarPath } = makeEnv();
  const { archive } = service.importArchive(tarPath);
  const plan = service.previewPlan(archive.id, ["docs/hello.txt"], "persist");
  service.executePlan(plan.planId);
  service.store.close();

  const service2 = new UstarService(new Store(dir), dir);
  const archives = service2.listArchives();
  assert.equal(archives.length, 1);
  const manifest = service2.manifest(archive.id);
  assert.equal(manifest.entries.length, 6);
  const exts = service2.listExtractions(archive.id);
  assert.equal(exts.length, 1);
  assert.equal(exts[0].status, "done");
  assert.equal(service2.verifyExtraction(exts[0].id).allOk, true);
  service2.store.close();
});

test("成功文件摘要与归档内容一致", () => {
  const { service, tarPath } = makeEnv();
  const { archive, entries } = service.importArchive(tarPath);
  const hello = entries.find((e) => e.name === "docs/hello.txt");
  assert.equal(hello!.sha256, createHash("sha256").update("hello world").digest("hex"));
  const empty = entries.find((e) => e.name === "docs/empty.txt");
  assert.equal(empty!.sha256, createHash("sha256").update("").digest("hex"));
  service.store.close();
});
