/**
 * 作品投影管理 — 用户作品的文件级感知
 *
 * 职责：
 *   - Agent 读取用户作品时生成"作品投影"（概要 + 结构 + 关键决策）
 *   - 基于文件 hash 判断是否需要重新生成
 *   - 不复制作品全文——只存概要，文件本体归用户
 *
 * 触发规则（01-主架构-v4.0.md §3.3）：
 *   - 首次读取（文件 hash 无记录）→ 生成投影
 *   - hash 变更（文件被修改）→ 重新生成
 *   - hash 未变（重复读取）→ 跳过
 *
 * 设计原则：
 *   - 作品 = 用户的产出物（小说、代码），不归 Agent 管
 *   - 作品投影 = Agent 记住"作品的形象"，属于助手记忆（permanence = domain）
 *   - 文件变化由用户负责
 *
 * 分层说明：
 *   本模块位于 agent/ 层（非 memory/ 层），因为它依赖 LlmProvider 做内容生成。
 *   memory/ 层只做存储和召回，不做 LLM 调用（EmbeddingService 接口注入除外）。
 */
import { createHash } from 'node:crypto';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { IMemoryStorage } from '@/memory/storage-interface.js';
import type { Memory } from '@/memory/types.js';
import { MemoryType, Permanence } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';

/** 作品投影的持久化结构 */
export interface WorkProjectionEntry {
  /** 唯一 ID（work-proj-<slug>） */
  id: string;
  /** 文件路径 */
  sourcePath: string;
  /** 文件 hash（用于变更检测） */
  fileHash: string;
  /** 概要 */
  summary: string;
  /** 结构（章节/模块列表） */
  structure: string[];
  /** 关键决策 */
  keyDecisions: string[];
  /** 最后更新时间 */
  updatedAt: string;
}

/**
 * 作品投影管理器
 *
 * 分层：agent/ 层 — 调用 LLM 生成投影内容，通过 SqliteStorage 写入 SQLite。
 * 属于"作品 → 记忆投影"的桥梁组件，不属于 memory/ 的纯存储/召回职责。
 */
export class WorkProjectionManager {
  constructor(
    private readonly index: IMemoryStorage,
    private readonly provider: LlmProvider,
  ) {}

  /**
   * A4 修复：in-flight Promise 缓存，防止同文件并发读取时重复调用 LLM
   * key: sourcePath（同一文件路径只会有一个未完成的生成 Promise）
   */
  private readonly _inflight: Map<string, Promise<WorkProjectionEntry | null>> = new Map();

  /**
   * 检查并更新作品投影
   *
   * 核心逻辑：
   *   1. 计算文件 hash
   *   2. 查询 SQLite 中是否有该文件的投影（by sourcePath）
   *   3. 无投影 → 首次读取 → 生成
   *   4. 有投影但 hash 不同 → 文件已修改 → 重新生成
   *   5. 有投影且 hash 相同 → 跳过
   *
   * A4 修复：同文件并发调用时复用同一 in-flight Promise，避免重复 LLM 调用。
   *
   * @param filePath 作品文件路径
   * @param content 文件内容
   * @param fileName 文件名（用于生成标题）
   * @returns 投影条目，跳过生成返回已有投影
   */
  async ensureProjection(
    filePath: string,
    content: string,
    fileName?: string,
  ): Promise<WorkProjectionEntry | null> {
    const inflight = this._inflight.get(filePath);
    if (inflight) {
      return inflight;
    }

    const promise = this._doEnsureProjection(filePath, content, fileName);
    this._inflight.set(filePath, promise);
    try {
      return await promise;
    } finally {
      // 不论成功失败都清理占位（让下一次调用重新走流程）
      this._inflight.delete(filePath);
    }
  }

  /**
   * 实际生成投影的核心逻辑（A4 修复后从 ensureProjection 拆出）
   */
  private async _doEnsureProjection(
    filePath: string,
    content: string,
    fileName?: string,
  ): Promise<WorkProjectionEntry | null> {
    const hash = this.computeHash(content);
    const name = fileName ?? filePath.split(/[/\\]/).pop() ?? 'unknown';

    // 查询已有投影
    const existingId = `work-proj-${this.slugify(name)}`;
    const existing = await this.index.getById(existingId);

    if (existing) {
      // 检查 hash 是否变化
      const existingHash = this.parseHash(existing);
      if (existingHash === hash) {
        // hash 未变 → 跳过
        return this.fromMemory(existing);
      }
      // hash 变了 → 重新生成（不删除旧投影，upsert 覆盖）
    }

    // 生成新投影
    try {
      const projection = await this.generate(name, content);
      const entry: WorkProjectionEntry = {
        id: `work-proj-${this.slugify(name)}`,
        sourcePath: filePath,
        fileHash: hash,
        summary: projection.summary,
        structure: projection.structure,
        keyDecisions: projection.keyDecisions,
        updatedAt: new Date().toISOString(),
      };

      // 写入 SQLite（用专用 WORK_PROJECTION 类型，语义独立于 ARCHIVE）
      await this.index.upsert(this.toMemory(entry, hash));
      logger.info(
        { file: filePath, hash, summaryLen: projection.summary.length },
        '作品投影已生成',
      );

      return entry;
    } catch (err) {
      logger.warn({ err, file: filePath }, '作品投影生成失败');
      return null;
    }
  }

