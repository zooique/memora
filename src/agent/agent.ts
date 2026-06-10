/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 设计文档（01-主架构-v4.0.md §9）要求宿主项目通过 `import { Agent } from '@memora/core'`
 * 一行代码接入。本类把当前 repl.ts 中埋藏的组装逻辑提取到正确的架构层，
 * 使 AgentLoop / MemoryIndex / ToolExecutor / SecurityGuard
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
 * 专注模式（应无所住，而生其心）：
 *   Agent 启动时只加载 always + domain 记忆（无所住），
 *   用户一开口，TopicMount 自动召回话题记忆注入上下文（生其心）。
 *   同话题内缓存召回结果，鼓励深度专注。
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
import { createTopicSummarizer } from './topic-summarizer.js';
import { RecallPipeline } from '@/memory/recall.js';
import { TopicMount } from '@/memory/topic-mount.js';
import { PersonaManager } from '@/persona/personaManager.js';
import { UserProfile } from '@/memory/userProfile.js';
import { WorkProjectionManager } from './workProjection.js';
import { SkillManager } from '@/skill/skillManager.js';
import { FileStore } from '@/memory/store.js';
import { configError } from '@/utils/errors.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory, TopicMessage, TopicSummarizerResult } from '@/memory/types.js';
import {
  MemoryType,
  Permanence,
  type PermanenceValue,
  type MemoryTypeValue,
} from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storage-interface.js';
import type { ILogger } from '@/logging/logger-interface.js';
import { logger, setLogger } from '@/logging/logger.js';
import type { TopicStore } from '@/memory/topic-store.js';
import type { SecurityGuard } from '@/security/path-guard.js';
import { detectMemorableSignal } from './signal-detector.js';

// ─── 类型定义 ───────────────────────────────────────────

/**
 * 归档模式（控制 chat() 中自动归档的行为）
 *
 * - 'full'（默认）：所有内容自动归档（信号检测 + 周期性 + 中途），适合日常对话
 * - 'insights-only'：只自动归档用户洞察（userProfile），话题归档需宿主手动触发，
 *   适合"审核-通过"工作流（如小说写作：草稿不归档，定稿才归档）
 * - 'manual'：完全不自动归档，宿主完全控制归档时机
 *
 * 详见 docs/memora-接入指南-v1.0.md §8.3 归档模式
 */
export type ArchiveMode = 'full' | 'insights-only' | 'manual';

/** Agent 构造选项 */
export interface AgentOptions {
  /** 项目路径（必须） */
  projectPath: string;
  /** 前台 LLM Provider（必须，宿主负责创建） */
  provider: LlmProvider;
  /** 后台 LLM Provider（可选，用于归档/投影等后台操作，不配时复用前台） */
  backgroundProvider?: LlmProvider;
  /** 配置目录（personas/rules/skills） */
  configDir?: string;
  /** 归档模式（默认 'full'）：控制 chat() 中自动归档的行为 */
  archiveMode?: ArchiveMode;
  /** 记忆数据目录（默认 ~/.memora） */
  dataDir?: string;
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
  /** 外部注入的存储实例（可选，不传则内部创建 SqliteStorage） */
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
  name: string;
  type: string;
  weight: number;
  contentPreview: string;
}

/**
 * 记忆库统计数据（新枝破土 N-101）
 *
 * 提供给 CLI /stat 命令渲染统计面板。
 */
export interface AgentStats {
  /** 按类型分组的记忆数量 */
  byType: Record<string, number>;
  /** 话题文件总数 */
  topicCount: number;
  /** 记忆总数 */
  total: number;
}

/**
 * 挂载记忆条目（新枝破土 N-102）
 *
 * 提供给 CLI /mounted 命令渲染挂载面板。
 */
export interface AgentMountedMemory {
  /** 记忆 ID */
  id: string;
  /** 记忆名称 */
  name: string;
  /** 永久性级别 */
  type: string;
  /** 权重 */
  weight: number;
  /** 内容预览（前 60 字符） */
  contentPreview: string;
  /** 是否已被踢出 */
  suppressed: boolean;
  /** 创建时间 */
  createdAt: string;
}

/**
 * Agent 内部组件快照（供宿主项目重建 history/loop 等 CLI 可见对象）
 *
 * 把 memory/security 层的具体类型收拢到 agent 层封装，
 * 避免 cli 直接 import memory 子模块（违反分层规则）。
 */
export interface AgentBuildCtx {
  topicStore: TopicStore;
  security: SecurityGuard;
  index: IMemoryStorage;
  bootstrapMemories: Memory[];
}

