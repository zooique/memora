/**
 * VS Code 项目搜索提供者 — IProjectSearchProvider 的宿主实现（2026-08-31）
 *
 * 将 VS Code 原生全局搜索能力注入内核，供 LLM 的 search_project 工具使用：
 *   - name 模式：workspace.findFiles（stable API，底层 ripgrep，按文件名 glob，高效可靠）
 *   - content 模式：宿主 Node fs 受限实现（workspace.findTextInFiles 为 proposed API，非 stable，
 *     不可用于生产；故用受控递归扫描 + 正则匹配，对齐内核 list_dir 的忽略规则与上限保护）
 *
 * 相对路径约定：返回相对项目根的 posix 路径（正斜杠），与 read_file / list_dir 的相对路径
 * 语义对齐——LLM 拿到搜索命中路径后可无缝 read_file 精读。
 */
import * as vscode from 'vscode';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, join } from 'node:path';
import type {
  IProjectSearchProvider,
  ProjectFileMatch,
  ProjectFileSearchOptions,
  ProjectTextMatch,
  ProjectTextSearchOptions,
} from '@zooique/memora';

/** search_files 单次返回上限（对齐内核 PROJECT_SEARCH_RESULT_MAX_LEN=100） */
const MAX_RESULTS = 100;
/** content 搜索忽略的目录/文件名（对齐内核 BuiltinToolHandlers.IGNORED_DIR_NAMES） */
const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules', '.memora', 'dist', 'coverage', '.next']);
/** content 搜索最大扫描文件数（防超大项目遍历失控卡死主循环） */
const MAX_FILES_SCANNED = 500;
/** content 搜索单文件读取上限（字节，防大文件/二进制读爆内存） */
const MAX_FILE_BYTES = 64 * 1024;
/** content 搜索单文件最大命中数（防单文件刷屏撑爆上下文） */
const MAX_MATCHES_PER_FILE = 3;

/**
 * 创建 VS Code 项目搜索提供者
 *
 * @param root 项目根绝对路径（用于把搜索结果转为相对路径；通常 = workspaceFolders[0]）
 * @returns 实现 IProjectSearchProvider 的提供者（注入 AgentOptions.projectSearchProvider）
 */
export function createVscodeProjectSearchProvider(root: string): IProjectSearchProvider {
  return {
    /**
     * 按文件名 glob 搜索（workspace.findFiles，stable API）
     *
     * @param options query 为文件名 glob（省略时列出项目全部文件）；exclude 排除 glob
     * @returns 相对项目根的文件路径列表
     */
    async searchFiles(options?: ProjectFileSearchOptions): Promise<ProjectFileMatch[]> {
      const include = options?.query || '**/*';
      const exclude = options?.exclude || null;
      const maxResults = Math.min(options?.maxResults ?? MAX_RESULTS, MAX_RESULTS);
      const uris = await vscode.workspace.findFiles(include, exclude, maxResults);
      return uris.map((u) => ({ path: toProjectRelative(root, u.fsPath) }));
    },

    /**
     * 按内容全文搜索（宿主 Node fs 受限实现；对齐内核 list_dir 忽略规则 + 上限保护）
     *
     * @param options pattern 为内容关键词（正则语义，大小写不敏感）；exclude 排除路径子串
     * @returns 命中文件路径 + 行号 + 预览片段（供 read_file 精读定位）
     */
    async searchText(options: ProjectTextSearchOptions): Promise<ProjectTextMatch[]> {
      const matches: ProjectTextMatch[] = [];
      const maxResults = Math.min(options.maxResults ?? 20, MAX_RESULTS);
      // 关键词按正则（escape 后精确匹配；大小写不敏感对齐全局搜索缺省）
      const re = new RegExp(escapeRegExp(options.pattern), 'i');
      const excludeSegments = (options.exclude ?? '').split('/').filter(Boolean);
      const counter = { scanned: 0 };
      await walkText(
        root,
        root,
        re,
        excludeSegments,
        matches,
        maxResults,
        counter,
      );
      return matches;
    },
  };
}

