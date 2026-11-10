/**
 * Agent 装配层 — 薄壳装配（ADR-VC-001 决策 2/3）
 *
 * 职责：
 *   - 复用 memora 内核 Agent 门面，注入宿主侧 provider + 存储 + 会话
 *   - 不重复实现内核能力（薄壳 + 装配）
 *
 * 装配：
 *   - LLM Provider：createProvider（配置面板激活 / 环境变量回退）
 *   - 记忆存储：SQLite（.memora/memories.db，经内核工厂；旧环境降级 JSON，见 host/memoryStorage.ts）
 *   - 会话存储：WorkspaceSessionStore（.memora/sessions/<sessionId>.json，**无全局共享文件**）
 *   - 网络搜索：FetchWebSearchProvider（Bing→DuckDuckGo 降级）
 *   - 功能定位：内置角色包（dist/extension/role-packs/ 构建期同步）+ 用户角色包（globalStorageUri/role-packs 运行态注入）
 *   - 日志对接：setLogger(vscodeOutputChannel) 将内核日志导向 VSCode 输出通道
 */
import {
  Agent,
  FetchWebSearchProvider,
  FetchWebFetchProvider,
  setLogger,
  resolveContextWindow,
} from '@zooique/memora';
import type {
  ISessionStore,
  IRoundStore,
  IMemoryStorage,
  UIMessages,
  ProviderRouter,
  LlmProvider,
  ArchiveMode,
  ImageResolver,
} from '@zooique/memora';
import type { ILogger } from '@zooique/memora';
import type { CustomSearchEngineConfig } from '../../shared/protocol.js';
import { resolveSearchEndpoints } from './searchEngines.js';
// vscode 命名空间类型引用（OutputChannel）：仅类型导入，无运行时依赖（宿主运行时由 VS Code 注入真实模块）
import type { OutputChannel } from 'vscode';
import { createProvider, createBackgroundProvider } from './llmConfig.js';
import { createLocalCodeExecutor } from './codeExecutor.js';
import { createVscodeEnvironmentProvider } from './environmentProvider.js';
import type { AnswerLanguageInput } from './responseLanguage.js';
import { createVscodeProjectSearchProvider } from './projectSearchProvider.js';
import { createHostMemoryStorage } from './memoryStorage.js';
import { resolveProjectDataDir } from './projectDataDir.js';
import { WorkspaceSessionStore } from './sessionStore.js';
import { vscodeTracer } from './tracer.js';
import { startMcpServers } from './mcp/runtime.js';
import type { McpServerConfig } from './mcp/connectionManager.js';

import type { ProviderStore } from '../providers/providerStore.js';

/**
 * 宿主 UI 消息中文化（P0）
 *
 * UIMessages 全键可选，未覆盖即用内核默认。本对象只覆盖**内核默认非中文、且能到用户眼前**的键；
 * 以下两类刻意不覆盖，各有理由（判据不同，不是遗漏）：
 *   - **内核默认本就是中文的键**：`softLimitWrapup` / `duplicateToolCallWarning` /
 *     `interrupted` / `reflectionHint` / `selfReviewPrompt`。复制一份到宿主即**双轨镜像**——
 *     内核改文案宿主不跟随，且复制品必然落后（实证：宿主版 `interrupted` 停在升级前的短
 *     `[已中断]`，遮蔽了内核带「断点摘要」的新文案，导致中文用户流式中断后模型重复输出；
 *     宿主版 `selfReviewPrompt` 丢了内核的 4 点核查清单）。故一律**不复制**，走内核默认。
 *   - `abortedByTimeout`：内核默认虽为英文，但渲染层按 `aborted.stopReason` 重贴中文
 *     （chatView 的 stopReasonLabel：timeout → 「对话处理超时」；内核恒带 stopReason），文案真源在渲染层。
 * ⚠️ 覆盖边界即本清单：内核若新增**默认值为英文**的 UI 键，须回来补此处，勿假定「全键已覆盖」。
 * ⚠️ 往本清单添键前先看内核默认值：中文默认的键**不许**再抄一遍。
 *
 * 传递时机由 {@link pickUiMessages} 决定：zh 开头 locale 才注入；其余 locale **不注入** ⇒ 走内核默认
 * （`UIMessages` 现为**混合默认**：其余键英文，上面点名不复制的那 5 条中文——即这 5 条对非 zh 用户
 * 仍是中文，与本仓英文标签 + 中文正文的错误通知同族的已知缺口）。
 */
