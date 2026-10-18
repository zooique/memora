/**
 * 只读记忆库 —— 直接只读打开工作区 `.memora/memories.db`（SQLite），检索语义全权委托内核
 *
 * ## SSOT 边界（刻意设计，勿改）
 *
 * 本文件**不实现任何检索/排序/过滤算法**，全部委托内核已导出物：
 *   - **检索与排序**（分词、accessedAt 降序、软删除过滤）→ 内核 `createNodeSqliteStorage(path, { readOnly: true })`
 *   - **取代状态判定**（`supersededBy` 悬空指针）→ 内核 `hasActiveSuperseder`
 *
 * 本文件只负责三件事：**定位库 → 只读打开 → 剔除被取代者**。
 *
 * 为什么不全量实现 `IMemoryStorage`：宿主侧自写第二套 SQL 语义 = 与内核并列，
 * 两边漂移后「同一份 .memora/ 在插件里和 MCP 里搜出不同结果」。用内核的只读视图即零并列。
 *
 * ## 为什么读 SQLite 而不是 memories.json（2026-10-18 修正）
 *
 * VS Code 宿主（`hosts/memora-vscode/.../memoryStorage.ts`）在 SQLite 可用时会把旧
 * `memories.json` **一次性迁移**到 `memories.db`，并把旧档改名 `memories.json.migrated-<date>`。
 * 再读 JSON 只会命中「文件不存在」分支并返回 0 条——**用户明明有记忆，却被 agent 判为无**，
 * 这正是本文件自述禁止的谎言。真源只有一份：`.memora/memories.db`。
 *
 * 附带收益：旧实现是「启动时把 JSON 灌进内存」的快照，运行期间宿主新写的记忆看不见；
 * 只读连接每次查询都读当前快照，**新记忆实时可见**。
 *
 * ## 只读保证由结构表达
 *
 * `ReadOnlyMemoryStorage` 在类型与运行时都**不含** `upsert / delete / restore / purge / touch`——
 * 不是「约定不乱调」，而是外部拿不到这些 API。约定会腐化，结构性缺失不会。
 *
 * ## 库不存在为什么「抛」而不是「降级空库」
 *
 * MCP 服务器起了就要回答记忆查询，**静默返回「没有记忆」是谎言**。库不存在有三种成因，
 * 必须分别说清（`explainMissing`）：未初始化 / 插件仍是旧 JSON 版 / 两侧数据布局漂移。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createNodeSqliteStorage,
  hasActiveSuperseder,
  MemoraError,
  ToolErrorCode,
  type Memory,
  type ReadOnlyMemoryStorage,
} from '@zooique/memora';

/** 数据目录名（与写宿主同一布局契约：`<工作区>/.memora/`） */
const DATA_DIR_NAME = '.memora';
/** 记忆库文件名（写宿主 `memoryStorage.ts` 的同一契约） */
const MEMORY_DB_FILENAME = 'memories.db';
/** 旧 JSON 档名（迁移后会被改名为 `memories.json.migrated-<date>`） */
const LEGACY_JSON_FILENAME = 'memories.json';

/**
 * 探测结果（诊断用：让「为什么这条记忆查不到」可解释，而非黑箱）。
 *
 * 不含 `exists` 字段——`probe()` 成功返回即意味库存在，恒真字段是死字段。
 */
export interface StoreProbe {
  /** 实际打开的库文件绝对路径（路径契约漂移时，这行日志就是证据） */
  dbPath: string;
  /** 当前版本条目数（已剔除软删除与被取代者） */
  totalCurrent: number;
  /** 已被现存且活跃的摘要取代、因而不参与检索的条目数 */
  superseded: number;
  /** 回收站（软删除）条目数 */
  deleted: number;
}

/** source 维度统计条目 */
export interface SourceSummary {
  source: string;
  /** 当前版本条目数（已剔除软删除与被取代者） */
  count: number;
}

export class ReadOnlyFileStore {
  /** 只读视图：写方法在类型与运行时都不存在 */
  private storage: ReadOnlyMemoryStorage | null = null;
  private readonly workspacePath: string;
  private readonly dbPath: string;