/**
 * 递归遍历项目目录，对文本文件做内容匹配（受限：忽略目录 + 扫描文件数上限 + 单文件读取上限）
 *
 * @param root 项目根（用于相对路径 + 子目录递归）
 * @param current 当前遍历目录
 * @param re 内容匹配正则
 * @param excludeSegments exclude 路径段（含任一则跳过该路径）
 * @param matches 结果收集（超 maxResults 停止）
 * @param maxResults 结果上限
 * @param counter 已扫描文件计数（超 MAX_FILES_SCANNED 停止）
 */
async function walkText(
  root: string,
  current: string,
  re: RegExp,
  excludeSegments: string[],
  matches: ProjectTextMatch[],
  maxResults: number,
  counter: { scanned: number },
): Promise<void> {
  if (matches.length >= maxResults || counter.scanned >= MAX_FILES_SCANNED) return;

  let names: string[];
  try {
    names = await readdir(current);
  } catch {
    return; // 目录不可读：跳过
  }
  names.sort();

  for (const name of names) {
    if (matches.length >= maxResults || counter.scanned >= MAX_FILES_SCANNED) return;
    // 忽略标准目录（对齐内核 list_dir）
    if (IGNORED_DIR_NAMES.has(name)) continue;
    // exclude 路径段过滤（路径任意段命中即跳过）
    if (excludeSegments.length > 0 && excludeSegments.some((seg) => name.includes(seg))) continue;

    const abs = join(current, name);
    const rel = toProjectRelative(root, abs);
    try {
      const s = await stat(abs);
      if (s.isDirectory()) {
        await walkText(root, abs, re, excludeSegments, matches, maxResults, counter);
      } else {
        // 跳过超大文件（单文件读取上限防内存/性能风险）
        if (s.size > MAX_FILE_BYTES) continue;
        counter.scanned++;
        await matchFileText(abs, rel, re, matches, maxResults);
      }
    } catch {
      // 单个文件 stat/读失败：跳过（权限/并发删除等）
    }
  }
}

/**
 * 读取单个文件并收集内容匹配（只读前 MAX_FILE_BYTES 字节，单文件最多 MAX_MATCHES_PER_FILE 条）
 *
 * @param abs 文件绝对路径
 * @param rel 文件相对项目根的 posix 路径
 * @param re 内容匹配正则
 * @param matches 结果收集
 * @param maxResults 结果上限
 */
async function matchFileText(
  abs: string,
  rel: string,
  re: RegExp,
  matches: ProjectTextMatch[],
  maxResults: number,
): Promise<void> {
  let content: string;
  try {
    // 只读前 MAX_FILE_BYTES 字节（对齐 size 预检双保险，防读取中途文件膨胀）
    const buf = await readFile(abs);
    content = buf.subarray(0, MAX_FILE_BYTES).toString('utf-8');
  } catch {
    return;
  }
  if (matches.length >= maxResults) return;

  const lines = content.split('\n');
  let hits = 0;
  for (let i = 0; i < lines.length && hits < MAX_MATCHES_PER_FILE; i++) {
    const line = lines[i]!;
    if (!re.test(line)) continue;
    // 预览片段：去控制字符 + 限长（防不可见字符/超长行注入上下文）
    const preview = line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 200);
    matches.push({ path: rel, line: i + 1, preview });
    hits++;
    if (matches.length >= maxResults) return;
  }
}

/**
 * 正则特殊字符转义（内容关键词按字面量匹配，避免用户/LLM 输入误触发正则元字符）
 *
 * @param input 原始关键词
 * @returns 转义后的正则字面量
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 绝对路径转相对项目根的 posix 路径（Windows 反斜杠统一为正斜杠，对齐 read_file 相对路径语义）
 *
 * @param root 项目根绝对路径
 * @param absolutePath 目标绝对路径
 * @returns 相对项目根的 posix 路径
 */
function toProjectRelative(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}
