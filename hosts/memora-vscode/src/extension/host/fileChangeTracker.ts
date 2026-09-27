/**
 * 文件改动追踪（extension 侧 · 纯逻辑，零 vscode 依赖）
 *
 * 用途：为「无 git 依赖的文件改动可见性」提供**未确认改动**的内存记录。
 * 设计依据：docs/方案-文件改动diff可视化-20260926.md（host-only，零内核改动）。
 *
 * 职责边界：
 *   - 只做「记录」——从 tool_start / tool_result 两个宿主事件派生改动事实；不打开编辑器、
 *     不做渲染（渲染归 fileChangeView）。
 *   - 键 = 文件**绝对路径**（一个文件一条记录）；同一文件多次写入**合并**（保留最早 beforeContent），
 *     使「回退本文件改动」回到本文件**尚未被你接受的改动之前**的状态（保留最早 beforeContent，而非上一次中间态）。
 *   - `toolCallId` 仅作写前/写后配对的**临时键**（pending），不作记录主键。
 *   - 记录生命周期：跨会话存活；仅「确认 / 恢复」注销，或扩展重启清空。
 *
 * 无 vscode 依赖 ⇒ 可在 node 环境纯单测（见 __tests__/fileChangeTracker.test.ts）。
 *
 * @module fileChangeTracker
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
// WRITE_PATH_EXTRACTORS：内核「按 args.path 改盘的工具」清单（loop 同路径写串行闸的判据）——
// 本模块的触发集合**派生自它的键**，禁并列维护第二份清单（两份必漂移 = 跨包静默少报）。
import { WRITE_PATH_EXTRACTORS } from '@zooique/memora';

/**
 * 触发追踪的内核落盘文件工具（派生集合，唯一真源 = 内核 `WRITE_PATH_EXTRACTORS` 的键）
 *
 * 实证：内核落盘工具仅 `write_file` / `delete_file`（内核 `src/agent/builtinTools.ts` 内置工具表中
 * `name: 'write_file'` 与 `name: 'delete_file'` 两项）；
 * 新建文件走 write_file 的 overwrite，无独立 create_file/edit_file。
 * `task_table_*` 是内核数据不落盘，排除。
 *
 * 派生而非并列的意义：内核新增「按 path 改盘」的工具时，宿主**自动跟随**进追踪，
 * 不会再出现「内核进了串行闸、宿主不知情」的改动可视化静默少报。
 *
 * ⚠️ 覆盖边界（已闭环）：清单只认 `args.path` 定位的写工具 ⇒ `run_code` / `run_skill_script`
 * / `run_project_script`（能改盘但无 `path`）**不进本清单的按路径追踪**——但它们在内核 `loop.ts`
 * 走 `diskWrite:'opaque'` 屏障（与一切写互斥，防并行丢内容已覆盖），且宿主对这类工具做「执行前后
 * 目录快照 diff」收口（见 `noteExternalMutations`），脚本类改动可见性盲区已闭环（台账 DIFF-4 可视化半已解除）。
 */
export const DISK_WRITE_TOOLS: readonly string[] = Object.keys(WRITE_PATH_EXTRACTORS);

/** 单条未确认改动（按文件归属：一个文件一条） */
export interface FileChangeRecord {
  /** 记录键 = 文件绝对路径 */
  path: string;
  /** 相对项目根路径（展示用） */
  relPath: string;
  /** 该文件**首次**未确认改动前的快照；新建文件 = null */
  beforeContent: string | null;
  /** **最近一次**写入后的内容；已删除 = null */
  afterContent: string | null;
  /** 最近一次 write_file 的写入模式（overwrite/append/insert） */
  mode?: string;
  /** 累积写入次数（展示用） */
  writeCount: number;
  /** 最近改动时刻（展示 / 淘汰用） */
  updatedAt: number;
}