  /**
   * 获取已有的作品投影（不触发生成）
   *
   * @param filePath 文件路径
   * @returns 投影条目，不存在返回 null
   */
  async getProjection(filePath: string): Promise<WorkProjectionEntry | null> {
    const name = filePath.split(/[/\\]/).pop() ?? 'unknown';
    const id = `work-proj-${this.slugify(name)}`;
    const existing = await this.index.getById(id);
    return existing ? this.fromMemory(existing) : null;
  }

  /**
   * 加载所有作品投影（领域记忆加载用）
   */
  async loadAll(): Promise<WorkProjectionEntry[]> {
    const memories = await this.index.getByType(MemoryType.WORK_PROJECTION);
    return memories.map((m: Memory) => this.fromMemory(m));
  }

  // ── 私有方法 ──────────────────────────────────────

  /**
   * 调用 LLM 生成作品投影
   *
   * @param name 文件名
   * @param content 文件内容
   * @returns { summary, structure, keyDecisions }
   */
  private async generate(
    name: string,
    content: string,
  ): Promise<{ summary: string; structure: string[]; keyDecisions: string[] }> {
    // 截断内容到 3000 字（控制 token 消耗）
    const truncated = content.slice(0, 3000);

    const promptMessages: Message[] = [
      {
        role: 'system',
        content: `你是作品分析助手。阅读用户的作品，生成一个"投影"——完整的作品概要、结构和关键决策。

输出格式（严格 JSON，不含 markdown 代码块标记）：
{
  "summary": "50-100字的作品概要",
  "structure": ["章节/模块1", "章节/模块2", "..."],
  "keyDecisions": ["关键决策1", "关键决策2", "..."]
}

要求：
- summary 控制在 50-100 字
- structure 列出 2-8 个章节/模块名称
- keyDecisions 列出 1-3 个关键决策（如有）
- 不评价优劣，只客观描述`,
      },
      { role: 'user', content: `# ${name}\n\n${truncated}` },
    ];

    let result = '';
    for await (const chunk of this.provider.chat(promptMessages, { maxTokens: 400 })) {
      if (chunk.content) result += chunk.content;
    }

    try {
      const parsed = JSON.parse(result.trim()) as {
        summary: string;
        structure: string[];
        keyDecisions: string[];
      };
      return {
        summary: parsed.summary ?? `${name}（无法获取概要）`,
        structure: parsed.structure ?? [],
        keyDecisions: parsed.keyDecisions ?? [],
      };
    } catch {
      // JSON 解析失败，降级为全文摘要
      return {
        summary: result.trim().slice(0, 100),
        structure: [name],
        keyDecisions: [],
      };
    }
  }

  /**
   * 计算文件 SHA-256 hash
   */
  private computeHash(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * 从 Memory tags 中解析 hash
   */
  private parseHash(memory: Memory): string | null {
    const hashTag = (memory.tags ?? []).find((t) => t.startsWith('hash:'));
    return hashTag ? hashTag.replace('hash:', '') : null;
  }

  /**
   * 将 WorkProjectionEntry 转为 Memory（用于写入 SQLite）
   *
   * 使用专用 WORK_PROJECTION 类型（非 ARCHIVE），语义独立。
   */
  private toMemory(entry: WorkProjectionEntry, hash: string): Memory {
    const now = new Date().toISOString();
    return {
      id: entry.id,
      type: MemoryType.WORK_PROJECTION,
      permanence: Permanence.DOMAIN,
      name: `作品投影: ${entry.sourcePath.split(/[/\\]/).pop()}`,
      content: entry.summary,
      tags: [
        'work-projection',
        `hash:${hash}`,
        ...entry.structure.map((s) => `structure:${s}`),
        ...entry.keyDecisions.map((d) => `decision:${d}`),
      ],
      weight: 0.8,
      createdAt: now,
      updatedAt: entry.updatedAt || now,
      filePath: entry.sourcePath,
    };
  }

  /**
   * 从 Memory 恢复 WorkProjectionEntry
   */
  private fromMemory(m: Memory): WorkProjectionEntry {
    const tags = m.tags ?? [];
    return {
      id: m.id,
      sourcePath: m.filePath ?? '',
      fileHash: tags.find((t) => t.startsWith('hash:'))?.replace('hash:', '') ?? '',
      summary: m.content,
      structure: tags
        .filter((t) => t.startsWith('structure:'))
        .map((t) => t.replace('structure:', '')),
      keyDecisions: tags
        .filter((t) => t.startsWith('decision:'))
        .map((t) => t.replace('decision:', '')),
      updatedAt: m.updatedAt,
    };
  }

  /**
   * 生成 URL 安全的标识符
   */
  private slugify(value: string): string {
    return value
      .replace(/[:\s]+/g, '-')
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_]/g, '')
      .slice(0, 40);
  }
}
