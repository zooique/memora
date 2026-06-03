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
import { ProjectManager } from '@/memory/project-manager.js';
import { createTopicSummarizer } from './topic-summarizer.js';
import { RecallPipeline } from '@/memory/recall.js';
import { TopicMount } from '@/memory/topic-mount.js';
import type { LlmProvider } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { MemoryIndex } from '@/memory/index.js';
import type { TopicStore } from '@/memory/topic-store.js';
import type { SecurityGuard } from '@/security/path-guard.js';

// ─── 类型定义 ───────────────────────────────────────────

/** Agent 构造选项 */
export interface AgentOptions {
  /**
   * Memora 配置对象（由 loadConfig() 产生），可选
   * 不传时 Agent 内部自动加载默认配置
   * 高级用户可传入自定义 Config 以获得完整控制
   */
  config?: Config;
  /**
   * 配置文件路径，可选
   * 与 config 二选一：两者都提供时，config 优先
   */
  configPath?: string;
  /** 宿主项目根目录的绝对路径 */
  projectPath: string;
  /**
   * 配置目录路径（personality.md / rules/ / skills/ / tools/），可选
   * 默认使用 projectPath + '.memora/'（与运行时数据同目录）
   * 建议设为 './agent-config/' 以分离配置与运行时数据
   */
  configDir?: string;
}

/** Agent 初始化后暴露的运行时上下文 */
export interface AgentContext {
  /** .memora/ 目录的绝对路径 */
  memoraDir: string;
  /** 启动时加载的必召记忆（全局规则 + 项目规则） */
  bootstrapMemories: Memory[];
  /** SQLite 全文索引 */
  index: MemoryIndex;
  /** 话题存储 */
  topicStore: TopicStore;
  /** 安全守卫 */
  security: SecurityGuard;
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
   * @returns AgentContext — 宿主项目可据此访问内部组件
   */
  async init(): Promise<AgentContext> {
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

    // 组装消息历史
    this.history = new MessageHistory(pctx.topicStore, summarizer);

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

    // 保存上下文
    this._ctx = {
      memoraDir: pctx.memoraDir,
      bootstrapMemories: pctx.bootstrapMemories,
      index: pctx.index,
      topicStore: pctx.topicStore,
      security: pctx.security,
    };

    this._initialized = true;
    return this._ctx;
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
      throw new Error('Agent 未初始化，请先调用 init()');
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
      throw new Error('Agent 未初始化，请先调用 init()');
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
      throw new Error('Agent 未初始化，请先调用 init()');
    }
    return this.history.listAllTopics();
  }

  /**
   * 关闭 Agent，释放 SQLite 连接等资源
   */
  async close(): Promise<void> {
    // 卸载话题记忆挂载器（sleep：回到"无所住"的清净状态）
    this.topicMount?.unmount();
    this.topicMount = null;

    if (this.projectManager) {
      await this.projectManager.closeProject();
    }
    this._initialized = false;
    this.provider = null;
    this.history = null;
    this.loop = null;
    this.projectManager = null;
    this._ctx = null;
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
}
