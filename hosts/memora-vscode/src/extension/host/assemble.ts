/**
 * Agent 装配层 — 薄壳装配（ADR-VC-001 决策 2/3）
 *
 * 职责：
 *   - 复用 memora 内核 Agent 门面，注入宿主侧 provider + 存储 + 会话
 *   - 不重复实现内核能力（薄壳 + 装配）
 *
 * 装配：
 *   - LLM Provider：createProvider（配置面板激活 / 环境变量回退）
 *   - 记忆存储：WorkspaceStorage（.memora/memories.json）
 *   - 会话存储：WorkspaceSessionStore（.memora/sessions.json）
 *   - 网络搜索：FetchWebSearchProvider（Bing→DuckDuckGo 降级）
 *   - 功能定位：configDir 下的内置角色包（role-packs/doc-review）承载
 */
import { Agent, FetchWebSearchProvider } from '@zooique/memora';
import type { ISessionStore, UIMessages } from '@zooique/memora';
import { join } from 'node:path';
import { createProvider } from './llmConfig.js';
import { WorkspaceStorage } from './workspaceStorage.js';
import { WorkspaceSessionStore } from './sessionStore.js';
import { vscodeTracer } from './tracer.js';

import type { ProviderStore } from '../providers/providerStore.js';

/**
 * 宿主可覆盖的 UI 消息中文化（P0，激进对齐 UIMessages 契约）
 *
 * 内核默认英文 UI 文案（如 abortedByUser），插件为中文用户，全部覆盖为中文。
 * 未启用的场景（如自审查 selfReviewPrompt）覆盖后无害——不触发即不消费。
 */
const CHINESE_MESSAGES: UIMessages = {
  // 对话取消 / 达上限 / 流式中断（三者均为「对话末尾状态标记」）
  abortedByUser: '用户取消了对话',
  maxIterationsReached: '\n\n[已达最大迭代次数]',
  interrupted: '\n\n[已中断]',
  // 上下文窗口截断提示
  contextTruncated: (skipped: number, kept: number) =>
    `[上下文已截断：跳过 ${skipped} 条历史，保留 ${kept} 条]`,
  // 上下文角色标签
  recentConversationLabel: '[最近对话]',
  userLabel: '[用户]',
  assistantLabel: '[助手]',
  // 护栏提示
  inputBlockedByGuard: (rule: string) => `[输入被护栏阻断：${rule}]`,
  guardrailWarningPrefix: '[护栏警告]',
  outputBlockedByGuard: (rule: string) => `[输出被护栏阻断：${rule}]`,
  // 工具失败重试 / 自审查（低频场景，覆盖保证中文化一致）
  reflectionHint: (remaining: number) =>
    `\n\n[工具调用失败，剩余 ${remaining} 次反思机会，请聚焦修正而非放弃]`,
  selfReviewPrompt: (round: number, total: number) =>
    `\n\n[请审查你上一轮的回答质量（第 ${round}/${total} 轮自审查），如发现问题请修正后重新输出]`,
};

/** 装配参数 */
export interface AssembleOptions {
  /** 工作区路径（memora projectPath） */
  projectPath: string;
  /** 大模型配置存储（配置面板装配后注入） */
  providerStore?: ProviderStore;
  /**
   * 会话存储（SSOT 复用：由 extension 单例注入，与 UI 面板共享同一实例）
   *
   * 不传时内部新建（独立用途/测试）。必须复用：否则 UI 面板与 Agent 各持一个
   * WorkspaceSessionStore 实例，双实例独立内存、覆盖写同一 sessions.json，
   * 会导致「UI 加载的会话记录不完整 / 互相覆盖丢消息」（无法加载会话记录根因）。
   */
  sessionStore?: ISessionStore;
  /**
   * 插件内置配置目录（configDir，SSOT 修复 2026-08-15）
   *
   * 由 extension.ts 从 context.extensionUri 显式定位（join(extensionUri, 'dist', 'extension')），
   * 而非 assemble 内用 import.meta.url 相对推断——后者在 esbuild bundle 后
   * import.meta.url 指向 dist/extension/extension.js，dirname 再 join('..') 会漂移到 dist，
   * 导致 role-packs 扫描为 0（内置角色包加载失败 bug）。显式注入消除路径漂移。
   */
  configDir: string;
  /**
   * 启动时激活的角色包名（可选，2026-08-15 角色包状态持久化）
   *
   * 宿主从 vscode workspaceState 读取用户上次选择的角色包注入，
   * Agent init 时优先激活；未配置/包不存在回退首个角色包。
   */
  activeRolePack?: string;
  /** 环境变量（默认 process.env，便于测试注入） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 装配并初始化 memora Agent（薄壳，功能定位由内置角色包承载）
 *
 * @returns 已 init 的 Agent 实例
 */
export async function assembleAgent(options: AssembleOptions): Promise<Agent> {
  const { projectPath, providerStore, sessionStore, env, activeRolePack, configDir } = options;

  // 1. 创建 LLM Provider（宿主注入；优先配置面板的激活 Provider，回退环境变量）
  const provider = await createProvider(providerStore, env ?? process.env);

  // 2. 创建工作区记忆存储 + 会话存储（宿主注入持久化）
  const storage = new WorkspaceStorage(projectPath);
  storage.load();
  // SSOT：复用 extension 单例 sessionStore（与 UI 面板共享同一实例，杜绝双实例覆盖写）；
  // 未注入时（独立用途/测试）才内部新建并加载。
  const store: ISessionStore =
    sessionStore ??
    (() => {
      const s = new WorkspaceSessionStore(projectPath);
      s.load();
      return s;
    })();

  // 3. 装配 Agent（薄壳，全部复用内核）
  const agent = new Agent({
    projectPath,
    // 记忆数据目录 = 工作区 .memora（注册表/锁文件落盘处，与存储同目录）
    dataDir: join(projectPath, '.memora'),
    // 配置目录 = 插件内置配置（role-packs/doc-review 角色包承载文档打磨定位；
    // 内核 init 自动扫描 <configDir>/role-packs/ 并激活 activeRolePack 或首个角色包）
    configDir,
    // 启动时激活的角色包（用户上次选择，由 extension 从 workspaceState 注入持久化值）
    activeRolePack,
    provider,
    storage,
    sessionStore: store,
    // 网络搜索（Bing→DuckDuckGo 降级，开箱即用，零依赖）
    webSearchProvider: new FetchWebSearchProvider(),
    // UI 消息中文化（P0：内核默认英文，覆盖为中文）
    messages: CHINESE_MESSAGES,
    // 执行前检查（P3：激进对齐 §7.2.1 统一检查点；收敛版仅放行——
    // 工具审计已由 tool_start/tool_result chunk + tool.execute span 承担，不重复记录）
    preExecutionCheck: () => ({ skip: false }),
    // 可观测性 Tracer（P2：§5.2.1 指纹由 ITracer 承载，宿主采集不落盘）
    tracer: vscodeTracer,
    permission: 'owner',
    allowedPaths: [projectPath],
  });

  // 4. 初始化（加载记忆/角色包/会话，注册内置工具）
  await agent.init();

  return agent;
}
