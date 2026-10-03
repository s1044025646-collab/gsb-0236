// CLI：导入、清单、计划、解包、核对、报告、样例、服务。
import path from "node:path";
import fs from "node:fs";
import { Service } from "./service";
import { startServer } from "./server";
import { writeSample } from "./sample";
import { AppError } from "./errors";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function makeService(): Service {
  const dataDir = process.env.USTAR_DATA_DIR ?? path.join(process.cwd(), "data");
  return new Service({ dataDir });
}

const USAGE = `用法: node dist/cli.js <命令> [参数]
命令:
  make-sample [输出路径]            生成演示归档（默认 samples/sample.tar）
  import <归档.tar>                 导入并解析归档
  list                              列出已导入归档
  show <archiveId>                  查看清单与诊断
  plan <archiveId> --target <目录> [--entries 0,2,3]   预览解包计划
  execute <planId>                  执行解包
  verify <planId>                   核对已解包内容
  report <archiveId>                导出 JSON 报告
  serve [--port N]                  启动 API 服务（默认自动选择空闲端口）
  demo                              一键演示：生成样例→导入→计划→解包→核对→报告
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const svc = makeService();
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  switch (cmd) {
    case "make-sample": {
      const p = writeSample(args[0] ?? path.join("samples", "sample.tar"));
      console.log(`样例归档已生成: ${p}`);
      break;
    }
    case "import": {
      if (!args[0]) throw new AppError("E_INVALID_ARG", "缺少归档路径");
      out(svc.importArchive(args[0]));
      break;
    }
    case "list":
      out(svc.store.listArchives());
      break;
    case "show": {
      out(svc.manifest(Number(args[0])));
      break;
    }
    case "plan": {
      const target = argValue(args, "target");
      if (!target) throw new AppError("E_INVALID_ARG", "缺少 --target 参数");
      const entriesArg = argValue(args, "entries");
      const entryIdxs = entriesArg ? entriesArg.split(",").map((s) => Number(s.trim())) : undefined;
      out(svc.plan(Number(args[0]), target, entryIdxs));
      break;
    }
    case "execute":
      out(svc.execute(Number(args[0])));
      break;
    case "verify":
      out(svc.verify(Number(args[0])));
      break;
    case "report":
      out(svc.report(Number(args[0])).file);
      break;
    case "serve": {
      const portArg = argValue(args, "port");
      const port = portArg ? Number(portArg) : Number(process.env.PORT ?? 0);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new AppError("E_INVALID_ARG", `非法端口: ${portArg}`);
      }
      const actual = await startServer(svc, port);
      console.log(`API 服务已启动: http://127.0.0.1:${actual}`);
      break;
    }
    case "demo": {
      const sample = writeSample(path.join("samples", "sample.tar"));
      console.log(`1) 样例归档: ${sample}`);
      const imp = svc.importArchive(path.relative(process.cwd(), sample));
      console.log(`2) 已导入 archiveId=${imp.archiveId}，条目数=${imp.entries.length}`);
      const plan = svc.plan(imp.archiveId, path.join("data", "demo-out"));
      console.log(`3) 计划 planId=${plan.planId}，目标=${plan.targetDir}`);
      svc.execute(plan.planId);
      console.log("4) 解包完成");
      const v = svc.verify(plan.planId);
      console.log(`5) 核对结果 ok=${v.ok}`);
      const rep = svc.report(imp.archiveId);
      console.log(`6) 报告: ${rep.file}`);
      break;
    }
    default:
      process.stdout.write(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof AppError) {
    console.error(`错误 [${err.code}] ${err.message}`);
  } else {
    console.error(`内部错误: ${err?.stack ?? err}`);
  }
  process.exitCode = 1;
});
