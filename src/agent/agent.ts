/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 设计文档（01-主架构-v4.0.md §9）要求宿主项目通过 `import { Agent } from '@memora/core'`
 * 一行代码接入。本类把当前 repl.ts 中埋藏的组装逻辑提取到正确的架构层，
 * 使 AgentLoop / IMemoryStorage / ToolExecutor / SecurityGuard
 * 这些已有组件可以被 CLI 以外的宿主项目直接使用。
 *
 * 使用方式（最简）：
 *   const agent = new Agent({ projectPath: './my-project', configDir: './agent-config' });
 *   await agent.init();
 *   for await (const chunk of agent.chat('你好')) {
 *     if (chunk.type === 'text') process.stdout.write(chunk.content);
 *   }
 *   await agent.close();
 *
 * 使用方式（高级）：
 *   const agent = new Agent({ projectPath: './my-project', provider: myProvider, configDir: './agent-config' });
 *
 * 基元驱动记忆模型（2026-06-11 重构）：
 *   - MemoryType/Permanence 枚举 → source 开放字符串
 *   - TopicMount 话题漂移检测 → recall() 简化关键词搜索
 *   - ArchiveManager → 移除
 *   - 归档模式 → 移除（召回策略由查询时决定）
 */
import { basename } from 'node:path';
import { AgentLoop } from './loop.js';
import type { AgentChunk } from './types.js';
import {
  ToolExecutor,
  type ToolDefinition,
  type ToolHandler,
  type WriteExtensions,
} from './tool-executor.js';
import { MessageHistory } from './message-history.js';
import { ProjectManager, type ProjectContext } from '@/memory/project-manager.js';
import { recall } from '@/memory/recall.js';
import { PersonaManager } from '@/persona/personaManager.js';
import { UserProfile } from '@/memory/userProfile.js';
import { WorkProjectionManager } from './workProjection.js';
import { SkillManager } from '@/skill/skillManager.js';
import { FileStore } from '@/memory/store.js';
import { configError } from '@/utils/errors.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storage-interface.js';
import type { ILogger } from '@/logging/logger-interface.js';
import { logger, setLogger } from '@/logging/logger.js';
import type { SecurityGuard } from '@/security/path-guard.js';

// ─── 类型定义 ───────────────────────────────────────────

/**
 * 记忆关键词（宿主提供，用于输入分类 Layer 2）
 *
 * 宿主通过 setMemoryKeywords() 注册领域关键词和用户专属关键词，
 * 用于判断用户输入是否值得提取记忆。
 */
export interface MemoryKeywords {
  /** 领域关键词（如小说创作：['主角', '角色', '情节', '设定']） */
  domain: string[];
  /** 用户专属关键词（如：['我', '我的', '记住', '帮我']） */
  personal: string[];
}

/**
 * 话题消息（TopicMessage 已从 types.ts 移除，保留此类型定义供 loadTopicMessages / restoreTopic 等方法签名使用）
 *
 * 保留此类型定义供 loadTopicMessages / restoreTopic 等方法签名使用，
 * 待 MessageHistory 重构完成后移除。
 */
interface TopicMessage {
  /** 消息角色 */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 消息内容 */
  content: string;
}

/** Agent 构造选项 */
export interface AgentOptions {
  /** 项目路径（必须） */
  projectPath: string;
  /** 前台 LLM Provider（必须，宿主负责创建） */
  provider: LlmProvider;
  /** 后台 LLM Provider（可选，用于投影等后台操作，不配时复用前台） */
  backgroundProvider?: LlmProvider;
  /** 配置目录（personas/rules/skills） */
  configDir?: string;
  /** 记忆数据目录（默认 ~/.memora） */
  dataDir?: string;
  /** 项目注册表目录（默认与 dataDir 相同）。设为用户级路径可避免每项目重复存储 */
  registryDir?: string;
  /** 最大上下文 token 数（默认 120000） */
  maxContextTokens?: number;
  /** 默认角色名 */
  persona?: string;
  /** 安全权限 */
  permission?: 'owner' | 'guest';
  /** 允许的路径白名单 */
  allowedPaths?: string[];
  /** 写入确认 */
  confirmWrites?: boolean;
  /** 外部注入的存储实例（可选，不传则内部创建 InMemoryStorage） */
  storage?: IMemoryStorage;
  /** 外部注入的日志实现（可选，不传则使用默认 PinoLogger） */
  logger?: ILogger;
}

/**
 * 配置建议（模式 3 · Agent 智能总结）
 *
 * AutoConfigRefiner 从对话中提取的配置建议，通过 onConfigSuggestion 回调通知宿主。
 * 宿主决定展示方式（桌宠气泡 / CLI 打印 / WebUI 弹窗），
 * 用户确认后调用 confirmConfigSuggestion() 写入配置文件。
 *
 * 与 addRule() 的区别：
 * - addRule() 写入 SQLite（运行时注入，会话级）
 * - confirmConfigSuggestion() 写入配置文件（持久化，重启后依然生效）
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

/** Agent 初始化后暴露的运行时上下文 */
export type AgentContext = ProjectContext;

/** Agent 项目条目（来自 ProjectManager 注册表） */
export interface AgentProjectEntry {
  name: string;
  path: string;
  lastOpened: string;
}

/** Agent 记忆搜索结果（cli 友好的扁平结构） */
export interface AgentSearchHit {
  /** 记忆名称 */
  name: string;
  /** 来源标签 */
  source: string;
  /** 权重（0-1） */
  score: number;
  /** 内容预览（截断到 120 字符） */
  contentPreview: string;
}

/**
 * 记忆库统计数据
 *
 * 提供给 CLI /stat 命令渲染统计面板。
 */
export interface AgentStats {
  /** 按来源标签分组的记忆数量 */
  bySource: Record<string, number>;
  /** 记忆总数 */
  total: number;
}

/**
 * Agent 内部组件快照（供宿主项目重建 history/loop 等 CLI 可见对象）
 *
 * 把 memory/security 层的具体类型收拢到 agent 层封装，
 * 避免 cli 直接 import memory 子模块（违反分层规则）。
 */
export interface AgentBuildCtx {
  security: SecurityGuard;
  index: IMemoryStorage;
  bootstrapMemories: Memory[];
}

// ─── 记忆快照类型（inspect() 返回值）──────────────────────

/**
 * 记忆快照类型
 *
 * 基元驱动模型下简化为 3 层：工作记忆 / Bootstrap / 话题归档
 * 详见 docs/基础设计文档/00-记忆归档原则-v1.0.md
 */
export interface MemorySnapshot {
  /** 第 1 层：工作记忆（messages 数组） */
  working: WorkingMemorySnapshot;
  /** 第 2 层：Bootstrap 记忆（永驻 + 领域） */
  bootstrap: BootstrapSnapshot;
  /** 第 3 层：话题归档文件（topic-*.md） */
  archive: ArchiveSnapshot;
}

/** 第 1 层：工作记忆快照 */
export interface WorkingMemorySnapshot {
  total: number;
  preview: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    contentPreview: string;
    contentLength: number;
  }>;
}

/** 第 2 层：Bootstrap 记忆快照 */
export interface BootstrapSnapshot {
  total: number;
  items: Array<{
    id: string;
    /** 来源标签（开放字符串） */
    source: string;
    name: string;
    contentPreview: string;
    /** 权重（0-1） */
    score: number;
  }>;
}

