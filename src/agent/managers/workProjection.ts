/**
 * 作品投影管理 — 用户作品的文件级感知
 *
 * 职责：
 *   - Agent 读取用户作品时生成"作品投影"（概要 + 结构 + 关键决策）
 *   - 基于文件 hash 判断是否需要重新生成
 *   - 不复制作品全文——只存概要，文件本体归用户
 *
 * 触发规则（architecture_philosophy_rules.md §1 万物皆记忆 · 第 2 层作品投影）：
 *   - 首次读取（文件 hash 无记录）→ 生成投影
 *   - hash 变更（文件被修改）→ 重新生成
 *   - hash 未变（重复读取）→ 跳过
 *
 * 设计原则：
 *   - 作品 = 用户的产出物（文档、代码等），不归 Agent 管
 *   - 作品投影 = Agent 记住"作品的形象"，source = 'work-projection'
 *   - 文件变化由用户负责
 *
 * 分层说明：
 *   本模块位于 agent/ 层（非 memory/ 层），因为它依赖 LlmProvider 做内容生成。
 *   memory/ 层只做存储和召回，不做 LLM 调用（EmbeddingService 接口注入除外）。
 */
import { createHash } from 'node:crypto';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';
import { slugify } from '@/utils/strings.js';
import { getBaseName } from '@/utils/path.js';
import { toError } from '@/utils/toError.js';
import { parseLlmJson } from '@/utils/json.js';
import { nowIso } from '@/utils/time.js';

/** 作品投影生成时内容截断长度（字符），控制 LLM token 消耗 */
const CONTENT_TRUNCATE_CHARS = 3000;

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
  /** 结构（章节/模块/段落等结构化列表） */
  structure: string[];
  /** 关键决策 */
  keyDecisions: string[];
  /** 最后更新时间 */
  updatedAt: string;
}

/**
 * 作品投影管理器
 *
 * 分层：agent/ 层 — 调用 LLM 生成投影内容，通过 IMemoryStorage 写入存储。
 * 属于"作品 → 记忆投影"的桥梁组件，不属于 memory/ 的纯存储/召回职责。
 */
export class WorkProjectionManager {
  /** 作品投影生成/更新时的回调（宿主可据此发射事件通知用户） */
  private readonly onGenerated?: (sourcePath: string, summary: string) => void;

  constructor(
    private readonly index: IMemoryStorage,
    private readonly provider: LlmProvider,
    onGenerated?: (sourcePath: string, summary: string) => void,
  ) {
    this.onGenerated = onGenerated;
  }

  /**
   * in-flight Promise 缓存，防止同文件并发读取时重复调用 LLM
   * key: sourcePath（同一文件路径只会有一个未完成的生成 Promise）
   */
  private readonly inflight: Map<string, Promise<WorkProjectionEntry | null>> = new Map();

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
   * 同文件并发调用时复用同一 in-flight Promise，避免重复 LLM 调用。
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
    const inflight = this.inflight.get(filePath);
    if (inflight) {
      return inflight;
    }

