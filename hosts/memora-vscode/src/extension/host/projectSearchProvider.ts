/**
 * VS Code 项目搜索提供者 — IProjectSearchProvider 的宿主实现
 *
 * 将 VS Code 原生全局搜索能力注入内核，供 LLM 的 search_project 工具使用：
 *   - name 模式：workspace.findFiles（stable API，底层 ripgrep，按文件名 glob，高效可靠）
 *   - content 模式：宿主 Node fs 受限实现（workspace.findTextInFiles 为 proposed API，非 stable，
 *     不可用于生产；故用受控递归扫描 + 正则匹配；忽略目录与结果上限 import 自内核单一真理源）
 *
 * 四项可靠性设计：
 *   - exclude 语义统一：content 模式按 glob 通配匹配相对路径（支持 ** / * / ?），与 name 模式一致；
 *   - 诚实化上报（SEARCH-1）：截断及其主因 / 已扫文件数 / 超大跳过数 / 单文件上限 / 是否放宽 —— 一律回报
 *     内核，零命中不再与"没搜完""搜坏了"逐字同形（截断挂在逐条命中上时，空数组没有载体）；
 *   - 精确优先 + 零命中回退：content 模式先按整串字面量匹配，整串零命中**且**内核下发了 `terms` 才做一次
 *     分词 OR 放宽（放宽的判定留在这里：只有宿主知道扫了多少、扫完没有）；
 *   - mtime 快照缓存：同一 provider 实例内复用未变更文件的读取内容，跳过重复 readFile IO。
 *
 * 相对路径约定：返回相对项目根的 posix 路径（正斜杠），与 read_file / list_dir 的相对路径
 * 语义对齐——LLM 拿到搜索命中路径后可无缝 read_file 精读。
 */
import * as vscode from 'vscode';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, join } from 'node:path';
import {
  IGNORED_DIR_NAMES,
  PROJECT_SEARCH_RESULT_MAX_LEN,
  type IProjectSearchProvider,
  type ProjectFileMatch,
  type ProjectFileSearchOptions,
  type ProjectTextMatch,
  type ProjectTextSearchOptions,
  type ProjectTextSearchResult,
} from '@zooique/memora';

/** content 搜索最大扫描文件数（防超大项目遍历失控卡死主循环） */
const MAX_FILES_SCANNED = 500;
/** content 搜索单文件读取上限（字节，防大文件/二进制读爆内存） */
const MAX_FILE_BYTES = 64 * 1024;
/** content 搜索单文件最大命中数（防单文件刷屏撑爆上下文） */
const MAX_MATCHES_PER_FILE = 3;
/** content 搜索内容缓存上限条目数（防内存无界增长；对齐 MAX_FILES_SCANNED 量级） */
const MAX_CONTENT_CACHE_ENTRIES = 500;

/**
 * 创建 VS Code 项目搜索提供者
 *
 * @param root 项目根绝对路径（用于把搜索结果转为相对路径；通常 = workspaceFolders[0]）
 * @returns 实现 IProjectSearchProvider 的提供者（注入 AgentOptions.projectSearchProvider）
 */