const CHINESE_MESSAGES: UIMessages = {
  // 对话取消 / 达上限 / 流式中断（三者均为「对话末尾状态标记」）
  abortedByUser: '用户取消了对话',
  maxIterationsReached: '\n\n[已达最大迭代次数]',
  // 上下文窗口截断提示
  contextTruncated: (skipped: number, kept: number) =>
    `[上下文已截断：跳过 ${skipped} 条历史，保留 ${kept} 条]`,
  // 上下文角色标签
  recentConversationLabel: '[最近对话]',
  userLabel: '[用户]',
  assistantLabel: '[助手]',
  // 空响应兜底：LLM 200 但 0 token（瞬态抽风 / 模型拒绝）时，
  // 覆盖内核默认英文为中文提示；配合内核空响应重试，多数瞬态会在重试中救回、落不到这里。
  emptyResponseFallback: '模型未返回有效内容，请重试或换个说法。',
  // 截断型分型文案（finishReason='length'：思考吃满输出预算）：带动作指引（调大输出上限），
  // 与瞬态型区分——用户拿到的提示能指导下一步动作。attempts = 内核空响应自动重试的尝试总数
  // （1 次首试 + N 次重试）——文案用「尝试」口径，勿写「重试 N 次」（恒多报 1）。
  emptyResponseFallbackTruncated: (attempts: number) =>
    `模型思考过长耗尽输出预算，已自动尝试 ${attempts} 次仍为空——建议调大模型输出上限`,
};

/**
 * 按 VS Code 显示语言选择 UI 消息覆盖（单一选择点）
 *
 * `zh` 开头（zh-cn / zh-tw）→ 中文覆盖；其余 / 缺省 → `undefined` = 内核默认（混合默认，见文件头）。
 * 繁中用户得简体框架文字是**内容供给的显式决策**（UI 消息仅此一套中文文案），
 * 不是「zh-tw 回落 zh-cn」的文件查找假设，ADR-042 边界不受影响。
 * 判定唯一在此处——回答语言的判定在 `buildResponseLanguageDirective`，两者机制分离。
 *
 * @param envLanguage VS Code 显示语言（`vscode.env.language`，装配调用方注入）
 * @returns 中文覆盖或 undefined（走内核默认，混合默认见文件头）
 */
