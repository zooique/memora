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
 *   - 功能定位：内置角色包（dist/extension/role-packs/ 构建期同步）+ 用户角色包（globalStorageUri/role-packs 运行态注入）
 *   - 日志对接：setLogger(vscodeOutputChannel) 将内核日志导向 VSCode 输出通道
 */
import {
  Agent,
  FetchWebSearchProvider,
  FetchWebFetchProvider,
  setLogger,
  resolveContextWindow,
  buildSearchEndpoints,
} from '@zooique/memora';
import type {
  ISessionStore,
  IRoundStore,
  UIMessages,
  ProviderRouter,
  LlmProvider,
  SearchEngineName,
} from '@zooique/memora';
import type { ILogger } from '@zooique/memora';
// vscode 命名空间类型引用（OutputChannel）：仅类型导入，无运行时依赖（宿主运行时由 VS Code 注入真实模块）
import type { OutputChannel } from 'vscode';
import { join } from 'node:path';
import { createProvider, createBackgroundProvider } from './llmConfig.js';
import { createLocalCodeExecutor } from './codeExecutor.js';
import { createVscodeProjectSearchProvider } from './projectSearchProvider.js';
import { WorkspaceStorage } from './workspaceStorage.js';
import { WorkspaceSessionStore } from './sessionStore.js';
import { vscodeTracer } from './tracer.js';

import type { ProviderStore } from '../providers/providerStore.js';