export function createVscodeProjectSearchProvider(root: string): IProjectSearchProvider {
  // content 搜索性能缓存（mtime 快照）：绝对路径 → { mtimeMs, size, content }；
  // mtime 未变时复用上次读取内容，跳过重复 readFile IO（同一 provider 实例内持续生效）
  const contentCache = new Map<string, { mtimeMs: number; size: number; content: string }>();
  return {
    /**
     * 按文件名 glob 搜索（workspace.findFiles，stable API）
     *
     * @param options query 为文件名 glob（省略时列出项目全部文件）；exclude 排除 glob
     * @returns 相对项目根的文件路径列表
     */
    async searchFiles(options?: ProjectFileSearchOptions): Promise<ProjectFileMatch[]> {
      const include = options?.query || '**/*';
      // name 模式与 content 模式忽略语义对齐：findFiles 显式排除 IGNORED_DIR_NAMES（含 .memora），
      // 否则 LLM 会搜到数据目录内的 task-table.md 等内核管理文件，形成「伪建表」自我强化
      // （2026-09-07 触发样本实证：LLM search_project "task-table" 命中 .memora/task-table.md 后继续沿用 write_file）。
      const ignoreGlob = IGNORED_DIR_NAMES.map((d) => `**/${d}/**`).join(',');
      const exclude = options?.exclude ? `${ignoreGlob},${options.exclude}` : ignoreGlob;
      const maxResults = Math.min(options?.maxResults ?? PROJECT_SEARCH_RESULT_MAX_LEN, PROJECT_SEARCH_RESULT_MAX_LEN);
      const uris = await vscode.workspace.findFiles(include, exclude, maxResults);
      return uris.map((u) => ({ path: toProjectRelative(root, u.fsPath) }));
    },

    /**
     * 按内容全文搜索（宿主 Node fs 受限实现；对齐内核 list_dir 忽略规则 + 上限保护）
     *
     * 两轮语义（精确优先 + 零命中回退）：先按 `pattern` **字面量**整串匹配（大小写不敏感，
     * 对齐全局搜索缺省）；整串零命中**且**内核下发了 `terms` 时，才用 `terms` 做一次 OR 放宽，
     * 并以 `relaxed` + `termsUsed` 如实回报。
     *
     * 注：`pattern` 是**字面量**而非正则（原注释误称"正则语义"，下一行就被 `escapeRegExp` 撤销——
     * 属断言与实现相悖的僵尸声明，2026-09-15 随 SEARCH-1 一并纠正）。
     *
     * @param options pattern 为内容关键词（字面量，大小写不敏感）；terms 为内核下发的放宽词表；
     *                exclude 排除路径 glob
     * @returns 命中列表 + 本次检索的元信息（截断/主因/已扫数/超大跳过/单文件上限/是否放宽）
     */
    async searchText(options: ProjectTextSearchOptions): Promise<ProjectTextSearchResult> {
      const maxResults = Math.min(options.maxResults ?? 20, PROJECT_SEARCH_RESULT_MAX_LEN);
      // exclude 语义与 name 模式统一：glob 通配匹配相对路径（支持 ** / * / ?）
      const excludeRe = options.exclude ? globToRegExp(options.exclude) : null;
      // 第一轮：整串字面量（精确优先）
      const primary = await scanText(
        root,
        escapeRegExp(options.pattern),
        maxResults,
        excludeRe,
        contentCache,
      );
      const terms = options.terms ?? [];
      if (primary.matches.length > 0 || terms.length === 0) return toTextResult(primary);
      // 第二轮：零命中且内核下发了放宽词表 → 分词 OR 放宽（任一命中即算，非"全部包含"）
      const relaxed = await scanText(
        root,
        terms.map(escapeRegExp).join('|'),
        maxResults,
        excludeRe,
        contentCache,
      );
      return { ...toTextResult(relaxed), relaxed: true, termsUsed: [...terms] };
    },
  };
}

/**
 * 一次内容扫描的事实收集（截断/跳过**一律回报**，不做静默）
 */
interface TextScanState {
  /** 是否达上限提前停止（还有结果/文件未返回） */
  truncated: boolean;
  /** 截断主因：results 结果达上限 / files 扫描达文件上限 */
  truncatedBy?: 'results' | 'files';
  /** 实际参与匹配的文件数（超大/不可读的不计入） */
  scannedFiles: number;
  /** 因超过单文件读取上限而被整文件跳过的文件数 */
  oversizedSkipped: number;
  /** 是否有文件的命中数被单文件上限截断（精确判定：真见到第 CAP+1 条命中才置位） */
  perFileCapped: boolean;
}

/** 一次扫描的产出 */
interface TextScan {
  matches: ProjectTextMatch[];
  state: TextScanState;
}

/**
 * 执行一次内容扫描（一次扫描 = 一个正则 + 一份状态）
 *
 * @param root 项目根绝对路径
 * @param patternSource 已转义的正则源（调用方负责逃生：字面量或 `a|b` 词表）
 * @param maxResults 结果条数上限
 * @param excludeRe exclude glob 转正则（null 表示不过滤）
 * @param cache content 缓存（mtime 快照，复用未变更文件内容）
 */
async function scanText(
  root: string,
  patternSource: string,
  maxResults: number,
  excludeRe: RegExp | null,
  cache: Map<string, { mtimeMs: number; size: number; content: string }>,
): Promise<TextScan> {
  const matches: ProjectTextMatch[] = [];
  const state: TextScanState = {
    truncated: false,
    scannedFiles: 0,
    oversizedSkipped: 0,
    perFileCapped: false,
  };
  const re = new RegExp(patternSource, 'i');
  await walkText(root, root, re, excludeRe, matches, maxResults, state, cache);
  return { matches, state };
}

/**
 * 扫描状态 → 结果对象（可选字段仅在"真的发生了"时才带上，避免 `undefined` 占位被误读为"否"）
 */
