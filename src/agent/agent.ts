/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 设计文档（01-主架构-v4.0.md §9）要求宿主项目通过 `import { Agent } from '@memora/core'`
 * 一行代码接入。本类把当前 repl.ts 中埋藏的组装逻辑提取到正确的架构层，
 * 使 AgentLoop / MemoryIndex / ToolExecutor / SecurityGuard
 * 这些已有组件可以被 CLI 以外的宿主项目直接使用。
 *
 * 使用方式（最简）：
 *   const agent = new Agent({ projectPath: './my-project' });
 *   await agent.init();
 *   for await (const chunk of agent.chat('你好')) { process.stdout.write(chunk); }
 *   await agent.close();
 *
 * 使用方式（高级）：
 *   const agent = new Agent({ config: myConfig, configDir: './agent-config', projectPath: './my-project' });
 *
 * 专注模式（应无所住，而生其心）：
 *   Agent 启动时只加载 always + domain 记忆（无所住），
 *   用户一开口，TopicMount 自动召回话题记忆注入上下文（生其心）。
 *   同话题内缓存召回结果，鼓励深度专注。
 */
import { loadConfig, type Config } from '@/config/loader.js';
import { createLlmProvider, createProviderFromConfig, type ProviderConfig } from '@/llm/factory.js';
import { AgentLoop } from './loop.js';
import type { AgentChunk } from './types.js';
import { ToolExecutor, type ToolDefinition, type ToolHandler } from './tool-executor.js';
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
import type { MemoryIndex } from '@/memory/index.js';
import type { TopicStore } from '@/memory/topic-store.js';
import type { SecurityGuard } from '@/security/path-guard.js';
import { detectMemorableSignal } from './signal-detector.js';
import { logger } from '@/logging/logger.js';

// ─── 类型定义 ───────────────────────────────────────────

/** Agent 构造选项 */
export interface AgentOptions {
  /** 项目路径（必须） */
  projectPath: string;
  /** 配置对象（可选，优先于 configPath） */
  config?: Config;
  /** 配置文件路径（可选，与 config 二选一） */
  configPath?: string;
  /** 配置目录（可选，分离配置与运行时数据） */
  configDir?: string;
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
  type: 'rule' | 'identity' | 'skill';
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
  index: MemoryIndex;
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
  private config: Config | null = null; // init 时延迟加载
  private configPath: string | undefined;
  private projectPath: string;
  private configDir: string | undefined; // 配置目录（identities/rules/skills/tools）

  // 运行时组件（init 后填充）
  private projectManager: ProjectManager | null = null;
  /** v1.2：多 Provider 映射表（key 为别名，如 "deepseek"、"openai"） */
  private providers: Map<string, LlmProvider> = new Map();
  /** v1.2：当前激活的 Provider 别名 */
  private activeProviderName: string | null = null;
  /** v1.2：后台通道 Provider 缓存（避免每次调用 getBackgroundProvider 重建实例） */
  private _backgroundProvider: LlmProvider | null = null;
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

  constructor(opts: AgentOptions) {
    // config 和 configPath 二选一，config 优先
    if (opts.config) {
      this.config = opts.config;
    }
    this.configPath = opts.configPath;
    this.projectPath = opts.projectPath;
    this.configDir = opts.configDir;
  }

  // ─── 生命周期 ─────────────────────────────────────────