/**
 * 脚本类工具（opaque 写）执行前后目录快照 diff 得到的单条文件变更
 *
 * 与 `FileChangeRecord` 不同：这里只有「绝对路径 + 执行前/后内容」，**不含 relPath / writeCount /
 * mode**——那些由 `noteExternalMutations` 按文件路径合并时补全（relPath 由 projectRoot 推导、
 * writeCount 累加、脚本类无 mode）。内容是调用方（chatPanel）在执行前后各扫一次 workspace 得到的
 * 事实快照，本模块不接触文件系统。
 */
export interface ExternalFileChange {
  /** 文件绝对路径（键） */
  absPath: string;
  /** 执行前内容；文件为脚本新建 = null */
  beforeContent: string | null;
  /** 执行后内容；文件被脚本删除 = null */
  afterContent: string | null;
}

/**
 * 比对两次 workspace 文本快照，输出变更集（纯函数，无 IO，可单测）
 *
 * 输入：before / after = `Map<absPath, 文件内容>`（调用方负责扫描与读取）。
 * 输出三类变更（均带 before/after 内容，供恢复用）：
 *   - 在 before 不在 after → 删除（afterContent = null）
 *   - 在 after 不在 before → 新增（beforeContent = null）
 *   - 都在但内容不同 → 修改
 *
 * 设计边界：只比对「内容」——调用方扫描时已排除构建/内部目录（node_modules/.git/.memora 等），
 * 故这里的变动集即「用户可见的源码/文档改动」，不含 memora 自身数据噪音。
 */
export function diffWorkspaceSnapshots(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): ExternalFileChange[] {
  const changes: ExternalFileChange[] = [];
  for (const [absPath, beforeText] of before) {
    if (!after.has(absPath)) {
      changes.push({ absPath, beforeContent: beforeText, afterContent: null });
    } else if (after.get(absPath) !== beforeText) {
      changes.push({ absPath, beforeContent: beforeText, afterContent: after.get(absPath)! });
    }
  }
  for (const [absPath, afterText] of after) {
    if (!before.has(absPath)) {
      changes.push({ absPath, beforeContent: null, afterContent: afterText });
    }
  }
  return changes;
}

/** 读文件能力（默认走 node:fs；测试注入假实现以保持纯逻辑可测、无真实 IO） */
export interface FileChangeIO {
  /** 读文本文件；不存在 / 读失败返回 null */
  readTextFile(absPath: string): string | null;
}

export interface FileChangeTrackerOptions {
  /** 读文件实现（默认 node:fs） */
  io?: FileChangeIO;
  /** 记录条目上限；超出淘汰最旧未确认条目（被淘汰 = 不可再恢复）。默认 100 */
  maxRecords?: number;
  /** 时钟注入（测试确定性）；默认 Date.now */
  now?: () => number;
}

/** tool_start 宿主侧最小输入形状（对位内核 AgentChunk.tool_start） */
export interface ToolStartLike {
  toolCallId: string;
  name: string;
  /** 工具参数 JSON 字符串（内核原样透传，可能是 undefined） */
  args?: string;
}

/** tool_result 宿主侧最小输入形状（对位内核 AgentChunk.tool_result） */
export interface ToolResultLike {
  toolCallId: string;
  name: string;
  ok: boolean;
  blocked?: boolean;
}

/**
 * 改动事件接入面（chatPanel 的**唯一**接入点）
 *
 * 定义在纯逻辑模块内（不含 vscode 类型），使 chatPanel 依赖此窄接口即可，
 * 无需直接依赖渲染实现（fileChangeView）——依赖倒置，降低耦合。
 */
export interface FileChangeSink {
  noteToolStart(chunk: ToolStartLike): void;
  noteToolResult(chunk: ToolResultLike): void;
  /** 脚本类工具（opaque 写）执行前后快照 diff 得到的变更集收口 */
  noteExternalMutations(changes: ExternalFileChange[]): void;
}

/** 写前快照的临时配对项（仅本次调用生命周期） */
interface PendingEntry {
  absPath: string;
  relPath: string;
  beforeContent: string | null;
  mode?: string;
}

/**
 * 解析写工具参数 JSON → { path, mode }
 *
 * `args` 是 JSON **字符串**且类型可选（内核 `AgentChunk` 的 `tool_start` 成员，见 `src/agent/types.ts`）：
 * `undefined` / 解析失败 / 无 `path`
 * 一律返回 null（调用方跳过，不追踪不抛错）。
 */
