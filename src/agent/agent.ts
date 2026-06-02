/**
 * Agent 门面类 — Memora 宿主项目接入入口
 *
 * 设计文档（agent设计.md §9）要求宿主项目通过 `import { Agent } from '@memora/core'`
 * 一行代码接入。本类把当前 repl.ts 中埋藏的组装逻辑提取到正确的架构层，
 * 使 AgentLoop / MemoryIndex / DomainManager / ToolExecutor / SecurityGuard
 * 这些已有组件可以被 CLI 以外的宿主项目直接使用。
 *
 * 使用方式：
 *   const agent = new Agent({ config, projectPath });
 *   await agent.init();
 *   for await (const chunk of agent.chat('你好')) { process.stdout.write(chunk); }
 *   await agent.close();
 */
import type { Config } from '../config/loader.js';
import { createLlmProvider } from '../llm/factory.js';
import { AgentLoop } from './loop.js';
import { ToolExecutor } from './tool-executor.js';
import { MessageHistory } from './message-history.js';
import { ProjectManager } from '../memory/project-manager.js';
import { createTopicSummarizer } from '../cli/repl.js';
import type { LlmProvider } from '../llm/provider.js';
import type { Memory } from '../memory/types.js';
import type { MemoryIndex } from '../memory/index.js';
import type { TopicStore } from '../memory/topic-store.js';
import type { SecurityGuard } from '../security/path-guard.js';

// ─── 类型定义 ───────────────────────────────────────────

/** Agent 构造选项 */
export interface AgentOptions {
  /** Memora 配置对象（由 loadConfig() 产生） */
  config: Config;
  /** 宿主项目根目录的绝对路径 */
  projectPath: string;
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
  private config: Config;
  private projectPath: string;

  // 运行时组件
  private projectManager: ProjectManager;
  private provider: LlmProvider | null = null;
  private history: MessageHistory | null = null;
  private loop: AgentLoop | null = null;

  // 上下文（init 后填充）
  private _ctx: AgentContext | null = null;
  private _initialized = false;

  constructor(opts: AgentOptions) {
    this.config = opts.config;
    this.projectPath = opts.projectPath;
    this.projectManager = new ProjectManager(this.config);
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
    // 初始化项目上下文（加载 .memora/ 下的记忆索引）
    const pctx = await this.projectManager.initProject(this.projectPath);

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
    if (!this._initialized || !this.history || !this.loop) {
      throw new Error('Agent 未初始化，请先调用 init()');
    }

    // 用户消息写入历史
    await this.history.appendUser(input);

    // Agent Loop 流式处理
    let assistantContent = '';
    for await (const chunk of this.loop.processUserInput(input)) {
      yield chunk;
      assistantContent += chunk;
    }

    // Agent 回复写入历史
    await this.history.appendAssistant(assistantContent);
  }

  /**
   * 关闭 Agent，释放 SQLite 连接等资源
   */
  async close(): Promise<void> {
    await this.projectManager.closeProject();
    this._initialized = false;
    this.provider = null;
    this.history = null;
    this.loop = null;
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
