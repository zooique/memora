/**
 * 配置管理器 — 规则/技能注入 + 配置建议持久化
 *
 * 从 Agent 拆分出来，负责：
 *   - addRule / addSimpleRule：运行时规则注入（SQLite + System Prompt）
 *   - addSkill / addSimpleSkill：运行时技能注入（SkillManager + SQLite）
 *   - onConfigSuggestion / confirmConfigSuggestion：模式 3 配置建议回调 + 持久化
 *
 * 设计原则：
 *   - 独立于 Agent 生命周期，仅依赖 Storage / SkillManager / Loop
 *   - 不持有 LLM Provider（纯配置操作）
 */
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { FileStore } from '@/memory/store.js';
import type { SkillManager } from '@/skill/skillManager.js';
import { configError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';

// ─── 类型 ────────────────────────────────────────────────

/**
 * 配置建议（模式 3 · Agent 智能总结）
 *
 * AutoConfigRefiner 从对话中提取的配置建议，通过 onSuggestion 回调通知宿主。
 * 宿主决定展示方式（桌宠气泡 / CLI 打印 / WebUI 弹窗），
 * 用户确认后调用 confirm() 写入配置文件。
 *
 * 与 addRule() 的区别：
 * - addRule() 写入 SQLite（运行时注入，会话级）
 * - confirm() 写入配置文件（持久化，重启后依然生效）
 */
export interface ConfigSuggestion {
  /** 建议类型 */
  type: 'rule' | 'persona' | 'skill';
  /** 建议名称（如"代码风格"、"TypeScript 偏好"） */
  name: string;
  /** 建议内容（Markdown 格式） */
  content: string;
  /** 置信度 0-1，低于阈值时宿主可选择性忽略 */
  confidence: number;
  /** 建议来源（如对话摘要、用户画像分析） */
  source?: string;
}

/** 配置建议回调函数类型 */
export type ConfigSuggestionHandler = (suggestion: ConfigSuggestion) => void;

// ─── 类 ──────────────────────────────────────────────────

export class ConfigManager {
  /** 配置建议回调（模式 3） */
  private _suggestionHandler: ConfigSuggestionHandler | null = null;

  /**
   * @param index - 记忆存储（规则/技能写入 SQLite）
   * @param skillManager - 技能管理器（运行时注入技能）
   * @param injectSystemMessage - 注入 system 消息的回调（来自 AgentLoop）
   * @param configDir - 配置目录（模式 3 写入配置文件时使用）
   */
  constructor(
    private readonly index: IMemoryStorage,
    private readonly skillManager: SkillManager,
    private readonly injectSystemMessage: (message: string) => void,
    private readonly configDir?: string,
  ) {}

  // ─── 配置建议 ─────────────────────────────────────────

  /**
   * 注册配置建议回调（模式 3）
   *
   * 宿主项目通过此方法注册回调，当 AutoConfigRefiner 从对话中
   * 提取到配置建议时，通过此回调通知宿主。
   */
  onSuggestion(handler: ConfigSuggestionHandler): void {
    this._suggestionHandler = handler;
  }

  /** 获取当前注册的配置建议回调 */
  get suggestionCallback(): ConfigSuggestionHandler | null {
    return this._suggestionHandler;
  }

  /**
   * 确认配置建议并写入配置文件（模式 3）
   *
   * 用户确认配置建议后，宿主调用此方法将建议持久化到 configDir/ 目录。
   * 写入的是配置文件（真理源），下次启动时 MemoryLoader 自动扫描加载到 SQLite。
   *
   * 与 addRule() 的关键区别：
   * - addRule() → 写入 SQLite（运行时注入，会话级，重启后需重新注入）
   * - confirm() → 写入配置文件（持久化，重启后自动加载）
   */
  async confirm(suggestion: ConfigSuggestion): Promise<void> {
    if (!this.configDir) {
      throw configError('configDir 未设置', '模式 3 需要指定 configDir 才能写入配置文件', [
        '在 Agent 构造时传入 configDir 参数',
        '例如：new Agent({ configDir: "~/.memora/agent-config", ... })',
      ]);
    }

    // 根据建议类型映射到 source 标签
    const sourceMap: Record<ConfigSuggestion['type'], string> = {
      rule: SOURCE_LABELS.RULE,
      persona: SOURCE_LABELS.PERSONA,
      skill: SOURCE_LABELS.SKILL,
    };
    const source = sourceMap[suggestion.type];

    // 构造记忆对象并写入配置文件（真理源）
    // 不写入 SQLite——遵守"配置文件是真理源"约束
    const fileStore = new FileStore(this.configDir);
    const now = new Date().toISOString();
    const memory: Memory = {
      id: `${source}:${suggestion.name}`,
      content: suggestion.content,
      source,
      name: suggestion.name,
      createdAt: now,
      accessedAt: now,
      score: suggestion.confidence,
    };
    await fileStore.write(memory);

    // 如果是规则，立即注入到 AgentLoop（当前会话生效，重启后由配置文件自动加载）
    if (suggestion.type === 'rule') {
      const rulePrompt = `【项目规则】${suggestion.name}\n${suggestion.content}`;
      this.injectSystemMessage(rulePrompt);
    }

    logger.info(
      { type: suggestion.type, name: suggestion.name, confidence: suggestion.confidence },
      '配置建议已确认并写入配置文件',
    );
  }

  // ─── 规则注入 ─────────────────────────────────────────

  /**
   * 新增项目规则记忆（Q-701 · v1.1）
   *
   * 宿主项目可通过此 API 在运行时动态注入规则记忆。
   * 规则写入 SQLite 索引后，重启时由 bootstrap 自动召回。
   * 当前轮次以 system 消息注入 AgentLoop。
   */
  async addRule(memory: Memory): Promise<void> {
    if (memory.source !== SOURCE_LABELS.RULE) {
      throw configError('无效来源', `addRule 只接受 source='rule'，收到 '${memory.source}'`, [
        '使用 SOURCE_LABELS.RULE 作为 source 字段',
      ]);
    }

    await this.index.upsert(memory);

    const rulePrompt = `【项目规则】${memory.name}\n${memory.content}`;
    this.injectSystemMessage(rulePrompt);

    logger.info({ name: memory.name, source: memory.source }, '项目规则已注入');
  }

  /**
   * 新增项目规则的便捷方法（P1-4 修复）
   *
   * 宿主程序只需提供 name + content 两个业务字段，
   * 内部自动填充 id / source / createdAt / accessedAt / score 等字段。
   */
  async addSimpleRule(name: string, content: string): Promise<void> {
    const now = new Date().toISOString();
    const memory: Memory = {
      id: `rule:${name}`,
      content,
      source: SOURCE_LABELS.RULE,
      name,
      createdAt: now,
      accessedAt: now,
      score: 0.8,
    };
    await this.addRule(memory);
  }

  // ─── 技能注入 ─────────────────────────────────────────

  /**
   * 新增技能记忆（C1 修复：与 addRule 对称的公共方法）
   *
   * 宿主程序可通过此方法在运行时动态注入技能，
   * 注入后 AgentLoop 会在下一轮对话时自动匹配（关键词触发）。
   */
  async addSkill(memory: Memory): Promise<void> {
    if (memory.source !== SOURCE_LABELS.SKILL) {
      throw configError('无效来源', `addSkill 只接受 source='skill'，收到 '${memory.source}'`, [
        '使用 SOURCE_LABELS.SKILL 作为 source 字段',
      ]);
    }

    // 1. 委托给 SkillManager：负责注册到内存、构建关键词索引
    this.skillManager.register({
      name: memory.name,
      keywords: [], // 基元驱动模型下，关键词从 memory.name 推导
      content: memory.content,
      description: memory.content.slice(0, 80),
      filePath: '', // 运行时注入的技能无文件路径
      layer: 'agent', // 运行时注入归 agent 层
    });

    // 2. 写入 SQLite 索引（持久化、跨会话可见）
    await this.index.upsert(memory);

    logger.info({ name: memory.name }, '技能已注入');
  }

  /**
   * 新增技能的便捷方法（C1 修复：与 addSimpleRule 对称）
   *
   * 宿主程序只需提供 name + content + keywords 三个业务字段，
   * 内部自动填充 id / source / createdAt / accessedAt / score。
   */
  async addSimpleSkill(name: string, content: string, keywords: string[] = []): Promise<void> {
    void keywords; // 基元驱动模型下关键词暂不存储到 Memory，由 SkillManager 管理
    const now = new Date().toISOString();
    const memory: Memory = {
      id: `skill:${name}`,
      content,
      source: SOURCE_LABELS.SKILL,
      name,
      createdAt: now,
      accessedAt: now,
      score: 0.7,
    };
    await this.addSkill(memory);
  }
}
