/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 设计文档（agent设计.md §9）要求宿主项目通过 `import { Agent } from '@memora/core'`
 * 一行代码接入。本类把当前 repl.ts 中埋藏的组装逻辑提取到正确的架构层，
 * 使 AgentLoop / MemoryIndex / DomainManager / ToolExecutor / SecurityGuard
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
import { createLlmProvider } from '@/llm/factory.js';
import { AgentLoop } from './loop.js';
import { ToolExecutor } from './tool-executor.js';
import { MessageHistory } from './message-history.js';
import { ProjectManager, type ProjectContext } from '@/memory/project-manager.js';
import { createTopicSummarizer } from './topic-summarizer.js';
import { RecallPipeline } from '@/memory/recall.js';
import { TopicMount } from '@/memory/topic-mount.js';
import { configError } from '@/utils/errors.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory, TopicMessage } from '@/memory/types.js';
import { MemoryType, Permanence } from '@/memory/types.js';
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
 * 详见 docs/基础设计文档/记忆系统全景图.md §二
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
  private configDir: string | undefined; // 配置目录（personality/rules/skills/tools）

  // 运行时组件（init 后填充）
  private projectManager: ProjectManager | null = null;
  private provider: LlmProvider | null = null;
  private history: MessageHistory | null = null;
  private loop: AgentLoop | null = null;
  private topicMount: TopicMount | null = null; // 话题记忆挂载器（专注模式）

  // 上下文（init 后填充）
  private _ctx: AgentContext | null = null;
  private _initialized = false;
  // 项目上下文（init / switchProject 后更新），持有 domainManager 等引用
  private _pctx: ProjectContext | null = null;
  // 当前领域名（switchDomain 后更新），独立于 _pctx 避免类型提升麻烦
  private _currentDomain: string = 'default';

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

    // 创建 LLM Provider
    this.provider = createLlmProvider(this.config);

    // 构造话题总结器（逻辑与 repl.ts 中的 createTopicSummarizer 一致）
    const summarizer = createTopicSummarizer(this.provider);

    // 组装消息历史（注入 MemoryIndex 让 archiveCurrentTopic 同步写 SQLite）
    this.history = new MessageHistory(pctx.topicStore, summarizer, undefined, 'main', pctx.index);

    // 组装工具执行器（不含 CLI 可视化包装）
    const toolExec = new ToolExecutor(this.projectPath, pctx.security, pctx.index);

    // 组装 Agent Loop
    this.loop = new AgentLoop({
      provider: this.provider,
      bootstrapMemories: pctx.bootstrapMemories,
      // 直接用 ToolExecutor.execute，不加 CLI 包装
      toolExecutor: (name: string, args: string) => toolExec.execute(name, args),
    });

    // 创建话题记忆挂载器（专注模式：应无所住，而生其心）
    // 阶段一不使用向量检索（VectorStore 为 undefined），纯关键词召回
    const recallPipeline = new RecallPipeline(pctx.index);
    this.topicMount = new TopicMount(recallPipeline);

    // 保存完整项目上下文（保留 domainManager / globalMemories / projectName 等所有字段）
    this._pctx = pctx;
    this._ctx = pctx;
    this._initialized = true;

    // 启动时 Lazy 扫描：兜底历史话题归档
    // 解决"用户在 main 话题聊 50 轮不切换 → 永远没归档过"的问题
    // fire-and-forget，单 topic 3s 超时（符合 architecture_philosophy §7 P3）
    this.history.archiveMissingTopics(3000).catch((err) => {
      // 已经在 MessageHistory 内部 log.warn，这里防止 unhandled rejection
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
   * @returns AsyncGenerator，逐段产出 Agent 回复文本
   */
  async *chat(input: string): AsyncGenerator<string, void, unknown> {
    if (!this._initialized || !this.history || !this.loop || !this.topicMount) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 chat() 前调用 await agent.init()',
      ]);
    }

    // 专注模式：检测话题 → 召回话题记忆（"生其心"）
    const topicMemories = await this.topicMount.focus(input);

    // 用户消息写入历史
    await this.history.appendUser(input);

    // Agent Loop 流式处理（注入话题记忆召回结果）
    let assistantContent = '';
    for await (const chunk of this.loop.processUserInput(input, topicMemories)) {
      yield chunk;
      assistantContent += chunk;
    }

    // Agent 回复写入历史
    await this.history.appendAssistant(assistantContent);

    // 实时信号检测：用户表达"自我介绍/偏好/决策/记住"等强信号
    // → 立即触发归档（fire-and-forget，不阻塞下一轮对话）
    // 详见 docs/基础设计文档/记忆归档原则.md
    if (detectMemorableSignal(input)) {
      // 记录到 pendingArchives，让 Agent.close() 也能 await
      const p = this.history.archiveCurrentTopic('signal').catch((err) => {
        // 归档失败已经在 MessageHistory 内部 log.warn，这里静默
        // （防止 unhandled rejection）
        void err;
      });
      this.history.registerPendingArchive(p);
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
      result += chunk;
    }
    return result;
  }

  /**
   * 切换当前话题
   *
   * 切换前自动为旧话题生成摘要归档（fire-and-forget，不阻塞切换）。
   * 同时卸载话题记忆挂载器，让新话题的"生其心"从空灵中重新浮现。
   * 对应 CLI 的 /topic <name> 命令。
   *
   * @param newTopic - 新话题名称
   * @returns 新话题的全名（格式：日期-话题名）
   */
  switchTopic(newTopic: string): string {
    if (!this._initialized || !this.history) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 switchTopic() 前调用 await agent.init()',
      ]);
    }
    // 卸载旧话题的记忆挂载，让新话题重新"生其心"
    this.topicMount?.unmount();
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
    if (!this._initialized || !this.projectManager || !this.provider) {
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
    this._rebuildComponentsWithCurrentCtx();

    return newPctx;
  }

  /**
   * 切换到指定领域
   *
   * 加载领域专属的 rules/skills/tools → 重建 history/loop
   * 对应 CLI 的 /domain <name> 命令
   *
   * @param name - 领域名称
   * @returns 新领域的完整上下文
   */
  async switchDomain(name: string): Promise<AgentContext> {
    if (!this._initialized || !this._pctx || !this.provider) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 switchDomain() 前调用 await agent.init()',
      ]);
    }

    // 校验领域存在
    const available = this._pctx.domainManager.listDomains();
    if (!available.includes(name)) {
      throw configError('领域不存在', `找不到领域：${name}`, [
        `可用领域：${available.join(', ') || '仅默认'}`,
      ]);
    }

    // 切换领域（DomainManager 内部已关闭旧 SQLite + 加载新领域）
    const dctx = await this._pctx.domainManager.switchDomain(name);

    // 把 DomainContext 字段合并到 ProjectContext
    // （保留 projectPath / projectName / globalMemories / domainManager 不变）
    this._pctx = {
      ...this._pctx,
      memoraDir: dctx.memoraDir,
      fileStore: dctx.fileStore,
      index: dctx.index,
      topicStore: dctx.topicStore,
      security: dctx.security,
      bootstrapMemories: dctx.bootstrapMemories,
      loadResult: dctx.loadResult,
    };
    this._ctx = this._pctx;
    this._currentDomain = name;
    this._rebuildComponentsWithCurrentCtx();

    return this._pctx;
  }

  /**
   * 用当前 _pctx 重建 history / loop / topicMount
   * 在 switchProject / switchDomain / init 中复用
   */
  private _rebuildComponentsWithCurrentCtx(): void {
    if (!this._pctx || !this.provider) return;
    const summarizer = createTopicSummarizer(this.provider);
    // 注入 MemoryIndex 让 archiveCurrentTopic 同步写 SQLite
    this.history = new MessageHistory(
      this._pctx.topicStore,
      summarizer,
      undefined,
      'main',
      this._pctx.index,
    );
    const toolExec = new ToolExecutor(this.projectPath, this._pctx.security, this._pctx.index);
    this.loop = new AgentLoop({
      provider: this.provider,
      bootstrapMemories: this._pctx.bootstrapMemories,
      toolExecutor: (n: string, args: string) => toolExec.execute(n, args),
    });
    const recallPipeline = new RecallPipeline(this._pctx.index);
    this.topicMount = new TopicMount(recallPipeline);
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
   * 重建 history / loop / topicMount（项目/领域切换后调用）
   *
   * 公开为公共方法供宿主项目触发——CLI 在 /project、/domain 命令后调用。
   * 内部实现复用 _rebuildComponentsWithCurrentCtx()。
   */
  rebuildComponents(): void {
    this._rebuildComponentsWithCurrentCtx();
  }

  /**
   * 列出可用领域
   *
   * 对应 CLI 的 /domain 命令（无参数时显示领域列表）
   */
  listDomains(): string[] {
    if (!this._initialized || !this._pctx) {
      throw configError('Agent 未初始化', '请先调用 init()', [
        '在 listDomains() 前调用 await agent.init()',
      ]);
    }
    return this._pctx.domainManager.listDomains();
  }

  /**
   * 当前领域名（init 后默认 'default'，switchDomain 后更新）
   *
   * 对应 CLI 的 /domain 命令（无参数时显示当前领域）
   */
  get currentDomainName(): string {
    return this._currentDomain;
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
   * 统一查看 4 层记忆快照
   *
   * 把 [记忆系统全景图.md §二](../../docs/基础设计文档/记忆系统全景图.md) 描述的
   * 4 层记忆结构（工作记忆 / Bootstrap / 话题归档 / 话题挂载）
   * 用一个同步快照暴露给调用方（CLI、demo UI、测试、调试）。
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
    // 防止 SQLITE_MISUSE：归档还在写时 db 已被 close
    // 5s 超时（兜底，正常情况 < 1s 完成）
    if (this.history) {
      await this.history.awaitPendingArchives(5000);
    }

    if (this.projectManager) {
      await this.projectManager.closeProject();
    }
    this._initialized = false;
    this.provider = null;
    this.history = null;
    this.loop = null;
    this.projectManager = null;
    this._ctx = null;
    this._pctx = null;
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
    const date = this.history['currentDate'] as string;
    const topic = this.history['currentTopic'] as string;
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