/**
 * 宿主 UI 消息中文化（P0）
 *
 * UIMessages 全键可选，未覆盖即用内核默认。本对象只覆盖**内核默认非中文、且能到用户眼前**的键；
 * 以下三类刻意不覆盖，各有理由（判据不同，不是遗漏）：
 *   - `softLimitWrapup` / `duplicateToolCallWarning`：内核默认本就是中文，复制一份到宿主即双轨镜像
 *     （内核改文案宿主不跟随），故只依赖内核默认文案；
 *   - `abortedByTimeout`：内核默认虽为英文，但渲染层按 `aborted.stopReason` 重贴中文
 *     （chatView 的 stopReasonLabel：timeout → 「对话处理超时」；内核恒带 stopReason），文案真源在渲染层；
 *   - 已覆盖键中的低频场景（如自审查 selfReviewPrompt）：覆盖后无害——不触发即不消费。
 * ⚠️ 覆盖边界即本清单：内核若新增英文默认的 UI 键，须回来补此处，勿假定「全键已覆盖」。
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
  selfReviewPrompt: () =>
    `\n\n[请审查你上一轮的回答质量（单次终审）]` +
    `\n输出格式（必须遵守）：` +
    `\n- 满意：只输出一句简短确认（如"无需修改"），严禁重复输出完整回答。` +
    `\n- 存在必须改进的判据：才输出改进后的完整回复，不要附加说明。`,
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
   * WorkspaceSessionStore 实例，双实例独立内存、覆盖写同一 sessions.json，
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
   * 同名冲突内置优先（loadExtraDir 跳过重名用户包）。
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
   * 脚本/代码执行确认开关
   *
   * 与 confirmWrites 同模式：开启后 owner 模式 run_code/run_project_script 执行前
   * 触发审批确认；关闭后自动批准。由 extension 从 globalState 读取注入，
   * 运行时经 agent.security.setConfirmScripts() 热更新（设置面板），无需重启。
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
   * 内置网页搜索引擎
   *
   * 由 extension 从 workspace 设置 memora.searchEngine 读取注入（'auto' | 'bing' | 'baidu' | 'sogou'）。
   * auto = 默认降级链（Bing→DuckDuckGo）；选 baidu/sogou 时用户首选引擎在前、Bing 兜底。
   * 修改需重建会话（装配是 activation 期一次性注入）。
   */
  searchEngine?: 'auto' | SearchEngineName;
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
   * VSCode 输出通道（日志对接）
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
    confirmWrites,
    confirmScripts,
    allowedPaths,
    outputChannel,
    disabledSkills,
  } = options;

  // 日志对接 — 宿主注入 OutputChannel 时，创建 ILogger 适配器并注入内核
  if (outputChannel) {
    const logger = createVscodeLogger(outputChannel);
    setLogger(logger);
  }

  // 1. 创建 LLM Provider（宿主注入；优先配置面板的激活 Provider，回退环境变量）
  const provider = await createProvider(providerStore, env ?? process.env);
  // 1.0 创建后台模型 Provider（后台任务走独立轻量模型；未配置回退与实时对话相同）
  const backgroundProvider = await createBackgroundProvider(providerStore);
  // 1.1 创建 Provider 路由策略（激活 AgentLoop 路由缓存优化；单 Provider 时直接返回同一实例）
  const providerRouter = createProviderRouter(provider);

  // 2. 创建工作区记忆存储 + 会话存储（宿主注入持久化）
  const storage = new WorkspaceStorage(projectPath);
  storage.load();
  // 设定记忆存量清理（R4 迁移出口）：persona/rule/skill 存量行软删出记忆库，幂等无残留即零动作
  storage.migrateRetiredSettingSources();
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
  // （LlmProviderConfig.contextWindow，由配置面板开放编辑）；未配置回落内核默认 120K（默认非真理源）。
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
    // 记忆数据目录 = 工作区 .memora（注册表/锁文件落盘处，与存储同目录）
    dataDir: join(projectPath, '.memora'),
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
    // 后台模型 Provider（摘要/归档/润色/去重等后台任务走独立轻量模型；undefined 回退前台）
    backgroundProvider,
    storage,
    sessionStore: store,
    // 问答闭环存储（round-based 模式，传入后内核启用独立 Round 存储）
    roundStore,
    // 网络搜索（memora.searchEngine 可切换内置引擎；auto = Bing→DuckDuckGo 默认链，
    // 选 baidu/sogou 时用户首选引擎在前、Bing 兜底——国内可达且解析稳定）
    webSearchProvider: new FetchWebSearchProvider(
      options.searchEngine && options.searchEngine !== 'auto'
        ? buildSearchEndpoints([options.searchEngine, 'bing'])
        : undefined,
    ),
    // 网页抓取（补「搜索→抓取」闭环第二段；Node 内置 fetch 开箱即用，零依赖）
    fetchProvider: new FetchWebFetchProvider(),
    // 代码执行（local vm 沙箱，受限计算能力）——注入后内核暴露 run_code 工具给 LLM
    codeExecutionProvider: createLocalCodeExecutor(),
    // 项目搜索（等价 IDE 全局搜索）——注入后内核暴露 search_project 工具给 LLM；
    // 仅真实工作区注入（无 folder 时 projectSearchRoot 为 undefined → 不注入、工具隐藏，
    // 避免搜索落到 projectPath 兜底根 ~/.memora 答非所问）
    projectSearchProvider: projectSearchRoot
      ? createVscodeProjectSearchProvider(projectSearchRoot)
      : undefined,
    // UI 消息中文化（P0：覆盖内核的英文默认文案；**覆盖边界**见 CHINESE_MESSAGES 注释，勿当全键覆盖）
    messages: CHINESE_MESSAGES,
    // 角色包**只用手动切换**（v0.13：内核已移除自动匹配全链）；切换入口唯一走角色管理视图的
    // agent.switchRolePack，`activeRolePack` 键保留并扩展为 §4.1 解析链第一层。
    // 此处不传 `strategyOverride`：它与「自动匹配」无关——是宿主**产品能力边界**覆盖（内核 types 明示
    // 「本机制保留供宿主能力边界使用」，活着、非废弃）；宿主当前不就任何策略键声明边界，故留空。
    // 未来若需从产品侧压过角色包声明（如强制关 userFollowup），入口即此键。
    // 执行前检查：单用户桌面场景恒放行（intentionally left blank）。
    // 理由：1) VSCode 插件运行在用户本地，天然信任模型；2) 工具审计已由
    // tool_start/tool_result chunk + tool.execute span 承担，不重复记录。
    // ⚠️ 若未来接多用户/服务端部署，必须替换为真实审批策略（权限/路径/只读）。
    preExecutionCheck: () => ({ skip: false }),
    // 可观测性 Tracer（P2：§5.2.1 指纹由 ITracer 承载，宿主采集不落盘）
    tracer: vscodeTracer,
    permission: 'owner',
    // 白名单 = 基准根 projectPath + 用户额外允许目录（运行时可热更新，基准根不可移除）
    allowedPaths: [projectPath, ...(allowedPaths ?? [])],
    // 写入二次确认（用户级安全偏好；开启后 owner 写文件前触发审批确认）
    confirmWrites: confirmWrites ?? false,
    // 脚本/代码执行确认（与写入确认同模式，开则 run_code/run_project_script 执行前询问）
    confirmScripts: confirmScripts ?? false,
    // 禁用技能清单（配置形态启停）：命中技能对 LLM 全链不可用（L1/L2/L3），
    // 宿主 settingsView 依据同名设置标注「已禁用」徽章
    disabledSkills: disabledSkills ?? [],
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
  // 同名冲突时「内置优先」（loadExtraDir 内部跳过重名用户包）。
  if (userRolePacksDir) {
    await agent.rolePacks?.loadExtraDir(userRolePacksDir);
  }

  return agent;
}
