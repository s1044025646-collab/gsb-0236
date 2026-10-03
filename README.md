# USTAR 归档检查与受限解包服务

一个纯本地运行的后端（API + CLI）：导入项目内未压缩的 `.tar` 文件，按 512 字节块自行解析 USTAR 头部与载荷边界，展示清单与诊断，并把选中的普通文件/目录安全解包到项目内新建目录。解析、清单、计划与执行结果全部持久化到 SQLite。

- 运行环境：Windows + Node.js ≥ 22（使用内置 `node:sqlite`，无原生依赖）
- 不调用系统 `tar`，不使用任何归档库；核心解析为手写的 512 字节块解析器
- 不需要 Docker / WSL / 网络服务 / 外部 API

## 支持范围

**支持：**
- 标准 USTAR 子集：普通文件（typeflag `0`/`\0`）与目录（`5`）
- `name` + `prefix` 路径组合、严格八进制 size、头部校验和校验
- 载荷后 512 对齐填充（不计入文件大小）、零字节文件、结束块识别（两个零块为干净结束；单个零块或缺失给出诊断警告）

**明确不支持（识别并拒绝/仅记录）：**
- gzip 压缩（`.tar.gz`/`.tgz`）、PAX 扩展头、GNU 扩展、稀疏文件
- 硬链接/软链接、设备文件等其它 typeflag（清单中标记为 `unsupported`，拒绝解包）
- 非 USTAR magic 的 tar 方言（报错终止，不做盲目扫描）

**限制（`src/tar/parser.ts` 中 `LIMITS`）：**
- 归档 ≤ 256 MB，条目 ≤ 10000，路径 ≤ 255 字符，单文件 ≤ 512 MB

## 安全约束

- 解包路径规范化后必须仍位于目标目录内；绝对路径、盘符、`..` 越界、反斜杠混淆、重复目标、链接条目一律拒绝
- 目标目录必须不存在，拒绝覆盖；同一计划不可重复执行
- 先完整校验再写入；任何失败清理半成品目录并登记 `failed`，不会发布半份结果
- 源归档保持原样（导入时复制留档并记录 SHA-256，执行前复核一致性）
- 不恢复归档中的权限，不执行归档内任何文件

## 快速开始

```powershell
npm install      # 仅安装 typescript / @types/node（开发依赖）
npm run build    # 编译到 dist/
npm test         # 构建并运行全部测试
npm run demo     # 生成样例归档并完整演示 导入→清单→计划→解包→核对→报告
npm start        # 启动 HTTP API（默认自动选择空闲端口）
```

数据目录默认为项目内 `data/`（可用环境变量 `USTAR_DATA_DIR` 覆盖），包含 SQLite 库、留档归档、解包输出与报告。演示样例生成在 `samples/`。

## CLI

```powershell
node dist/src/cli.js import samples/demo.tar        # 导入归档
node dist/src/cli.js list                           # 列出归档
node dist/src/cli.js show 1                         # 清单 + 诊断
node dist/src/cli.js plan 1 out "docs/hello.txt,docs/empty.txt"   # 预览计划（省略条目=全部）
node dist/src/cli.js extract 1                      # 执行计划
node dist/src/cli.js verify 1                       # 核对已解包内容
node dist/src/cli.js report 1                       # 导出 JSON 报告
node dist/src/cli.js serve 8080                     # 指定端口（被占用时自动换空闲端口）
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/archives/import` | `{path}` 导入归档 |
| GET | `/archives` | 归档列表 |
| GET | `/archives/:id` | 清单与诊断 |
| POST | `/archives/:id/plan` | `{targetDir, entries?}` 预览解包计划 |
| POST | `/plans/:id/execute` | 执行解包 |
| GET | `/extractions/:id/verify` | 核对已解包内容 |
| POST | `/archives/:id/report` | 导出 JSON 报告 |

错误统一返回 `{"error": {"code", "message", "details"}}`，主要错误码：`TAR_BAD_CHECKSUM`、`TAR_BAD_OCTAL`、`TAR_BAD_MAGIC`、`TAR_TRUNCATED`、`TAR_MISSING_END`、`TAR_UNSUPPORTED_TYPE`、`PATH_ABSOLUTE`、`PATH_DRIVE`、`PATH_ESCAPE`、`PATH_DUPLICATE`、`PATH_LINK`、`TARGET_EXISTS`、`LIMIT_*`、`ENTRY_NOT_FOUND` 等。

## 测试

`test/parser.test.ts` 用独立构造的字节夹具覆盖：校验和、511/512/513 字节载荷填充边界、零字节文件、prefix 组合、结束块/单零块/缺失结束、坏八进制、截断、非 USTAR magic、不支持类型。`test/service.test.ts` 覆盖：全流程、越界路径、链接拒绝、目标已存在、重复目标、失败不留半成品、重启后可查询、摘要一致性。

## 目录结构

```
src/tar/parser.ts   512 字节块 USTAR 解析器（核心）
src/tar/paths.ts    路径规范化与越界防护
src/tar/builder.ts  样例/测试用 tar 构造器
src/service.ts      导入/清单/计划/解包/核对/报告
src/db.ts           SQLite 模式与访问
src/server.ts       HTTP API（node:http，可配置端口）
src/cli.ts          命令行入口与演示
test/               字节夹具与服务测试
```