function toTextResult(scan: TextScan): ProjectTextSearchResult {
  const { state } = scan;
  return {
    matches: scan.matches,
    truncated: state.truncated,
    ...(state.truncatedBy !== undefined ? { truncatedBy: state.truncatedBy } : {}),
    scannedFiles: state.scannedFiles,
    ...(state.oversizedSkipped > 0 ? { oversizedSkipped: state.oversizedSkipped } : {}),
    ...(state.perFileCapped ? { perFileCapped: true } : {}),
  };
}

/**
 * 是否已达上限需要停止（并记录截断主因）
 *
 * 结果上限优先于文件上限：结果已满 = 更靠前的停因，也是更可操作的信息（换更精确的关键词）。
 *
 * @returns true 表示应立即停止本次遍历
 */
function shouldStop(matchCount: number, state: TextScanState, maxResults: number): boolean {
  if (matchCount >= maxResults) {
    state.truncated = true;
    state.truncatedBy = 'results';
    return true;
  }
  if (state.scannedFiles >= MAX_FILES_SCANNED) {
    state.truncated = true;
    state.truncatedBy = 'files';
    return true;
  }
  return false;
}

/**
 * 递归遍历项目目录，对文本文件做内容匹配（受限：忽略目录 + 扫描文件数上限 + 单文件读取上限）
 *
 * 忽略语义（G5 合并规则）：默认忽略（IGNORED_DIR_NAMES，如 node_modules）与调用方 exclude
 * 是独立叠加关系（AND）——默认忽略目录无条件跳过，调用方无法通过 exclude 取消忽略；
 * exclude 只额外过滤（匹配相对路径，支持 ** / * / ?，目录命中即跳整棵子树）。
 *
 * @param root 项目根（用于相对路径 + 子目录递归）
 * @param current 当前遍历目录
 * @param re 内容匹配正则
 * @param excludeRe exclude glob 转正则（匹配相对路径；null 表示不过滤）
 * @param matches 结果收集（超 maxResults 停止）
 * @param maxResults 结果上限
 * @param state 扫描状态（截断/已扫数/超大跳过/单文件上限）
 * @param cache content 缓存（mtime 快照，复用未变更文件内容）
 */
async function walkText(
  root: string,
  current: string,
  re: RegExp,
  excludeRe: RegExp | null,
  matches: ProjectTextMatch[],
  maxResults: number,
  state: TextScanState,
  cache: Map<string, { mtimeMs: number; size: number; content: string }>,
): Promise<void> {
  // 达上限提前停止：记录截断与主因（还有更多结果/文件未返回），由 searchText 统一带出
  if (shouldStop(matches.length, state, maxResults)) return;

  let names: string[];
  try {
    names = await readdir(current);
  } catch {
    return; // 目录不可读：跳过
  }
  names.sort();

  for (const name of names) {
    if (shouldStop(matches.length, state, maxResults)) return;
    // 忽略标准目录（import 自内核单一真理源 IGNORED_DIR_NAMES，与 list_dir 规则一致）
    if (IGNORED_DIR_NAMES.includes(name)) continue;

    const abs = join(current, name);
    const rel = toProjectRelative(root, abs);
    // exclude glob 匹配相对路径（与 name 模式语义一致，支持 ** / * / ?）
    if (excludeRe && excludeRe.test(rel)) continue;

    try {
      const s = await stat(abs);
      if (s.isDirectory()) {
        // 目录级 exclude：目录自身或其子路径前缀命中即跳过整棵子树（如 exclude "docs/**" 跳过 docs 目录）
        if (excludeRe && (excludeRe.test(rel) || excludeRe.test(`${rel}/`))) continue;
        await walkText(root, abs, re, excludeRe, matches, maxResults, state, cache);
      } else {
        // 读取文件文本（带 mtime 快照缓存）；超大文件/读取失败返回 null 跳过
        const loaded = await readTextCached(abs, cache);
        if (loaded === null) continue;
        // 跳过超大文件（单文件读取上限防内存/性能风险）——跳过数**必须上报**：
        // 静默跳过 = 调用方会把"这部分没搜"读成"项目里没有"（F4-lite）
        if (loaded.size > MAX_FILE_BYTES) {
          state.oversizedSkipped++;
          continue;
        }
        state.scannedFiles++;
        await matchFileText(rel, re, loaded.content, matches, maxResults, state);
      }
    } catch {
      // 单个文件 stat/读失败：跳过（权限/并发删除等）
    }
  }
}