function parseWriteArgs(args: string | undefined): { path: string; mode?: string } | null {
  if (!args) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const p = rec['path'];
  if (typeof p !== 'string' || p.length === 0) return null;
  const mode = typeof rec['mode'] === 'string' ? rec['mode'] : undefined;
  return mode === undefined ? { path: p } : { path: p, mode };
}

/**
 * 归一为**相对项目根**的展示路径
 *
 * `relPath` 会经 `file_changes` 下发 webview 并展示（协议声明「不下发绝对路径，避免在 UI
 * 暴露无关信息」），而模型偶发把 `path` 写成绝对路径——内核 `assertPathAllowed` 接受绝对
 * 路径、不拦，故原样透传即泄漏用户目录结构。这里绝对路径一律折回相对路径，
 * 并把 Windows 反斜杠统一为正斜杠（同一清单里两种分隔符并存会误导用户）。
 * 相对路径（正常情形）原样返回，行为不变。
 */
function toRelPath(rawPath: string, absPath: string, projectRoot: string): string {
  if (!isAbsolute(rawPath)) return rawPath;
  return relative(projectRoot, absPath).split(sep).join('/');
}

/** 默认 IO：node:fs 同步读（ENOENT / 权限失败 → null） */
const defaultIO: FileChangeIO = {
  readTextFile(absPath: string): string | null {
    try {
      return readFileSync(absPath, 'utf-8');
    } catch {
      return null;
    }
  },
};

export class FileChangeTracker {
  /** 记录表：键 = 文件绝对路径 */
  private readonly records = new Map<string, FileChangeRecord>();
  /** 写前快照临时表：键 = toolCallId（用完即删） */
  private readonly pending = new Map<string, PendingEntry>();
  private readonly io: FileChangeIO;
  private readonly maxRecords: number;
  private readonly now: () => number;

  /**
   * @param projectRoot 项目根绝对路径（tool args.path 为**相对项目根**，据此解析）
   * @param options 注入项（io / maxRecords / now）
   */
  constructor(
    private readonly projectRoot: string,
    options: FileChangeTrackerOptions = {},
  ) {
    this.io = options.io ?? defaultIO;
    this.maxRecords = options.maxRecords ?? 100;
    this.now = options.now ?? Date.now;
  }

  /**
   * tool_start：写前快照
   *
   * 此刻工具尚未执行（loop 先 yield tool_start 再执行），磁盘仍是**旧内容** ⇒ 读盘即 beforeContent。
   * 非落盘工具 / 参数不可解析 → 静默跳过。
   */
  noteToolStart(chunk: ToolStartLike): void {
    if (!DISK_WRITE_TOOLS.includes(chunk.name)) return;
    const parsed = parseWriteArgs(chunk.args);
    if (!parsed) return;
    const absPath = isAbsolute(parsed.path) ? parsed.path : resolve(this.projectRoot, parsed.path);
    this.pending.set(chunk.toolCallId, {
      absPath,
      relPath: toRelPath(parsed.path, absPath, this.projectRoot),
      beforeContent: this.io.readTextFile(absPath),
      mode: parsed.mode,
    });
  }

  /**
   * tool_result：写后合并
   *
   * `ok && !blocked` 才视为发生写入（blocked / 失败 → 丢弃 pending，无记录）。
   * 按**文件路径**合并：目标文件已有未确认记录 → 保留旧 `beforeContent`，只更新其余字段。
   *
   * @returns 合并后的记录；无有效改动时返回 null
   */
  noteToolResult(chunk: ToolResultLike): FileChangeRecord | null {
    const entry = this.pending.get(chunk.toolCallId);
    if (!entry) return null;
    this.pending.delete(chunk.toolCallId);
    if (!chunk.ok || chunk.blocked) return null;
    const afterContent = this.io.readTextFile(entry.absPath);
    const record = this.upsert(entry.absPath, entry.relPath, entry.beforeContent, afterContent, entry.mode);
    this.evictOverflow();
    return record;
  }

