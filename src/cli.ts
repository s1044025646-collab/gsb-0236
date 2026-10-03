import path from "node:path";
import fs from "node:fs";
import { Store } from "./db.js";
import { UstarService } from "./service.js";
import { createServer, findFreePort } from "./server.js";
import { buildTar } from "./tar/builder.js";
import { AppError } from "./errors.js";

const DATA_DIR = path.resolve(process.env.USTAR_DATA_DIR ?? "data");

function makeService(): UstarService {
  return new UstarService(new Store(DATA_DIR), DATA_DIR);
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const service = makeService();
  try {
    switch (cmd) {
      case "import": {
        if (!args[0]) throw new AppError("VALIDATION", "用法: cli import <file.tar>");
        const r = service.importArchive(args[0]);
        print({ archive: r.archive, diagnostics: r.parse.diagnostics, entries: r.entries.length });
        break;
      }
      case "list":
        print(service.listArchives());
        break;
      case "show": {
        const id = Number(args[0]);
        if (!id) throw new AppError("VALIDATION", "用法: cli show <archiveId>");
        print(service.manifest(id));
        break;
      }
      case "plan": {
        const id = Number(args[0]);
        const target = args[1];
        if (!id || !target) throw new AppError("VALIDATION", "用法: cli plan <archiveId> <targetDirName> [entry1,entry2,...]");
        const entries = args[2] ? args[2].split(",").filter(Boolean) : undefined;
        print(service.previewPlan(id, entries, target));
        break;
      }
      case "extract": {
        const planId = Number(args[0]);
        if (!planId) throw new AppError("VALIDATION", "用法: cli extract <planId>");
        print(service.executePlan(planId));
        break;
      }
      case "verify": {
        const id = Number(args[0]);
        if (!id) throw new AppError("VALIDATION", "用法: cli verify <extractionId>");
        print(service.verifyExtraction(id));
        break;
      }
      case "report": {
        const id = Number(args[0]);
        if (!id) throw new AppError("VALIDATION", "用法: cli report <archiveId>");
        print({ report: service.exportReport(id) });
        break;
      }
      case "serve": {
        const preferred = args[0] ? Number(args[0]) : undefined;
        const port = await findFreePort(preferred);
        const server = createServer(service);
        server.listen(port, "127.0.0.1", () => {
          console.log(`USTAR 检查服务已启动: http://127.0.0.1:${port}  (数据目录: ${DATA_DIR})`);
        });
        return; // 保持进程
      }
      case "demo": {
        await runDemo(service);
        break;
      }
      default:
        console.log(`用法: node dist/src/cli.js <命令>
  import <file.tar>                 导入归档
  list                              列出归档
  show <archiveId>                  查看清单与诊断
  plan <archiveId> <dir> [entries]  预览解包计划（entries 为逗号分隔，可省略=全部）
  extract <planId>                  执行解包
  verify <extractionId>             核对已解包内容
  report <archiveId>                导出 JSON 报告
  serve [port]                      启动 HTTP API（默认自动选空闲端口）
  demo                              生成样例并完整演示`);
    }
  } finally {
    if (process.argv.slice(2)[0] !== "serve") service.store.close();
  }
}

async function runDemo(service: UstarService): Promise<void> {
  const samplesDir = path.resolve("samples");
  fs.mkdirSync(samplesDir, { recursive: true });
  const tarPath = path.join(samplesDir, "demo.tar");
  const longPayload = Buffer.alloc(1500);
  for (let i = 0; i < longPayload.length; i++) longPayload[i] = 65 + (i % 26);
  fs.writeFileSync(tarPath, buildTar([
    { name: "docs", typeflag: "5" },
    { name: "empty.txt", prefix: "docs", content: "" },
    { name: "hello.txt", prefix: "docs", content: "你好，USTAR！\n" },
    { name: "exact512.bin", content: Buffer.alloc(512, 0x42) },
    { name: "long.bin", content: longPayload },
    { name: "deep/note.md", prefix: "a/very/long/prefix/path", content: "# prefix 路径演示\n" },
  ]));
  console.log(`样例归档已生成: ${tarPath}`);

  const imported = service.importArchive(tarPath);
  const archiveId = imported.archive.id;
  console.log(`\n== 导入归档 #${archiveId}，条目 ${imported.entries.length} 个 ==`);
  for (const e of imported.entries) {
    console.log(`  [${e.idx}] ${e.type.padEnd(9)} ${String(e.size).padStart(6)} 头@${e.header_offset}  ${e.name}`);
  }

  console.log("\n== 预览计划（只解出 docs/hello.txt 与 docs/empty.txt）==");
  const plan = service.previewPlan(archiveId, ["docs/hello.txt", "docs/empty.txt"], "demo-out");
  print(plan.items);

  console.log("\n== 执行解包 ==");
  const ext = service.executePlan(plan.planId);
  console.log(`解包 #${ext.id} 状态: ${ext.status} -> ${ext.target_dir}`);

  console.log("\n== 核对 ==");
  const verify = service.verifyExtraction(ext.id);
  console.log(`全部一致: ${verify.allOk}`);

  console.log("\n== 再次执行同一计划（应被拒绝）==");
  try {
    service.executePlan(plan.planId);
  } catch (err) {
    console.log(`按预期拒绝: ${(err as Error).message}`);
  }

  const report = service.exportReport(archiveId);
  console.log(`\n报告已导出: ${report}`);
}

main().catch((err) => {
  if (err instanceof AppError) {
    console.error(`错误 [${err.code}] ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