/**
 * 收集单个文件的内容匹配（单文件最多 MAX_MATCHES_PER_FILE 条）
 *
 * 单文件上限是"精确判定"而非保守猜测：命中满 CAP 后**继续探测**是否还有第 CAP+1 条命中，
 * 真见到才置 `perFileCapped`（否则"还剩更多"是我猜的，而不是事实）。代价 ≈ 一个正则扫描。
 *
 * 注：`content` 由 `readTextCached` 提供（当前实现为整文件读入后截断，见该函数注释的 S2 待办）。
 *
 * @param rel 文件相对项目根的 posix 路径
 * @param re 内容匹配正则
 * @param content 文件内容
 * @param matches 结果收集
 * @param maxResults 结果上限
 * @param state 扫描状态（置 perFileCapped）
 */
async function matchFileText(
  rel: string,
  re: RegExp,
  content: string,
  matches: ProjectTextMatch[],
  maxResults: number,
  state: TextScanState,
): Promise<void> {
  if (matches.length >= maxResults) return;

  const lines = content.split('\n');
  let hits = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!re.test(line)) continue;
    if (hits >= MAX_MATCHES_PER_FILE) {
      state.perFileCapped = true;
      return;
    }
    // 预览片段：去控制字符 + 限长（防不可见字符/超长行注入上下文）
    const preview = line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 200);
    matches.push({ path: rel, line: i + 1, preview });
    hits++;
    if (matches.length >= maxResults) return;
  }
}

/**
 * 读取文件文本（带 mtime 快照缓存：mtime 未变时复用上次内容，跳过重复 readFile IO）
 *
 * @param abs 文件绝对路径
 * @param cache content 缓存（provider 闭包持有）
 * @returns { size, content } 文件大小与内容（当前为整文件读入）；读取失败返回 null
 *
 * ⚠️ **已知未达成的宣称**（F4，S2 待办）：本函数当前为 `readFile` **全量读入**后再由调用方按
 * `size > MAX_FILE_BYTES` 跳过——也就是说 `MAX_FILE_BYTES` 的"防大文件读爆内存"保护**尚未生效**，
 * 且超大文件是**整文件不可搜**（而非只搜前 N 字节）。S2 改为：`size` 预检前移到 `readFile` 之前
 * + `fs.open`/`read` 只读前 64KB + UTF-8 字节边界按 `lastIndexOf('\n')` 收口。
 * 本次（S1）只把"跳过了多少个"如实上报，不动 IO。
 */
async function readTextCached(
  abs: string,
  cache: Map<string, { mtimeMs: number; size: number; content: string }>,
): Promise<{ size: number; content: string } | null> {
  try {
    const s = await stat(abs);
    const hit = cache.get(abs);
    // mtime 未变：复用缓存内容（省 readFile IO；同一会话多次搜索不同关键词时显著加速）
    if (hit && hit.mtimeMs === s.mtimeMs) {
      return { size: hit.size, content: hit.content };
    }
    // 整文件读入后截断到 MAX_FILE_BYTES 字节（S2 将改为只读前 N 字节，见函数注释）
    const buf = await readFile(abs);
    const content = buf.subarray(0, MAX_FILE_BYTES).toString('utf-8');
    // 缓存上限保护：超限清空（简单策略，防内存无界增长）
    if (cache.size >= MAX_CONTENT_CACHE_ENTRIES) cache.clear();
    cache.set(abs, { mtimeMs: s.mtimeMs, size: s.size, content });
    return { size: s.size, content };
  } catch {
    return null;
  }
}

/**
 * glob 转正则（支持 ** / * / ? 通配，路径以 / 分隔；语义对齐 VS Code search.exclude）
 *
 * 变换顺序：先转义正则元字符（保留 glob 通配符），再处理「双星+斜杠」→ 零或多级目录、
 * 双星 → 任意、单星 → 单层内任意（不含 /）、问号 → 单字符。
 *
 * @param glob 排除模式（如 "node_modules/**" 或 "docs/**"，按相对路径匹配）
 * @returns 用于匹配相对路径的正则
 */
function globToRegExp(glob: string): RegExp {
  // 转义正则特殊字符（glob 通配符 * ? 保留待替换；字符集排除 * ?）
  let re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // **/ 可匹配零或多个目录层级（如 src/**/utils.ts 匹配 src/utils.ts）
  re = re.replace(/\*\*\//g, '(?:[^/]*/)*');
  // 剩余 ** 匹配任意字符（含 /，用于尾部如 node_modules/**）
  re = re.replace(/\*\*/g, '.*');
  // 单 * 匹配单层内任意（不含 /）
  re = re.replace(/\*/g, '[^/]*');
  // ? 匹配单个字符（不含 /）
  re = re.replace(/\?/g, '[^/]');
  return new RegExp(`^(?:${re})$`);
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