function pickUiMessages(envLanguage: string | undefined): UIMessages | undefined {
  return envLanguage && /^zh/i.test(envLanguage) ? CHINESE_MESSAGES : undefined;
}

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
  /**
   * 回答语言输入：VS Code 显示语言（值）+ 用户自定义（读取器）。
   *
   * 由 `answerLanguageAssembly()` 单点构造；缺省 ⇒ 英文软默认。
   * 覆盖值传**读取器**：内核每轮重建前缀时现取 ⇒ 改设置下一轮即生效。
   * 不新增 `memora.*` **UI 语言**配置项（ADR-042 决策 1 仍成立）；
   * `memora.answerLanguage` 只影响模型可见的回答语言，不改任何界面文案。
   */
  answerLanguage?: AnswerLanguageInput;
  /**
   * VS Code 显示语言（`vscode.env.language`）——**UI 消息语言**的唯一选择依据。
   *
   * `zh` 开头（zh-cn / zh-tw）⇒ 传 `CHINESE_MESSAGES`（UI 消息仅此一套简体中文文案，
   * 给繁中用户提供简体框架文字是**内容供给的显式决策**，非文件查找回落，ADR-042 边界不受影响）；
   * 其余 / 缺省 ⇒ 不传 = 内核默认（混合：多数键英文 + 上面点名的 5 条中文）。由装配调用方注入；与回答语言机制无关
   * （回答语言判定唯一在 `buildResponseLanguageDirective`，勿在此耦合）。
   */
  envLanguage?: string;
  /**
   * 项目搜索根（可选）
   *
   * 仅当存在真实工作区文件夹时注入（= workspaceFolders[0].fsPath）；
   * 未打开工作区时为 undefined → 不注入 projectSearchProvider，LLM 不暴露 search_project 工具，
   * 避免搜索落到 projectPath 兜底根（~/.memora）答非所问。
   */
  projectSearchRoot?: string;
  /** 大模型配置存储（配置面板装配后注入） */
  providerStore?: ProviderStore;
  /**
   * 会话存储（SSOT 复用：由 extension 单例注入，与 UI 面板共享同一实例）
   *
   * 不传时内部新建（独立用途/测试）。必须复用：否则 UI 面板与 Agent 各持一个
   * WorkspaceSessionStore 实例，双实例独立内存、各自写同一会话文件，
   * 会导致「UI 加载的会话记录不完整 / 互相覆盖丢消息」（无法加载会话记录根因）。
   */
  sessionStore?: ISessionStore;
  /**
   * 问答闭环存储（round-based 模式注入）
   *
   * 传入后内核启用 round-based 写入模式：每个问答闭环独立存储，
   * 会话通过 Round ID 列表组装。不传则仅 legacy 模式（向后兼容）。
   */
  roundStore?: IRoundStore;
  /**
   * 记忆存储单例（多实例宿主必传）
   *
   * 同一项目的所有 Agent 必须共享**同一实例**（共存储共记忆）；所有权归注入方，
   * 任一 Agent close 不会关闭它（内核 ProjectManager 只关自建存储）。
   * 不传时按 `projectPath` 内部新建——单实例/独立用途/测试路径，所有权归该 Agent。
   */
  storage?: IMemoryStorage;
  /**
   * 插件内置配置目录（configDir）
   *
   * 由 extension.ts 从 context.extensionUri 显式定位（join(extensionUri, 'dist', 'extension')），
   * 而非 assemble 内用 import.meta.url 相对推断——后者在 esbuild bundle 后
   * import.meta.url 指向 dist/extension/extension.js，dirname 再 join('..') 会漂移到 dist，
   * 导致 role-packs 扫描为 0（内置角色包加载失败 bug）。显式注入消除路径漂移。
   */
  configDir: string;
  /**
   * 启动时激活的角色包名（可选，用户级持久化）
   *
   * 宿主从 vscode globalState 读取用户上次选择的角色包注入，
   * Agent init 时优先激活（解析链第一层）；未配置/包不存在落兜底包。
   */
  activeRolePack?: string;
  /**
   * 角色包组（会议名单，v0.13 S7）：组长 + 组员名单。用户级数据（globalState），
   * 注入 AgentOptions.rolePackTeams 供内核装配；组员仅作小组会议参与者，不用于日常。
   */
  rolePackTeams?: { leader: string; members: string[] }[];
  /**
   * 用户技能目录（可选）
   *
   * 用户自定义技能存储路径（如 globalStorage/skills/），由宿主确定并注入。
   * Agent init 完成后，SkillManager 会扫描该目录并注册技能（运行时注入）。
   * 与内置技能（configDir/skills/）分离，支持用户独立管理。
   */
  userSkillsDir?: string;
  /**
   * 用户角色包目录（可选，与内置包同池注入）
   *
   * extension.ts 从 globalStorageUri/role-packs 传入有效路径，本装配处实际加载：
   * 用户角色包经内核 RolePackManager.loadExtraDir() 运行态注入，与内置包同池可切换。
   * 同名冲突按加载顺序裁决（内置 → 用户 → 项目，后加载者胜，见内核 loadExtraDir）。
   */
  userRolePacksDir?: string;
  /**
   * 项目级技能目录（可选）
   *
   * `<workspaceFolder>/.memora/skills/`，作为**第三个** extra dir 注入：
   * 与用户级同一套 `loadExtraDir`（不另造扫描器），后加载者胜 ⇒ 项目覆盖用户/内置。
   * ⚠️ 仅当工作区已受信任时由 extension 传入；未信任不注入（信任门）。
   */
  projectSkillsDir?: string;
  /**
   * 项目级角色包目录（可选）
   *
   * `<workspaceFolder>/.memora/role-packs/`，与用户角色包同一注入面，档位 = 'project'。
   * 同上受工作区信任门约束。
   */
  projectRolePacksDir?: string;
  /**
   * 工作区信任态（现读快照，来源唯一 = 本模块导出 `readWorkspaceTrusted`）
   *
   * 透传 `AgentOptions.workspaceTrusted`，内核侧唯一消费面 = 项目规则层的第一道闸
   * （`setResident` 与装配期 `ResidentRulesManager` 同一判据：**非布尔 `true` 一律按未信任**）。
   * ⚠️ 必须由 extension **装配时刻现读**注入，不得在 activate 时采样缓存——
   * 信任可运行期授予/撤销，快照会与真实判定不同源（漏传 ⇒ 常驻层恒关且所有测试仍全绿）。
   */
  workspaceTrusted?: boolean;
  /**
   * 脚本/代码执行确认开关
   *
   * 开启后 owner 模式 run_code/run_project_script 执行前触发审批确认；关闭后自动批准。
   * 由 extension 从 globalState 读取注入，运行时经 agent.security.setConfirmScripts()
   * 热更新（设置面板），无需重启。
   * ⚠️ 写入侧的 confirmWrites 装配参数已于 2026-11-06（E4 批 4）移除：写文件一律直接落盘，
   * 宿主不再提供开关（内核 `AgentOptions.confirmWrites` 仍在，仅保留 guest 语义与公开面）。
   */
  confirmScripts?: boolean;
  /**
   * 白名单额外允许路径
   *
   * 用户级项目白名单（不含 projectPath 基准根），由 extension 从 workspace 设置
   * memora.allowedPaths 读取注入。Agent 装配时合并为 [projectPath, ...extras]。
   * 运行时经 agent.security.setAllowedPaths() 热更新（设置面板），无需重启。
   */
  allowedPaths?: string[];
  /**
   * 当前激活的网页搜索引擎（预设名或自定义引擎名；auto = 默认降级链 Bing→DuckDuckGo）。
   * 由 extension 从 workspace 设置 memora.searchEngine 读取注入；修改需重载窗口生效。
   */
  searchEngine?: string;
  /**
   * 用户自定义搜索引擎清单（memora.customSearchEngines 设置形态）。
   * 由 extension 读取注入；resolveSearchEndpoints 据此把激活引擎解析为内核 SearchEndpoint[]。
   * 修改需重载窗口生效。
   */
  customSearchEngines?: CustomSearchEngineConfig[];
  /**
   * 会话归档模式（memora.archiveMode 设置形态）
   *
   * full=自动归档（切走/分叉/暂停超时时自动生成会话摘要元数据）；manual=仅手动。
   * 轮次摘要不受影响（无模式开关，总是生成）。透传 AgentOptions.archiveMode；
   * 缺省（undefined）由内核回落 'full'——宿主不复制默认字面量（SSOT：默认值在内核）。
   * 运行时切换走设置面板热更新（agent.setArchiveMode），无需重装。
   */
  archiveMode?: ArchiveMode;
  /**
   * 是否让内核 Agent 自启周期 GC（默认 true，透传 AgentOptions.autoStartGc）
   *
   * 宿主多实例共享同一对存储单例时必须传 false：GC 由宿主 `MemoryGcScheduler` 单点驱动
   * （E6），否则 N 个实例各挂一个定时器、每周期重复扫同一份存储。
   */
  autoStartGc?: boolean;
  /**
   * 禁用的技能名清单
   *
   * 由 extension 从 workspace 设置 memora.disabledSkills 读取注入，配置形态启停：
   * 命中技能对 LLM 全链不可用（L1 清单剔除 / L2 read_skill / L3 资源脚本），
   * 语义 = 技能不存在；宿主 settingsView 依据同名设置标注「已禁用」徽章。
   * 修改需重建会话（装配是 activation 期一次性注入）。
   */
  disabledSkills?: string[];
  /**
   * 脚本执行 node 路径（可选，S3-接续）
   *
   * 由 extension 从 workspace 设置 memora.scriptNodePath 读取注入（用户显式配置），
   * 透传 AgentOptions.scriptNodePath → 内核 run_skill_script / run_project_script 的
   * node runtime 分支（内核零解释转发）。缺省不注入 → 内核走 'node'（PATH 查找）；
   * 宿主机无独立 node 时由用户配置可避免 .js/.mjs 技能脚本 ENOENT。
   * 刻意不做自动探测（where node 有 WindowsApps stub 假阳性风险）——执行配置由用户显式决定。
   */
  scriptNodePath?: string;
  /**
   * VSCode 输出通道（日志对接）
   *
   * 宿主创建 vscode.OutputChannel 注入，内核通过 setLogger() 将日志导向该通道。
   * 未传入时内核日志默认输出到 stdout（生产环境建议始终注入）。
   */
  outputChannel?: OutputChannel;
  /**
   * MCP 服务器配置（用户级设置 memora.mcpServers）
   *
   * 装配末尾逐台拉起并注册工具（实现见 host/mcp/）；缺省/空数组 = 完全不碰内核工具集。
   * 单个 server 连不上只记日志，不阻断装配。
   */
  mcpServers?: readonly McpServerConfig[];
  /**
   * MCP 工具免确认 allowlist 原值（用户级设置 memora.mcpToolAllowlist）
   *
   * 键格式 `mcp__<服务器名>__<工具名>`，按**原名**寻址（非清洗后的显示名）；
   * 命中 = 该工具免弹窗仍落审计，未命中 = 每次调用都需确认（fail-closed）。
   * 缺省/空数组 = 全部逐次确认。解析在 host/mcp/runtime.ts（policy.ts）。
   */
  mcpToolAllowlist?: readonly string[];
  /**
   * 扩展版本号（写进 MCP clientInfo，供 server 侧遥测；不参与任何判据）
   *
   * 由 extension.ts 从 `context.extension.packageJSON.version` 读取注入，宿主不另存版本常量。
   */
  extensionVersion?: string;
  /**
   * 图片解析器（IMG-2 §5.4：宿主缓存 → `data:` URL）
   *
   * 运行时回调、不入 DTO（函数不可持久化）；由 extension.ts 用激活期单例 `ImageCache`
   * 的 `resolver` 注入。未注入 = 图片序列化走 D7 二级降级占位（不阻断对话）。
   */
  imageResolver?: ImageResolver;
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
  const {
    projectPath,
    projectSearchRoot,
    providerStore,
    sessionStore,
    roundStore,
    env,
    activeRolePack,
    rolePackTeams,
    configDir,
    userSkillsDir,
    userRolePacksDir,
    projectSkillsDir,
    projectRolePacksDir,
    workspaceTrusted,
    confirmScripts,
    allowedPaths,
    outputChannel,
    disabledSkills,
    scriptNodePath,
    archiveMode,
    autoStartGc,
    mcpServers,
    mcpToolAllowlist,
    extensionVersion,
    imageResolver,
  } = options;

  // 日志对接 — 宿主注入 OutputChannel 时，创建 ILogger 适配器并注入内核；
  // 同一 logger 同时交给记忆存储接线（迁移摘要等经它上报，避免迁移结果无痕）
  const logger = outputChannel ? createVscodeLogger(outputChannel) : undefined;
  if (logger) setLogger(logger);

  // 1. 创建 LLM Provider（宿主注入；优先配置面板的激活 Provider，回退环境变量）
  //    图片解析器随 Provider 注入：内核 formatMessages 同步查表，宿主零 IO 暴露给内核
  const provider = await createProvider(providerStore, env ?? process.env, imageResolver);
  // 1.0 创建后台模型 Provider（后台任务走独立轻量模型；未配置回退与实时对话相同）
  const backgroundProvider = await createBackgroundProvider(providerStore);
  // 1.1 创建 Provider 路由策略（激活 AgentLoop 路由缓存优化；单 Provider 时直接返回同一实例）
  const providerRouter = createProviderRouter(provider);

  // 2. 创建工作区记忆存储 + 会话存储（宿主注入持久化）
  // 记忆存储接线：按「迁移状态 × 环境能力」分档选实现（SQLite / 降级 JSON），
  // 并内含旧 JSON 一次性迁移（含退役设定来源清理 + 旧档改名保留）——
  // 装配点只调本工厂，判据与分档逻辑收口在 host/memoryStorage.ts（禁散点）；
  // 多实例宿主注入共享单例（所有权归注入方），不传才内部新建（单实例/测试）
  const storage = options.storage ?? createHostMemoryStorage(projectPath, logger);
  // SSOT：复用 extension 单例 sessionStore（与 UI 面板共享同一实例，杜绝双实例覆盖写）；
  // 未注入时（独立用途/测试）才内部新建并加载，且共享同一 roundStore 实例。
  const store: ISessionStore =
    sessionStore ??
    (() => {
      const s = new WorkspaceSessionStore(projectPath, roundStore);
      s.load();
      return s;
    })();

  // 上下文窗口解析（SSOT 单源公式）：vscode 窗口上限唯一真理源 = 用户 per-LLM 的 contextWindow
  // （LlmProviderConfig.contextWindow，由配置面板开放编辑）；未配置回落内核默认窗口（AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS）（默认非真理源）。
  // 无全局封顶——用户对自己填写的参数负责（见架构决策）。resolveContextWindow 单参：传 per-LLM 值，undefined 即兜底。
  const activeProviderCfg = providerStore ? await providerStore.getActive() : undefined;
  const maxContextTokens = resolveContextWindow(activeProviderCfg?.contextWindow);
  // per-LLM 输出预算（T1）：底座值 = 用户 per-LLM 的 maxTokens（配置面板「输出上限 (K)」）；
  // **非最终生效值**——与角色包策略 act.outputLimit **取更小值**（同为「上限」，须同时满足；
  // 裁决只在内核 buildChatOptions 单点进行，宿主不重算）。生效值读取口 = Agent.getEffectiveMaxTokens()，
  // 取证面取它而非本配置值。角色包未声明或声明 0 时不参与取小（0 = 不干预哨兵，
  // 与 contextLimit/stepBudget 同构）。
  // 未配置 undefined → 内核不传 max_tokens（回服务端默认，盲区语义与 contextWindow 同构）。
  const maxTokens = activeProviderCfg?.maxTokens;

  // 3. 装配 Agent（薄壳，全部复用内核）
  const agent = new Agent({
    projectPath,
    // 上下文窗口上限（token）：宿主注入，内核预算路径唯一容量输入
    maxContextTokens,
    // per-LLM 输出预算（token）：请求体 max_tokens 唯一注入口（AgentOptions 透传链）
    maxTokens,
    // 记忆数据目录 = 工作区数据目录（注册表/锁文件落盘处，与存储同目录；
    // 经单点推导 = projectDataDir.ts）
    dataDir: resolveProjectDataDir(projectPath),
    // 配置目录 = 插件内置配置（dist/extension，含构建期从内核同步的 role-packs；
    // 内核 init 自动扫描 <configDir>/role-packs/ 并激活 activeRolePack 或首个角色包）
    configDir,
    // 启动时激活的角色包（用户上次选择，由 extension 从 globalState 注入持久化值；
    // §4.1 解析链第一层，失效落兜底包）
    activeRolePack,
    // 角色包组（会议名单，用户级数据；内核 buildTeamContextBlock 注入组/成员清单供 LLM 组织会议）
    rolePackTeams,
    provider,
    // Provider 路由策略（激活 AgentLoop 路由缓存优化；按任务类型返回对应 Provider）
    providerRouter,
    // 后台模型 Provider（摘要 / 归档 / 润色等后台任务走独立轻量模型；undefined 回退前台）
    backgroundProvider,
    storage,
    sessionStore: store,
    // 问答闭环存储（round-based 模式，传入后内核启用独立 Round 存储）
    roundStore,
    // 网络搜索（memora.searchEngine 可切换内置/自定义引擎；auto = Bing→DuckDuckGo 默认链）。
    // 单一嫁接点 resolveSearchEndpoints：预设委托内核 REGISTRY，自定义走宿主预置解析策略，
    // 解析逻辑零复制（见 extension/host/searchEngines.ts）。
    webSearchProvider: new FetchWebSearchProvider(
      resolveSearchEndpoints(options.searchEngine, options.customSearchEngines ?? []),
    ),
    // 网页抓取（补「搜索→抓取」闭环第二段；Node 内置 fetch 开箱即用，零依赖）
    fetchProvider: new FetchWebFetchProvider(),
    // 代码执行（local vm 沙箱，受限计算能力）——注入后内核暴露 run_code 工具给 LLM
    codeExecutionProvider: createLocalCodeExecutor(),
    // 宿主环境提供者（命令执行能力方案 §10.4-②）：上报 OS/shell/可用运行时 → 内核注入
    // system prompt「## 运行环境」段；环境事实只给模型看，内核零解释（不进判据）。
    // 同一快照另带回答语言指令行（HOST-I18N-LLM-1/-2），来源 = options.answerLanguage。
    environmentProvider: createVscodeEnvironmentProvider({
      answerLanguage: options.answerLanguage,
    }),
    // 工作区信任态（现读快照）：内核常驻规则层 fail-closed 闸的唯一入参；
    // 缺省 = undefined ⇒ 内核按未信任处理（不读任何常驻正文）
    workspaceTrusted,
    // 脚本执行 node 路径（S3-接续）：用户经 memora.scriptNodePath 显式配置，
    // 内核 run_skill_script / run_project_script 的 node runtime 分支零解释转发
    scriptNodePath: scriptNodePath || undefined,
    // 项目搜索（等价 IDE 全局搜索）——注入后内核暴露 search_project 工具给 LLM；
    // 仅真实工作区注入（无 folder 时 projectSearchRoot 为 undefined → 不注入、工具隐藏，
    // 避免搜索落到 projectPath 兜底根 ~/.memora 答非所问）
    projectSearchProvider: projectSearchRoot
      ? createVscodeProjectSearchProvider(projectSearchRoot)
      : undefined,
    // UI 消息语言：zh 开头传中文覆盖（繁中用户亦得简体框架文字——显式内容供给决策），
    // 其余走内核默认（混合：多数键英文 + 文件头点名的 5 条中文）。选择依据唯一 = options.envLanguage
    messages: pickUiMessages(options.envLanguage),
    // 角色包**只用手动切换**（v0.13：内核已移除自动匹配全链）；切换入口唯一走角色管理视图的
    // agent.switchRolePack，`activeRolePack` 键保留并扩展为 §4.1 解析链第一层。
    // 此处不传 `strategyOverride`：它与「自动匹配」无关——是宿主**产品能力边界**覆盖（内核 types 明示
    // 「本机制保留供宿主能力边界使用」，活着、非废弃）；宿主当前不就任何策略键声明边界，故留空。
    // 覆盖语义：非权限类字段由覆盖值胜出；`toolReadonly` / `toolMode` 只能收紧（`readonly` 严于 `full`、
    // `block` 严于 `allow`）——判据唯一真源 = 内核 `role-pack/strategyResolver.ts` 的 `PERMISSION_FIELD_LENIENCE`。
    // 未来若需从产品侧收紧或调整角色包行为（如强制关 userFollowup），入口即此键。
    // 执行前检查：单用户桌面场景恒放行（intentionally left blank）。
    // 理由：1) VSCode 插件运行在用户本地，天然信任模型；2) 工具审计已由
    // tool_start/tool_result chunk + tool.execute span 承担，不重复记录。
    // ⚠️ 若未来接多用户/服务端部署，必须替换为真实审批策略（权限/路径/只读）。
    preExecutionCheck: () => ({ skip: false }),
    // 可观测性 Tracer（P2：§5.2.1 指纹由 ITracer 承载，宿主采集不落盘）
    tracer: vscodeTracer,
    permission: 'owner',
    // 白名单 = 基准根 projectPath + 用户在 `memora.allowedPaths` 额外允许的目录。
    //
    // ⚠️ 用户级资产目录（`<globalStorage>/skills`、`/role-packs`）**刻意不再并入**：
    // 本轮方向定案为「LLM 只写当前项目 `.memora/` 下的技能与角色包，用户级资产由用户在
    // 设置页点『添加到用户级』复制装载」。用户目录不在白名单内 ⇒ 正常工具路径的写入
    // （`write_file` / `delete_file`）会被基准根判据拒绝；**读取面不受影响**——下方
    // `loadExtraDir(userSkillsDir)` / `loadExtraDir(userRolePacksDir)` 照旧扫描用户目录，
    // 复制过去的资产仍可见、可选中（收回写 ≠ 收回读）。
    // 基准根不可移除；条数上限由内核如实报错，宿主不截断。
    // ⚠️ `run_code` / `run_skill_script` 等任意代码执行面不在本判据射程内（已知不设防），
    // 故对外措辞只能是「正常工具路径不再写用户目录」，不得写成「模型无法写用户目录」。
    allowedPaths: [projectPath, ...(allowedPaths ?? [])],
    // 删后注记（2026-11-05 · 内核 6.0.0 · DEPRECATE-1）：`noOverwriteRoots` 装配期传参已移除——
    // 内核「禁止覆盖根」判据与 `SecurityGuard.setNoOverwriteRoots` 均保留，入口改为运行期；
    // 本宿主不显式启用（用户资产目录本就不在 `allowedPaths`，装配期传参判据不可达）。
    // 写入二次确认已退役（E4 批 4）：不传 confirmWrites ⇒ 内核默认 false ⇒ 界内写直接落盘；
    // 界外仍由 assertPathAllowed 硬拒，拆除确认不放开越界。
    // 脚本/代码执行确认（开则 run_code/run_project_script 执行前询问）
    confirmScripts: confirmScripts ?? false,
    // 禁用技能清单（配置形态启停）：命中技能对 LLM 全链不可用（L1/L2/L3），
    // 宿主 settingsView 依据同名设置标注「已禁用」徽章
    disabledSkills: disabledSkills ?? [],
    // 会话归档模式（用户级设置 memora.archiveMode；undefined → 内核回落 'full'）。
    // 只做透传：默认值与模式判据的真源都在内核（archiveCoordinator.resolveAutoArchiveAllowed），
    // 宿主不重算；运行时切换经 agent.setArchiveMode 热更新（设置面板）。
    archiveMode,
    // GC 自启开关：宿主统一传 false，由 MemoryGcScheduler 单点驱动（E6）；
    // undefined 保持内核默认 true（demo / 独立装配场景自足）
    autoStartGc,
  });

  // 4. 初始化（加载记忆/角色包/会话，注册内置工具）
  await agent.init();

  // 4.1 无缝插话策略（缺口）：宿主「生成中 Enter 输入补充」走 agent.interject()。
  // 单一模式：interject 一律排队、在下一 step 边界并入，
  // 不中断当前 loop 执行——无需再 setInputInterrupt('block')（API 已删除），
  // 默认行为即「申请 → 气口生效」。

  // 5. 加载用户技能（可选，宿主扩展内置技能池）
  // 用户技能与内置技能分离：内置从 configDir/skills/ 扫描，用户从 userSkillsDir 扫描
  if (userSkillsDir) {
    await agent.skills?.loadExtraDir(userSkillsDir);
  }

  // 6. 加载用户角色包（对齐技能系统）
  //
  // extension.ts 经 globalStorageUri/role-packs 传入有效目录，本分支实际执行：
  // 用户可在该目录放置自己的角色包（manifest.json + persona.md/rules.md/skills/），
  // 经内核 RolePackManager.loadExtraDir() 以运行态注入，与内置包同池可切换。
  // 同名冲突按加载顺序裁决（内置 → 用户 → 项目，后加载者胜）。
  if (userRolePacksDir) {
    await agent.rolePacks?.loadExtraDir(userRolePacksDir);
  }

  // 6.1 项目级来源（第三档，必须排在用户之后 ⇒ 同名时项目胜出）
  //
  // 与用户级共用同一注入面（loadExtraDir），不新增扫描器；档位显式传 'project'，
  // 用于内核分账（项目覆盖不统计进用户覆盖）与顺序守卫（项目先加载时拒绝用户反超）。
  // 目录不存在时内核扫描容错为空（首次使用前 .memora/skills 可能尚未创建）。
  if (projectSkillsDir) {
    await agent.skills?.loadExtraDir(projectSkillsDir, 'project');
  }
  if (projectRolePacksDir) {
    await agent.rolePacks?.loadExtraDir(projectRolePacksDir, 'project');
  }

  // 7. 接入 MCP server（用户级设置 memora.mcpServers）
  //
  // 放在 init 之后：工具注册走 agent.tools.registerTool（需要已初始化的执行器），
  // 注册即触发 onToolsChanged → 工具表与 system prompt 自动刷新（宿主不手动重建提示词）。
  // 单个 server 失败只影响它自己；注销出口统一在 host/mcp/runtime.ts（deactivate 调用停机）。
  // allowlist 原值传入、runtime 内解析（fail-closed：读不到合法值 = 全部逐次确认）。
  await startMcpServers(agent, mcpServers ?? [], {
    allowlist: mcpToolAllowlist ?? [],
    logger,
    clientVersion: extensionVersion,
    // 相对路径基准 = 工作区根（用户填 `./server.js` 时的直觉就是"我打开的这个项目"）。
    // 未打开工作区时退回 projectPath（memora 数据目录），至少是稳定的绝对路径而非宿主进程 cwd。
    baseDir: projectSearchRoot ?? projectPath,
  });

  return agent;
}
