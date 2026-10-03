import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store, ArchiveRow, EntryRow, PlanRow, ExtractionRow } from "./db.js";
import { parseTar, ParseResult, TarEntry } from "./tar/parser.js";
import { normalizeEntryPath, resolveWithinTarget, validateTargetDirName } from "./tar/paths.js";
import { AppError } from "./errors.js";

export interface PlanItem {
  entryIndex: number;
  name: string;
  type: "file" | "directory";
  size: number;
  relPath: string;
  sha256: string | null;
}

export interface ExtractResultItem {
  name: string;
  relPath: string;
  type: string;
  size: number;
  sha256: string | null;
  verified: boolean;
}

function now(): string {
  return new Date().toISOString();
}

export class UstarService {
  readonly archivesDir: string;
  readonly extractRoot: string;
  readonly reportsDir: string;

  constructor(
    public readonly store: Store,
    public readonly dataDir: string
  ) {
    this.archivesDir = path.join(dataDir, "archives");
    this.extractRoot = path.join(dataDir, "extracted");
    this.reportsDir = path.join(dataDir, "reports");
    for (const d of [this.archivesDir, this.extractRoot, this.reportsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  /** 导入项目内 .tar：复制到数据目录留档（源文件保持原样），解析并登记。 */
  importArchive(sourcePath: string): { archive: ArchiveRow; entries: EntryRow[]; parse: ParseResult } {
    const abs = path.resolve(sourcePath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new AppError("VALIDATION", `归档文件不存在: ${sourcePath}`);
    }
    if (!abs.toLowerCase().endsWith(".tar")) {
      throw new AppError("VALIDATION", "仅支持未压缩的 .tar 文件（不支持 .tar.gz/.tgz 等）");
    }
    const buf = fs.readFileSync(abs);
    const parse = parseTar(buf);

    const keptPath = path.join(this.archivesDir, `archive-${Date.now()}-${path.basename(abs)}`);
    fs.copyFileSync(abs, keptPath);

    const ins = this.store.db.prepare(
      `INSERT INTO archives (source_path, sha256, total_bytes, entry_count, end_marker, diagnostics, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const res = ins.run(
      keptPath,
      parse.archiveSha256,
      parse.totalBytes,
      parse.entries.length,
      parse.endMarker,
      JSON.stringify(parse.diagnostics),
      now()
    );
    const archiveId = Number(res.lastInsertRowid);

    const insEntry = this.store.db.prepare(
      `INSERT INTO entries (archive_id, idx, name, type, typeflag, size, header_offset, data_offset, sha256, unsupported_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of parse.entries) {
      insEntry.run(
        archiveId, e.index, e.name, e.type, e.typeflag, e.size,
        e.headerOffset, e.dataOffset, e.sha256, e.unsupportedReason ?? null
      );
    }
    return {
      archive: this.getArchive(archiveId),
      entries: this.listEntries(archiveId),
      parse,
    };
  }

  listArchives(): ArchiveRow[] {
    return this.store.db.prepare(`SELECT * FROM archives ORDER BY id`).all() as unknown as ArchiveRow[];
  }

  getArchive(id: number): ArchiveRow {
    const row = this.store.db.prepare(`SELECT * FROM archives WHERE id = ?`).get(id) as unknown as ArchiveRow | undefined;
    if (!row) throw new AppError("ARCHIVE_NOT_FOUND", `归档 #${id} 不存在`);
    return row;
  }

  listEntries(archiveId: number): EntryRow[] {
    this.getArchive(archiveId);
    return this.store.db
      .prepare(`SELECT * FROM entries WHERE archive_id = ? ORDER BY idx`)
      .all(archiveId) as unknown as EntryRow[];
  }

  manifest(archiveId: number) {
    const archive = this.getArchive(archiveId);
    return {
      archive,
      diagnostics: JSON.parse(archive.diagnostics),
      entries: this.listEntries(archiveId),
    };
  }

  /**
   * 构建解包计划（纯校验，不写盘）。
   * selectedNames 为空表示选择全部可解包条目。
   */
  buildPlan(archiveId: number, selectedNames: string[] | undefined, targetDirName: string): PlanItem[] {
    validateTargetDirName(targetDirName);
    const entries = this.listEntries(archiveId);
    const selectable = entries.filter((e) => e.type === "file" || e.type === "directory");

    let chosen: EntryRow[];
    if (selectedNames && selectedNames.length > 0) {
      const byName = new Map(selectable.map((e) => [e.name, e]));
      chosen = selectedNames.map((n) => {
        const e = byName.get(n);
        if (!e) {
          const hit = entries.find((x) => x.name === n);
          if (hit && hit.type === "unsupported") {
            throw new AppError("PATH_LINK", `条目 "${n}" 类型不受支持（链接/设备等），拒绝解包`);
          }
          throw new AppError("ENTRY_NOT_FOUND", `条目不存在或不可解包: ${n}`);
        }
        return e;
      });
    } else {
      chosen = selectable;
    }

    const seen = new Set<string>();
    const items: PlanItem[] = [];
    for (const e of chosen) {
      const rel = normalizeEntryPath(e.name);
      const key = rel.toLowerCase();
      if (seen.has(key)) {
        throw new AppError("PATH_DUPLICATE", `规范化后出现重复目标路径: ${rel}`);
      }
      seen.add(key);
      items.push({
        entryIndex: e.idx,
        name: e.name,
        type: e.type as "file" | "directory",
        size: e.size,
        relPath: rel,
        sha256: e.sha256,
      });
    }
    // 目录与自身前缀冲突检查（如 a 与 a/b 同时存在时目录须先建）
    items.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return items;
  }

  /** 预览计划：校验 + 登记一条 preview 计划，返回计划内容。 */
  previewPlan(archiveId: number, selectedNames: string[] | undefined, targetDirName: string) {
    const items = this.buildPlan(archiveId, selectedNames, targetDirName);
    const targetDir = path.join(this.extractRoot, targetDirName);
    const targetExists = fs.existsSync(targetDir);
    const res = this.store.db
      .prepare(`INSERT INTO plans (archive_id, target_dir, items, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(archiveId, targetDir, JSON.stringify(items), targetExists ? "blocked" : "preview",
        targetExists ? "目标目录已存在，执行将被拒绝" : null, now());
    return {
      planId: Number(res.lastInsertRowid),
      archiveId,
      targetDir,
      targetExists,
      items,
    };
  }

  getPlan(planId: number): PlanRow {
    const row = this.store.db.prepare(`SELECT * FROM plans WHERE id = ?`).get(planId) as unknown as PlanRow | undefined;
    if (!row) throw new AppError("PLAN_NOT_FOUND", `计划 #${planId} 不存在`);
    return row;
  }

  /** 执行解包：先完整校验，再写入；失败清理并登记 failed。 */
  executePlan(planId: number): ExtractionRow {
    const plan = this.getPlan(planId);
    if (plan.status === "done") {
      throw new AppError("VALIDATION", `计划 #${planId} 已执行过，不能重复执行`);
    }
    const archive = this.getArchive(plan.archive_id);
    const items = JSON.parse(plan.items) as PlanItem[];

    const startedAt = now();
    const ins = this.store.db.prepare(
      `INSERT INTO extractions (plan_id, archive_id, target_dir, status, results, error, started_at)
       VALUES (?, ?, ?, 'running', '[]', NULL, ?)`
    );
    const extractionId = Number(ins.run(planId, plan.archive_id, plan.target_dir, startedAt).lastInsertRowid);

    const results: ExtractResultItem[] = [];
    try {
      // 执行前完整检查（全部在登记后进行，失败也会留下 failed 记录）
      if (fs.existsSync(plan.target_dir)) {
        this.store.db.prepare(`UPDATE plans SET status = 'blocked', error = ? WHERE id = ?`)
          .run("目标目录已存在，拒绝覆盖", planId);
        throw new AppError("TARGET_EXISTS", `目标目录已存在，拒绝覆盖: ${plan.target_dir}`);
      }
      const buf = fs.readFileSync(archive.source_path);
      const archiveHash = createHash("sha256").update(buf).digest("hex");
      if (archiveHash !== archive.sha256) {
        throw new AppError("IO_ERROR", "源归档内容与导入时不一致，拒绝解包");
      }
      const entryRows = this.listEntries(plan.archive_id);
      const byIdx = new Map(entryRows.map((e) => [e.idx, e]));

      fs.mkdirSync(plan.target_dir, { recursive: false });
      // 先建所有目录，再写文件
      for (const item of items.filter((i) => i.type === "directory")) {
        fs.mkdirSync(resolveWithinTarget(plan.target_dir, item.relPath), { recursive: true });
        results.push({ name: item.name, relPath: item.relPath, type: "directory", size: 0, sha256: null, verified: true });
      }
      for (const item of items.filter((i) => i.type === "file")) {
        const row = byIdx.get(item.entryIndex);
        if (!row) throw new AppError("ENTRY_NOT_FOUND", `条目 idx=${item.entryIndex} 缺失`);
        const dest = resolveWithinTarget(plan.target_dir, item.relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const content = buf.subarray(row.data_offset, row.data_offset + row.size);
        const digest = createHash("sha256").update(content).digest("hex");
        if (digest !== row.sha256) {
          throw new AppError("IO_ERROR", `条目 "${item.name}" 内容摘要与清单不一致，中止解包`);
        }
        fs.writeFileSync(dest, content, { flag: "wx" });
        // 写后回读核对
        const written = createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
        if (written !== row.sha256) {
          throw new AppError("IO_ERROR", `条目 "${item.name}" 写入后校验失败`);
        }
        results.push({ name: item.name, relPath: item.relPath, type: "file", size: row.size, sha256: digest, verified: true });
      }
      this.store.db.prepare(`UPDATE extractions SET status = 'done', results = ?, finished_at = ? WHERE id = ?`)
        .run(JSON.stringify(results), now(), extractionId);
      this.store.db.prepare(`UPDATE plans SET status = 'done' WHERE id = ?`).run(planId);
    } catch (err) {
      // 失败：清理半成品目录，登记失败
      fs.rmSync(plan.target_dir, { recursive: true, force: true });
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof AppError ? err.code : "IO_ERROR";
      this.store.db.prepare(`UPDATE extractions SET status = 'failed', results = '[]', error = ?, finished_at = ? WHERE id = ?`)
        .run(`${code}: ${message}`, now(), extractionId);
      this.store.db.prepare(`UPDATE plans SET status = 'failed', error = ? WHERE id = ?`).run(message, planId);
      throw err;
    }
    return this.getExtraction(extractionId);
  }

  getExtraction(id: number): ExtractionRow {
    const row = this.store.db.prepare(`SELECT * FROM extractions WHERE id = ?`).get(id) as unknown as ExtractionRow | undefined;
    if (!row) throw new AppError("EXTRACTION_NOT_FOUND", `解包记录 #${id} 不存在`);
    return row;
  }

  listExtractions(archiveId?: number): ExtractionRow[] {
    if (archiveId !== undefined) {
      return this.store.db.prepare(`SELECT * FROM extractions WHERE archive_id = ? ORDER BY id`).all(archiveId) as unknown as ExtractionRow[];
    }
    return this.store.db.prepare(`SELECT * FROM extractions ORDER BY id`).all() as unknown as ExtractionRow[];
  }

  /** 核对已解包内容：重新计算磁盘文件摘要并与清单比对。 */
  verifyExtraction(id: number) {
    const ext = this.getExtraction(id);
    if (ext.status !== "done") {
      throw new AppError("VALIDATION", `解包 #${id} 状态为 ${ext.status}，无法核对`);
    }
    const results = JSON.parse(ext.results) as ExtractResultItem[];
    const checks = results.map((r) => {
      if (r.type === "directory") {
        const ok = fs.existsSync(resolveWithinTarget(ext.target_dir, r.relPath));
        return { ...r, diskOk: ok };
      }
      const p = resolveWithinTarget(ext.target_dir, r.relPath);
      if (!fs.existsSync(p)) return { ...r, diskOk: false, diskSha256: null };
      const diskSha256 = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      return { ...r, diskOk: diskSha256 === r.sha256, diskSha256 };
    });
    return { extraction: ext, allOk: checks.every((c) => c.diskOk), checks };
  }

  /** 导出 JSON 报告到数据目录。 */
  exportReport(archiveId: number): string {
    const manifest = this.manifest(archiveId);
    const extractions = this.listExtractions(archiveId).map((e) => ({
      ...e,
      verify: e.status === "done" ? this.verifyExtraction(e.id).allOk : null,
    }));
    const report = {
      generatedAt: now(),
      archive: manifest.archive,
      diagnostics: manifest.diagnostics,
      entries: manifest.entries,
      extractions,
    };
    const file = path.join(this.reportsDir, `report-archive-${archiveId}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
    return file;
  }
}
