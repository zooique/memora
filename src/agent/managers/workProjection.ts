/**
 * 作品投影管理 — 用户作品的文件级感知：Agent 读取用户作品时生成"作品投影"（概要+结构+关键决策）。
 * 基于文件 hash 判断是否重生成，不复制作品全文（只存概要，文件本体归用户）。
 * 触发规则：首次读取（无 hash 记录）→生成；hash 变更→重新生成；hash 未变→跳过。
 * 分层：位于 agent/ 层（依赖 LlmProvider 做生成；memory/ 层只做存储召回不做 LLM 调用）。
 */
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';
import { slugify } from '@/utils/strings.js';
import { sha256Fingerprint } from '@/utils/hash.js';
import { getBaseName } from '@/utils/path.js';
import { toError } from '@/utils/toError.js';
import { parseLlmJson } from '@/utils/json.js';
import { nowIso } from '@/utils/time.js';
import { accumulateStream } from '@/agent/managers/streamAccumulator.js';

/** 作品投影生成时内容截断长度（字符），控 LLM token 消耗 */
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

/** 作品投影管理器：agent/ 层，经 LLM 生成投影内容并写入 IMemoryStorage（作品→记忆投影桥梁，非 memory/ 纯存储职责） */
export class WorkProjectionManager {
  /** 投影生成/更新回调（宿主据此发射事件） */
  private readonly onGenerated?: (sourcePath: string, summary: string) => void;

  constructor(
    private readonly index: IMemoryStorage,
    private readonly provider: LlmProvider,
    onGenerated?: (sourcePath: string, summary: string) => void,
  ) {
    this.onGenerated = onGenerated;
  }

  /** in-flight Promise 缓存（key: sourcePath），防同文件并发读取时重复调 LLM */
  private readonly inflight: Map<string, Promise<WorkProjectionEntry | null>> = new Map();

  /**
   * 检查并更新作品投影：计算 hash → 查询已有投影 → 无则生成 / hash 不同则重新生成 / hash 相同则跳过。
   * 同文件并发复用同一 in-flight Promise 避免重复 LLM 调用。跳过生成时返回已有投影。
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
      this.inflight.delete(filePath);
    }
  }

  /** 实际生成投影核心逻辑：hash 未变跳过，hash 变了或首次则重新生成（不删旧投影，upsert 覆盖） */
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
      const existingHash = this.parseHash(existing);
      if (existingHash === hash) {
        // hash 未变 → 跳过
        return this.fromMemory(existing);
      }
    }

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

      // 写入存储（source='work-projection'，语义独立）
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

  /** 获取已有作品投影（不触发生成）；不存在返回 null */
  async getProjection(filePath: string): Promise<WorkProjectionEntry | null> {
    const name = getBaseName(filePath) || 'unknown';
    const id = `work-proj-${slugify(name)}`;
    const existing = this.index.getById(id);
    return existing ? this.fromMemory(existing) : null;
  }

  /**
   * 等待所有 inflight 投影生成完成（Agent.close 调用），防 close 后 upsert 已关闭 storage。
   * 不 abort LLM——作品投影是用户主动触发的高价值操作，让其完成优于快速失败（与 L2 时效性批量场景不同）。
   */
  async awaitInflight(): Promise<void> {
    if (this.inflight.size === 0) return;
    const promises = Array.from(this.inflight.values());
    await Promise.allSettled(promises);
  }

  /** 加载所有作品投影（按 source 标签召回） */
  async loadAll(): Promise<WorkProjectionEntry[]> {
    const memories = this.index.getBySource(SOURCE_LABELS.WORK_PROJECTION);
    return memories.map((m: Memory) => this.fromMemory(m));
  }

  // ── 私有方法 ──────────────────────────────────────

  /** 调用 LLM 生成作品投影（summary/structure/keyDecisions） */
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

    const result = await accumulateStream(this.provider, promptMessages, { maxTokens: 400 });

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

  /** 计算文件 SHA-256 hash（复用 utils/hash.ts 通用指纹函数） */
  private computeHash(content: string): string {
    return sha256Fingerprint(content);
  }

  /** 从 Memory content 解析 hash（复用 decodeContent，避免重复 JSON 解析） */
  private parseHash(memory: Memory): string | null {
    return this.decodeContent(memory.content).hash;
  }

  /** 将 WorkProjectionEntry 转 Memory 写存储：元数据（hash/structure/keyDecisions）编码为 content 首行 JSON，summary 保持可见，source='work-projection' */
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

  /** 从 Memory 恢复 WorkProjectionEntry（解码 content 中的元数据） */
  private fromMemory(m: Memory): WorkProjectionEntry {
    const { hash, structure, keyDecisions, summary, sourcePath } = this.decodeContent(m.content);
    return {
      id: m.id,
      // 从 content 还原 sourcePath（旧数据无该字段 → 兜底空串）
      sourcePath: sourcePath ?? '',
      fileHash: hash ?? '',
      summary,
      structure,
      keyDecisions,
      updatedAt: m.accessedAt,
    };
  }

  /** 投影元数据编码为 content（JSON 元数据行 + 空行 + summary）。sourcePath 编入元数据使 toMemory→fromMemory 往返不丢字段 */
  private encodeContent(
    hash: string,
    sourcePath: string,
    structure: string[],
    keyDecisions: string[],
    summary: string,
  ): string {
    const meta = JSON.stringify({ hash, sourcePath, structure, decisions: keyDecisions });
    return `${meta}\n\n${summary}`;
  }

  /** 从 content 解码投影元数据（首行 JSON + 空行 + summary）；非 JSON 首行视为无元数据旧文本（兜底空元数据） */
  private decodeContent(content: string): {
    hash: string | null;
    sourcePath: string;
    structure: string[];
    keyDecisions: string[];
    summary: string;
  } {
    // 首行 JSON（唯一格式）
    const firstLine = content.split('\n')[0] ?? '';
    if (!firstLine.startsWith('{')) {
      return { hash: null, sourcePath: '', structure: [], keyDecisions: [], summary: content.trim() };
    }
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
      // JSON 解析失败：降级为空元数据（内容保留为 summary）
      logger.debug({ err: toError(err).message }, '作品投影 JSON 解析失败');
      return { hash: null, sourcePath: '', structure: [], keyDecisions: [], summary: content.trim() };
    }
  }

}
