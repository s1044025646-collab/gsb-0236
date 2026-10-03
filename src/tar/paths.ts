import path from "node:path";
import { AppError } from "../errors.js";

/**
 * 校验并规范化归档内相对路径。
 * 拒绝：绝对路径、盘符、向上越界、空段、反斜杠混淆、控制字符。
 * 返回规范化后的 POSIX 风格相对路径（使用 / 分隔）。
 */
export function normalizeEntryPath(raw: string): string {
  if (!raw || raw.length === 0) {
    throw new AppError("PATH_INVALID", "路径为空");
  }
  if (/[\x00-\x1f]/.test(raw)) {
    throw new AppError("PATH_INVALID", `路径含控制字符: ${JSON.stringify(raw)}`);
  }
  if (raw.includes("\\")) {
    throw new AppError("PATH_INVALID", `路径含反斜杠，疑似 Windows 路径混淆: ${raw}`);
  }
  if (/^[A-Za-z]:/.test(raw)) {
    throw new AppError("PATH_DRIVE", `路径含盘符: ${raw}`);
  }
  if (raw.startsWith("/") || raw.startsWith("//")) {
    throw new AppError("PATH_ABSOLUTE", `绝对路径被拒绝: ${raw}`);
  }
  const segments = raw.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      throw new AppError("PATH_ESCAPE", `路径含 ".." 向上越界: ${raw}`);
    }
    out.push(seg);
  }
  if (out.length === 0) {
    throw new AppError("PATH_INVALID", `路径规范化后为空: ${raw}`);
  }
  return out.join("/");
}

/**
 * 把规范化后的相对路径解析到目标目录内，确保结果仍位于目标目录之下。
 */
export function resolveWithinTarget(targetDir: string, relPath: string): string {
  const targetAbs = path.resolve(targetDir);
  const resolved = path.resolve(targetAbs, ...relPath.split("/"));
  const rel = path.relative(targetAbs, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AppError("PATH_ESCAPE", `路径越出目标目录: ${relPath}`);
  }
  return resolved;
}

/** 校验目标目录名（项目内新建目录），不允许路径分隔符与特殊名。 */
export function validateTargetDirName(name: string): string {
  if (!name || name === "." || name === "..") {
    throw new AppError("VALIDATION", "目标目录名非法");
  }
  if (/[\\/:*?"<>|]/.test(name) || /[\x00-\x1f]/.test(name)) {
    throw new AppError("VALIDATION", `目标目录名含非法字符: ${name}`);
  }
  return name;
}