  /**
   * 外部（脚本类工具）改动收口：把「执行前后目录快照 diff」得到的变更集并入记录表。
   *
   * 用途：`run_code` / `run_project_script` / `run_skill_script` 标 `diskWrite:'opaque'`，目标路径
   * 运行时才可知，无法走 `noteToolStart` 的 `args.path` 提取。宿主在工具执行**前后**各扫一次
   * workspace 文本快照、diff 出变动文件，把结果（已含 before/after 内容）喂到这里。
   *
   * 合并语义与 `noteToolResult` **完全一致**（同走 `upsert`）：按文件路径合并、保留最早
   * `beforeContent`、writeCount+1——故脚本改的文件若之前已被 `write_file` 建过，两份记录自然合并，
   * 不另造状态面。脚本类无 `mode`（非 write_file 三模式），故不写 `mode` 字段。
   *
   * @returns 本次新增 / 更新的记录（调用方据此触发渲染）
   */
  noteExternalMutations(changes: ExternalFileChange[]): FileChangeRecord[] {
    const out: FileChangeRecord[] = [];
    for (const ch of changes) {
      const relPath = relative(this.projectRoot, ch.absPath).split(sep).join('/');
      out.push(this.upsert(ch.absPath, relPath, ch.beforeContent, ch.afterContent));
    }
    this.evictOverflow();
    return out;
  }

  /** 按文件路径 upsert 一条记录（noteToolResult / noteExternalMutations 共用，合并逻辑单源） */
  private upsert(
    absPath: string,
    relPath: string,
    beforeContent: string | null,
    afterContent: string | null,
    mode?: string,
  ): FileChangeRecord {
    const existing = this.records.get(absPath);
    const updatedAt = this.now();
    const record: FileChangeRecord = existing
      ? { ...existing, afterContent, mode: mode ?? existing.mode, writeCount: existing.writeCount + 1, updatedAt }
      : {
          path: absPath,
          relPath,
          beforeContent,
          afterContent,
          writeCount: 1,
          updatedAt,
          ...(mode === undefined ? {} : { mode }),
        };
    this.records.set(absPath, record);
    return record;
  }

  /** 全部未确认改动（按改动时间升序） */
  list(): FileChangeRecord[] {
    return [...this.records.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  }

  /** 未确认改动条数（状态栏计数） */
  size(): number {
    return this.records.size;
  }

  /** 取单条（键 = 绝对路径） */
  get(absPath: string): FileChangeRecord | undefined {
    return this.records.get(absPath);
  }

  /** 注销单条（确认 / 恢复后调用） */
  drop(absPath: string): void {
    this.records.delete(absPath);
  }

  /**
   * 块级动作后更新记录内容（记录状态的**唯一写入口**）
   *
   * - 接受一块 ⇒ 改 `beforeContent`（基线并入该块；磁盘不动）；
   * - 拒绝一块 ⇒ 改 `afterContent`（磁盘已写成回退后的内容）。
   *
   * 走本方法而非外部直接改字段，是为了让「记录状态归 tracker 所有」这条不被绕过：
   * 直接改字段会让 `updatedAt` / 淘汰序 / 缓存失效时机各自漂移。
   * 记录不存在（已确认 / 已淘汰）⇒ 静默无事，不抛错。
   */
  updateContents(
    absPath: string,
    patch: { beforeContent?: string; afterContent?: string | null },
  ): void {
    const existing = this.records.get(absPath);
    if (!existing) return;
    this.records.set(absPath, { ...existing, ...patch });
  }

  /** 全清（扩展重启的自然边界之外，测试 / 显式重置用） */
  clear(): void {
    this.records.clear();
    this.pending.clear();
  }

  /** 超出上限则淘汰最旧（updatedAt 最小）条目 */
  private evictOverflow(): void {
    while (this.records.size > this.maxRecords) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, rec] of this.records) {
        if (rec.updatedAt < oldestAt) {
          oldestAt = rec.updatedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.records.delete(oldestKey);
    }
  }
}
