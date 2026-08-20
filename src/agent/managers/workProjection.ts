/**
 * 作品投影管理 — 用户作品的文件级感知：Agent 读取用户作品时生成"作品投影"（概要+结构+关键决策）。
 * 基于文件 hash 判断是否重生成，不复制作品全文（只存概要，文件本体归用户）。
 * 触发规则：首次读取（无 hash 记录）→生成；hash 变更→重新生成；hash 未变→跳过。
 *
 * 存储：项目级目录（<memoraDir>/projections/<slug>.json），独立于记忆库——
 * 投影是"作品感知"而非"对话记忆"（对话记忆唯一为 round-summary，沉淀在记忆库）。
 * 随项目隔离：memora.db 全局共享，投影若存库里会跨项目残留且无意义；落项目目录后换项目即消失。
 * 不参与记忆召回与治理（记忆系统纯化，召回面只剩 round-summary）。
 * 分层：位于 agent/ 层（依赖 LlmProvider 做生成）。
 */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmProvider, Message } from '@/llm/provider.js';
import { logger } from '@/logging/logger.js';
import { slugify } from '@/utils/strings.js';
import { sha256Fingerprint } from '@/utils/hash.js';
import { getBaseName } from '@/utils/path.js';
import { toError } from '@/utils/toError.js';
import { parseLlmJson } from '@/utils/json.js';
import { nowIso } from '@/utils/time.js';
import { accumulateStream } from '@/agent/managers/streamAccumulator.js';
import { atomicWriteFile } from '@/utils/atomicWrite.js';

/** 作品投影生成时内容截断长度（字符），控 LLM token 消耗 */
const CONTENT_TRUNCATE_CHARS = 3000;

/** 投影文件扩展名（loadAll 扫描过滤用） */
const PROJECTION_EXT = '.json';

/** 投影文件子目录名（位于 memoraDir 下，与 rules/skills 并列） */
const PROJECTIONS_SUBDIR = 'projections';

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

/** 作品投影管理器：agent/ 层，经 LLM 生成投影内容并以 JSON 文件写入项目目录（作品→项目内投影桥梁） */
export class WorkProjectionManager {
  /** 投影文件目录（<memoraDir>/projections），项目级、随项目隔离 */
  private readonly projectionsDir: string;
  /** 生成投影用的 LLM Provider（后台优先，降级到默认） */
  private readonly provider: LlmProvider;
  /** 投影生成/更新回调（宿主据此发射事件） */
  private readonly onGenerated?: (sourcePath: string, summary: string) => void;

  /** in-flight Promise 缓存（key: sourcePath），防同文件并发读取时重复调 LLM */
  private readonly inflight: Map<string, Promise<WorkProjectionEntry | null>> = new Map();

  /**
   * @param memoraDir 项目级 .memora/ 目录（投影存 <memoraDir>/projections/，随项目隔离）
   * @param provider 生成投影的 LLM Provider
   * @param onGenerated 投影生成/更新回调（宿主通知用，可选）
   */
  constructor(
    memoraDir: string,
    provider: LlmProvider,
    onGenerated?: (sourcePath: string, summary: string) => void,
  ) {
    this.projectionsDir = join(memoraDir, PROJECTIONS_SUBDIR);
    this.provider = provider;
    this.onGenerated = onGenerated;
  }

  /**
   * 检查并更新作品投影：计算 hash → 查询已有投影文件 → 无则生成 / hash 不同则重新生成 / hash 相同则跳过。
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

  /** 实际生成投影核心逻辑：hash 未变跳过，hash 变了或首次则重新生成（同 id 文件原子覆盖） */
  private async doEnsureProjection(
    filePath: string,
    content: string,
    fileName?: string,
  ): Promise<WorkProjectionEntry | null> {
    const hash = this.computeHash(content);
    const name = fileName ?? (getBaseName(filePath) || 'unknown');
    const projectionPath = this.projectionPath(name);

    // 已有投影且 hash 未变 → 跳过（不重新调 LLM）
    const existing = await this.readProjection(projectionPath);
    if (existing && existing.fileHash === hash) {
      return existing;
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

      // 目录保证存在 + 原子写覆盖（rename 原子替换，防写半截损坏投影）
      await mkdir(this.projectionsDir, { recursive: true });
      await atomicWriteFile(projectionPath, JSON.stringify(entry, null, 2));
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
    return this.readProjection(this.projectionPath(name));
  }

  /**
   * 等待所有 inflight 投影生成完成（Agent.close 调用），防 close 后写文件失败。
   * 不 abort LLM——作品投影是用户主动触发的高价值操作，让其完成优于快速失败。
   */
  async awaitInflight(): Promise<void> {
    if (this.inflight.size === 0) return;
    const promises = Array.from(this.inflight.values());
    await Promise.allSettled(promises);
  }

  /** 加载项目目录下所有作品投影（扫描 projections/ 子目录） */
  async loadAll(): Promise<WorkProjectionEntry[]> {
    try {
      const names = await readdir(this.projectionsDir);
      const entries: WorkProjectionEntry[] = [];
      for (const name of names) {
        if (!name.endsWith(PROJECTION_EXT)) continue;
        const entry = await this.readProjection(join(this.projectionsDir, name));
        if (entry) entries.push(entry);
      }
      return entries;
    } catch (err) {
      // 目录不存在（项目尚未生成任何投影）→ 视为无投影，不阻塞
      logger.debug({ err: toError(err).message }, '作品投影目录不存在，返回空');
      return [];
    }
  }

  // ── 私有方法 ──────────────────────────────────────

  /** 投影文件绝对路径（<projectionsDir>/<slug>.json） */
  private projectionPath(name: string): string {
    return join(this.projectionsDir, `${slugify(name)}${PROJECTION_EXT}`);
  }

  /** 读取投影文件；文件不存在 / JSON 损坏 / 缺关键字段 → 返回 null */
  private async readProjection(path: string): Promise<WorkProjectionEntry | null> {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as WorkProjectionEntry;
      if (!parsed || typeof parsed.summary !== 'string' || typeof parsed.fileHash !== 'string') {
        return null;
      }
      return parsed;
    } catch (err) {
      // ENOENT（无投影）与解析失败（损坏）统一按无投影处理
      logger.debug({ err: toError(err).message, path }, '读取作品投影失败');
      return null;
    }
  }

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
}
