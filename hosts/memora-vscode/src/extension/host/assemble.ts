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
 *   - 功能定位：内核同步的内置角色包承载（role-packs/ 构建期复制到 dist）
 *   - 日志对接：setLogger(vscodeOutputChannel) 将内核日志导向 VSCode 输出通道
 */
import { Agent, FetchWebSearchProvider, FetchWebFetchProvider, setLogger } from '@zooique/memora';
import type { ISessionStore, IRoundStore, UIMessages, ProviderRouter, LlmProvider } from '@zooique/memora';
import type { ILogger } from '@zooique/memora';
// vscode 命名空间类型引用（OutputChannel）：仅类型导入，无运行时依赖（宿主运行时由 VS Code 注入真实模块）
import type { OutputChannel } from 'vscode';
import { join } from 'node:path';
import { createProvider, createBackgroundProvider, createVectorStore } from './llmConfig.js';
import { createLocalCodeExecutor } from './codeExecutor.js';
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
  // 工具失败重试 / 自审查（低频场景，覆盖保证中文化一致）
  reflectionHint: (remaining: number) =>
    `\n\n[工具调用失败，剩余 ${remaining} 次反思机会，请聚焦修正而非放弃]`,
  selfReviewPrompt: (round: number, total: number) =>
    `\n\n[请审查你上一轮的回答质量（第 ${round}/${total} 轮自审查），如发现问题请修正后重新输出]`,
};

/**
 * VSCode OutputChannel → ILogger 适配器
 *
 * 接受一个 vscode.OutputChannel 实例，将内核 ILogger 的调用
 * （支持 `info(msg)` 与 `info(obj, msg)` 两种形式）转换为 OutputChannel.appendLine。
 */
export function createVscodeLogger(output: OutputChannel): ILogger {
  return {
    info: (objOrMsg, msg?) => {
      const line = msg ? `[INFO] ${msg} ${JSON.stringify(objOrMsg)}` : `[INFO] ${objOrMsg}`;
      output.appendLine(line);
    },
    warn: (objOrMsg, msg?) => {
      const line = msg ? `[WARN] ${msg} ${JSON.stringify(objOrMsg)}` : `[WARN] ${objOrMsg}`;
      output.appendLine(line);
    },
    error: (objOrMsg, msg?) => {
      const line = msg ? `[ERROR] ${msg} ${JSON.stringify(objOrMsg)}` : `[ERROR] ${objOrMsg}`;
      output.appendLine(line);
    },
    debug: (objOrMsg, msg?) => {
      const line = msg ? `[DEBUG] ${msg} ${JSON.stringify(objOrMsg)}` : `[DEBUG] ${objOrMsg}`;
      output.appendLine(line);
    },
  };
}

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
   * 问答闭环存储（Phase 4：round-based 模式注入）
   *
   * 传入后内核启用 round-based 写入模式：每个问答闭环独立存储，
   * 会话通过 Round ID 列表组装。不传则仅 legacy 模式（向后兼容）。
   */
  roundStore?: IRoundStore;
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
   * 启动时激活的角色包名（可选，2026-08-15 角色包状态持久化，2026-08-17 升为用户级）
   *
   * 宿主从 vscode globalState 读取用户上次选择的角色包注入，
   * Agent init 时优先激活；未配置/包不存在回退首个角色包。
   */
  activeRolePack?: string;
  /**
   * 用户技能目录（可选，2026-08-22 新增）
   *
   * 用户自定义技能存储路径（如 globalStorage/skills/），由宿主确定并注入。
   * Agent init 完成后，SkillManager 会扫描该目录并注册技能（运行时注入）。
   * 与内置技能（configDir/skills/）分离，支持用户独立管理。
   */
  userSkillsDir?: string;
  /**
   * 用户角色包目录（可选，2026-08-22 新增，预留扩展点）
   *
   * ⚠️ 当前状态：角色包**不开放给用户**，仅支持内置角色包
   * - 此参数仅为未来扩展预留，当前宿主不会传入有效值
   * - 内核 loadExtraDir() 方法已就绪，宿主开放时直接调用即可
   *
   * 设计决策见 extension.ts 中 userRolePacksDir 的完整注释
   */
  userRolePacksDir?: string;
  /**
   * 写入二次确认开关（H0）
   *
   * 用户级安全偏好：开启后 owner 模式写文件前触发审批确认（需宿主 UI 确认放行）；
   * 关闭后 owner 模式写文件自动批准（审计仍记录）。由 extension 从 globalState 读取注入。
   */
  confirmWrites?: boolean;
  /**
   * 白名单额外允许路径（G8）
   *
   * 用户级项目白名单（不含 projectPath 基准根），由 extension 从 workspace 设置
   * memora.allowedPaths 读取注入。Agent 装配时合并为 [projectPath, ...extras]。
   * 运行时经 agent.security.setAllowedPaths() 热更新（设置面板），无需重启。
   */
  allowedPaths?: string[];
  /**
   * VSCode 输出通道（G7：日志对接）
   *
   * 宿主创建 vscode.OutputChannel 注入，内核通过 setLogger() 将日志导向该通道。
   * 未传入时内核日志默认输出到 stdout（生产环境建议始终注入）。
   */
  outputChannel?: OutputChannel;
  /** 环境变量（默认 process.env，便于测试注入） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 创建 Provider 路由策略（P1-2 多模型路由基础）
 *
 * VSCode 插件为单 Provider 配置模型（用户配置面板选择一个激活 Provider），
 * 因此路由策略当前直接返回同一个 Provider——但保留路由钩子，为未来
 * 「按任务类型自动选择不同 Provider」场景（如代码用强模型、摘要用快模型）
 * 预留扩展位。内核 AgentLoop 已实现 providerRouteCache 缓存机制，
 * 注入 router 后即可激活该优化路径。
 *
 * @param provider 当前激活的 LLM Provider
 * @returns Provider 路由选择器
 */