  /**
   * 初始化 Agent：创建 LLM Provider、加载索引、组装内部组件
   *
   * 对应 repl.ts 中 rebuildAgentComponents() 的逻辑，
   * 但去掉了 CLI 特有的可视化包装。
   *
   * @param configOverride - 可选，运行时覆盖构造器 config（用于热重载/多项目切换）
   * @returns ProjectContext — 完整项目上下文，宿主项目可据此访问内部组件
   */
  async init(projectPathOverride?: string, configOverride?: Config): Promise<ProjectContext> {
    // 允许运行时覆盖（用于 switchProject 时的二次 init）
    if (projectPathOverride) {
      this.projectPath = projectPathOverride;
    }
    if (configOverride) {
      this.config = configOverride;
    }

    // 确保 config 已加载（构造时未提供则自动加载）
    if (!this.config) {
      this.config = await loadConfig(this.configPath);
    }

    // 创建 ProjectManager（延迟到 init 以确保 config 正确）
    this.projectManager = new ProjectManager(this.config);

    // 初始化项目上下文（加载 .memora/ 下的记忆索引）
    // 传递 configDir 以分离配置目录与运行时数据目录
    const pctx = await this.projectManager.initProject(this.projectPath, undefined, this.configDir);

    // v1.2：创建多 Provider 映射表
    this._initProviders();

    // 组装所有运行时组件（v4.0：包括 persona/skill/userProfile/workProjection）
    await this._assembleComponents(pctx);

    // 保存完整项目上下文（保留 globalMemories / projectName 等所有字段）
    this._pctx = pctx;
    this._ctx = pctx;
    this._initialized = true;

    // 启动时 Lazy 扫描：兜底历史话题归档
    this.history!.archiveMissingTopics(3000).catch((err) => {
      void err;
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
  async *chat(input: string): AsyncGenerator<AgentChunk, void, unknown> {
    if (!this._initialized || !this.history || !this.loop || !this.topicMount) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 chat() 前调用 await agent.init()',
      ]);
    }

    // 专注模式：检测话题 → 召回话题记忆（"生其心"）
    yield { type: 'thinking', phase: 'recalling' };
    const topicMemories = await this.topicMount.focus(input);

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

    // Agent Loop 流式处理（注入话题记忆召回结果）
    let assistantContent = '';
    for await (const chunk of this.loop.processUserInput(input, topicMemories)) {
      yield chunk; // 透传结构化事件给上层
      if (chunk.type === 'text') {
        assistantContent += chunk.content;
      }
    }

    // Agent 回复写入历史
    await this.history.appendAssistant(assistantContent);

    // 后处理阶段：归档 + 身份匹配 + 技能匹配
    yield { type: 'thinking', phase: 'archiving' };

    // v4.0：用户画像实时归档（每轮结束后扫描用户输入中的身份/偏好/专长事实）
    // 高置信度直接归档，低置信度标记待确认
    if (this.userProfile) {
      const turnIndex = `turn-${Date.now()}`;
      this.userProfile.archive(input, turnIndex).catch((err) => {
        logger.warn({ err }, '用户画像实时归档失败');
      });
    }

    // v1.1：身份自动匹配（P-602 · L4 修正：阈值 ≥0.5 + 独立于技能匹配）
    if (this.personaManager) {
      const matchedPersona = this.personaManager.autoMatch(input);
      if (matchedPersona) {
        this.personaManager.switchPersona(matchedPersona);
        if (this.loop) {
          // 重建完整前缀（身份 prompt + 用户画像）
          const profilePrompt = this.userProfile?.buildSystemPrompt() ?? '';
          const personaPrompt = this.personaManager.buildSystemPrompt();
          const newPrefix =
            [personaPrompt, profilePrompt].filter(Boolean).join('\n\n') +
            ([personaPrompt, profilePrompt].some(Boolean) ? '\n\n---\n\n' : '');
          this.loop.refreshPersonaPrefix(newPrefix);
        }
        logger.info({ persona: matchedPersona }, '身份自动切换');
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
    if (detectMemorableSignal(input)) {
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
    this.roundCount++;
    this.totalTopicRounds++; // 不随周期性归档重置，用于中途归档触发
    if (this.roundCount >= this.archiveCheckRounds) {
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
    if (
      this.totalTopicRounds >= Agent.MIDWAY_ARCHIVE_INTERVAL &&
      this.totalTopicRounds % 10 === 0
    ) {
      logger.debug({ totalRounds: this.totalTopicRounds }, '触发中途归档（炼化管线减法 · 方向 A）');
      const p = this.history
        .archiveCurrentTopic('midway')
        .catch((_err): TopicSummarizerResult | null => null);
      this.history.registerPendingArchive(p);
      // 不重置 roundCount（totalTopicRounds 继续累积，roundCount 继续自己的周期）
    }
  }

  /**
   * 发送用户消息，非流式返回完整回复
   *
   * 便捷方法：内部调用 chat() 流式方法，收集所有 chunk 后一次性返回。
   * 适用于不需要流式输出的场景（如测试、批处理、API 响应）。
   *
   * @param input - 用户输入的文本
   * @returns 完整的 Agent 回复文本
   */
  async chatSync(input: string): Promise<string> {
    let result = '';
    for await (const chunk of this.chat(input)) {
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
   * @param newTopic - 新话题名称
   * @returns 新话题的全名（格式：日期-话题名）
   */
  async switchTopic(newTopic: string): Promise<string> {
    if (!this._initialized || !this.history) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 switchTopic() 前调用 await agent.init()',
      ]);
    }

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
    if (!this._initialized || !this.projectManager || this.providers.size === 0) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 switchProject() 前调用 await agent.init()',
      ]);
    }

    const projects = this.projectManager.listProjects();
    const target = projects.find((p) => p.name === nameOrPath || p.path === nameOrPath);
    if (!target) {
      throw configError('项目不存在', `找不到项目：${nameOrPath}`, [
        '使用 listProjects() 查看已注册项目',
        '使用 /project 命令查看列表',
      ]);
    }

    // 重新初始化项目（ProjectManager.initProject 内部会先 closeProject）
    const newPctx = await this.projectManager.initProject(target.path, target.name, this.configDir);

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
    const activeProvider = this.activeProvider;
    if (!activeProvider) return;

    // 构造话题总结器（使用后台通道或当前激活的 Provider）
    const summarizer = createTopicSummarizer(this.getBackgroundProvider() ?? activeProvider);

    // 消息历史（注入 MemoryIndex 让 archiveCurrentTopic 同步写 SQLite）
    this.history = new MessageHistory(pctx.topicStore, summarizer, undefined, 'main', pctx.index);

    // v4.0：作品投影管理器（注入 MemoryIndex + LlmProvider）
    this.workProjection = new WorkProjectionManager(
      pctx.index,
      this.getBackgroundProvider() ?? activeProvider,
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

    // v4.0：角色管理器（v1.1：identities/ 目录 + SQLite 存储 + 关键词匹配）
    this.personaManager = new PersonaManager(this.configDir, undefined, pctx.index);
    const personaPrompt = await this.personaManager.load(this.config?.persona);

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

    // Agent Loop（v4.0：注入系统 prompt 前缀 + 工具定义）
    this.loop = new AgentLoop({
      provider: activeProvider,
      bootstrapMemories: pctx.bootstrapMemories,
      toolExecutor: (name: string, args: string) => toolExec.execute(name, args),
      systemPromptPrefix,
      toolDefinitions: toolExec.getToolDefinitions(),
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
    if (!this._pctx || !this.providers) return;
    await this._assembleComponents(this._pctx);
  }

  // ─── v1.2：多 Provider 管理 ────────────────────────────

  /**
   * 初始化 Provider 映射表
   *
   * 从配置中读取 providers 映射表（新格式）或创建单 Provider（旧格式）。
   * 创建失败时记录错误但不中断启动——后续 chat() 调用会报错。
   */
  private _initProviders(): void {
    if (!this.config) return;
    const { llm } = this.config;

    // 新格式：多 Provider 映射表
    if (llm.providers && Object.keys(llm.providers).length > 0) {
      for (const [name, providerConfig] of Object.entries(llm.providers)) {
        try {
          const provider = createProviderFromConfig(name, providerConfig);
          this.providers.set(name, provider);
        } catch (err) {
          logger.warn({ err, name }, `Provider "${name}" 创建失败，已跳过`);
        }
      }

      // 设置激活的 Provider
      const active = llm.active ?? this.providers.keys().next().value ?? null;
      if (active && this.providers.has(active)) {
        this.activeProviderName = active;
        logger.info({ active, total: this.providers.size }, '多 Provider 已就绪');
      } else {
        logger.warn({ active, available: [...this.providers.keys()] }, 'active Provider 无效');
      }
      return;
    }

    // 旧格式：单 Provider（向后兼容）
    try {
      const provider = createLlmProvider(this.config);
      this.providers.set('default', provider);
      this.activeProviderName = 'default';
    } catch (err) {
      logger.warn({ err }, '默认 Provider 创建失败');
    }
  }

  /**
   * 当前激活的 LlmProvider 实例
   */
  private get activeProvider(): LlmProvider | null {
    if (!this.activeProviderName) return null;
    return this.providers.get(this.activeProviderName) ?? null;
  }

  /**
   * 获取后台通道 Provider（用于归档/投影等后台操作）
   *
   * 如果配置了 llm.background，使用后台 Provider；
   * 否则回退到当前激活的 Provider（零破坏性，完全向后兼容）。
   * 结果缓存，避免每次调用重建实例。
   */
  private getBackgroundProvider(): LlmProvider | null {
    if (!this.config) return null;
    const bg = this.config.llm.background;
    if (!bg) return null;

    // 缓存后台 Provider 实例
    if (!this._backgroundProvider) {
      try {
        this._backgroundProvider = createProviderFromConfig('background', bg);
      } catch {
        return null;
      }
    }
    return this._backgroundProvider;
  }

  /**
   * 列出所有已注册的 Provider 别名
   *
   * @returns Provider 别名数组，当前激活的排第一
   */
  listProviders(): string[] {
    const names = [...this.providers.keys()];
    if (this.activeProviderName && names.includes(this.activeProviderName)) {
      // 把激活的移到第一位
      const idx = names.indexOf(this.activeProviderName);
      names.splice(idx, 1);
      names.unshift(this.activeProviderName);
    }
    return names;
  }

  /**
   * 获取当前激活的 Provider 名称
   */
  getActiveProviderName(): string | null {
    return this.activeProviderName;
  }

  /**
   * 切换当前激活的 Provider
   *
   * 切换后更新 AgentLoop 的 provider 引用，后续 chat() 调用使用新 Provider。
   *
   * @param name - Provider 别名
   * @throws 如果 Provider 不存在
   */
  switchProvider(name: string): void {
    if (!this.providers.has(name)) {
      const available = [...this.providers.keys()].join(', ');
      throw configError('Provider 不存在', `"${name}" 不在已注册的 Provider 列表中`, [
        `可用的 Provider：${available || '(无)'}`,
        '使用 listProviders() 查看可用 Provider',
        '使用 `memora config llm add` 添加新 Provider',
      ]);
    }

    this.activeProviderName = name;
    const provider = this.providers.get(name)!;

    // 更新 AgentLoop 的 provider 引用
    if (this.loop) {
      this.loop.setProvider(provider);
    }

    logger.info({ provider: name }, '已切换 Provider');
  }

  /**
   * 添加新的 Provider（运行时动态添加，不写入配置文件）
   *
   * 用于宿主项目在运行时动态注册新 Provider。
   * 如需持久化到配置文件，请使用 `memora config llm add` CLI 命令。
   *
   * 注意：配置文件是真理源（project-rules §1.6）。
   * 运行时添加的 Provider 在 Agent 重启后不会保留，
   * 除非通过 CLI 命令写入配置文件。
   *
   * @param name - Provider 别名
   * @param config - Provider 配置
   */
  addProvider(name: string, config: ProviderConfig): void {
    if (this.providers.has(name)) {
      throw configError('Provider 已存在', `"${name}" 已注册，请使用其他名称`, [
        '使用 switchProvider() 切换到已有 Provider',
        '使用 listProviders() 查看可用 Provider',
      ]);
    }

    const provider = createProviderFromConfig(name, config);
    this.providers.set(name, provider);

    // 如果这是第一个 Provider，自动激活
    if (!this.activeProviderName) {
      this.activeProviderName = name;
      if (this.loop) {
        this.loop.setProvider(provider);
      }
    }

    logger.info({ name, type: config.provider }, '已添加 Provider');
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

    // 第 3 层：话题归档文件计数（通过 history 的 listAllTopics 暴露）
    // 注意：listAllTopics 是异步的，但 inspect 是同步的。
    // 这里只取"已加载的缓存"——真实文件数用 listAllTopics() 异步获取。
    const archiveTotal = 0; // 同步快照中文件数 = 0，hint 引导调 listAllTopics()

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
    // v1.2：清理 Provider 映射表
    this.providers.clear();
    this.activeProviderName = null;
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
    return this.toolExec.execute(name, argsJson);
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
      identity: MemoryType.PERSONALITY,
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

  // ─── 身份管理 API（P-605 · v1.1）────────────────────

  /**
   * 手动切换身份
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
    logger.info({ persona: name }, '身份手动切换');
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
   * 设置身份激活模式
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
   * 获取当前激活的身份名称
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
   * v1.2：当前激活的 LlmProvider 实例（只读）
   *
   * 供宿主项目（如 REPL）在需要创建依赖 Provider 的组件时使用。
   * 不暴露 providers Map 本身——切换/添加/列出都通过专用 API。
   */
  get currentProvider(): LlmProvider | null {
    return this.activeProvider;
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
   */
  getMessages(): readonly Message[] {
    if (!this._initialized) {
      throw new Error('Agent 未初始化，请先调用 init()');
    }
    return this.loop?.getMessages() ?? [];
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
}