// ─── 4 层记忆快照类型（inspect() 返回值）──────────────────

/**
 * 4 层记忆的统一快照类型
 *
 * 详见 docs/基础设计文档/00-记忆归档原则-v1.0.md §2.1 四层记忆模型
 */
export interface MemorySnapshot {
  /** 第 1 层：工作记忆（messages 数组） */
  working: WorkingMemorySnapshot;
  /** 第 2 层：Bootstrap 记忆（永驻 + 领域） */
  bootstrap: BootstrapSnapshot;
  /** 第 3 层：话题归档文件（topic-*.md） */
  archive: ArchiveSnapshot;
  /** 第 4 层：话题挂载（TopicMount 缓存） */
  mounted: MountedSnapshot;
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
    type: string;
    permanence: string;
    name: string;
    contentPreview: string;
    weight: number;
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

/** 第 4 层：话题挂载快照 */
export interface MountedSnapshot {
  total: number;
  isMounted: boolean;
  items: Array<{
    id: string;
    name: string;
    weight: number;
    contentPreview: string;
  }>;
}

/**
 * 快照预览配置
 *
 * 不引入新类，只用 class holder 装常量——避免污染 Agent 类。
 */
class MemoryInspector {
  /** 工作记忆预览条数（最近 N 条） */
  static readonly WORKING_PREVIEW = 5;
  /** 话题挂载预览条数（最近 N 条） */
  static readonly MOUNTED_PREVIEW = 5;
  /** 内容预览字符数 */
  static readonly CONTENT_PREVIEW_LEN = 80;
}

// ─── Agent 门面类 ───────────────────────────────────────

export class Agent {
  // 构造参数
  private _provider: LlmProvider; // 前台 LLM Provider（构造时存储）
  private _backgroundProvider: LlmProvider | null; // 后台 LLM Provider（可选）
  private _dataDir: string; // 记忆数据目录（默认 ~/.memora）
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
  private topicMount: TopicMount | null = null; // 话题记忆挂载器（专注模式）
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
   * 对话轮次计数器（记忆减法方案 v1.0 · 排雷修正 L5）
   *
   * 每轮 chat() 递增。达到 archiveCheckRounds 后触发话题归档检查，
   * 使用 TopicMount 的 Jaccard 相似度判断话题是否漂移。
   * 切换话题时重置。
   */
  private roundCount = 0;

  /**
   * 当前话题总轮次计数器（排雷新增：炼化管线减法 方向 A）
   *
   * 从话题建立开始累计，不随周期性归档重置。
   * 用于超长话题中途归档触发（>= 30 轮后每 10 轮 1 次）。
   * 切换话题时与 roundCount 同步重置。
   */
  private totalTopicRounds = 0;

  /**
   * 归档检查轮次阈值（记忆减法方案 v1.0）
   * N 轮后启动话题归档检查（话题级检查，非逐轮归档）
   */
  private readonly archiveCheckRounds = 3;

  /** 中途归档间隔轮次（排雷新增） */
  private static readonly MIDWAY_ARCHIVE_INTERVAL = 30;

  /**
   * 配置建议回调（模式 3 · Agent 智能总结）
   *
   * 宿主通过 onConfigSuggestion() 注册，AutoConfigRefiner 触发时调用。
   * 目前仅提供接口，AutoConfigRefiner 实现属于设计阶段。
   */
  private _configSuggestionHandler: ConfigSuggestionHandler | null = null;
  /** P3-9 修复：chat() 并发锁，防止同时发起多个对话导致消息序列混乱 */
  private _chatBusy = false;
  /** 归档模式：控制 chat() 中自动归档的行为（默认 'full'） */
  private _archiveMode: ArchiveMode = 'full';
  /** 桌面精灵缺口：最近一次 chat() 调用的时间戳（供宿主判断用户离线时长） */
  private _lastInteractionAt: Date | null = null;
  /** 桌面精灵缺口：缓存的已归档话题文件数（inspect() 同步读取，init/close 时刷新） */
  private _cachedTopicCount = 0;
  /** 写入扩展回调（宿主注入 diff 对比确认逻辑，小说生成器场景必需） */
  private _writeExtensions: WriteExtensions | null = null;

