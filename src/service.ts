// 业务层：导入归档、生成解包计划、执行解包、核对与报告。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseTar, sanitizePath, TarEntry, MAX_ARCHIVE_SIZE } from "./tar";
import { Store } from "./db";
import { AppError } from "./errors";

export interface ServiceOptions {
  dataDir: string; // 项目内数据目录（SQLite、报告、默认目标根）
}

export class Service {
  store: Store;
  dataDir: string;
  constructor(opts: ServiceOptions) {
    this.dataDir = path.resolve(opts.dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.store = new Store(path.join(this.dataDir, "ustar.db"));
  }

  close() {
    this.store.close();
  }

  // 只允许导入项目内（CWD 下）的 .tar 文件，不扫描用户其他目录
  private resolveSource(p: string): string {
    if (typeof p !== "string" || p.length === 0) throw new AppError("E_INVALID_ARG", "缺少归档路径");
    const abs = path.resolve(process.cwd(), p);
    const cwd = process.cwd();
    if (!(abs === cwd || abs.startsWith(cwd + path.sep))) {
      throw new AppError("E_PATH_UNSAFE", `仅允许导入项目目录内的归档文件: ${p}`);
    }
    if (!abs.toLowerCase().endsWith(".tar")) {
      throw new AppError("E_INVALID_ARG", "仅支持未压缩的 .tar 文件");
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new AppError("E_NOT_FOUND", `归档文件不存在: ${p}`, 404);
    }
    const size = fs.statSync(abs).size;
    if (size > MAX_ARCHIVE_SIZE) throw new AppError("E_LIMIT_EXCEEDED", `归档超过大小上限 ${MAX_ARCHIVE_SIZE}`);
    return abs;
  }

  importArchive(sourcePath: string) {
    const abs = this.resolveSource(sourcePath);
    const buf = fs.readFileSync(abs);
    const result = parseTar(buf); // 解析失败则抛错，不落库
    const archiveId = this.store.createArchive(abs, result.sha256, result.size, result.diagnostics, result.entries);
    return { archiveId, ...result, sourcePath: abs };
  }

  manifest(archiveId: number) {
    const archive = this.store.getArchive(archiveId);
    const entries = this.store.listEntries(archiveId);
    return { archive, entries };
  }

  // 规范化目标目录：必须位于项目内，且不存在（拒绝覆盖）
  private resolveTargetDir(targetDir: string): string {
    if (typeof targetDir !== "string" || targetDir.trim().length === 0) {
      throw new AppError("E_INVALID_ARG", "缺少目标目录");
    }
    const abs = path.resolve(process.cwd(), targetDir);
    const cwd = process.cwd();
    if (!(abs.startsWith(cwd + path.sep))) {
      throw new AppError("E_PATH_UNSAFE", `目标目录必须位于项目目录内: ${targetDir}`);
    }
    if (fs.existsSync(abs)) {
      throw new AppError("E_TARGET_EXISTS", `目标目录已存在，拒绝覆盖: ${targetDir}`);
    }
    return abs;
  }

  // 预览解包计划：校验条目、规范化目标路径、检查重复目标
  plan(archiveId: number, targetDir: string, entryIdxs?: number[]) {
    const { entries } = this.manifest(archiveId);
    const all = entries as unknown as Array<{ idx: number; path: string; type: string }>;
    let selected = all;
    if (entryIdxs !== undefined) {
      if (!Array.isArray(entryIdxs) || entryIdxs.length === 0) {
        throw new AppError("E_INVALID_ARG", "entryIdxs 必须是非空数组");
      }
      const wanted = new Set(entryIdxs.map((n) => {
        if (!Number.isInteger(n) || n < 0) throw new AppError("E_INVALID_ARG", `非法条目序号: ${n}`);
        return n;
      }));
      selected = all.filter((e) => wanted.has(e.idx));
      if (selected.length !== wanted.size) {
        const found = new Set(selected.map((e) => e.idx));
        const missing = [...wanted].filter((i) => !found.has(i));
        throw new AppError("E_NOT_FOUND", `条目不存在: ${missing.join(", ")}`, 404);
      }
    }
    const absTarget = this.resolveTargetDir(targetDir);
    const seen = new Map<string, number>();
    const items = selected.map((e) => {
      const rel = sanitizePath(e.path); // 二次校验，防御数据库被篡改
      const targetPath = path.join(absTarget, ...rel.split("/"));
      // 规范化后必须仍在目标目录内
      if (!(targetPath === absTarget || targetPath.startsWith(absTarget + path.sep))) {
        throw new AppError("E_PATH_UNSAFE", `目标路径越界: ${e.path}`);
      }
      const key = targetPath.toLowerCase(); // Windows 大小写不敏感
      if (seen.has(key)) {
        throw new AppError("E_DUPLICATE_TARGET", `重复目标路径: ${e.path}（与条目 ${seen.get(key)} 冲突）`);
      }
      seen.set(key, e.idx);
      return { entryIdx: e.idx, path: e.path, type: e.type, targetPath };
    });
    const planId = this.store.createPlan(archiveId, absTarget, items);
    return { planId, archiveId, targetDir: absTarget, items };
  }

  // 执行解包：只解普通文件与目录；失败整体标记 failed，不登记成功
  execute(planId: number) {
    const plan = this.store.getPlan(planId);
    if (plan.status === "done") throw new AppError("E_PLAN_NOT_READY", `计划 ${planId} 已执行完成`);
    if (plan.status === "executing") throw new AppError("E_PLAN_NOT_READY", `计划 ${planId} 正在执行`);
    const archive = this.store.getArchive(plan.archive_id);
    const buf = fs.readFileSync(archive.source_path); // 源归档保持原样，只读
    const parsed = parseTar(buf); // 重新解析，不信任缓存
    const byIdx = new Map<number, TarEntry>(parsed.entries.map((e) => [e.index, e]));

    const targetDir: string = plan.target_dir;
    if (fs.existsSync(targetDir)) {
      this.store.finishPlan(planId, false, "目标目录已存在，拒绝覆盖");
      throw new AppError("E_TARGET_EXISTS", "目标目录已存在，拒绝覆盖");
    }
    this.store.markPlanExecuting(planId);
    try {
      fs.mkdirSync(targetDir, { recursive: false });
      const items = plan.items as Array<any>;
      for (const item of items) {
        const entry = byIdx.get(item.entry_idx);
        if (!entry) throw new AppError("E_INTERNAL", `条目 ${item.entry_idx} 在归档中不存在`);
        const targetPath: string = item.target_path;
        if (!(targetPath.startsWith(targetDir + path.sep))) {
          throw new AppError("E_PATH_UNSAFE", `目标路径越界: ${targetPath}`);
        }
        if (entry.type === "dir") {
          fs.mkdirSync(targetPath, { recursive: true });
          this.store.setItemStatus(item.id, "done", null);
        } else {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          const data = buf.subarray(entry.dataOffset, entry.dataOffset + entry.size);
          // 写前再核对摘要，确保与归档内容一致
          const sha = createHash("sha256").update(data).digest("hex");
          if (sha !== entry.sha256) throw new AppError("E_INTERNAL", `条目 ${entry.path} 摘要不一致`);
          fs.writeFileSync(targetPath, data, { flag: "wx" }); // 不覆盖已存在文件
          this.store.setItemStatus(item.id, "done", sha);
        }
      }
      this.store.finishPlan(planId, true);
    } catch (err: any) {
      const appErr = err instanceof AppError ? err : new AppError("E_IO", `写入失败: ${err.message}`, 500);
      this.store.finishPlan(planId, false, `${appErr.code}: ${appErr.message}`);
      throw appErr;
    }
    return this.store.getPlan(planId);
  }

  // 核对已解包内容：重新计算目标文件摘要并与归档条目比对
  verify(planId: number) {
    const plan = this.store.getPlan(planId);
    if (plan.status !== "done") throw new AppError("E_PLAN_NOT_READY", `计划 ${planId} 未成功执行，无法核对`);
    const results = (plan.items as Array<any>).map((item) => {
      if (item.type === "dir") {
        return { path: item.path, type: "dir", ok: fs.existsSync(item.target_path) };
      }
      if (!fs.existsSync(item.target_path)) return { path: item.path, type: "file", ok: false, error: "文件缺失" };
      const sha = createHash("sha256").update(fs.readFileSync(item.target_path)).digest("hex");
      return { path: item.path, type: "file", ok: sha === item.sha256, sha256: sha, expected: item.sha256 };
    });
    return { planId, ok: results.every((r) => r.ok), results };
  }

  // 导出报告到数据目录
  report(archiveId: number) {
    const { archive, entries } = this.manifest(archiveId);
    const plans = this.store.listPlans(archiveId).map((p: any) => this.store.getPlan(p.id));
    const report = { generatedAt: new Date().toISOString(), archive, entries, plans };
    const dir = path.join(this.dataDir, "reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `archive-${archiveId}-report.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    return { file, report };
  }
}
