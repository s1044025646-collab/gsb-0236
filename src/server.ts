import http from "node:http";
import net from "node:net";
import { UstarService } from "./service.js";
import { AppError } from "./errors.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("VALIDATION", "请求体不是合法 JSON");
  }
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v) throw new AppError("VALIDATION", `参数 ${name} 必须是非空字符串`);
  return v;
}

function optStrArray(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new AppError("VALIDATION", `参数 ${name} 必须是字符串数组`);
  }
  return v as string[];
}

export function createServer(service: UstarService): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && parts.length === 0) {
        return sendJson(res, 200, {
          name: "ustar-inspector",
          endpoints: [
            "POST /archives/import {path}",
            "GET /archives",
            "GET /archives/:id",
            "POST /archives/:id/plan {targetDir, entries?}",
            "POST /plans/:id/execute",
            "GET /extractions/:id/verify",
            "POST /archives/:id/report",
          ],
        });
      }
      if (method === "POST" && parts[0] === "archives" && parts[1] === "import") {
        const body = await readBody(req);
        const result = service.importArchive(str(body.path, "path"));
        return sendJson(res, 201, result);
      }
      if (method === "GET" && parts[0] === "archives" && parts.length === 1) {
        return sendJson(res, 200, service.listArchives());
      }
      if (method === "GET" && parts[0] === "archives" && parts.length === 2) {
        return sendJson(res, 200, service.manifest(Number(parts[1])));
      }
      if (method === "POST" && parts[0] === "archives" && parts[2] === "plan") {
        const body = await readBody(req);
        return sendJson(res, 201, service.previewPlan(
          Number(parts[1]), optStrArray(body.entries, "entries"), str(body.targetDir, "targetDir")
        ));
      }
      if (method === "POST" && parts[0] === "archives" && parts[2] === "report") {
        return sendJson(res, 201, { report: service.exportReport(Number(parts[1])) });
      }
      if (method === "POST" && parts[0] === "plans" && parts[2] === "execute") {
        return sendJson(res, 200, service.executePlan(Number(parts[1])));
      }
      if (method === "GET" && parts[0] === "extractions" && parts[2] === "verify") {
        return sendJson(res, 200, service.verifyExtraction(Number(parts[1])));
      }
      return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (err) {
      if (err instanceof AppError) {
        return sendJson(res, 400, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      }
      return sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
    }
  });
}

export async function findFreePort(preferred?: number): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
    });
  if (preferred) {
    try {
      return await tryListen(preferred);
    } catch {
      /* 占用则选空闲端口 */
    }
  }
  return tryListen(0);
}