  constructor(opts: AgentOptions) {
    this.projectPath = opts.projectPath;
    this._provider = opts.provider;
    this._backgroundProvider = opts.backgroundProvider ?? null;
    this.configDir = opts.configDir;
    this._dataDir = opts.dataDir ?? '~/.memora';
    this._maxContextTokens = opts.maxContextTokens ?? 120000;
    this._personaName = opts.persona;
    this._permission = opts.permission ?? 'owner';
    this._allowedPaths = opts.allowedPaths ?? [];
    this._confirmWrites = opts.confirmWrites ?? false;
    // 外部注入的存储实例（可选，不传则内部创建 SqliteStorage）
    this._storage = opts.storage;
    // 外部注入的日志实现（可选，不传则使用默认 PinoLogger）
    if (opts.logger) {
      setLogger(opts.logger);
    }
    // 归档模式（默认 'full'，向后兼容）
    if (opts.archiveMode) {
      this._archiveMode = opts.archiveMode;
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
    // P2-6 修复：重复调用 init() 时先清理旧资源，防止泄漏
    if (this._initialized) {
      await this.close();
    }

    // 允许运行时覆盖（用于 switchProject 时的二次 init）
    if (projectPathOverride) {
      this.projectPath = projectPathOverride;
    }

    // 创建 ProjectManager（只传 dataDir，不依赖 Config 类型）
    // 如果宿主注入了 storage，传递给 ProjectManager（否则内部创建 SqliteStorage）
    this.projectManager = new ProjectManager(
      this._dataDir,
      this._allowedPaths,
      this._confirmWrites,
      this._permission,
      this._storage,
    );

    // 初始化项目上下文（加载 .memora/ 下的记忆索引）
    // 传递 configDir 以分离配置目录与运行时数据目录
    const pctx = await this.projectManager.initProject(this.projectPath, undefined, this.configDir);

    // 组装所有运行时组件（v4.0：包括 persona/skill/userProfile/workProjection）
    await this._assembleComponents(pctx);

    // 保存完整项目上下文（保留 globalMemories / projectName 等所有字段）
    this._pctx = pctx;
    this._ctx = pctx;

    // P2-8 修复：关键组件缺失时报错，而非静默成功后 chat() 崩溃
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

    // 缓存话题文件数，供 inspect() 同步读取
    this._refreshTopicCount().catch(() => {
      /* 异步刷新失败忽略，inspect() 将回退显示 0 */
    });

    return pctx;
  }

  /**
   * 发送用户消息，流式返回 Agent 回复
   *
   * 对应 repl.ts 中 processUserInput() → 逐 chunk yield 的逻辑。
   * 内部自动维护 MessageHistory（appendUser → loop → appendAssistant）。
   *
   * @param input - 用户输入的文本
   * @returns AsyncGenerator，逐段产出 Agent 回复事件（结构化：thinking/recall/text/tool_start/tool_result/done）
   */
  /**
   * 流式对话（核心 API）
   *
   * @param input 用户输入文本
   * @param signal 可选的 AbortSignal，用于取消正在进行的对话（V-105）
   *   泊文等宿主 UI 传入 AbortController.signal，用户点击"取消"时触发 abort
   */
  async *chat(input: string, signal?: AbortSignal): AsyncGenerator<AgentChunk, void, unknown> {
    if (!this._initialized || !this.history || !this.loop || !this.topicMount) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 chat() 前调用 await agent.init()',
      ]);
    }

    // P3-9 修复：并发保护，防止同时发起多个 chat() 导致消息序列混乱
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

      // 专注模式：检测话题 → 召回话题记忆（"生其心"）
      yield { type: 'thinking', phase: 'recalling' };
      const topicMemories = await this.topicMount.focus(input);

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

      // Agent Loop 流式处理（注入话题记忆召回结果 + 中断信号）
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

      // 后处理阶段：归档 + 角色匹配 + 技能匹配
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

      // 实时信号检测：用户表达"自我介绍/偏好/决策/记住"等强信号
      // → 立即触发归档（fire-and-forget，不阻塞下一轮对话）
      // 详见 docs/基础设计文档/00-记忆归档原则-v1.0.md
      // archiveMode 控制：full → 自动归档；insights-only/manual → 跳过（宿主手动控制）
      if (this._archiveMode === 'full' && detectMemorableSignal(input)) {
        // 记录到 pendingArchives，让 Agent.close() 也能 await
        const p = this.history
          .archiveCurrentTopic('signal')
          .catch((_err): TopicSummarizerResult | null => null);
        this.history.registerPendingArchive(p);
      }