  /**
   * @param workspacePath 工作区根目录（记忆库位于 `<workspacePath>/.memora/memories.db`，
   *                      由 Memora VS Code 插件创建；本 Store 不建库、不迁移）
   */
  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.dbPath = join(workspacePath, DATA_DIR_NAME, MEMORY_DB_FILENAME);
  }

  /** 记忆库绝对路径（诊断输出用；**勿据此写盘**——本 Store 只读） */
  get path(): string {
    return this.dbPath;
  }

  /**
   * 只读打开记忆库并返回诊断。重复调用会先断开旧连接再重开（长驻进程可据此重连）。
   *
   * @throws MemoraError `FILE_NOT_FOUND`（库不存在，附三态成因）或环境不支持（`NOT_AVAILABLE`）
   */
  probe(): StoreProbe {
    this.close();
    let storage: ReadOnlyMemoryStorage;
    try {
      storage = createNodeSqliteStorage(this.dbPath, { readOnly: true });
    } catch (err) {
      // 只处理「未初始化」这一类：其余（环境不支持 / 库损坏）原样抛，不伪装成因
      if (err instanceof MemoraError && err.errorCode === ToolErrorCode.FILE_NOT_FOUND) {
        throw this.explainMissing(err);
      }
      throw err;
    }
    this.storage = storage;

    const deleted = storage.listDeleted().length;
    let totalCurrent = 0;
    let superseded = 0;
    for (const source of storage.getAllSources().keys()) {
      for (const memory of storage.getBySource(source)) {
        if (hasActiveSuperseder(memory, storage)) superseded++;
        else totalCurrent++;
      }
    }
    return { dbPath: this.dbPath, totalCurrent, superseded, deleted };
  }

  /** 释放连接（进程退出前可选调用；SQLite 连接不释放也不会丢数据） */
  close(): void {
    this.storage?.close?.();
    this.storage = null;
  }

  /** 关键词搜索当前版本记忆（分词 + accessedAt 降序由内核完成） */
  search(query: string, limit = 10): Memory[] {
    return this.current(this.requireStore().search(query, limit));
  }

  /** 按 id 取单条当前版本记忆；被取代/软删/不存在均返回 null */
  getById(id: string): Memory | null {
    const store = this.requireStore();
    const found = store.getById(id);
    return found && !hasActiveSuperseder(found, store) ? found : null;
  }

  /** 按 source 取当前版本记忆 */
  getBySource(source: string): Memory[] {
    return this.current(this.requireStore().getBySource(source));
  }

  /** 当前版本记忆总数 */
  count(): number {
    return this.allCurrent().length;
  }

  /** source 维度统计（按条目数降序，count 已剔除被取代者） */
  listSources(): SourceSummary[] {
    const counted = new Map<string, number>();
    for (const m of this.allCurrent()) {
      counted.set(m.source, (counted.get(m.source) ?? 0) + 1);
    }
    return [...counted.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ─── 内部 ───────────────────────────────────────────────

  /**
   * 取连接：未调用 `probe()` 即用属编程错误（早失败优于隐式 IO）。
   * 文案面向宿主维护者，不进 MCP 工具返回。
   */
  private requireStore(): ReadOnlyMemoryStorage {
    if (this.storage === null) {
      throw new Error('ReadOnlyFileStore 尚未 probe()：启动流程必须先探测记忆库再提供工具');
    }
    return this.storage;
  }

  /**
   * 剔除「已被现存且活跃的摘要取代」的条目。
   * 判据复用内核 `hasActiveSuperseder`：指针悬空（目标被移除）⇒ 视为未取代 ⇒ 旧摘要回退为当前版本。
   */
  private current(memories: Memory[]): Memory[] {
    const store = this.requireStore();
    return memories.filter((m) => !hasActiveSuperseder(m, store));
  }

  /** 全量当前版本记忆（按 source 分桶遍历，避免受 `search` 的 limit 截断影响） */
  private allCurrent(): Memory[] {
    const store = this.requireStore();
    const out: Memory[] = [];
    for (const source of store.getAllSources().keys()) {
      for (const m of store.getBySource(source)) {
        if (!hasActiveSuperseder(m, store)) out.push(m);
      }
    }
    return out;
  }

  /**
   * 把「库不存在」翻译成三态成因——三种情况的用户动作完全不同，混成一句就是废话：
   *   ① 目录里只有 `memories.json` → 插件仍是旧 JSON 版（未升级 / 未触发迁移）
   *   ② 目录里有 `memories.json.migrated-*` → 迁移发生过但 db 不在，两侧布局已漂移
   *   ③ 两者都没有 → 工作区从未被插件打开过
   * 保留内核的 `FILE_NOT_FOUND` 错误码，只换文案（判据不变，解释更具体）。
   */
  private explainMissing(cause: MemoraError): MemoraError {
    const dir = join(this.workspacePath, DATA_DIR_NAME);
    let entries: string[] = [];
    try {
      entries = existsSync(dir) ? readdirSync(dir) : [];
    } catch {
      // 目录不可读：不外抛——真正的成因仍是「库不存在」，读目录失败只让文案退化为通用版
    }

    const hasLegacyJson = entries.includes(LEGACY_JSON_FILENAME);
    const hasMigratedSnapshot = entries.some((name) =>
      name.startsWith(`${LEGACY_JSON_FILENAME}.migrated-`),
    );

    if (hasMigratedSnapshot) {
      return new MemoraError({
        title: '记忆库路径不一致：有迁移快照却没有 memories.db',
        detail:
          `目录 ${dir} 里存在旧档迁移快照，但 ${this.dbPath} 不存在。` +
          '这通常意味着两侧对数据布局的约定已经漂移（改过目录名或文件名）。',
        suggestions: [
          '确认 Memora VS Code 插件与 memora-mcp 为同一版本线',
          '检查 .memora/ 下实际存在的库文件名，并向维护者报告该差异',
        ],
        category: 'config',
        errorCode: ToolErrorCode.FILE_NOT_FOUND,
        cause,
      });
    }

    if (hasLegacyJson) {
      return new MemoraError({
        title: '记忆库尚未迁移到 SQLite',
        detail: `${dir} 里仍只有 memories.json，${this.dbPath} 不存在。`,
        suggestions: [
          '升级 Memora VS Code 插件到支持 SQLite 的版本，并打开该工作区一次（插件会自动迁移）',
          '迁移后旧的 memories.json 会改名保留，不会被删除',
        ],
        category: 'config',
        errorCode: ToolErrorCode.FILE_NOT_FOUND,
        cause,
      });
    }

    return new MemoraError({
      title: '记忆库不存在',
      detail: `${this.dbPath} 尚未创建。该工作区可能从未用 Memora 插件打开过。`,
      suggestions: [
        '用 Memora VS Code 插件（VS Code ≥1.101）打开该工作区一次，插件会创建记忆库',
        '确认 --db 指向的是工作区根目录，而不是它的子目录',
      ],
      category: 'config',
      errorCode: ToolErrorCode.FILE_NOT_FOUND,
      cause,
    });
  }
}
