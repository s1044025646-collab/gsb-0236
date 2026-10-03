# USTAR 归档清单解析与受限解包服务

一个本地运行的后端服务（仅 API 与 CLI），用 TypeScript + Node.js + SQLite 实现。
核心是**自行按 512 字节块解析 USTAR 头部与载荷边界**，不调用系统 `tar`，也不使用任何归档库。

## 支持范围（USTAR 子集）

- 未压缩的 `.tar`（USTAR，`magic = "ustar"`）
- 普通文件（typeflag `0` / `\0`）与目录（typeflag `5`）
- `name` + `prefix` 路径组合、严格八进制 `size`、头部校验和校验
- 双零块结束标记识别；缺失结束标记作为诊断保留；截断归档报错
- 载荷后的 512 对齐填充不计入文件大小；零字节文件是独立条目

**明确不支持**：gzip/压缩、PAX 扩展头、GNU 扩展（含 base-256 长度编码）、稀疏文件、
硬链接/符号链接、设备文件。遇到即拒绝导入并返回对应错误码。

## 安全限制

- 仅允许导入**项目目录内**的 `.tar` 文件；不扫描用户其他目录
- 路径规范化后必须仍在目标目录内：绝对路径、盘符、`..` 越界、NUL、重复目标一律拒绝
- 目标目录已存在时拒绝覆盖；写文件使用 `wx` 标志不覆盖
- 上限：归档 64 MiB、条目 10000、单文件 32 MiB、路径 255 字符
- 先完整解析检查再落库（事务），解析或写入失败不会登记为成功
- 源归档只读、保持原样；不恢复原始权限，不执行归档中任何文件

## 环境要求

- Windows 本地，Node.js ≥ 22（使用内置 `node:sqlite`，无原生依赖）
- 不需要 Docker / WSL / 任何外部在线服务

## 复现命令

```powershell
npm install        # 仅安装 typescript 与 @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部字节级夹具测试
npm run demo       # 一键演示：生成样例→导入→计划→解包→核对→报告
npm start          # 启动 API 服务（默认自动选择空闲端口）
```

## CLI 用法

```
node dist/cli.js make-sample [输出路径]           # 默认 samples/sample.tar
node dist/cli.js import samples/sample.tar        # 导入并解析
node dist/cli.js list                             # 已导入归档
node dist/cli.js show 1                           # 清单与诊断
node dist/cli.js plan 1 --target data/out [--entries 2,4]
node dist/cli.js execute 1
node dist/cli.js verify 1
node dist/cli.js report 1
node dist/cli.js serve [--port N]                 # 默认端口 0 = 自动选空闲端口
```

数据目录默认为项目内 `data/`（SQLite、报告、演示输出），可用环境变量 `USTAR_DATA_DIR` 覆盖。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/archives` | 导入归档，body: `{"path":"samples/sample.tar"}` |
| GET | `/api/archives` | 归档列表 |
| GET | `/api/archives/:id` | 清单与诊断 |
| POST | `/api/archives/:id/plan` | 预览解包计划，body: `{"targetDir":"data/out","entryIdxs":[2,4]}`（省略 `entryIdxs` 表示全部） |
| POST | `/api/plans/:id/execute` | 执行解包 |
| GET | `/api/plans/:id` | 计划与执行结果 |
| GET | `/api/plans/:id/verify` | 重新计算摘要并核对已解包内容 |
| GET | `/api/archives/:id/report` | 导出 JSON 报告到 `data/reports/` |

错误响应统一为 `{"error":{"code","message","details"}}`。

## 错误码

`E_BAD_CHECKSUM` 头部校验和不匹配 · `E_BAD_OCTAL` 八进制字段非法 ·
`E_BAD_HEADER` 非 USTAR · `E_UNSUPPORTED_TYPE` 链接/设备等类型 ·
`E_UNSUPPORTED_ENCODING` base-256 长度 · `E_TRUNCATED` 截断 ·
`E_PATH_UNSAFE` 路径越界/绝对路径/盘符 · `E_DUPLICATE_TARGET` 重复目标 ·
`E_TARGET_EXISTS` 目标已存在 · `E_LIMIT_EXCEEDED` 超过上限 ·
`E_NOT_FOUND` 资源不存在 · `E_INVALID_ARG` 参数非法 ·
`E_PLAN_NOT_READY` 计划状态不允许操作 · `E_IO` 写入失败 · `E_INTERNAL` 内部错误

## 目录结构

```
src/tar.ts      512 字节块 USTAR 解析器（校验和、八进制、prefix、结束块、填充）
src/service.ts  业务层：导入、计划、解包、核对、报告
src/db.ts       SQLite（node:sqlite）：归档、条目、计划、执行结果
src/server.ts   node:http JSON API
src/cli.ts      命令行入口
src/sample.ts   演示归档生成器（目录/空文件/511/512/513 载荷/prefix 长路径）
test/           独立构造的字节夹具测试
```

## 已知限制

- 不追求所有 tar 方言兼容，仅标准 USTAR 子集
- 归档整体读入内存解析（受 64 MiB 上限约束）
- 解包不恢复 mtime/权限/属主；Windows 下目标路径比较按大小写不敏感处理
- `node:sqlite` 在 Node 25 仍标记为 experimental（启动时有一条警告，不影响功能）