      // 记忆减法方案 v1.0 · 排雷修正 L5：N 轮后话题归档检查
      // 归档粒度改为"话题级检查归档"——每 archiveCheckRounds 轮检查一次，
      // 超长话题（>30 轮）中途也触发中间归档。
      // archiveCurrentTopic 内部有幂等保护（已有摘要则跳过），安全重复触发。
      // 翠幕天罗 P2-2 修复：周期性归档使用 'switch' 原因而非 'signal'
      // 'signal' 会绕过幂等检查强制重新调用 LLM，只应在 detectMemorableSignal 命中时使用
      // archiveMode 控制：full → 自动归档；insights-only/manual → 跳过
      this.roundCount++;
      this.totalTopicRounds++; // 不随周期性归档重置，用于中途归档触发
      if (this._archiveMode === 'full' && this.roundCount >= this.archiveCheckRounds) {
        logger.debug({ roundCount: this.roundCount }, '触发话题归档检查（记忆减法 · 窗口计数）');
        const p = this.history
          .archiveCurrentTopic('switch')
          .catch((_err): TopicSummarizerResult | null => null);
        this.history.registerPendingArchive(p);
        // 归档后重置轮次计数（从归档点重新计数）
        this.roundCount = 0;
      }

      // 排雷新增 P0-L1：超长话题中途归档（方向 A）
      // 修正：>= 30（非 > 30），首次触发在 30 轮
      // archiveMode 控制：full → 自动归档；insights-only/manual → 跳过
      if (
        this._archiveMode === 'full' &&
        this.totalTopicRounds >= Agent.MIDWAY_ARCHIVE_INTERVAL &&
        this.totalTopicRounds % 10 === 0
      ) {
        logger.debug(
          { totalRounds: this.totalTopicRounds },
          '触发中途归档（炼化管线减法 · 方向 A）',
        );
        const p = this.history
          .archiveCurrentTopic('midway')
          .catch((_err): TopicSummarizerResult | null => null);
        this.history.registerPendingArchive(p);
        // 不重置 roundCount（totalTopicRounds 继续累积，roundCount 继续自己的周期）
      }
    } finally {
      // P3-9 修复：无论 chat() 正常结束还是异常，都释放并发锁
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
   * 同时卸载话题记忆挂载器，让新话题的"生其心"从空灵中重新浮现。
   * 对应 CLI 的 /topic <name> 命令。
   *
   * 归档模式控制：
   * - 'full' → 自动归档旧话题
   * - 'insights-only' / 'manual' → 不自动归档，宿主必须先调用 archiveApprovedContent()
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

    // 归档模式控制：只有 full 模式自动归档旧话题
    // insights-only / manual 模式下，宿主必须先手动归档定稿内容
    if (this._archiveMode === 'full') {
      // 排雷修正 P1-L4：先等待旧话题归档，从结果取 snapshots
      // 顺序化流程：归档(await) → 写 seed_snapshots → unmount → switchTopic
      const result = await this.history.archiveCurrentTopic('switch');

      // 从归档结果中提取快照，写入旧话题的 seed_snapshots
      // 此时 this.currentTopic 仍为旧值（尚未切换），不会有 P1-L4 时序 bug
      if (result && result.snapshots.length > 0) {
        await this.history.setCurrentTopicSeedSnapshots(result.snapshots).catch(() => {
          /* 写入失败忽略，不阻塞切话题 */
        });
      }
    }

    // 卸载旧话题的记忆挂载，让新话题重新"生其心"
    this.topicMount?.unmount();
    // 重置轮次计数（新话题从 0 开始）
    this.roundCount = 0;
    this.totalTopicRounds = 0;
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
    return this.history.loadTopicMessages(date, topic);
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
   *   - dialogueSnapshot（对话快照提取器）
   *   - loop（AgentLoop + systemPromptPrefix）
   *   - topicMount（话题记忆挂载器）
   */
  private async _assembleComponents(pctx: ProjectContext): Promise<void> {
    const activeProvider = this._provider;
    if (!activeProvider) return;

    // 构造话题总结器（使用后台通道或当前激活的 Provider）
    const summarizer = createTopicSummarizer(this._backgroundProvider ?? activeProvider);

    // 消息历史（注入 MemoryIndex 让 archiveCurrentTopic 同步写 SQLite）
    this.history = new MessageHistory(pctx.topicStore, summarizer, undefined, 'main', pctx.index);

    // v4.0：作品投影管理器（注入 MemoryIndex + LlmProvider）
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

    // 排雷修正：对话快照已合并到 topic-summarizer 输出中
    // DialogueSnapshotExtractor 已删除，snapshots 从 archiveCurrentTopic('switch') R 中获取

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

    // 话题记忆挂载器（专注模式：应无所住，而生其心）
    const recallPipeline = new RecallPipeline(pctx.index);
    this.topicMount = new TopicMount(recallPipeline);
  }

  /**
   * 用当前 _pctx 重建 history / loop / topicMount
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
   * 后台 Provider 用于归档、投影等不需要用户等待的操作。
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
   * 对外暴露当前组件快照（供 REPL 等 CLI 宿主重建 history/loop 引用）
   *
   * 注意：此方法仅返回引用，调用方在重建 history/loop 后需重新调用
   * rebuildComponents() 才能拿到新对象。
   */
  getBuildCtx(): AgentBuildCtx | null {
    if (!this._pctx) return null;
    return {
      topicStore: this._pctx.topicStore,
      security: this._pctx.security,
      index: this._pctx.index,
      bootstrapMemories: this._pctx.bootstrapMemories,
    };
  }

  /**
   * 重建 history / loop / topicMount（项目切换后调用）
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
    // C4 修复：query 必须非空。空 query 会让 MemoryIndex.search() 退化为"返回所有"，
    // 对宿主程序是静默误导（以为是"无匹配"，实际是"全量"）。
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
    const hits = await this._ctx.index.search(query, limit);
    return hits.map((m: Memory) => ({
      name: m.name,
      type: m.type,
      weight: m.weight,
      // 截断长内容到 120 字符（与 repl.ts 旧实现一致）
      contentPreview: m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content,
    }));
  }

  /**
   * 新枝破土 N-101：记忆库统计
   *
   * 返回记忆类型分布、话题数量、数据库大小等关键指标，
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

    // 按永久性级别统计记忆数量
    const perms: PermanenceValue[] = [
      Permanence.ALWAYS,
      Permanence.DOMAIN,
      Permanence.TOPIC,
      Permanence.ON_DEMAND,
    ];
    const byType: Record<string, number> = {};
    for (const p of perms) {
      const memories = await this._ctx.index.getByPermanence(p);
      byType[p] = memories.length;
    }

    // 话题文件数量
    const topicFiles = await this._ctx.topicStore.list();
    const topicCount = topicFiles.length;

    // 总记忆数
    const total = Object.values(byType).reduce((a, b) => a + b, 0);

    return { byType, topicCount, total };
  }

  /**
   * 获取当前挂载记忆列表（新枝破土 N-102）
   *
   * 返回 TopicMount 中当前活跃的记忆，供 CLI /mounted 渲染面板。
   * 每个条目包含名称、类型、权重、预览，以及是否被踢出。
   *
   * @returns 记忆条目数组（空数组表示无挂载或未初始化）
   */
  getMountedMemories(): AgentMountedMemory[] {
    if (!this._initialized || !this._ctx || !this.topicMount) {
      return [];
    }
    const memories = this.topicMount.mounted;
    return memories.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      weight: m.weight,
      contentPreview: m.content.slice(0, 60) + (m.content.length > 60 ? '…' : ''),
      suppressed: this.topicMount!.isSuppressed(m.id),
      createdAt: m.createdAt,
    }));
  }

  /**
   * 踢出指定记忆（新枝破土 N-103）
   *
   * 从当前话题挂载中移除指定名称的记忆，并加入抑制集合。
   * 后续话题漂移重新挂载时也会自动过滤该记忆。
   * 抑制仅在本话题会话内有效。
   *
   * @param name - 记忆名称（模糊前缀匹配）
   * @returns 踢出结果：{ removed: true, name, id } 或 { removed: false, reason }
   */
  unmountMemory(name: string): { removed: boolean; name?: string; id?: string; reason?: string } {
    if (!this._initialized || !this._ctx || !this.topicMount) {
      return { removed: false, reason: 'Agent 未初始化，请先 /init' };
    }
    const lower = name.toLowerCase();
    const memories = this.topicMount.mounted;

    // 前缀模糊匹配
    let match = memories.find((m) => m.name.toLowerCase() === lower);
    if (!match) {
      match = memories.find((m) => m.name.toLowerCase().includes(lower));
    }

    if (!match) {
      return {
        removed: false,
        reason: `未找到匹配的记忆: "${name}"。当前挂载 ${memories.length} 条，输入 /mounted 查看`,
      };
    }

    const ok = this.topicMount.suppress(match.id);
    return ok
      ? { removed: true, name: match.name, id: match.id }
      : { removed: false, reason: `踢出失败: "${match.name}" 可能已被抑制` };
  }

  /**
   * 统一查看 4 层记忆快照
   *
   * 把 [00-记忆归档原则-v1.0.md §2.1 四层记忆模型](../../docs/基础设计文档/00-记忆归档原则-v1.0.md)
   * 描述的"作品 / 角色 / 心得 / 助手记忆"工程化为可观测的运行时结构。
   *
   * 当前实现：inspect() 返回的 4 层（工作记忆 / Bootstrap / 话题归档 / 话题挂载）
   * 是该哲学在工程上的当前映射——后续将随新四层（作品 / 角色 / 心得 / 助手记忆）
   * 在源码侧的落地逐步对齐。
   *
   * 设计原则：
   * - **纯只读**——不动任何组件状态
   * - **同步返回**——避免 4 层数据不一致（不调 LLM、不调 SQLite）
   * - **轻量**——每层只返回前 N 条 + 总数
   *
   * @returns 4 层记忆快照
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

    // 第 3 层：话题归档文件计数（启动时缓存，同步读取，无需再调 listAllTopics()）
    const archiveTotal = this._cachedTopicCount;

    // 第 4 层：话题挂载（TopicMount 缓存）
    const mountedFull = this.topicMount?.mounted ?? [];
    const mountedTotal = mountedFull.length;
    const mounted = mountedFull.slice(-MemoryInspector.MOUNTED_PREVIEW);

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
          type: m.type,
          permanence: m.permanence,
          name: m.name,
          contentPreview: m.content.slice(0, MemoryInspector.CONTENT_PREVIEW_LEN),
          weight: m.weight,
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
      mounted: {
        total: mountedTotal,
        isMounted: this.topicMount?.isMounted ?? false,
        items: mounted.map((m: Memory) => ({
          id: m.id,
          name: m.name,
          weight: m.weight,
          contentPreview: m.content.slice(0, MemoryInspector.CONTENT_PREVIEW_LEN),
        })),
      },
    };
  }

  /**
   * 关闭 Agent，释放 SQLite 连接等资源
   */
  async close(): Promise<void> {
    // 卸载话题记忆挂载器（sleep：回到"无所住"的清净状态）
    this.topicMount?.unmount();
    this.topicMount = null;

    // 等待所有 fire-and-forget 归档完成（signal / lazy / switch）
    if (this.history) {
      await this.history.awaitPendingArchives(5000);
    }

    if (this.projectManager) {
      await this.projectManager.shutdown();
    }
    this._initialized = false;
    // P2-7 修复：清理后台 Provider 缓存，防止 close() 后再 init() 复用失效实例
    this._backgroundProvider = null;
    // A7 修复：清理并发锁，防止 chat() 因异常未走 finally 时新 init 后被永久锁定
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

    // 根据建议类型映射到 MemoryType
    const typeMap: Record<ConfigSuggestion['type'], MemoryTypeValue> = {
      rule: MemoryType.RULE,
      persona: MemoryType.PERSONALITY,
      skill: MemoryType.SKILL,
    };
    const memoryType = typeMap[suggestion.type];

    // 构造记忆对象并写入配置文件（真理源）
    // 不写入 SQLite——遵守"配置文件是真理源"约束（接入指南 §九 第 7/10 条）
    // 下次启动时 MemoryLoader 自动扫描配置文件 → 加载到 SQLite
    const fileStore = new FileStore(this.configDir);
    const memory: Memory = {
      id: `${memoryType}:${suggestion.name}`,
      type: memoryType,
      permanence: suggestion.type === 'rule' ? 'always' : 'domain',
      name: suggestion.name,
      content: suggestion.content,
      tags: [suggestion.type, 'auto-refined', `confidence:${suggestion.confidence.toFixed(2)}`],
      weight: suggestion.confidence,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      filePath: '',
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
   * @param memory 规则记忆（必须 type='rule'，permanence ∈ {always, domain}）
   */
  async addRule(memory: Memory): Promise<void> {
    if (!this._initialized || !this._pctx) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 addRule() 前调用 await agent.init()',
      ]);
    }
    if (memory.type !== MemoryType.RULE) {
      throw configError('无效记忆类型', `addRule 只接受 type='rule'，收到 '${memory.type}'`, [
        '使用 MemoryType.RULE',
      ]);
    }
    if (memory.permanence !== 'always' && memory.permanence !== 'domain') {
      throw configError('无效永久性', `addRule 只接受 always/domain，收到 '${memory.permanence}'`, [
        '规则记忆的 permanence 应为 always 或 domain',
      ]);
    }

    await this._pctx.index.upsert(memory);

    if (this.loop) {
      const rulePrompt = `【项目规则】${memory.name}\n${memory.content}`;
      this.loop.injectSystemMessage(rulePrompt);
    }

    logger.info({ name: memory.name, permanence: memory.permanence }, '项目规则已注入');
  }

  /**
   * 新增项目规则的便捷方法（P1-4 修复）
   *
   * 宿主程序只需提供 name + content + permanence 三个业务字段，
   * 内部自动填充 id / type / createdAt / updatedAt / tags / weight 等字段。
   *
   * @param name 规则名称（如"代码风格"、"TypeScript 偏好"）
   * @param content 规则内容（Markdown 格式）
   * @param permanence 永久性级别：'always'（永驻）或 'domain'（领域级），默认 'domain'
   */
  async addSimpleRule(
    name: string,
    content: string,
    permanence: 'always' | 'domain' = 'domain',
  ): Promise<void> {
    const now = new Date().toISOString();
    const memory: Memory = {
      id: `rule:${name}`,
      type: MemoryType.RULE,
      permanence,
      name,
      content,
      tags: ['rule', 'runtime-injected'],
      weight: permanence === 'always' ? 1.0 : 0.8,
      createdAt: now,
      updatedAt: now,
      filePath: '',
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
   *   - memory.type 必须为 'skill'
   *   - memory.permanence 必须为 'domain'（技能通常是领域级）
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
    if (memory.type !== MemoryType.SKILL) {
      throw configError('无效记忆类型', `addSkill 只接受 type='skill'，收到 '${memory.type}'`, [
        '使用 MemoryType.SKILL 作为 type 字段',
      ]);
    }
    if (memory.permanence !== Permanence.DOMAIN) {
      throw configError(
        '无效永久性',
        `addSkill 只接受 permanence='domain'，收到 '${memory.permanence}'`,
        ['技能通常使用 domain 永久性（领域级，启动时加载）'],
      );
    }

    // 1. 委托给 SkillManager：负责注册到内存、构建关键词索引
    this.skillManager.register({
      name: memory.name,
      keywords: memory.tags.filter((t) => t !== 'skill' && t !== 'runtime-injected'),
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
   * 内部自动填充 id / type / createdAt / updatedAt / tags / weight。
   *
   * @param name 技能名称（如"代码审查"、"章节创作"）
   * @param content 技能内容（Markdown 格式）
   * @param keywords 触发关键词数组（AgentLoop 用关键词匹配调用时机）
   */
  async addSimpleSkill(name: string, content: string, keywords: string[] = []): Promise<void> {
    const now = new Date().toISOString();
    const memory: Memory = {
      id: `skill:${name}`,
      type: MemoryType.SKILL,
      permanence: Permanence.DOMAIN,
      name,
      content,
      tags: ['skill', 'runtime-injected', ...keywords],
      weight: 0.7,
      createdAt: now,
      updatedAt: now,
      filePath: '',
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
   * 等待所有 fire-and-forget 归档完成（测试 / 关键路径使用）
   *
   * 在以下场景必须调用：
   * - 单元测试中，希望在查询 SQLite 前确保所有归档已写入
   * - 关键业务路径，希望确保 signal/lazy 归档已生效后再继续
   *
   * 内部已通过 Agent.close() 兜底，此方法主要供主动控制使用。
   *
   * @param timeoutMs 超时（默认 5000ms）
   * @returns 是否所有归档都完成
   */
  async waitForArchives(timeoutMs = 5000): Promise<boolean> {
    if (!this.history) return true;
    return this.history.awaitPendingArchives(timeoutMs);
  }

  // ─── 归档模式 API ─────────────────────────────────────

  /**
   * 设置归档模式
   *
   * 可在运行时动态切换，例如：
   * - 进入草稿模式时设为 'insights-only'
   * - 审核通过后切回 'full'
   *
   * @param mode 归档模式
   */
  setArchiveMode(mode: ArchiveMode): void {
    this._archiveMode = mode;
    logger.info({ archiveMode: mode }, '归档模式已切换');
  }

  /**
   * 获取当前归档模式
   */
  getArchiveMode(): ArchiveMode {
    return this._archiveMode;
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
   * 归档已审核通过的内容（insights-only / manual 模式下的手动归档入口）
   *
   * 典型场景：小说写作中，草稿阶段 archiveMode='insights-only'，
   * 审核通过后调用此方法将定稿内容归档到记忆系统。
   *
   * 工作流：
   *   1. setArchiveMode('insights-only')  — 进入草稿模式
   *   2. chat() 多轮迭代                    — 用户洞察自动归档，内容不归档
   *   3. archiveApprovedContent()           — 审核通过，归档定稿内容
   *   4. switchTopic('下一章')              — 切换到下一章
   *
   * 内部调用 history.archiveCurrentTopic('signal')，
   * 'signal' 模式会强制重新归档（覆盖之前的摘要，如果有的话）。
   *
   * @param content 可选，定稿内容摘要（如果提供，会先追加到历史再归档）
   * @returns 归档结果，null 表示归档失败或无可归档内容
   */
  async archiveApprovedContent(content?: string): Promise<TopicSummarizerResult | null> {
    if (!this._initialized || !this.history) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 archiveApprovedContent() 前调用 await agent.init()',
      ]);
    }

    // 如果宿主提供了定稿内容，先追加到历史（作为本轮的"最终版本"）
    if (content && content.trim()) {
      await this.history.appendAssistant(`【定稿】\n${content}`);
    }

    // 使用 'signal' 原因强制归档（确保覆盖之前的摘要）
    const result = await this.history.archiveCurrentTopic('signal');

    if (result) {
      logger.info(
        { topic: this.history.currentTopicName, hasSnapshots: result.snapshots.length > 0 },
        '定稿内容已归档',
      );
    }

    return result;
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
    const messages: Message[] = topicMessages.map((tm) => ({
      role: tm.role,
      content: tm.content,
    }));

    // 恢复到 AgentLoop
    this.loop.restoreHistory(messages);

    // 同时，我们需要让 TopicMount 也能召回这个话题的记忆
    // 如果话题没有归档过（没有 summary），我们需要把整个话题内容写入索引
    await this.ensureTopicInIndex(topicMessages);

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

    // 从话题文件加载历史消息
    const topicMessages = await this.history.loadTopicMessages(date, topic);
    if (topicMessages.length === 0) {
      return 0;
    }

    // 转换 TopicMessage[] 为 Message[]
    const messages: Message[] = topicMessages.map((tm) => ({
      role: tm.role,
      content: tm.content,
    }));

    // 恢复到 AgentLoop
    this.loop.restoreHistory(messages);

    // 确保话题在索引中
    await this.ensureTopicInIndex(topicMessages);

    return topicMessages.length;
  }

  /**
   * 确保话题内容在索引中（即使没有归档 summary）
   * 如果话题还没有索引记录，就把完整对话内容作为摘要写入索引
   * 这样 TopicMount.focus() 就能跨会话召回了
   */
  private async ensureTopicInIndex(topicMessages: readonly TopicMessage[]): Promise<void> {
    if (!this.history || !this._pctx) return;

    const index = this._pctx.index;
    // 通过 MessageHistory 的只读访问器获取（不破坏封装）
    const date = this.history.currentDateValue;
    const topic = this.history.currentTopicValue;
    const id = `topic-${date}-${topic}`;

    // 检查是否已在索引中
    const existing = await index.getById(id);
    if (existing && existing.content) {
      return; // 已有归档，不需要重复
    }

    // 把完整对话拼接成一个摘要（前 2000 字符）
    const fullContent = topicMessages
      .map((m) => `[${m.role}] ${m.content}`)
      .join('\n\n')
      .slice(0, 2000);

    const now = new Date().toISOString();
    const memory: Memory = {
      id,
      type: MemoryType.TOPIC,
      permanence: Permanence.TOPIC,
      name: `${date} ${topic}`,
      content: fullContent,
      tags: ['restored', `messages:${topicMessages.length}`],
      weight: 0.7,
      createdAt: now,
      updatedAt: now,
    };

    await index.upsert(memory);
    logger.info({ date, topic, messageCount: topicMessages.length }, '话题已写入索引');
  }

  /**
   * 刷新缓存的归档话题文件数（异步，供 inspect() 同步读取）
   *
   * 在 init() 和 close() 时调用，确保 inspect() 返回的 archive.topicFilesCount
   * 是接近实时的数值。调用失败不抛异常，不影响核心流程。
   */
  private async _refreshTopicCount(): Promise<void> {
    try {
      if (this.history) {
        const topics = await this.history.listAllTopics();
        this._cachedTopicCount = topics.length;
      }
    } catch {
      // 静默失败，inspect() 将回退显示上次缓存的值
    }
  }
}
