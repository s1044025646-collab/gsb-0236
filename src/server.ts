// 基于 node:http 的 JSON API 服务。
import http from "node:http";
import { AddressInfo } from "node:net";
import { Service } from "./service";
import { AppError } from "./errors";

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const json = JSON.stringify(body, null, 2);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(json);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const segs = url.pathname.split("/").filter(Boolean);

      const readBody = (): Promise<any> =>
        new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          let len = 0;
          req.on("data", (c: Buffer) => {
            len += c.length;
            if (len > 1024 * 1024) reject(new AppError("E_LIMIT_EXCEEDED", "请求体过大"));
            chunks.push(c);
          });
          req.on("end", () => {
            if (chunks.length === 0) return resolve({});
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new AppError("E_INVALID_ARG", "请求体不是合法 JSON"));
            }
          });
          req.on("error", reject);
        });

      if (method === "GET" && url.pathname === "/api/health") {
        return send(200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/api/archives") {
        const body = await readBody();
        return send(201, service.importArchive(body.path));
      }
      if (method === "GET" && url.pathname === "/api/archives") {
        return send(200, { archives: service.store.listArchives() });
      }
      if (method === "GET" && segs[0] === "api" && segs[1] === "archives" && segs.length === 3) {
        return send(200, service.manifest(Number(segs[2])));
      }
      if (method === "POST" && segs[0] === "api" && segs[1] === "archives" && segs[3] === "plan") {
        const body = await readBody();
        return send(201, service.plan(Number(segs[2]), body.targetDir, body.entryIdxs));
      }
      if (method === "GET" && segs[0] === "api" && segs[1] === "archives" && segs[3] === "report") {
        const { file } = service.report(Number(segs[2]));
        return send(200, { reportFile: file });
      }
      if (method === "POST" && segs[0] === "api" && segs[1] === "plans" && segs[3] === "execute") {
        return send(200, service.execute(Number(segs[2])));
      }
      if (method === "GET" && segs[0] === "api" && segs[1] === "plans" && segs.length === 3) {
        return send(200, service.store.getPlan(Number(segs[2])));
      }
      if (method === "GET" && segs[0] === "api" && segs[1] === "plans" && segs[3] === "verify") {
        return send(200, service.verify(Number(segs[2])));
      }
      throw new AppError("E_NOT_FOUND", `路由不存在: ${method} ${url.pathname}`, 404);
    } catch (err: any) {
      const e = err instanceof AppError ? err : new AppError("E_INTERNAL", err.message ?? "内部错误", 500);
      send(e.status, { error: { code: e.code, message: e.message, details: e.details ?? null } });
    }
  });
}

export function startServer(service: Service, port: number): Promise<number> {
  const server = createServer(service);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