/** 第 3 层：话题归档快照（仅元信息，文件列表调 listAllTopics()） */
export interface ArchiveSnapshot {
  topicFilesCount: number;
  currentTopic: string;
  /** 当前话题全名（含日期前缀，与 topics/*.md 文件名一致），用于渲染端精确高亮 */
  currentTopicName: string;
  hint: string;
}

/**
 * 快照预览配置
 *
 * 不引入新类，只用 class holder 装常量——避免污染 Agent 类。
 */
class MemoryInspector {
  /** 工作记忆预览条数（最近 N 条） */
  static readonly WORKING_PREVIEW = 5;
  /** 内容预览字符数 */
  static readonly CONTENT_PREVIEW_LEN = 80;
}

// ─── Agent 门面类 ───────────────────────────────────────

export class Agent {
  // 构造参数
  private _provider: LlmProvider; // 前台 LLM Provider（构造时存储）
  private _backgroundProvider: LlmProvider | null; // 后台 LLM Provider（可选）
  private _dataDir: string; // 记忆数据目录（默认 ~/.memora）
  private _registryDir: string | undefined; // 项目注册表目录（用户级，避免每项目重复存储）
  private _maxContextTokens: number; // 最大上下文 token 数（默认 120000）
  private _personaName: string | undefined; // 默认角色名
  private _permission: 'owner' | 'guest'; // 安全权限
  private _allowedPaths: string[]; // 允许的路径白名单
  private _confirmWrites: boolean; // 写入确认
  private _storage: IMemoryStorage | undefined; // 外部注入的存储实例（可选）
  private projectPath: string;
  private configDir: string | undefined; // 配置目录（personas/rules/skills/tools）

  // 运行时组件（init 后填充）
  private projectManager: ProjectManager | null = null;
  private history: MessageHistory | null = null;
  private loop: AgentLoop | null = null;
  private toolExec: ToolExecutor | null = null; // 工具执行器（注册自定义工具用）

  // v4.0 新模块（init 后填充）
  private personaManager: PersonaManager | null = null;
  private userProfile: UserProfile | null = null;
  private workProjection: WorkProjectionManager | null = null;
  private skillManager: SkillManager | null = null;
  /** v4.0：当前激活的技能名（上一轮匹配，本轮注入） */
  private activeSkill: string | null = null;

  // 上下文（init 后填充）
  private _ctx: AgentContext | null = null;
  private _initialized = false;
  // 项目上下文（init / switchProject 后更新）
  private _pctx: ProjectContext | null = null;

  /**
   * 配置建议回调（模式 3 · Agent 智能总结）
   *
   * 宿主通过 onConfigSuggestion() 注册，AutoConfigRefiner 触发时调用。
   * 目前仅提供接口，AutoConfigRefiner 实现属于设计阶段。
   */
  private _configSuggestionHandler: ConfigSuggestionHandler | null = null;
  /** P3-9 修复：chat() 并发锁，防止同时发起多个对话导致消息序列混乱 */
  private _chatBusy = false;
  /** 最近一次 chat() 调用的时间戳（供宿主判断用户离线时长） */
  private _lastInteractionAt: Date | null = null;
  /** 写入扩展回调（宿主注入 diff 对比确认逻辑，小说生成器场景必需） */
  private _writeExtensions: WriteExtensions | null = null;
  /** 宿主提供的记忆关键词（用于输入分类 Layer 2） */
  private _hostKeywords: MemoryKeywords | null = null;

  constructor(opts: AgentOptions) {
    this.projectPath = opts.projectPath;
    this._provider = opts.provider;
    this._backgroundProvider = opts.backgroundProvider ?? null;
    this.configDir = opts.configDir;
    this._dataDir = opts.dataDir ?? '~/.memora';
    this._registryDir = opts.registryDir;
    this._maxContextTokens = opts.maxContextTokens ?? 120000;
    this._personaName = opts.persona;
    this._permission = opts.permission ?? 'owner';
    this._allowedPaths = opts.allowedPaths ?? [];
    this._confirmWrites = opts.confirmWrites ?? false;
    // 外部注入的存储实例（可选，不传则内部创建 InMemoryStorage）
    this._storage = opts.storage;
    // 外部注入的日志实现（可选，不传则使用默认 PinoLogger）
    if (opts.logger) {
      setLogger(opts.logger);
    }
  }

  // ─── 生命周期 ─────────────────────────────────────────

  /**
   * 初始化 Agent：加载索引、组装内部组件
   *
   * 对应 repl.ts 中 rebuildAgentComponents() 的逻辑，
   * 但去掉了 CLI 特有的可视化包装。
   *
   * @param projectPathOverride - 可选，运行时覆盖构造器 projectPath（用于项目切换）
   * @returns ProjectContext — 完整项目上下文，宿主项目可据此访问内部组件
   */
  async init(projectPathOverride?: string): Promise<ProjectContext> {
    if (this._initialized) {
      await this.close();
    }

    // 允许运行时覆盖（用于 switchProject 时的二次 init）
    if (projectPathOverride) {
      this.projectPath = projectPathOverride;
    }

    // 创建 ProjectManager（只传 dataDir，不依赖 Config 类型）
    // 如果宿主注入了 storage，传递给 ProjectManager（否则内部创建 InMemoryStorage）
    this.projectManager = new ProjectManager(
      this._dataDir,
      this._allowedPaths,
      this._confirmWrites,
      this._permission,
      this._storage,
      this._registryDir,
    );

    // 初始化项目上下文（加载 .memora/ 下的记忆索引）
    // 传递 configDir 以分离配置目录与运行时数据目录
    const pctx = await this.projectManager.initProject(this.projectPath, undefined, this.configDir);

    // 组装所有运行时组件（v4.0：包括 persona/skill/userProfile/workProjection）
    await this._assembleComponents(pctx);

    // 保存完整项目上下文（保留 projectName 等所有字段）
    this._pctx = pctx;
    this._ctx = pctx;

    if (!this.loop || !this.history) {
      throw configError('Agent 初始化失败', 'LLM Provider 不可用或创建失败', [
        '检查传入的 provider 参数是否有效',
        '确认 API Key 已配置（环境变量或配置文件）',
        '使用 setProvider() 运行时切换 Provider',
      ]);
    }

    this._initialized = true;

    // 启动时 Lazy 扫描：兜底历史话题归档
    this.history!.archiveMissingTopics(3000).catch((err) => {
      void err;
    });

    return pctx;
  }

