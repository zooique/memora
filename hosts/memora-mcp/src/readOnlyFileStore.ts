/**
 * 只读文件记忆库 —— 从工作区 `.memora/memories.json` 读档，检索语义全权委托内核
 *
 * ## SSOT 边界（刻意设计，勿改）
 *
 * 本文件**不实现任何检索/排序/过滤算法**，全部委托内核已导出物：
 *   - **检索与排序**（分词、accessedAt 降序、软删除过滤）→ 内核 `InMemoryStorage`
 *   - **读档白名单校验**（未知字段剥离、旧档清洗）→ 内核 `parseMemory`
 *   - **取代状态判定**（`supersededBy` 悬空指针）→ 内核 `hasActiveSuperseder`
 *
 * 本文件只负责三件事：**读盘 → 解析 → 灌入**。
 *
 * 为什么不全量实现 `IMemoryStorage`：宿主侧自写第二套 Map + 分词 + 排序 = 与内核并列，
 * 两边语义漂移后「同一份 .memora/ 在插件里和 MCP 里搜出不同结果」。这里用内核容器即零并列。
 *
 * ## 只读保证由结构表达
 * 本类**不暴露** `upsert / delete / restore / purge / touch` 等写方法——不是「约定不乱调」，
 * 而是外部拿不到这些 API。约定会腐化，结构性缺失不会。
 *
 * ## 取代过滤为什么必须有
 * `supersededBy` 是写时取代模型的软指针（见内核 `supersedeResolve.ts`）。消费侧必须
 * 用 `hasActiveSuperseder` 过滤被取代的旧摘要，否则会把「已被更新版本覆盖的旧结论」
 * 当作当前事实喂给外部 agent。**判据必须复用内核单源**，不得按 lookuper 重新实现。
 *
 * ## 读失败为什么「抛」而不是「降级空库」
 * vscode 宿主 `WorkspaceStorage.load()` 在文件不可读时降级为空库——那是为了「不阻塞插件启动」。
 * 本场景不成立：MCP 服务器起了就要回答记忆查询，**静默返回「没有记忆」是谎言**
 * （用户明明有记忆，却被 agent 判为无）。宁可启动失败暴露错误，也不静默丢失。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryStorage, hasActiveSuperseder, parseMemory, type Memory } from '@zooique/memora';

/** 读档统计（诊断用：让「为什么这条记忆查不到」可解释，而非黑箱） */
export interface LoadStats {
  /** 文件中条目总数 */
  fileTotal: number;
  /** 成功解析并入库的条目数 */
  loaded: number;
  /** 解析/校验失败被跳过的条目数 */
  skipped: number;
}

/** source 维度统计条目 */
export interface SourceSummary {
  source: string;
  /** 当前版本条目数（已剔除软删除与被取代者） */
  count: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ReadOnlyFileStore {
  /** 运行时容器：检索/排序/软删过滤全由内核承担 */
  private readonly storage = new InMemoryStorage();
  private readonly filePath: string;

  /**
   * @param workspacePath 工作区根目录（对齐 vscode 宿主 `WorkspaceStorage` 语义：
   *                      记忆文件位于 `<workspacePath>/.memora/memories.json`）
   */
  constructor(workspacePath: string) {
    this.filePath = join(workspacePath, '.memora', 'memories.json');
  }

  /** 记忆文件绝对路径（诊断输出用；**勿据此写盘**——本 Store 不落盘） */
  get path(): string {
    return this.filePath;
  }

  /**
   * 读档入库。重复调用会先清空再重载（`InMemoryStorage.close()` 即丢弃内存）。
   * 单条损坏只跳过该条并计入 `skipped`——不因一条脏数据丢掉整个记忆库。
   */
  load(): LoadStats {
    this.storage.close();
    if (!existsSync(this.filePath)) {
      return { fileTotal: 0, loaded: 0, skipped: 0 };
    }

    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      throw new Error(`记忆文件读取失败：${this.filePath} — ${errMessage(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`记忆文件 JSON 解析失败：${this.filePath} — ${errMessage(err)}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`记忆文件格式非法（顶层非数组）：${this.filePath}`);
    }

    let loaded = 0;
    let skipped = 0;
    for (const item of parsed) {
      try {
        this.storage.upsert(parseMemory(item));
        loaded++;
      } catch (err) {
        // 跳过坏条目保住其余记忆；走 stderr —— stdout 被 MCP stdio 传输占用，写 stdout 会污染协议流
        skipped++;
        console.error(`[memora-mcp] 跳过一条无法解析的记忆：${errMessage(err)}`);
      }
    }
    return { fileTotal: parsed.length, loaded, skipped };
  }

  /**
   * 剔除「已被现存且活跃的摘要取代」的条目。
   * 判据复用内核 `hasActiveSuperseder`：指针悬空（目标被移除）⇒ 视为未取代 ⇒ 旧摘要回退为当前版本。
   */
  private current(memories: Memory[]): Memory[] {
    return memories.filter((m) => !hasActiveSuperseder(m, this.storage));
  }

  /** 全量当前版本记忆（按 source 分桶遍历，避免受 `search` 的 limit 截断影响） */
  private allCurrent(): Memory[] {
    const out: Memory[] = [];
    for (const source of this.storage.getAllSources().keys()) {
      for (const m of this.storage.getBySource(source)) {
        if (!hasActiveSuperseder(m, this.storage)) out.push(m);
      }
    }
    return out;
  }

  /** 关键词搜索当前版本记忆（分词 + accessedAt 降序由内核完成） */
  search(query: string, limit = 10): Memory[] {
    return this.current(this.storage.search(query, limit));
  }

  /** 按 id 取单条当前版本记忆；被取代/软删/不存在均返回 null */
  getById(id: string): Memory | null {
    const found = this.storage.getById(id);
    return found && !hasActiveSuperseder(found, this.storage) ? found : null;
  }

  /** 按 source 取当前版本记忆 */
  getBySource(source: string): Memory[] {
    return this.current(this.storage.getBySource(source));
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
}