    const promise = this.doEnsureProjection(filePath, content, fileName);
    this.inflight.set(filePath, promise);
    try {
      return await promise;
    } finally {
      // 不论成功失败都清理占位（让下一次调用重新走流程）
      this.inflight.delete(filePath);
    }
  }

  /**
   * 实际生成投影的核心逻辑
   */
  private async doEnsureProjection(
    filePath: string,
    content: string,
    fileName?: string,
  ): Promise<WorkProjectionEntry | null> {
    const hash = this.computeHash(content);
    const name = fileName ?? (getBaseName(filePath) || 'unknown');

    // 查询已有投影
    const existingId = `work-proj-${slugify(name)}`;
    const existing = this.index.getById(existingId);

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
        id: `work-proj-${slugify(name)}`,
        sourcePath: filePath,
        fileHash: hash,
        summary: projection.summary,
        structure: projection.structure,
        keyDecisions: projection.keyDecisions,
        updatedAt: nowIso(),
      };

      // 写入存储（source = 'work-projection'，语义独立）
      this.index.upsert(this.toMemory(entry, hash));
      logger.info(
        { file: filePath, hash, summaryLen: projection.summary.length },
        '作品投影已生成',
      );

      this.onGenerated?.(filePath, projection.summary);
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
    const name = getBaseName(filePath) || 'unknown';
    const id = `work-proj-${slugify(name)}`;
    const existing = this.index.getById(id);
    return existing ? this.fromMemory(existing) : null;
  }

  /**
   * 等待所有 inflight 投影生成完成
   *
   * FIX-P0-1：Agent.close() 调用此方法，确保所有正在进行的 LLM 生成 Promise
   * 完成后再关闭 storage，防止 close 后 upsert 写入已关闭的 storage。
   *
   * 实现：等待 inflight Map 中所有 Promise 完成（不论成功失败）。
   * 不 abort LLM 调用——作品投影生成是用户主动触发的高价值操作，
   * 让正在进行的生成完成比快速失败更合理（与 L2 时效性评估的批量场景不同）。
   *
   * @returns 完成 Promise，无 inflight 时立即 resolve
   */
  async awaitInflight(): Promise<void> {
    if (this.inflight.size === 0) return;
    // 收集所有 inflight Promise，等待全部完成
    const promises = Array.from(this.inflight.values());
    await Promise.allSettled(promises);
  }

  /**
   * 加载所有作品投影（按 source 标签召回）
   */
  async loadAll(): Promise<WorkProjectionEntry[]> {
    const memories = this.index.getBySource(SOURCE_LABELS.WORK_PROJECTION);
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
    // 截断内容（控制 token 消耗）
    const truncated = content.slice(0, CONTENT_TRUNCATE_CHARS);

    const promptMessages: Message[] = [
      {
        role: 'system',
        content: `你是作品分析助手。阅读用户的作品，生成一个"投影"——完整的作品概要、结构和关键决策。

输出格式（严格 JSON，不含 markdown 代码块标记）：
{
  "summary": "50-100字的作品概要",
  "structure": ["模块1", "模块2", "..."],
  "keyDecisions": ["关键决策1", "关键决策2", "..."]
}

要求：
- summary 控制在 50-100 字
- structure 列出 2-8 个模块名称
- keyDecisions 列出 1-3 个关键决策（如有）
- 不评价优劣，只客观描述`,
      },
      { role: 'user', content: `# ${name}\n\n${truncated}` },
    ];

    let result = '';
    for await (const chunk of this.provider.chat(promptMessages, { maxTokens: 400 })) {
      if (chunk.content) result += chunk.content;
    }

    const parsed = parseLlmJson<{
      summary: string;
      structure: string[];
      keyDecisions: string[];
    }>(result.trim());

    if (parsed) {
      return {
        summary: parsed.summary ?? `${name}（无法获取概要）`,
        structure: parsed.structure ?? [],
        keyDecisions: parsed.keyDecisions ?? [],
      };
    }

    // JSON 解析失败，降级为全文摘要
    return {
      summary: result.trim().slice(0, 100),
      structure: [name],
      keyDecisions: [],
    };
  }

  /**
   * 计算文件 SHA-256 hash
   */
  private computeHash(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * 从 Memory content 中解析 hash
   *
   * 复用 decodeContent，避免重复 JSON 解析与 HTML 注释匹配逻辑。
   * content 格式：JSON 元数据行 + 空行 + summary（旧格式：HTML 注释兼容）
   */
  private parseHash(memory: Memory): string | null {
    return this.decodeContent(memory.content).hash;
  }

  /**
   * 将 WorkProjectionEntry 转为 Memory（用于写入存储）
   *
   * 元数据（hash / structure / keyDecisions）编码为 content 首行 JSON，
   * summary 保持为可见内容。source = 'work-projection'。
   */
  private toMemory(entry: WorkProjectionEntry, hash: string): Memory {
    const now = nowIso();
    const fileName = getBaseName(entry.sourcePath);
    return {
      id: entry.id,
      content: this.encodeContent(
        hash,
        entry.sourcePath,
        entry.structure,
        entry.keyDecisions,
        entry.summary,
      ),
      source: SOURCE_LABELS.WORK_PROJECTION,
      name: `作品投影: ${fileName}`,
      createdAt: now,
      accessedAt: entry.updatedAt || now,
      score: 0.8,
    };
  }

  /**
   * 从 Memory 恢复 WorkProjectionEntry
   *
   * 从 content 的 HTML 注释中解码 hash / structure / keyDecisions
   */
  private fromMemory(m: Memory): WorkProjectionEntry {
    const { hash, structure, keyDecisions, summary, sourcePath } = this.decodeContent(m.content);
    return {
      id: m.id,
      // M1 修复：从 content 还原 sourcePath（旧数据无该字段 → 兜底空串，向后兼容）
      sourcePath: sourcePath ?? '',
      fileHash: hash ?? '',
      summary,
      structure,
      keyDecisions,
      updatedAt: m.accessedAt,
    };
  }

  /**
   * 将投影元数据编码为 content（JSON 元数据行 + 空行 + summary）
   *
   * 格式：
   *   {"hash":"...","structure":["..."],"decisions":["..."]}
   *   (空行)
   *   <summary>
   */
  private encodeContent(
    hash: string,
    sourcePath: string,
    structure: string[],
    keyDecisions: string[],
    summary: string,
  ): string {
    // M1 修复：将 sourcePath 编入元数据，使往返（toMemory → fromMemory）不丢字段
    const meta = JSON.stringify({ hash, sourcePath, structure, decisions: keyDecisions });
    return `${meta}\n\n${summary}`;
  }

  /**
   * 从 content 中解码投影元数据
   *
   * 新格式：首行 JSON + 空行 + summary
   * 旧格式（HTML 注释）兼容解析
   */
  private decodeContent(content: string): {
    hash: string | null;
    sourcePath: string;
    structure: string[];
    keyDecisions: string[];
    summary: string;
  } {
    // 新格式：首行 JSON
    const firstLine = content.split('\n')[0] ?? '';
    if (firstLine.startsWith('{')) {
      try {
        const meta = JSON.parse(firstLine) as {
          hash?: string;
          sourcePath?: string;
          structure?: string[];
          decisions?: string[];
        };
        const summary = content.slice(firstLine.length).trim();
        return {
          hash: meta.hash ?? null,
          sourcePath: meta.sourcePath ?? '',
          structure: meta.structure ?? [],
          keyDecisions: meta.decisions ?? [],
          summary,
        };
      } catch (err) {
        logger.debug({ err: toError(err).message }, '作品投影 JSON 解析失败，降级到旧格式');
      }
    }

    // 旧格式兼容：HTML 注释
    const hashMatch = content.match(/<!--\s*wp:hash:(\S+)\s*-->/);
    const structureMatch = content.match(/<!--\s*wp:structure:(.+?)\s*-->/);
    const decisionsMatch = content.match(/<!--\s*wp:decisions:(.+?)\s*-->/);
    const summary = content.replace(/<!--\s*wp:\S+\s*-->\n?/g, '').trim();

    return {
      hash: hashMatch?.[1] ?? null,
      sourcePath: '',
      structure: structureMatch?.[1]?.split('|') ?? [],
      keyDecisions: decisionsMatch?.[1]?.split('|') ?? [],
      summary,
    };
  }

}