  /**
   * 流式对话（核心 API）
   *
   * @param input 用户输入文本
   * @param signal 可选的 AbortSignal，用于取消正在进行的对话（V-105）
   *   泊文等宿主 UI 传入 AbortController.signal，用户点击"取消"时触发 abort
   */
  async *chat(input: string, signal?: AbortSignal): AsyncGenerator<AgentChunk, void, unknown> {
    if (!this._initialized || !this.history || !this.loop) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 chat() 前调用 await agent.init()',
      ]);
    }

    if (this._chatBusy) {
      throw configError('对话繁忙', '上一轮对话尚未完成，请等待其结束后再发起新对话', [
        '等待上一轮 chat() 的 AsyncGenerator 耗尽（收到 done 事件）',
        '宿主程序应确保同一时间只有一个 chat() 调用',
      ]);
    }
    this._chatBusy = true;
    try {
      // 记录最后交互时间（桌面精灵用于判断用户离线时长、主动问候时机）
      this._lastInteractionAt = new Date();

      // 基元驱动召回：用 recall() 从存储中搜索相关记忆注入上下文
      yield { type: 'thinking', phase: 'recalling' };
      const topicMemories = recall(this._pctx!.index, input, { limit: 5 });

      // Layer 5: 最近对话注入（最近 3 轮，固定注入）
      // 让 LLM 在用户输入无信息量（如"你好"）时仍能看到最近对话上下文
      const recentHistory = this.loop.getRecentHistory(3);
      if (recentHistory.length > 0) {
        const recentPrompt = '[最近对话]\n' + recentHistory.map(m =>
          `${m.role === 'user' ? '用户' : '助手'}：${m.content}`
        ).join('\n');
        this.loop.injectSystemMessage(recentPrompt);
        logger.debug({ turns: recentHistory.length / 2 }, '最近对话已注入');
      }

      // V-105：召回后检查取消
      if (signal?.aborted) {
        yield { type: 'aborted', reason: '用户取消了对话' };
        return;
      }

      // v4.0：注入上一轮匹配的技能 prompt（本轮可用）
      yield { type: 'thinking', phase: 'processing' };
      if (this.activeSkill && this.skillManager && this.loop) {
        const skillPrompt = this.skillManager.buildSystemPrompt(this.activeSkill);
        if (skillPrompt) {
          this.loop.injectSystemMessage(skillPrompt);
          logger.debug({ skill: this.activeSkill }, '技能 prompt 已注入');
        }
        this.activeSkill = null; // 本轮已注入，清空等待下一轮重新匹配
      }

      // 用户消息写入历史
      await this.history.appendUser(input);

      // Agent Loop 流式处理（注入召回记忆结果 + 中断信号）
      let assistantContent = '';
      let wasAborted = false;
      for await (const chunk of this.loop.processUserInput(input, topicMemories, signal)) {
        yield chunk; // 透传结构化事件给上层
        if (chunk.type === 'text') {
          assistantContent += chunk.content;
        } else if (chunk.type === 'aborted') {
          wasAborted = true;
        }
      }

      // 中断时不写历史（对话未完成，不应污染历史记录）
      if (wasAborted) {
        return;
      }

      // Agent 回复写入历史
      await this.history.appendAssistant(assistantContent);

      // 后处理阶段：角色匹配 + 技能匹配
      yield { type: 'thinking', phase: 'archiving' };

      // v4.0：用户画像实时归档（每轮结束后扫描用户输入中的身份/偏好/专长事实）
      // 高置信度直接归档，低置信度标记待确认
      if (this.userProfile) {
        const turnIndex = `turn-${Date.now()}`;
        this.userProfile.archive(input, turnIndex).catch((err) => {
          logger.warn({ err }, '用户画像实时归档失败');
        });
      }

      // v1.1：角色自动匹配（P-602 · L4 修正：阈值 ≥0.5 + 独立于技能匹配）
      if (this.personaManager) {
        const matchedPersona = this.personaManager.autoMatch(input);
        if (matchedPersona) {
          this.personaManager.switchPersona(matchedPersona);
          if (this.loop) {
            // 重建完整前缀（角色 prompt + 用户画像）
            const profilePrompt = this.userProfile?.buildSystemPrompt() ?? '';
            const personaPrompt = this.personaManager.buildSystemPrompt();
            const newPrefix =
              [personaPrompt, profilePrompt].filter(Boolean).join('\n\n') +
              ([personaPrompt, profilePrompt].some(Boolean) ? '\n\n---\n\n' : '');
            this.loop.refreshPersonaPrefix(newPrefix);
          }
          logger.info({ persona: matchedPersona }, '角色自动切换');
        }
      }

      // v4.0：技能关键词匹配（匹配到则下一轮注入 system prompt）
      if (this.skillManager) {
        const match = this.skillManager.match(input);
        if (match) {
          this.activeSkill = match.skill.name;
          logger.debug({ skill: match.skill.name, score: match.score }, '技能匹配，下一轮注入');
        }
      }

      // 输入分类三层架构：判断是否值得提取记忆
      // Layer 1: 通用规则（零成本）→ Layer 2: 宿主关键词（零成本）→ Layer 3: 默认 extract
      const shouldExtract = this.classifyInput(input);
      if (shouldExtract === 'extract') {
        // 异步提取 insight（fire-and-forget，不阻塞下一轮对话）
        const p = this.extractInsight(input, assistantContent).catch(() => null);
        this.history.registerPendingArchive(p);
      }
    } finally {
      this._chatBusy = false;
    }
  }

  /**
   * 发送用户消息，非流式返回完整回复
   *
   * 便捷方法：内部调用 chat() 流式方法，收集所有 chunk 后一次性返回。
   * 适用于不需要流式输出的场景（如测试、批处理、API 响应）。
   *
   * @param input - 用户输入的文本
   * @param signal - 可选的 AbortSignal（V-105）
   * @returns 完整的 Agent 回复文本
   */
  async chatSync(input: string, signal?: AbortSignal): Promise<string> {
    let result = '';
    for await (const chunk of this.chat(input, signal)) {
      if (chunk.type === 'text') {
        result += chunk.content;
      }
    }
    return result;
  }

  /**
   * 切换当前话题
   *
   * 切换前为旧话题生成摘要归档（await 而非 fire-and-forget，排雷 P1-L4 时序修正）。
   * 从归档结果中提取 snapshots 写入 seed_snapshots（替代已删除的 DialogueSnapshotExtractor）。
   * 对应 CLI 的 /topic <name> 命令。
   *
   * @param newTopic - 新话题名称
   * @returns 新话题的全名（格式：日期-话题名）
   */
  async switchTopic(newTopic: string): Promise<string> {
    if (!this._initialized || !this.history) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 switchTopic() 前调用 await agent.init()',
      ]);
    }

    // 顺序化流程：归档(await) → switchTopic
    // TopicStore 已移除，归档返回 null，快照逻辑暂跳过
    await this.history.archiveCurrentTopic('switch');

    return this.history.switchTopic(newTopic);
  }

  /**
   * 列出所有话题文件
   * 对应 CLI 的 /topics 命令
   *
   * @returns 话题文件名列表
   */
  async listAllTopics(): Promise<string[]> {
    if (!this._initialized || !this.history) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 listAllTopics() 前调用 await agent.init()',
      ]);
    }
    return this.history.listAllTopics();
  }

  /**
   * 加载指定话题的历史消息
   * 对应话题文件 topics/<date>-<topic>.md
   * 加载后 Memora 状态（currentDate/currentTopic）同步切换到该话题
   * 用于"切回历史话题"——把旧对话拉回工作台
   *
   * @param date - 话题日期 YYYY-MM-DD
   * @param topic - 话题名（不含日期和扩展名）
   * @returns 消息列表
   */
  async loadTopicMessages(date: string, topic: string): Promise<TopicMessage[]> {
    if (!this._initialized || !this.history) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 loadTopicMessages() 前调用 await agent.init()',
      ]);
    }
    // TopicMessage 类型已从 types.ts 移除，保留此类型定义供 loadTopicMessages / restoreTopic 等方法签名使用
    return this.history.loadTopicMessages(date, topic) as unknown as TopicMessage[];
  }

  /**
   * 列出已注册项目
   *
   * 对应 CLI 的 /project 命令（无参数时显示项目列表）
   *
   * @returns 已注册项目条目数组（含当前项目）
   */
  listProjects(): AgentProjectEntry[] {
    if (!this._initialized || !this.projectManager) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 listProjects() 前调用 await agent.init()',
      ]);
    }
    return this.projectManager.listProjects();
  }

  /**
   * 切换到指定项目
   *
   * 关闭当前项目（释放锁 + 关闭数据库）→ 初始化新项目 → 重建所有 Agent 组件
   * 对应 CLI 的 /project <name> 命令
   *
   * @param nameOrPath - 项目名称或路径
   * @returns 新项目的完整上下文
   */
  async switchProject(nameOrPath: string): Promise<AgentContext> {
    if (!this._initialized || !this.projectManager || !this._provider) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 switchProject() 前调用 await agent.init()',
      ]);
    }

    const projects = this.projectManager.listProjects();
    // Windows 文件系统不区分大小写，大小写不同视为同一路径（F: vs f:）
    // 先尝试精确匹配，找不到再尝试大小写不敏感匹配
    let target = projects.find((p) => p.name === nameOrPath || p.path === nameOrPath);
    if (!target) {
      const nameOrPathLower = nameOrPath.toLowerCase();
      target = projects.find(
        (p) => p.name.toLowerCase() === nameOrPathLower || p.path.toLowerCase() === nameOrPathLower,
      );
    }
    // 注册表未命中时自动注册新路径，initProject 内部会写入注册表，后续再切换可走轻量路径
    const projectPath = target ? target.path : nameOrPath;
    const projectName = target ? target.name : basename(nameOrPath);

    // 重新初始化项目（ProjectManager.initProject 内部会先 closeProject）
    const newPctx = await this.projectManager.initProject(projectPath, projectName, this.configDir);

    // 重建内部组件（复用 provider）
    this._pctx = newPctx;
    this._ctx = newPctx;
    await this._rebuildComponentsWithCurrentCtx();

    return newPctx;
  }

  /**
   * 组装所有运行时组件（v4.0 统一入口）
   *
   * 从 init() 中抽取，让 init() 和 _rebuildComponentsWithCurrentCtx()
   * 共享同一套组件组装逻辑，确保切换项目/领域后不会丢失 v4.0 模块。
   *
   * 组装内容：
   *   - history（MessageHistory + MemoryIndex）
   *   - toolExec（ToolExecutor + WorkProjectionManager）
   *   - personaManager（角色 prompt 前缀）
   *   - userProfile（启动时从 SQLite 加载）
   *   - skillManager（首次创建后复用，技能配置不随项目切换变化）
   *   - loop（AgentLoop + systemPromptPrefix）
   */
  private async _assembleComponents(pctx: ProjectContext): Promise<void> {
    const activeProvider = this._provider;
    if (!activeProvider) return;

    // 消息历史（注入 storage 让 archiveCurrentTopic 同步写存储）
    // 基元驱动重构：TopicStore 和 summarizer 已从构造参数移除
    this.history = new MessageHistory(pctx.index);

    // v4.0：作品投影管理器（注入 storage + LlmProvider）
    this.workProjection = new WorkProjectionManager(
      pctx.index,
      this._backgroundProvider ?? activeProvider,
    );

    // 工具执行器（v4.0：注入 workProjection，读取文件时自动生成投影）
    const toolExec = new ToolExecutor(
      this.projectPath,
      pctx.security,
      pctx.index,
      this.workProjection,
    );
    // 保存引用，供 registerTool / executeTool 使用
    this.toolExec = toolExec;

    // v4.0：角色管理器（v1.2：personas/ 目录 + SQLite 存储 + 关键词匹配）
    this.personaManager = new PersonaManager(this.configDir, pctx.index);
    const personaPrompt = await this.personaManager.load(this._personaName);

    // v4.0：用户画像管理器 + 从 SQLite 加载
    this.userProfile = new UserProfile(pctx.index);
    await this.userProfile.load();

    // v4.0：技能管理器（首次创建后复用，两层目录扫描不随项目/领域变化）
    if (!this.skillManager) {
      this.skillManager = new SkillManager(this.configDir);
      this.skillManager.load();
    }

    // v4.0：构建系统 prompt 前缀（角色 + 用户画像）
    const systemPrefixParts = [personaPrompt];
    const profilePrompt = this.userProfile.buildSystemPrompt();
    if (profilePrompt) systemPrefixParts.push(profilePrompt);
    const systemPromptPrefix =
      systemPrefixParts.filter(Boolean).join('\n\n') +
      (systemPrefixParts.length > 0 ? '\n\n---\n\n' : '');

    // Agent Loop（v4.0：注入系统 prompt 前缀 + 工具定义 + 上下文窗口上限）
    this.loop = new AgentLoop({
      provider: activeProvider,
      bootstrapMemories: pctx.bootstrapMemories,
      toolExecutor: (name: string, args: string) =>
        toolExec.execute(name, args, this._writeExtensions ?? undefined),
      systemPromptPrefix,
      toolDefinitions: toolExec.getToolDefinitions(),
      maxContextTokens: this._maxContextTokens,
    });
  }

  /**
   * 用当前 _pctx 重建 history / loop
   * 在 switchProject / init 中复用
   */
  private async _rebuildComponentsWithCurrentCtx(): Promise<void> {
    if (!this._pctx) return;
    await this._assembleComponents(this._pctx);
  }

  // ─── Provider 管理 ────────────────────────────────────

  /**
   * 运行时切换前台 LLM Provider
   *
   * 更新 Agent 内部的 Provider 引用，同时更新 AgentLoop 的 provider。
   * 供宿主在运行时动态切换 LLM 后端。
   *
   * @param provider - 新的 LlmProvider 实例
   */
  setProvider(provider: LlmProvider): void {
    this._provider = provider;
    if (this.loop) {
      this.loop.setProvider(provider);
    }
    logger.info('Provider 已切换');
  }

  /**
   * 运行时切换后台 LLM Provider
   *
   * 后台 Provider 用于投影等不需要用户等待的操作。
   * 不配时复用前台 Provider。
   *
   * @param provider - 新的后台 LlmProvider 实例，null 表示复用前台
   */
  setBackgroundProvider(provider: LlmProvider | null): void {
    this._backgroundProvider = provider;
    logger.info({ hasBackground: !!provider }, '后台 Provider 已切换');
  }

  /**
   * 设置写入扩展回调（小说生成器场景必需）
   *
   * 宿主通过此方法注入 onBeforeWrite 回调，在 write_file 执行前
   * 收到旧内容和新内容，渲染 diff 对比面板让用户确认。
   *
   * 使用示例（小说生成器）：
   *   agent.setWriteExtensions({
   *     async onBeforeWrite(path, before, after) {
   *       // 宿主渲染 diff 面板
   *       const confirmed = await ui.showDiffConfirm(path, before, after);
   *       return confirmed;
   *     }
   *   });
   *
   * @param ext - WriteExtensions 对象，null 表示移除回调
   */
  setWriteExtensions(ext: WriteExtensions | null): void {
    this._writeExtensions = ext;
    logger.info({ hasExtensions: !!ext }, '写入扩展已设置');
  }

  /**
   * 设置宿主记忆关键词（输入分类 Layer 2）
   *
   * 宿主通过此方法注册领域关键词和用户专属关键词，
   * 用于判断用户输入是否值得提取记忆。
   *
   * @param keywords - 记忆关键词对象
   *
   * @example
   * agent.setMemoryKeywords({
   *   domain: ['主角', '角色', '情节', '设定', '世界观'],
   *   personal: ['我', '我的', '记住', '帮我'],
   * });
   */
  setMemoryKeywords(keywords: MemoryKeywords): void {
    this._hostKeywords = keywords;
    logger.info(
      { domainCount: keywords.domain.length, personalCount: keywords.personal.length },
      '宿主记忆关键词已设置',
    );
  }

  /**
   * 输入分类三层架构（Layer 1: 通用规则）
   *
   * 零成本规则过滤：短输入、问候、确认等无信息量输入 → skip
   *
   * @param input - 用户输入
   * @returns 'skip' 表示跳过提取，null 表示未命中交给下一层
   */
  private classifyByRules(input: string): 'skip' | null {
    const trimmed = input.trim();
    // 太短不可能含值得记忆的信息
    if (trimmed.length < 5) return 'skip';
    // 问候、确认、闲聊等无信息量输入
    const trivialPatterns = /^(你好|hi|hello|ok|好的|嗯|知道了|谢谢|thanks|对|不是|是的|哈哈|嗯嗯|哦|好吧|行|可以|没问题)/i;
    if (trivialPatterns.test(trimmed)) return 'skip';
    return null; // 未命中，交给下一层
  }

  /**
   * 输入分类三层架构（Layer 2: 宿主关键词）
   *
   * 宿主提供的领域关键词和用户专属关键词匹配。
   *
   * @param input - 用户输入
   * @returns 'extract' 表示值得提取，null 表示未命中交给下一层
   */
  private classifyByHostKeywords(input: string): 'extract' | null {
    if (!this._hostKeywords) return null; // 宿主未注册关键词，跳过此层

    // 领域关键词匹配
    if (this._hostKeywords.domain.some((k) => input.includes(k))) return 'extract';
    // 用户专属关键词匹配
    if (this._hostKeywords.personal.some((k) => input.includes(k))) return 'extract';

    return null; // 未命中，交给下一层
  }

  /**
   * 输入分类三层架构（串联）
   *
   * Layer 1: 通用规则（Memora 内置，零成本）
   * Layer 2: 宿主关键词（宿主提供，零成本）
   * Layer 3: 默认 extract + 后台异步精判修正
   *
   * @param input - 用户输入
   * @returns 'skip' 或 'extract'
   */
  private classifyInput(input: string): 'skip' | 'extract' {
    // Layer 1: 通用规则
    const ruleResult = this.classifyByRules(input);
    if (ruleResult) return ruleResult;

    // Layer 2: 宿主关键词
    const keywordResult = this.classifyByHostKeywords(input);
    if (keywordResult) return keywordResult;

    // Layer 3: 默认 extract（宁可多提，不可漏提）
    // LLM 精判作为后台异步优化，不影响主对话流程
    return 'extract';
  }

  /**
   * 提取对话中的 insight（每轮异步提取）
   *
   * 流程：
   * 1. 调用 LLM 提取 insight（异步，不阻塞主对话）
   * 2. 去重检查（防止重复写入）
   * 3. 写入 SQLite（source='insight', score=0.5）
   *
   * @param userInput - 用户输入
   * @param assistantContent - 助手回复
   */
  private async extractInsight(userInput: string, assistantContent: string): Promise<void> {
    if (!this._provider || !this._pctx || !this.loop) return;

    try {
      // 获取前 2 轮对话作为语义支撑（R-11 排雷修正）
      const recentHistory = this.loop.getRecentHistory(2);
      const contextSection = recentHistory.length > 0
        ? '\n\n前几轮对话（供参考）：\n' + recentHistory.map(m =>
          `${m.role === 'user' ? '用户' : '助手'}：${m.content}`
        ).join('\n')
        : '';

      // Step 1: 调用 LLM 提取 insight
      const extractionPrompt = `你是一个记忆提取助手。判断以下对话是否包含值得长期记忆的信息。

如果有，输出 JSON：
{"insight": "一句话描述", "tags": ["关键词1", "关键词2"]}

如果没有，输出 null。

值得记忆的信息：
- 用户的偏好、决策、设定
- 创作中的关键信息（角色、情节、世界观）
- 用户明确要求记住的内容

不值得记忆的信息：
- 问候、确认、闲聊
- AI 的通用回复（不涉及具体创作内容）
- 重复之前已说过的内容
${contextSection}
对话：
用户：${userInput}
助手：${assistantContent}`;

      const messages: Message[] = [{ role: 'user', content: extractionPrompt }];
      let llmResponse = '';
      for await (const chunk of this._provider.chat(messages)) {
        llmResponse += chunk;
      }

      // 解析 LLM 响应
      const trimmedResponse = llmResponse.trim();
      if (trimmedResponse === 'null' || !trimmedResponse) {
        logger.debug('extractInsight: LLM 判断无值得记忆的信息');
        return;
      }

      // 尝试解析 JSON
      let insight: string | null = null;
      try {
        const parsed = JSON.parse(trimmedResponse);
        if (parsed && typeof parsed.insight === 'string') {
          insight = parsed.insight;
        }
      } catch {
        // JSON 解析失败，尝试从文本中提取
        const match = trimmedResponse.match(/"insight"\s*:\s*"([^"]+)"/);
        if (match && match[1]) {
          insight = match[1];
        }
      }

      if (!insight) {
        logger.debug('extractInsight: 无法解析 LLM 响应');
        return;
      }

      // Step 2: 去重检查
      const snippet = insight.slice(0, 30).replace(/[%_]/g, '\\$&');
      const existing = this._pctx.index.search(snippet, 1);
      const existingMemory = existing[0];
      if (existingMemory && existingMemory.content.includes(insight.slice(0, 30))) {
        // 已有相似记忆，更新 accessed_at 和 score
        existingMemory.score = Math.min(1.0, existingMemory.score + 0.05);
        existingMemory.accessed_at = new Date().toISOString();
        this._pctx.index.upsert(existingMemory);
        logger.debug({ id: existingMemory.id }, 'extractInsight: 更新已有记忆');
        return;
      }

      // Step 3: 写入 SQLite
      const now = new Date().toISOString();
      const memory: Memory = {
        id: `insight:${Date.now()}`,
        content: insight,
        source: SOURCE_LABELS.INSIGHT,
        name: `insight-${Date.now()}`,
        created_at: now,
        accessed_at: now,
        score: 0.5,
      };
      this._pctx.index.upsert(memory);
      logger.info({ id: memory.id, insight }, 'extractInsight: 写入新记忆');
    } catch (err) {
      // 提取失败不影响主对话流程
      logger.warn({ err }, 'extractInsight: 提取失败');
    }
  }

  /**
   * 对外暴露当前组件快照（供 REPL 等 CLI 宿主重建 history/loop 引用）
   *
   * 注意：此方法仅返回引用，调用方在重建 history/loop 后需重新调用
   * rebuildComponents() 才能拿到新对象。
   */
  getBuildCtx(): AgentBuildCtx | null {
    if (!this._pctx) return null;
    return {
      security: this._pctx.security,
      index: this._pctx.index,
      bootstrapMemories: this._pctx.bootstrapMemories,
    };
  }

  /**
   * 重建 history / loop（项目切换后调用）
   *
   * 公开为公共方法供宿主项目触发——CLI 在 /project 命令后调用。
   * 内部实现复用 _rebuildComponentsWithCurrentCtx()。
   */
  async rebuildComponents(): Promise<void> {
    await this._rebuildComponentsWithCurrentCtx();
  }

  /**
   * 搜索记忆（关键词 + FTS5 索引）
   *
   * 对应 CLI 的 /search <query> 命令
   * 返回 CLI 友好的扁平结构（已处理内容截断）
   *
   * @param query - 搜索关键词
   * @param limit - 最大返回条数（默认 10）
   * @returns 搜索结果数组
   */
  async searchMemories(query: string, limit = 10): Promise<AgentSearchHit[]> {
    if (!this._initialized || !this._ctx) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 searchMemories() 前调用 await agent.init()',
      ]);
    }
    // 空 query 会让 search() 退化为"返回所有"，对宿主程序是静默误导
    if (!query || query.trim() === '') {
      throw configError('搜索关键词为空', 'searchMemories() 需要非空 query', [
        '传入非空字符串关键词',
        '使用 inspect().bootstrap.items 列出所有引导记忆',
      ]);
    }
    if (limit <= 0 || !Number.isInteger(limit)) {
      throw configError('无效 limit', `limit 必须是正整数，收到 ${limit}`, [
        '使用 limit = 10（默认值）',
      ]);
    }
    const hits = this._ctx.index.search(query, limit);
    return hits.map((m: Memory) => ({
      name: m.name,
      source: m.source,
      score: m.score,
      // 截断长内容到 120 字符
      contentPreview: m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content,
    }));
  }

  /**
   * 记忆库统计
   *
   * 返回记忆来源分布、数据库大小等关键指标，
   * 供 CLI /stat 命令渲染统计面板。
   *
   * @returns 记忆库统计数据
   */
  async getStats(): Promise<AgentStats> {
    if (!this._initialized || !this._ctx) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 getStats() 前调用 await agent.init()',
      ]);
    }

    // 按来源标签统计记忆数量
    const sources = Object.values(SOURCE_LABELS);
    const bySource: Record<string, number> = {};
    for (const src of sources) {
      const memories = this._ctx.index.getBySource(src);
      bySource[src] = memories.length;
    }

    // 总记忆数
    const total = Object.values(bySource).reduce((a, b) => a + b, 0);

    return { bySource, total };
  }

  /**
   * 统一查看记忆快照
   *
   * 基元驱动模型下简化为 3 层（工作记忆 / Bootstrap / 话题归档），
   * 移除了旧的第 4 层"话题挂载"（TopicMount 已删除）。
   *
   * 设计原则：
   * - **纯只读**——不动任何组件状态
   * - **同步返回**——避免数据不一致（不调 LLM、不调 SQLite）
   * - **轻量**——每层只返回前 N 条 + 总数
   *
   * @returns 记忆快照
   */
  inspect(): MemorySnapshot {
    if (!this._initialized) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 inspect() 前调用 await agent.init()',
      ]);
    }

    // 第 1 层：工作记忆（AgentLoop 的 messages 数组，详见 loop.ts §messages）
    // - 包含 system 提示、user 消息、assistant 消息、tool 工具结果
    // - 这是 LLM 当下决策的全部上下文
    const workingFull = this.loop?.getMessages() ?? [];
    const workingTotal = workingFull.length;
    const working = workingFull.slice(-MemoryInspector.WORKING_PREVIEW);

    // 第 2 层：Bootstrap 记忆（永驻 + 领域）
    const bootstrap: readonly Memory[] = this._ctx?.bootstrapMemories ?? [];

    // 第 3 层：话题归档文件计数（异步加载，inspect 同步返回缓存值）
    // _cachedTopicCount 已移除，后续通过异步机制刷新
    const archiveTotal = 0;

    return {
      working: {
        total: workingTotal,
        preview: working.map(
          (m: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }) => ({
            role: m.role,
            contentPreview: m.content.slice(0, MemoryInspector.CONTENT_PREVIEW_LEN),
            contentLength: m.content.length,
          }),
        ),
      },
      bootstrap: {
        total: bootstrap.length,
        items: bootstrap.map((m: Memory) => ({
          id: m.id,
          source: m.source,
          name: m.name,
          contentPreview: m.content.slice(0, MemoryInspector.CONTENT_PREVIEW_LEN),
          score: m.score,
        })),
      },
      archive: {
        topicFilesCount: archiveTotal,
        currentTopic: this.history?.topic ?? '(none)',
        // 当前话题全名（含日期前缀，与 topics/*.md 文件名一致）
        // 用于渲染端精确高亮"当前话题"——裸名 "main" 在多文件场景下不唯一
        currentTopicName: this.history?.currentTopicName ?? '(none)',
        // 真实归档文件列表需调 listAllTopics()，本方法不阻塞
        hint: '调 listAllTopics() 获取文件清单',
      },
    };
  }

  /**
   * 关闭 Agent，释放 SQLite 连接等资源
   */
  async close(): Promise<void> {
    // 等待所有 fire-and-forget 归档完成（signal / lazy / switch）
    if (this.history) {
      await this.history.awaitPendingArchives(5000);
    }

    if (this.projectManager) {
      await this.projectManager.shutdown();
    }
    this._initialized = false;
    this._backgroundProvider = null;
    this._chatBusy = false;
    this.history = null;
    this.loop = null;
    this.projectManager = null;
    this._ctx = null;
    this._pctx = null;
  }

  // ─── 工具注册 API ─────────────────────────────────────

  /**
   * 注册自定义工具
   *
   * 宿主项目通过此方法注册领域专属工具（如小说创作的 create_chapter）。
   * 注册后工具会出现在 LLM 的 tools 列表中，可被 tool_call 调用。
   * handler 中可通过 agent.executeTool() 委托内置工具（复用安全层）。
   *
   * 必须在 init() 之后调用（否则 ToolExecutor 尚未创建）。
   *
   * @param definition 工具定义（名称、描述、参数 schema）
   * @param handler 工具执行处理器
   * @throws Agent 未初始化或工具名冲突时抛错
   */
  registerTool(definition: ToolDefinition, handler: ToolHandler): void {
    if (!this._initialized || !this.toolExec) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 registerTool() 前调用 await agent.init()',
      ]);
    }
    this.toolExec.registerTool(definition, handler);
    // 刷新 AgentLoop 的 system prompt，让 LLM 看到新注册的工具描述
    if (this.loop) {
      this.loop.refreshToolDefinitions(this.toolExec.getToolDefinitions());
    }
  }

  /**
   * 获取所有工具定义（内置 + 自定义）
   *
   * 用于宿主项目了解当前可用工具列表，
   * 或构建 LLM 请求时获取 tools 参数。
   */
  getToolDefinitions(): ToolDefinition[] {
    if (!this.toolExec) return [];
    return this.toolExec.getToolDefinitions();
  }

  /**
   * 执行工具调用（委托给 ToolExecutor）
   *
   * 宿主项目的自定义工具 handler 可通过此方法委托内置工具，
   * 复用安全层（路径白名单、写入确认等）。
   * 例如小说工具 create_chapter 的 handler 可调用：
   *   agent.executeTool('write_file', JSON.stringify({ path, content }))
   *
   * @param name 工具名称
   * @param argsJson 参数 JSON 字符串
   * @returns 工具执行结果字符串
   */
  async executeTool(name: string, argsJson: string): Promise<string> {
    if (!this._initialized || !this.toolExec) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 executeTool() 前调用 await agent.init()',
      ]);
    }
    return this.toolExec.execute(name, argsJson, this._writeExtensions ?? undefined);
  }

  // ─── 配置建议 API（模式 3 · Agent 智能总结）────────────

  /**
   * 注册配置建议回调（模式 3）
   *
   * 宿主项目通过此方法注册回调，当 AutoConfigRefiner 从对话中
   * 提取到配置建议时，通过此回调通知宿主。
   * 宿主决定展示方式（桌宠气泡 / CLI 打印 / WebUI 弹窗）。
   *
   * 目前仅提供接口，AutoConfigRefiner 实现属于设计阶段。
   * 宿主可提前注册回调，后续 AutoConfigRefiner 上线后自动生效。
   *
   * @param handler 配置建议回调函数
   */
  onConfigSuggestion(handler: ConfigSuggestionHandler): void {
    this._configSuggestionHandler = handler;
  }

  /**
   * 获取当前注册的配置建议回调
   *
   * 供 AutoConfigRefiner（设计阶段）调用，检查是否有宿主注册了回调。
   * 外部代码一般不需要直接访问此属性。
   */
  get configSuggestionCallback(): ConfigSuggestionHandler | null {
    return this._configSuggestionHandler;
  }

  /**
   * 确认配置建议并写入配置文件（模式 3）
   *
   * 用户确认配置建议后，宿主调用此方法将建议持久化到 agent-config/ 目录。
   * 写入的是配置文件（真理源），下次启动时 MemoryLoader 自动扫描加载到 SQLite。
   *
   * 与 addRule() 的关键区别：
   * - addRule() → 写入 SQLite（运行时注入，会话级，重启后需重新注入）
   * - confirmConfigSuggestion() → 写入配置文件（持久化，重启后自动加载）
   *
   * @param suggestion 用户确认的配置建议
   * @throws Agent 未初始化或 configDir 未设置时抛错
   */
  async confirmConfigSuggestion(suggestion: ConfigSuggestion): Promise<void> {
    if (!this._initialized) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 confirmConfigSuggestion() 前调用 await agent.init()',
      ]);
    }
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
    // 不写入 SQLite——遵守"配置文件是真理源"约束（接入指南 §九 第 7/10 条）
    // 下次启动时 MemoryLoader 自动扫描配置文件 → 加载到 SQLite
    const fileStore = new FileStore(this.configDir);
    const now = new Date().toISOString();
    const memory: Memory = {
      id: `${source}:${suggestion.name}`,
      content: suggestion.content,
      source,
      name: suggestion.name,
      created_at: now,
      accessed_at: now,
      score: suggestion.confidence,
    };
    await fileStore.write(memory);

    // 如果是规则，立即注入到 AgentLoop（当前会话生效，重启后由配置文件自动加载）
    if (suggestion.type === 'rule' && this.loop) {
      const rulePrompt = `【项目规则】${suggestion.name}\n${suggestion.content}`;
      this.loop.injectSystemMessage(rulePrompt);
    }

    logger.info(
      { type: suggestion.type, name: suggestion.name, confidence: suggestion.confidence },
      '配置建议已确认并写入配置文件',
    );
  }

  // ─── 角色管理 API（P-605 · v1.1）────────────────────

  /**
   * 手动切换角色
   *
   * 切换到指定角色名，自动更新 system prompt 前缀。
   * 需确保模式为 'manual'（或调用后自动切换为 manual 模式）。
   *
   * @param name 角色名
   */
  switchPersona(name: string): void {
    if (!this._initialized || !this.personaManager) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 switchPersona() 前调用 await agent.init()',
      ]);
    }
    this.personaManager.switchPersona(name);
    this.personaManager.setMode('manual');
    if (this.loop && this.userProfile) {
      const profilePrompt = this.userProfile.buildSystemPrompt();
      const personaPrompt = this.personaManager.buildSystemPrompt();
      const newPrefix =
        [personaPrompt, profilePrompt].filter(Boolean).join('\n\n') +
        ([personaPrompt, profilePrompt].some(Boolean) ? '\n\n---\n\n' : '');
      this.loop.refreshPersonaPrefix(newPrefix);
    }
    logger.info({ persona: name }, '角色手动切换');
  }

  /**
   * 获取可用角色列表
   */
  listPersonas(): Array<{ name: string; description?: string; keywords: string[] }> {
    if (!this._initialized || !this.personaManager) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 listPersonas() 前调用 await agent.init()',
      ]);
    }
    return this.personaManager.list.map((p) => ({
      name: p.name,
      description: p.description,
      keywords: p.keywords,
    }));
  }

  /**
   * 设置角色激活模式
   *
   * @param mode 'auto'（自动匹配）| 'manual'（手动固定）
   */
  setPersonaMode(mode: 'auto' | 'manual'): void {
    if (!this._initialized || !this.personaManager) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 setPersonaMode() 前调用 await agent.init()',
      ]);
    }
    this.personaManager.setMode(mode);
    // 切回自动模式时立即执行一次自动匹配
    if (mode === 'auto' && this.loop && this.userProfile) {
      const profilePrompt = this.userProfile.buildSystemPrompt();
      const personaPrompt = this.personaManager.buildSystemPrompt();
      const newPrefix =
        [personaPrompt, profilePrompt].filter(Boolean).join('\n\n') +
        ([personaPrompt, profilePrompt].some(Boolean) ? '\n\n---\n\n' : '');
      this.loop.refreshPersonaPrefix(newPrefix);
    }
  }

  /**
   * 获取当前激活模式
   */
  getPersonaMode(): 'auto' | 'manual' {
    if (!this._initialized || !this.personaManager) return 'auto';
    return this.personaManager.currentMode;
  }

  /**
   * 获取当前激活的角色名称
   */
  getActivePersonaName(): string {
    if (!this._initialized || !this.personaManager) return '';
    return this.personaManager.activeName;
  }

  // ─── 只读访问器 ───────────────────────────────────────

  /** 是否已初始化 */
  get initialized(): boolean {
    return this._initialized;
  }

  /** 初始化后的运行时上下文（init 前为 null） */
  get context(): AgentContext | null {
    return this._ctx;
  }

  /**
   * 获取内部 AgentLoop 引用（只读）
   *
   * 供 REPL 等宿主项目获取 Agent 内部的 loop 实例，
   * 避免宿主自行创建 loop 导致内外不同步。
   * 切换 Provider/项目后，Agent 内部 loop 自动更新。
   */
  get agentLoop(): AgentLoop | null {
    return this.loop;
  }

  /**
   * 获取内部 MessageHistory 引用（只读）
   *
   * 供 REPL 等宿主项目获取 Agent 内部的 history 实例，
   * 避免宿主自行创建 history 导致内外不同步。
   */
  get agentHistory(): MessageHistory | null {
    return this.history;
  }

  /**
   * 当前激活的 LlmProvider 实例（只读）
   *
   * 供宿主项目在需要创建依赖 Provider 的组件时使用。
   */
  get provider(): LlmProvider {
    return this._provider;
  }

  /**
   * Agent 是否正在处理对话（V-106 · 泊文 UI 刚需）
   *
   * 泊文等宿主 UI 用此属性：
   * - 禁用输入框（防止并发 chat()）
   * - 显示加载动画（"思考中..."）
   * - 控制取消按钮可见性
   */
  get isBusy(): boolean {
    return this._chatBusy;
  }

  /**
   * 新增项目规则记忆（Q-701 · v1.1）
   *
   * 宿主项目可通过此 API 在运行时动态注入规则记忆。
   * 规则写入 SQLite 索引后，重启时由 bootstrap 自动召回。
   * 如果 AgentLoop 已启动，当前轮次以 system 消息注入。
   *
   * @param memory 规则记忆（必须 source='rule'）
   */
  async addRule(memory: Memory): Promise<void> {
    if (!this._initialized || !this._pctx) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 addRule() 前调用 await agent.init()',
      ]);
    }
    if (memory.source !== SOURCE_LABELS.RULE) {
      throw configError('无效来源', `addRule 只接受 source='rule'，收到 '${memory.source}'`, [
        '使用 SOURCE_LABELS.RULE 作为 source 字段',
      ]);
    }

    await this._pctx.index.upsert(memory);

    if (this.loop) {
      const rulePrompt = `【项目规则】${memory.name}\n${memory.content}`;
      this.loop.injectSystemMessage(rulePrompt);
    }

    logger.info({ name: memory.name, source: memory.source }, '项目规则已注入');
  }

  /**
   * 新增项目规则的便捷方法（P1-4 修复）
   *
   * 宿主程序只需提供 name + content 两个业务字段，
   * 内部自动填充 id / source / created_at / accessed_at / score 等字段。
   *
   * @param name 规则名称（如"代码风格"、"TypeScript 偏好"）
   * @param content 规则内容（Markdown 格式）
   */
  async addSimpleRule(
    name: string,
    content: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const memory: Memory = {
      id: `rule:${name}`,
      content,
      source: SOURCE_LABELS.RULE,
      name,
      created_at: now,
      accessed_at: now,
      score: 0.8,
    };
    await this.addRule(memory);
  }

  /**
   * 新增技能记忆（C1 修复：与 addRule 对称的公共方法）
   *
   * 宿主程序可通过此方法在运行时动态注入技能，
   * 注入后 AgentLoop 会在下一轮对话时自动匹配（关键词触发）。
   *
   * 校验规则：
   *   - memory.source 必须为 'skill'
   *
   * @param memory 完整的 Memory 对象
   */
  async addSkill(memory: Memory): Promise<void> {
    if (!this._initialized) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 addSkill() 前调用 await agent.init()',
      ]);
    }
    if (!this.skillManager) {
      throw configError('技能管理器不可用', '请先调用 init()', [
        '在 addSkill() 前调用 await agent.init()',
      ]);
    }
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
    if (this._pctx) {
      await this._pctx.index.upsert(memory);
    }

    logger.info({ name: memory.name }, '技能已注入');
  }

  /**
   * 新增技能的便捷方法（C1 修复：与 addSimpleRule 对称）
   *
   * 宿主程序只需提供 name + content + keywords 三个业务字段，
   * 内部自动填充 id / source / created_at / accessed_at / score。
   *
   * @param name 技能名称（如"代码审查"、"章节创作"）
   * @param content 技能内容（Markdown 格式）
   * @param keywords 触发关键词数组（AgentLoop 用关键词匹配调用时机）
   */
  async addSimpleSkill(name: string, content: string, keywords: string[] = []): Promise<void> {
    void keywords; // 基元驱动模型下关键词暂不存储到 Memory，由 SkillManager 管理
    const now = new Date().toISOString();
    const memory: Memory = {
      id: `skill:${name}`,
      content,
      source: SOURCE_LABELS.SKILL,
      name,
      created_at: now,
      accessed_at: now,
      score: 0.7,
    };
    await this.addSkill(memory);
  }

  /**
   * 获取工作记忆的完整消息列表
   *
   * 用于宿主项目恢复对话界面（如 Web UI 刷新后重新渲染历史消息）。
   * 返回 AgentLoop 内部的 messages 数组引用（只读），包含：
   * - system 提示（人格 + 规则 + 领域）
   * - user / assistant 对话轮次
   * - tool 调用与结果
   *
   * 注意：这是 LLM 当下看到的完整上下文，不是 topic 文件的归档。
   * 服务重启后此数组为空（仅含 system prompt），历史对话在 topic-*.md 文件中。
   *
   * C2 修复：未初始化时抛友好错（与 chat() / addRule() 等方法行为一致），
   * 避免宿主程序误以为"空数组 = 全新对话"。
   */
  getMessages(): readonly Message[] {
    if (!this._initialized || !this.loop) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 getMessages() 前调用 await agent.init()',
      ]);
    }
    return this.loop.getMessages();
  }

  /**
   * 最近一次 chat() 调用时间（只读访问器）
   *
   * 桌面精灵等长时间运行的宿主程序可通过此访问器判断：
   * - 用户离线了多久（new Date() - agent.lastInteractionAt）
   * - 是否应该主动发起问候（如超过 30 分钟未交互）
   *
   * 返回 null 表示尚未调用过 chat()。
   */
  get lastInteractionAt(): Date | null {
    return this._lastInteractionAt;
  }

  /**
   * 恢复最近的话题对话
   * 用于启动时自动恢复上次对话
   *
   * @param preferredTopic - 优先加载的话题名（默认 'main'）
   * @returns 恢复的消息数量，没有恢复返回 0
   */
  async restoreMostRecentTopic(preferredTopic = 'main'): Promise<number> {
    if (!this._initialized || !this.history || !this.loop) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 restoreMostRecentTopic() 前调用 await agent.init()',
      ]);
    }

    // 从话题文件加载历史消息
    const topicMessages = await this.history.loadMostRecentTopic(preferredTopic);
    if (topicMessages.length === 0) {
      logger.debug('没有找到可恢复的历史话题');
      return 0;
    }

    // 转换 TopicMessage[] 为 Message[]
    const messages: Message[] = topicMessages.map((tm: { role: string; content: string }) => ({
      role: tm.role as Message['role'],
      content: tm.content,
    }));

    // 恢复到 AgentLoop
    this.loop.restoreHistory(messages);

    // ensureTopicInIndex 已移除（TopicStore 已删除），后续通过 recall() 自然召回
    return topicMessages.length;
  }

  /**
   * 恢复指定话题的对话
   *
   * @param date - 话题日期 YYYY-MM-DD
   * @param topic - 话题名
   * @returns 恢复的消息数量，没有恢复返回 0
   */
  async restoreTopic(date: string, topic: string): Promise<number> {
    if (!this._initialized || !this.history || !this.loop) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 restoreTopic() 前调用 await agent.init()',
      ]);
    }

    // TopicMessage 类型已从 types.ts 移除，保留此类型定义供 loadTopicMessages / restoreTopic 等方法签名使用
    const topicMessages = await this.history.loadTopicMessages(date, topic);
    if (topicMessages.length === 0) {
      return 0;
    }

    // 转换为 Message[]
    const messages: Message[] = topicMessages.map((tm: { role: string; content: string }) => ({
      role: tm.role as Message['role'],
      content: tm.content,
    }));

    // 恢复到 AgentLoop
    this.loop.restoreHistory(messages);

    // ensureTopicInIndex 已移除（TopicStore 已删除），后续通过 recall() 自然召回
    return topicMessages.length;
  }
}