function createProviderRouter(provider: LlmProvider): ProviderRouter {
  return (_taskType) => provider;
}

/**
 * 装配并初始化 memora Agent（薄壳，功能定位由内置角色包承载）
 *
 * @returns 已 init 的 Agent 实例
 */
export async function assembleAgent(options: AssembleOptions): Promise<Agent> {
  const { projectPath, providerStore, sessionStore, roundStore, env, activeRolePack, configDir, userSkillsDir, userRolePacksDir, confirmWrites, allowedPaths, outputChannel } = options;

  // G7：日志对接 — 宿主注入 OutputChannel 时，创建 ILogger 适配器并注入内核
  if (outputChannel) {
    const logger = createVscodeLogger(outputChannel);
    setLogger(logger);
  }

  // 1. 创建 LLM Provider（宿主注入；优先配置面板的激活 Provider，回退环境变量）
  const provider = await createProvider(providerStore, env ?? process.env);
  // 1.0 创建后台模型 Provider（G5：后台任务走独立轻量模型；未配置回退与实时对话相同）
  const backgroundProvider = await createBackgroundProvider(providerStore);
  // 1.0b 创建向量存储（G1：配置 Embedding 时启用记忆语义检索；未配置回退关键词搜索）
  const vectorStore = await createVectorStore(providerStore, join(projectPath, '.memora'));
  // 1.1 创建 Provider 路由策略（激活 AgentLoop 路由缓存优化；单 Provider 时直接返回同一实例）
  const providerRouter = createProviderRouter(provider);

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
    // 配置目录 = 插件内置配置（dist/extension，含构建期从内核同步的 role-packs；
    // 内核 init 自动扫描 <configDir>/role-packs/ 并激活 activeRolePack 或首个角色包）
    configDir,
    // 启动时激活的角色包（用户上次选择，由 extension 从 globalState 注入持久化值）
    activeRolePack,
    provider,
    // Provider 路由策略（激活 AgentLoop 路由缓存优化；按任务类型返回对应 Provider）
    providerRouter,
    // 后台模型 Provider（G5：摘要/归档/润色/去重等后台任务走独立轻量模型；undefined 回退前台）
    backgroundProvider,
    storage,
    sessionStore: store,
    // 问答闭环存储（Phase 4：round-based 模式，传入后内核启用独立 Round 存储）
    roundStore,
    // 网络搜索（Bing→DuckDuckGo 降级，开箱即用，零依赖）
    webSearchProvider: new FetchWebSearchProvider(),
    // 网页抓取（B8 首发生长：补「搜索→抓取」闭环第二段；Node 内置 fetch 开箱即用，零依赖）
    fetchProvider: new FetchWebFetchProvider(),
    // 代码执行（G2：local vm 沙箱，受限计算能力）——注入后内核暴露 run_code 工具给 LLM
    codeExecutionProvider: createLocalCodeExecutor(),
    // 向量存储（G1：配置 Embedding 时启用语义召回；undefined 则 searchHybrid 回退关键词）
    vectorStore,
    // UI 消息中文化（P0：内核默认英文，覆盖为中文）
    messages: CHINESE_MESSAGES,
    // 执行前检查：单用户桌面场景恒放行（intentionally left blank）。
    // 理由：1) VSCode 插件运行在用户本地，天然信任模型；2) 工具审计已由
    // tool_start/tool_result chunk + tool.execute span 承担，不重复记录。
    // ⚠️ 若未来接多用户/服务端部署，必须替换为真实审批策略（权限/路径/只读）。
    preExecutionCheck: () => ({ skip: false }),
    // 可观测性 Tracer（P2：§5.2.1 指纹由 ITracer 承载，宿主采集不落盘）
    tracer: vscodeTracer,
    permission: 'owner',
    // 白名单 = 基准根 projectPath + 用户额外允许目录（G8：运行时可热更新，基准根不可移除）
    allowedPaths: [projectPath, ...(allowedPaths ?? [])],
    // 写入二次确认（H0：用户级安全偏好；开启后 owner 写文件前触发审批确认）
    confirmWrites: confirmWrites ?? false,
  });

  // 4. 初始化（加载记忆/角色包/会话，注册内置工具）
  await agent.init();

  // 4.1 无缝插话策略（缺口 B）：宿主「生成中 Enter 输入补充」走 agent.interject()，
  // 设 inputInterrupt='block' 使其排队、在下一迭代边界并入，不中断当前 loop 执行
  //（默认 'allow' 会中断当前调用，达不到「补充内容不打断 loop」的效果）。
  agent.setInputInterrupt('block');

  // 5. 加载用户技能（可选，宿主扩展内置技能池）
  // 用户技能与内置技能分离：内置从 configDir/skills/ 扫描，用户从 userSkillsDir 扫描
  if (userSkillsDir) {
    await agent.skills?.loadExtraDir(userSkillsDir);
  }

  // 6. 加载用户角色包（⚠️ 当前禁用，预留扩展点）
  //
  // 当前角色包不开放给用户（详见 AssembleOptions.userRolePacksDir 注释）
  // userRolePacksDir 参数当前为 undefined，此分支不会执行
  // 未来开放时：宿主传入用户目录 → 内核 loadExtraDir() 加载
  if (userRolePacksDir) {
    await agent.rolePacks?.loadExtraDir(userRolePacksDir);
  }

  return agent;
}
