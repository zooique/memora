/**
 * Memora — VS Code 插件入口（memora 通用落地宿主）
 *
 * 职责：
 *   - 注册侧栏对话视图 + 设置面板（editor tab）+ 通用命令（打开对话 / 打开设置 / 配置大模型）
 *   - 按会话懒装配 Agent（`AgentRegistry.createAgentForSession`，会话 → 实例唯一真源）
 *
 * 结构（通用化设计，功能定位由内置角色包承载）：
 *   - commands/   命令处理器（薄壳：装配 + 聚焦，核心逻辑全部由内核 + 角色包承载）
 *   - host/       薄壳装配（注入 memora 内核）
 *   - role-packs/ 内置角色包（构建期从内核 role-packs/ 同步，见 esbuild.config.mjs）
 *   - webview/    面板 UI（仅 postMessage）
 *   - shared/     extension ↔ webview 消息协议
 */
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Agent, ArchiveMode, IRoundStore, IMemoryStorage } from '@zooique/memora';
// GC 周期单点驱动取内核常量（不复制 24h 字面量）
import { AGENT_CONSTANTS } from '@zooique/memora';
import { assembleAgent, createVscodeLogger, type AssembleOptions } from './host/assemble.js';
import { createHostMemoryStorage } from './host/memoryStorage.js';
import { resolveProjectDataDir } from './host/projectDataDir.js';
import { WorkspaceSessionStore } from './host/sessionStore.js';
import { readSessionRolePackName } from './host/sessionRolePack.js';
import { WorkspaceRoundStore, DEFAULT_SWEEP_MIN_AGE_MS } from './host/workspaceRoundStore.js';
import { WorkspaceSessionViewLoader } from './host/sessionViewLoader.js';
import { AgentRegistry } from './host/agentRegistry.js';
import { broadcastRolePackTeams } from './host/rolePackTeams.js';
import { attachRolePackCatalog } from './host/rolePackCatalog.js';
import { MemoryGcScheduler } from './host/memoryGcScheduler.js';
import { ImageCache } from './host/imageCache.js';
import { ProviderStore } from './providers/providerStore.js';
import { MemoraChatViewProvider } from '../webview/panels/chatPanel.js';
import { formatDiagnosticsSnapshot } from '../webview/panels/hostDiagnostics.js';
import { MemoraSettingsPanel } from '../webview/panels/settingsPanel.js';
// 设置面板 tab 标识的类型真源（`shared/settingsTabs.ts`）：命令参数与 protocol 共用同一联合，
// 本文件不手写字面量清单（加一页不必回来补签名）
import type { SettingsTab } from '../shared/settingsTabs.js';
import { openChatCommand } from './commands/openChat.js';
import { runDemoCommand } from './commands/demo.js';
import { reloadSkillsCommand } from './commands/reloadSkills.js';
import { cleanupMemoriesCommand, memoryStatsCommand, runGcCommand } from './commands/memory.js';
import { registerRegisterWorkCommand } from './commands/registerWork.js';
import { registerResidentRuleCommands } from './commands/residentRules.js';
// 作品投影：侧边栏 TreeView 已退役，清单变更由 notifier 回推设置页「作品和规则」选项卡
import { notifyWorkProjectionChanged } from './host/workProjectionBridge.js';
import { addToChatCommand } from './commands/addToChat.js';
import { createUserDataResetHandler } from './commands/userDataReset.js';
import { importAssetCommand } from './commands/importAsset.js';
import { readDisabledSkills, syncDisabledSkills } from './host/skillSync.js';
import {
  projectAssetDirsFor,
  applyGrantedWorkspaceTrust,
  readWorkspaceTrusted,
  type ProjectAssetDirs,
} from './host/userAssets/projectScope.js';
import { FileChangeTracker } from './host/fileChangeTracker.js';
import { FileChangeView } from './host/fileChangeView.js';
import { stopMcpServers, applyMcpConfigChange } from './host/mcp/runtime.js';
import { readMcpServers, readMcpToolAllowlist } from './mcpConfig.js';
import {
  CONFIRM_SCRIPTS_KEY,
  ROLE_PACK_TEAMS_KEY,
  USER_SKILLS_DIR_NAME,
  USER_ROLE_PACKS_DIR_NAME,
} from '../shared/constants.js';
import type { CustomSearchEngineConfig } from '../shared/protocol.js';

/**
 * 解析工作区持久化根路径（SSOT，extension 与 assemble 共用同一来源）
 *
 * 取当前工作区文件夹路径；未打开工作区时回退用户主目录（绝对路径），
 * 避免 `join('', '.memora', ...)` 生成相对路径 `.memora/...` 写到错误位置
 * （相对路径基于进程 cwd，VS Code 扩展宿主 cwd 不可控，会导致会话文件写丢）。
 */
function resolveWorkspacePath(): string {
  // 兜底根同样经数据目录单点取（字面量只许在 projectDataDir.ts；此处行为与旧 join 逐字节相同）
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? resolveProjectDataDir(homedir());
}

/**
 * 解析项目搜索根（仅真实工作区注入）
 *
 * 存在真实工作区文件夹时返回其路径（workspaceFolders[0].fsPath），
 * 否则返回 undefined —— 未打开工作区时无「当前项目」可搜，不注入 search_project 工具
 * （避免搜索落到 resolveWorkspacePath 的兜底根 ~/.memora，答非所问）。
 */
function resolveProjectSearchRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * 会话 → Agent 登记表（模块级引用；供 deactivate 关闭**全部**实例）
 *
 * 生产唯一取用面：面板 / 命令 / 设置面板 / 信任门 / 配置热更一律经它（单实例引用已删）。
 */
let hostAgentRegistry: AgentRegistry | null = null;

/**
 * 孤儿 Round GC 的单点调度器（一个宿主进程只有一份）
 *
 * 内核 Agent 一律 `autoStartGc: false`、只登记不启动；周期扫描仅由本调度器驱动，避免 N 份重复扫描。
 */
let gcScheduler: MemoryGcScheduler | null = null;

/**
 * 激活期会话存储单例的模块级引用（仅用于停用时释放跨进程会话锁）
 *
 * 会话锁是进程级 OS 句柄：不释放别的窗口永远打不开该会话；`deactivate` 原本拿不到局部
 * `sessionStore`，锁只能等进程退出才由 OS 回收。
 */
let hostSessionStore: WorkspaceSessionStore | null = null;

/**
 * 激活期记忆存储单例的模块级引用（所有权归宿主，停用时由宿主关闭）
 *
 * 多 Agent 共享同一实例（共存储共记忆）；内核 `ProjectManager` 只借用、不关闭，
 * 因此「关掉一个会话 Agent」不会把其他实例的库关掉。懒建：首次装配才打开 DB，
 * 打开失败的时机与现状一致（落在装配错误路径，而不是激活期把插件拖死）。
 */
let hostMemoryStorage: IMemoryStorage | null = null;

/**
 * 扩展版本号（MCP 客户端握手时上报给 server，仅作遥测，不参与任何判据）
 * activate 时从扩展清单取值——版本号唯一真源是 package.json，宿主不另存常量
 * （另存一份必然与发版数字漂移）。activate 前为空串，此时 MCP 尚未装配，不影响使用。
 */
let extensionVersion = '';

/**
 * 读取「允许路径白名单」配置（唯一读取点）
 *
 * 两处消费共用：① 装配期注入；② 配置变更监听（settings.json 手改 / Settings Sync 落地）。
 * 键名与默认值只在此处写一次，避免两处各存一份后改一处漏一处。
 */
function readAllowedPaths(): string[] {
  return vscode.workspace.getConfiguration('memora').get<string[]>('allowedPaths', []);
}

/**
 * 读取「会话归档模式」配置（唯一读取点）
 *
 * 两处消费共用：① 装配期注入；② 配置变更监听。默认值与 package.json 的
 * `memora.archiveMode.default` 保持一致（'full'）——恢复默认时热更新也要切回 full。
 */
function readArchiveMode(): ArchiveMode {
  return vscode.workspace.getConfiguration('memora').get<ArchiveMode>('archiveMode', 'full');
}

/**
 * 对「已装配的 Agent」执行一次配置热更新动作
 *
 * 真源约束（与 syncDisabledSkills 的注释同源）：**不触发懒装配**——配置变更若发生在
 * 面板未开 / Agent 未装配时，下次装配本就会按新配置注入，不该为「改一次设置」付
 * 整个 Agent 装配成本。失败降级为日志：配置已落盘，下次装配仍会读到新值，
 * 不能打断用户当前操作。
 *
 * @param action   热更新动作（可异步：返回 Promise 时本函数等待其完成，失败同样降级为日志）
 * @param failLabel 失败日志标签（区分是哪条配置的同步失败）
 */
function runOnAssembledAgent(
  action: (agent: Agent) => void | Promise<void>,
  failLabel: string,
): void {
  void (async () => {
    // 遍历登记表：多会话下「所有已装配实例」都可能持有该配置的镜像，
    // 只同步「当前那台」会让后台会话读到旧配置（静默分叉，无测试会红）
    const agents = hostAgentRegistry?.list() ?? [];
    for (const agent of agents) {
      await action(agent);
    }
  })().catch((err) => {
    console.warn(`Memora ${failLabel}失败`, err);
  });
}

/**
 * 装配期稳定依赖（activate 内采样一次）：只服务按会话装配（`assembleAgentForSession`），
 * 杜绝「每处各写一套选项」导致行为漂移（E4 验收判据「选项键快照」）。
 */
interface AssemblyDeps {
  /** 大模型配置存储 */
  providerStore: ProviderStore;
  /** 会话存储单例（SSOT：与 UI 面板共享，杜绝双实例覆盖写） */
  sessionStore: WorkspaceSessionStore;
  /** 问答闭环存储单例（与 sessionStore 同一项目） */
  roundStore: IRoundStore;
  /** vscode 全局状态（用户级偏好：角色组 teams / 脚本确认开关；**不含角色包激活态**，后者随会话文件落盘） */
  globalState: vscode.Memento;
  /** 插件内置配置目录（由 extensionUri 显式定位） */
  configDir: string;
  /** 图片字节缓存（激活期单例） */
  imageCache: ImageCache;
  /** 用户技能目录（可选） */
  userSkillsDir?: string;
  /** 用户角色包目录（可选，与内置包同池注入） */
  userRolePacksDir?: string;
  /** 输出通道（日志对接） */
  outputChannel?: vscode.OutputChannel;
  /** 项目级来源目录（调用时现读信任状态：未受信任返回空） */
  readProjectDirs: () => ProjectAssetDirs;
  /** 记忆存储单例（懒建；所有会话 Agent 共用此同一对象，所有权归宿主） */
  storage: () => IMemoryStorage;
}

/**
 * 唯一的装配选项构建点
 *
 * 所有装配入口（单实例 / 按会话）都经此函数产出 `AssembleOptions`：**静态选项键**只在此处
 * 写一次，新增字段不会漏传某一路（防「单实例能用、会话实例少注入」）。会话级的
 * `activeRolePack` 需 sessionId，由 `assembleAgentForSession` 装配前注入。
 *
 * @param projectPath 工作区路径
 * @param deps 装配期稳定依赖
 */
function buildAssembleOptions(projectPath: string, deps: AssemblyDeps): AssembleOptions {
  // 角色包激活状态是**会话级**（方案 A，2026-11-06 定案）：装配不再从 globalState 读「上次
  // 全局选择」当默认值——那会让新会话偷偷继承别的会话的选择。未注入时内核 §4.1 单链落兜底包，
  // 这就是「新会话默认角色」的唯一真源；会话内的角色切换只走该会话 agent 的 switchRolePack。
  // 读取角色包组（会议名单，用户级数据；无记录为空数组）
  const rolePackTeams =
    deps.globalState.get<{ leader: string; members: string[] }[]>(ROLE_PACK_TEAMS_KEY) ?? [];
  // 写文件一律直接落盘（E4 批 4）：不再读写入确认开关 —— 界内写在前后台一致地直接执行；
  // 界外仍是**硬拒**（`assertPathAllowed`），拆除确认不会放开越界写。guest 语义留在内核公开面。
  // 读取脚本/代码执行确认开关（用户安全偏好；默认 false → owner 脚本执行自动批准）
  const confirmScripts = deps.globalState.get<boolean>(CONFIRM_SCRIPTS_KEY) ?? false;
  // 读取白名单额外路径（用户级设置，机器级目录信任；项目目录基准根恒在，此处仅含额外路径）
  const allowedPaths = readAllowedPaths();
  // 内置网页搜索引擎（memora.searchEngine 设置；'auto' = Bing→DuckDuckGo 默认链，亦可为自定义引擎名）
  const searchEngine = vscode.workspace
    .getConfiguration('memora')
    .get<string>('searchEngine', 'auto');
  // 用户自定义搜索引擎清单（memora.customSearchEngines 设置）
  const customSearchEngines = vscode.workspace
    .getConfiguration('memora')
    .get<CustomSearchEngineConfig[]>('customSearchEngines', []);
  // 会话归档模式（memora.archiveMode 设置；'full'=自动归档允许，'manual'=仅手动）。
  // 装配期一次性注入内核 AgentOptions.archiveMode；运行时切换走配置变更监听
  // （agent.setArchiveMode，繁忙顺延）——设置面板与直接改 settings.json 同一路径。
  const archiveMode = readArchiveMode();
  // 禁用的技能名清单（配置形态启停）：命中技能对 LLM 全链不可用
  // （L1 清单 / list_skills / read_skill / L3 全不可达）。此处只是**装配期快照**；
  // 用户改设置由 activate 内的配置监听实时重设，无需重新装配。
  const disabledSkills = readDisabledSkills();
  // 脚本执行 node 路径（S3-接续）：用户显式配置的 node 可执行文件绝对路径；
  // 空/未配置 = 不注入（内核走 'node' PATH 查找）。修改需重建会话（装配期一次性注入）。
  const scriptNodePath = vscode.workspace
    .getConfiguration('memora')
    .get<string>('scriptNodePath', '');
  // 项目级来源（仅工作区受信任时非空；信任门在 activate 采样，调用时现读）
  const projectDirs = deps.readProjectDirs();

  return {
    projectPath,
    // 项目搜索根 = 真实工作区文件夹（无 folder 时 undefined → 不注入 search_project）
    projectSearchRoot: resolveProjectSearchRoot(),
    providerStore: deps.providerStore,
    sessionStore: deps.sessionStore,
    roundStore: deps.roundStore,
    rolePackTeams,
    configDir: deps.configDir,
    searchEngine,
    customSearchEngines,
    archiveMode,
    // E6：GC 不自启——周期扫描由宿主 MemoryGcScheduler 单点驱动（见 assembleAgentForSession 尾部）
    autoStartGc: false,
    userSkillsDir: deps.userSkillsDir,
    userRolePacksDir: deps.userRolePacksDir,
    // 项目级来源（仅信任时非空；顺序由 assemble 保证 user → project 后加载者胜）
    projectSkillsDir: projectDirs.skills,
    projectRolePacksDir: projectDirs.rolePacks,
    // 工作区信任态现读（非 activate 采样）；漏传 ⇒ 常驻层恒关且所有测试仍全绿
    workspaceTrusted: readWorkspaceTrusted(),
    confirmScripts,
    allowedPaths,
    disabledSkills,
    scriptNodePath: scriptNodePath || undefined,
    // MCP server（用户级设置；装配末尾接入并注册工具，失败只影响该 server）
    mcpServers: readMcpServers(),
    // MCP 工具免确认 allowlist（同名寻址键，按原名；空 = 全部逐次确认）
    mcpToolAllowlist: readMcpToolAllowlist(),
    extensionVersion: extensionVersion || undefined,
    // 图片解析器（IMG-2 §5.4）：运行时回调，与能力位 supportsVision 一起才构成可用视觉链
    imageResolver: deps.imageCache.resolver,
    outputChannel: deps.outputChannel,
    // 记忆存储单例（多 Agent 共享同一对象；所有权归宿主，close 单个实例不关它）
    storage: deps.storage(),
  };
}

/**
 * 取当前时刻的「命令作用会话」标识
 *
 * 命令（记忆统计 / 整理 / 角色刷新等）没有会话入参：作用对象 = 面板**正在显示**的会话；
 * 面板尚未初始化时退回存储里的启动会话。二者都为空 ⇒ 命令侧拒绝（不凭空造会话）。
 *
 * @param chatProvider 对话面板（当前会话的唯一真源）
 * @param sessionStore 会话存储（启动会话兜底）
 */
function resolveCommandSessionId(
  chatProvider: MemoraChatViewProvider,
  sessionStore: WorkspaceSessionStore,
): string {
  return chatProvider.getCurrentSessionId() || sessionStore.getInitialSessionId();
}

/**
 * 按会话装配 Agent（E4 批 2：生产唯一装配面）
 *
 * - 存储：由 `deps` 提供共享单例（sessionStore / roundStore / 记忆存储 = 同一对象）
 * - 会话归属：装配后 `switchToSession(sessionId)` 真正切到目标会话（载入该会话消息、
 *   重建工作记忆），而不是「装出来还停在 today-main」
 * - 失败不留半成品：绑定失败即关闭刚装配的实例，避免锁 / 定时器泄漏
 * - 复用 / 在途去重 / 登记：归 `AgentRegistry.createAgentForSession`
 *
 * @param projectPath 工作区路径（一个宿主 = 一个项目）
 * @param sessionId 目标会话标识（内核 `MessageHistory.currentSessionName` 口径）
 * @param deps 装配期稳定依赖
 */
async function assembleAgentForSession(
  projectPath: string,
  sessionId: string,
  deps: AssemblyDeps,
): Promise<Agent> {
  // 会话级角色包（方案 A）：按会话文件读回名字快照；解析不到由内核 §4.1 落兜底包，
  // 宿主侧由 chatPanel.bindAgent 读同一份 meta 发可见提示（不许静默回落）。
  const options = buildAssembleOptions(projectPath, deps);
  options.activeRolePack = readSessionRolePackName(deps.sessionStore, sessionId);
  const agent = await assembleAgent(options);
  try {
    // getter 类型为可空（未初始化时 null）；此处刚装配完成，为空即内部状态异常
    const sessionManager = agent.sessionManager;
    if (!sessionManager) throw new Error('Agent 装配完成但 sessionManager 为空，无法绑定会话');
    // 生产会话切换走 switchToSession：同时载入该会话消息并重建工作记忆
    await sessionManager.switchToSession(sessionId);
  } catch (err) {
    // 装配成功但绑定失败：按 Agent 生命周期关掉，不留半成品
    await agent.close().catch(() => {});
    throw err;
  }
  // E6：GC 单点驱动——全部实例共享同一对存储单例（E3），任一实例 scan 即覆盖全量。
  // 驱动实例**现取登记表首个存活实例**、不持有引用：删除会话会 close 实例，持有引用会让
  // 周期扫描打到已关闭的 Agent（静默失效）。调度器全局只建一份、启动幂等；后续实例只登记
  // 不再各起定时器（内核侧 autoStartGc:false 已保证）。
  gcScheduler ??= new MemoryGcScheduler(() => hostAgentRegistry?.list()[0]?.gcNow());
  gcScheduler.startPeriodic(AGENT_CONSTANTS.GC_INTERVAL_MS);
  return agent;
}

/** 插件激活入口 */
export function activate(context: vscode.ExtensionContext): void {
  // 扩展版本（MCP clientInfo 遥测用）：取扩展清单，版本号唯一真源 = package.json
  extensionVersion = context.extension.packageJSON.version;
  // 创建日志输出通道 —— 内核日志将导向此通道，用户可在 VS Code 输出面板查看
  const memoraOutput = vscode.window.createOutputChannel('Memora');
  context.subscriptions.push(memoraOutput);

  // 大模型配置存储（providerStore 供配置面板 + Agent 装配共用）
  const providerStore = new ProviderStore(context.secrets);
  // 一次性迁移：工作区 settings.json 旧 Provider 配置 → 用户级
  // （避免 Workspace 优先级覆盖 Global 新配置导致不生效）
  void providerStore.migrateFromWorkspace();
  // 一次性迁移：旧全局 memora.maxContextTokens → 首个 Provider 的 contextWindow
  // （窗口上限为 per-LLM 配置，全局键仅作迁移来源；见架构决策）
  void providerStore.migrateMaxContextTokens();

  // 图片字节缓存（激活期单例，IMG-2 §5.4.1）：会话加载期预读填字节 → Provider 的
  // imageResolver 同步查表出 data URL；与工作区无关（跨会话复用）。
  const imageCache = new ImageCache();

  // 插件内置配置目录（SSOT）：从 extensionUri 显式定位，
  // 指向 dist/extension（role-packs 等资源所在）。若在 assemble 内用 import.meta.url
  // 相对推断，esbuild bundle 后路径漂移会导致内置角色包加载为 0（坑）。
  const configDir = join(context.extensionUri.fsPath, 'dist', 'extension');

  // 用户技能目录：使用 VS Code 全局存储目录
  // 路径示例：C:\Users\SJ\AppData\Roaming\Code\User\globalStorage\zooique.memora-vscode\skills\
  // 与内置技能分离，支持用户独立管理；目录不存在时自动创建
  // （目录名常量 USER_SKILLS_DIR_NAME 与「初始化」清空目标共用，禁散落字面量）
  const userSkillsDir = join(context.globalStorageUri.fsPath, USER_SKILLS_DIR_NAME);
  void mkdir(userSkillsDir, { recursive: true }).catch(() => {
    // 目录创建失败不阻塞插件启动，用户技能功能不可用而已
  });

  // 用户角色包目录（对齐技能系统）：内置（dist/extension/role-packs/，构建期同步）
  //   + 用户（globalStorageUri/role-packs/，运行态经 loadExtraDir() 注入同池）。用户放入
  //   manifest.json + persona.md/rules.md/skills/ 即生效；同名按加载顺序裁决（内置 → 用户 → 项目）。
  // （目录名常量 USER_ROLE_PACKS_DIR_NAME 与「初始化」清空目标共用，禁散落字面量）
  const userRolePacksDir = join(context.globalStorageUri.fsPath, USER_ROLE_PACKS_DIR_NAME);
  void mkdir(userRolePacksDir, { recursive: true }).catch(() => {
    // 目录创建失败不阻塞插件启动
  });

  // ─── 项目级来源目录（第三来源，优先级 项目 > 用户 > 内置）───
  //
  // **目录推导与信任判定只在 `projectAssetDirsFor` 一处发生**（本文件不再拼目录）：
  // 此前这里另有一处 `resolveProjectDataDir + join(...)` 推导，与信任判定分散两处，
  // 任一处改口径另一处静默走旧值（B 修复：单点化）。
  // ⚠️ **多根工作区只取 folders[0]**：与 resolveWorkspacePath 同一取根口径；
  //    其余根的 .memora 目录不扫描（限制见 CHANGELOG）。
  // 信任门：**只有工作区受信任时才注入**——未信任工作区的 .memora 内容属「未审代码」形态
  //   （可携带技能/角色包提示词），不扫描即不进入模型上下文。判据每次调用现读
  //   （`isTrusted` 可运行期变化；授予信任后由监听器补注入）。
  /** 项目级目录的唯一读取入口（调用时现读信任状态与工作区根） */
  const readProjectAssetDirs = (): ProjectAssetDirs =>
    projectAssetDirsFor({
      isTrusted: readWorkspaceTrusted(),
      workspaceFolderPath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });
  // 激活期的目录快照（供面板展示用；运行期补注入时再读一次并回推面板—见信任监听器）
  const projectDirsAtActivation = readProjectAssetDirs();
  const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];

  // 未信任可见提示（状态栏）：只提示、不阻断对话——用户可随时「信任工作区」后即时生效
  const trustNotice = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  trustNotice.text = '$(shield) Memora：项目级资产未启用';
  trustNotice.tooltip =
    '工作区未受信任，Memora 不读取项目级技能/角色包（.memora/）。信任后自动生效。';
  trustNotice.command = 'workbench.action.manageTrust';
  context.subscriptions.push(trustNotice);
  /** 刷新信任提示显隐（真源 = vscode.workspace.isTrusted，不自存状态副本） */
  const syncTrustNotice = (): void => {
    if (firstWorkspaceFolder && !readWorkspaceTrusted()) {
      trustNotice.show();
    } else {
      trustNotice.hide();
    }
  };
  syncTrustNotice();

  // 侧边栏视图：对话面板（sessionStore 与 assemble 同路径 .memora/sessions/）
  const workspacePath = resolveWorkspacePath();

  /**
   * 统一取 Agent 入口（**唯一调用面**，E4 批 2）
   *
   * 取用面一律带会话归属：命令/设置面板没有会话入参 ⇒ 作用对象 = 面板当前显示的会话
   * （面板未初始化时退回存储的启动会话）。**不经任何单实例缓存**——复用/在途/登记
   * 全在 `AgentRegistry.createAgentForSession`，宿主不得在登记表之外再存一份实例。
   *
   * @param _projectPath 工作区路径（工作区在 activate 时已固定，保留形参兼容既有调用点）
   */
  const getAgent = (_projectPath: string): Promise<Agent> => {
    const sessionId = resolveCommandSessionId(chatProvider, sessionStore);
    if (!sessionId) {
      // 无任何会话 ⇒ 没有可归属的 Agent；显式拒绝，避免「装出来挂在空会话上」
      return Promise.reject(new Error('尚未创建任何会话，无法装配 Agent'));
    }
    return agentRegistry.createAgentForSession(sessionId);
  };

  /**
   * 命令侧取 Agent：装配失败返 null（**不抛错**）
   *
   * 与 `getAgent` 刻意分开：命令的目标是「给用户一条提示」，装配失败属预期路径，
   * 不该让每个命令各写一遍 try/catch；而面板工厂需要异常冒泡以便如实回执。
   * 工作区根的回退规则（无工作区 → home/.memora）由 workspacePath 单点持有。
   */
  const tryGetAgent = async (): Promise<Agent | null> => {
    try {
      return await getAgent(workspacePath);
    } catch {
      return null;
    }
  };

  // 启动清扫暂存的孤儿 Round ID（清扫 → 摘要软删的「对称的另一半」）：
  // 清扫发生在 activate（Agent 尚未装配），此处暂存被清扫 Round，待 Agent 首次就绪后
  // 延迟联动软删其 round-summary 摘要。单进程内一次性消费（splice 清空）；进程退出前
  // 未消费则暂存丢失——物理轮已被删、摘要保持「无溯源独立记忆」，不构成数据错误
  // （该形态为合法降级，且下一轮启动清扫/GC 无重复对象）。
  const pendingSweptRoundIds: string[] = [];

  // Round-based 存储层（SSOT：WorkspaceSessionStore 与 Agent 共享同一 WorkspaceRoundStore 实例，
  // 杜绝双实例覆盖写 / 缓存漂移——否则 UI 重载历史读不到 Agent 刚写入的 Round）
  const roundStore = new WorkspaceRoundStore(workspacePath);
  roundStore.load();
  const sessionStore = new WorkspaceSessionStore(workspacePath, roundStore);
  sessionStore.load();
  // 模块级引用交给 deactivate（停用路径释放跨进程锁的唯一入口）
  hostSessionStore = sessionStore;
  // 跨进程写锁启用：两个 VS Code 窗口（各自一个 extension host 进程）同时打开会话时，
  // 第二个写者被明确拒绝而不是静默覆盖。锁名含工作区路径哈希，跨工作区互不误挡；
  // 迁移/打捞在 load() 内直接写盘（不经过写断言），故必须在 load() 之后启用。
  sessionStore.enableCrossProcessLock();

  /**
   * 记忆存储单例（懒建，所有权归宿主）
   *
   * 首次装配才打开 DB：打开失败的时机与现状一致（落在装配错误路径），
   * 不会把 activate 拖死；此后所有会话 Agent 共用这一对象（共存储共记忆）。
   */
  const getMemoryStorage = (): IMemoryStorage => {
    hostMemoryStorage ??= createHostMemoryStorage(workspacePath, createVscodeLogger(memoraOutput));
    return hostMemoryStorage;
  };

  // 装配期稳定依赖：单实例路径与按会话路径共用同一份（选项唯一构建点 = buildAssembleOptions）
  const assemblyDeps: AssemblyDeps = {
    providerStore,
    sessionStore,
    roundStore,
    globalState: context.globalState,
    configDir,
    imageCache,
    userSkillsDir,
    userRolePacksDir,
    outputChannel: memoraOutput,
    // 信任门判据在**调用时**读取（workspace.isTrusted 可运行期变化）：
    // 未信任 ⇒ 返回空目录对，装配不注入项目级；授予信任后由监听器补注入。
    readProjectDirs: readProjectAssetDirs,
    storage: getMemoryStorage,
  };

  // 会话 → Agent 登记表（E4 批 2：生产唯一取用面）。构造参数强制传入
  // **同一对**存储单例——这来自 E3 实证的硬约束（各建一份 roundStore ⇒ `rounds/index.json`
  // 覆盖写丢视图），登记表自身不得新建存储；工厂只负责「装一个属于该会话的实例」。
  const agentRegistry = new AgentRegistry(
    { sessionStore, roundStore },
    // 工厂：共享存储单例由 assemblyDeps 提供；会话归属在装配后 switchToSession 落实。
    (sessionId) => assembleAgentForSession(workspacePath, sessionId, assemblyDeps),
  );
  // 模块级引用供 deactivate 关闭全部实例（停用路径拿不到 activate 局部变量）
  hostAgentRegistry = agentRegistry;

  /** 同步探视指定会话的已登记实例（无参 = 当前显示会话；**不触发装配**） */
  const peekAgent = (sessionId?: string): Agent | undefined => {
    const id = sessionId ?? resolveCommandSessionId(chatProvider, sessionStore);
    return id ? agentRegistry.get(id) : undefined;
  };
  /** 当前显示会话 id（设置面板按会话解绑监听的判据；与 `getAgent` 同一解析） */
  const resolveSessionId = (): string | undefined =>
    resolveCommandSessionId(chatProvider, sessionStore) || undefined;

  // 孤儿清扫（无会话引用 Round 统一回收）：删除会话/截断后遗留的无引用轮
  // 在启动时清理，防磁盘膨胀与「无引用卡片滞留」（引用归 SessionStore、物理归 RoundStore）。
  // 🔴 必须在 sessionStore.load() **之后**执行：判据 = 「不在任何会话 roundIds 中」，
  // 由 sessionStore.referencedIds() 现场派生（构造时已注入 provider），不读 Round.refCount。
  // 存活保护必须显式带上：刚失去引用的轮给 24h 后悔窗口，无保护会立即移入回收站。
  const sweptIds = roundStore.sweepOrphans(DEFAULT_SWEEP_MIN_AGE_MS);
  if (sweptIds.length > 0) {
    console.info(`Memora 启动清扫无引用问答闭环 ${sweptIds.length} 条`);
    // 对称的另一半：被清扫轮的 round-summary 摘要暂存，
    // 待 Agent 装配后延迟联动软删——清扫发生在启动时 Agent 尚未装配，无法直接访问记忆库。
    // 详见 setAgentFactory 处的消费逻辑。
    pendingSweptRoundIds.push(...sweptIds);
  }

  // 视图加载器：将 Session（Round ID 列表）+ RoundStore 组合为完整视图
  const viewLoader = new WorkspaceSessionViewLoader(roundStore, sessionStore);

  const chatProvider = new MemoraChatViewProvider(
    context.extensionUri,
    sessionStore,
    providerStore,
    // 工作区根单点传入（chatPanel 不自算；附件预览 roots 由此推导）
    workspacePath,
    // 图片缓存（会话回放前预读窗口内附件字节；与 Agent 的 imageResolver 同一实例）
    imageCache,
  );
  // 注入 Round-based 视图加载器（用于加载 round-based 会话的历史消息）
  // 未注入时 chatPanel 仅支持 legacy 模式（向后兼容）
  chatProvider.setViewLoader(viewLoader);
  // 注入过程事件落盘目标（v1.5）：与 viewLoader 同一 WorkspaceRoundStore 单例，生命周期原子一致
  chatProvider.setRoundStore(roundStore);

  // ─── 文件改动可视化（host-only，零内核改动；见 docs/方案-文件改动diff可视化-20260926.md）───
  // 记录归属 extension 激活期单例（工作区级），独立于聊天会话存在；旧内容走内存虚拟文档（零落盘）。
  // 「回退本文件改动」经 agent.security.assertPathAllowed 校验 + 宿主原子写（判据与内核守门同源）。
  const fileChangeTracker = new FileChangeTracker(workspacePath);
  const fileChangeView = new FileChangeView(fileChangeTracker, {
    // 同步取「面板正在显示的会话」实例的守卫：回退动作作用于当前视图，不能取任意后台实例
    getSecurityGuard: () => chatProvider.getCurrentAgent()?.security ?? undefined,
    // 写入确认已退役：不再注入 isConfirmWrites（改动自动打开即唯一呈现）
    // 诊断日志：装饰/打开/恢复的失败必须留痕（真机曾因静默吞异常导致「打开了但看不出改了哪里」无从定位）
    log: (message) => memoraOutput.appendLine(message),
  });
  fileChangeView.register(context);
  chatProvider.setFileChangeSink(fileChangeView);
  // 未确认改动集变化 → 推给对话区常驻条；webview ready 时 chatPanel 会主动补推一次
  // （两个时机缺一即漏面：只推变化 ⇒ 面板重开常驻条消失）
  chatProvider.setFileChangesProvider(() => fileChangeView.snapshotFiles());
  context.subscriptions.push(fileChangeView.onDidChange(() => chatProvider.pushFileChanges()));
  // 技能聚合目录：composer 与设置面板同一清单来源；项目级未信任时为空（不伪造来源）
  chatProvider.setSkillDirs(configDir, userSkillsDir, projectDirsAtActivation.skills);
  // 默认角色包校验：目录编目（与装配/角色页同一内核扫描器，冷启动无实例亦可校验；两面板共用）
  const rolePackCatalogDirs = {
    configDir,
    userRolePacksDir,
    projectRolePacksDir: projectDirsAtActivation.rolePacks,
  };
  attachRolePackCatalog(chatProvider, rolePackCatalogDirs);
  // 打开面板即懒装配 Agent（不依赖 open 命令）；复用同一 sessionStore（SSOT），路径同源
  chatProvider.setAgentFactory((_projectPath, sessionId) => {
    // 工厂只做「按会话取/建 + 一次性联动」，不持有实例：复用与在途去重归登记表
    const assembling = agentRegistry.createAgentForSession(sessionId);
    // 孤儿轮摘要延迟联动：启动清扫发生 Agent 尚未装配，
    // Agent 首次就绪后补做「对称的另一半」——软删被清扫轮的 round-summary
    // （与手动删会话同语义：脱钩溯源 + 进回收站，可恢复为无溯源独立记忆）。
    // 消费语义：**软删成功后才清空 pending**——失败/未就绪保留待下次装配重试，
    // 避免「清空了却未删」导致的永久悬空（软删由存储端 deletedAt 过滤，幂等，重复消费无害）。
    if (pendingSweptRoundIds.length > 0) {
      void assembling.then((agent) => {
        const memory = agent.memory;
        if (!memory) return; // memory 未就绪：不消费，pending 保留待下次装配
        try {
          memory.softDeleteRoundSummaries(pendingSweptRoundIds);
          pendingSweptRoundIds.length = 0;
        } catch (err) {
          // 联动失败仅记录并保留 pending（降级优先：记忆治理不阻塞 Agent 装配/对话）
          console.warn('Memora 孤儿清扫摘要联动失败（保留待重试；也可在记忆治理页手动处理）', err);
        }
      });
    }
    return assembling;
  });
  // 会话实例回收（删除会话时唯一生产调用点）：先注销登记再 close——反序会让「close 后仍留在表里」的实例被当活实例复用（僵尸）
  chatProvider.setAgentReleaser(async (sessionId) => {
    const agent = agentRegistry.get(sessionId);
    if (!agent) return;
    agentRegistry.unregister(sessionId);
    await agent.close();
  });
  // 会话实例改键（分叉）：内核把**同一实例**切到新会话 ⇒ 必须同步改登记键，否则「实例实际会话」与「登记键」漂移成两份语义
  chatProvider.setAgentRekeyer((from, to) => {
    const agent = agentRegistry.get(from);
    if (!agent) return;
    agentRegistry.unregister(from);
    agentRegistry.register(to, agent);
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MemoraChatViewProvider.viewType, chatProvider),
  );

  // 设置面板：editor tab 形态；装配复用 chat 面板同一登记表 SSOT，草稿只碰草稿内存（落盘随建会话 meta）
  const settingsProvider = new MemoraSettingsPanel(context.extensionUri, providerStore);
  const isDraft = () => chatProvider.isDraftSession();
  settingsProvider.setAgentFactory(getAgent, peekAgent, resolveSessionId, isDraft);
  // 默认角色包校验与建会话共用同一编目读面（设置页冷启动无实例亦可校验，不再要求先打开会话）
  attachRolePackCatalog(settingsProvider, rolePackCatalogDirs);
  settingsProvider.setDraftRolePackAccess({
    getName: () => chatProvider.getDraftRolePackName(),
    setName: (name) => chatProvider.setDraftRolePack(name),
  });
  settingsProvider.setGlobalState(context.globalState);
  settingsProvider.setSessionStore(sessionStore); // 角色切换落盘到会话文件（装配期读回）
  // 组队热更广播：全局一份数据 ⇒ 写时打所有已装配实例（判据见 setTeamBroadcaster 文档）
  settingsProvider.setTeamBroadcaster((teams) =>
    broadcastRolePackTeams(agentRegistry.listEntries(), teams),
  );
  // 注入技能目录：用户目录（打开目录按钮）+ 内置配置目录（三源技能来源判定，SSOT 收紧）
  settingsProvider.setUserSkillsDir(userSkillsDir);
  settingsProvider.setConfigDir(configDir);
  // 注入项目级目录（来源判定 + 打开目录）；目录与信任判定同源（未信任 ⇒ 空，避免「有路径但打不开」）
  settingsProvider.setProjectDirs(
    projectDirsAtActivation.skills,
    projectDirsAtActivation.rolePacks,
  );
  // 注入用户角色包目录（打开目录按钮 + 角色来源判定，对齐技能系统）
  settingsProvider.setUserRolePacksDir(userRolePacksDir);
  // 注入对话面板提供者：角色 handoff 预填需从设置面板跨 webview 投递到对话视图
  settingsProvider.setChatProvider(chatProvider);

  // 命令：打开对话面板（聚焦侧边栏视图）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.open', () => openChatCommand(getAgent, chatProvider)),
  );

  // 命令：添加图片到对话（IMG-2 Q3）：拾取编排（开框/读盘/落盘/回执）全归 chatPanel.pickAndAttachImages 单点
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.attachImage', () => chatProvider.pickAndAttachImages()),
  );

  // 设置面板打开入口的**唯一实现**（下面三个命令都是它的薄包装）。
  // 为什么收成一个本地函数而不是各写一遍：
  //   ① `switchTab` 必须在 `open` **之前**——先缓存待切页再打开，面板未就绪时由 ready 握手
  //      补发；顺序写反即落点丢失（三处各写一遍迟早有一处写反）；
  //   ② tab 参数化后，webview 侧 `open_settings_tab` 不必再维护「tab → 命令名」映射表
  //      （那张表是第二真源：加一页要回来补一行，且 protocol 还得同步收窄类型）。
  const openSettingsAt = (tab?: SettingsTab): void => {
    if (tab) settingsProvider.switchTab(tab);
    settingsProvider.open();
  };

  // 命令：打开设置面板（editor tab 单例 reveal-or-create）
  // 原入口 = 点活动栏图标（侧栏 view 随 L3 分家移除），由本命令承接——
  // 六页皆可达（打开后页内选项卡自由切换），MCP/技能/记忆/安全页的文档步骤靠它落地。
  // 命令参数 `tab` 可选：不传 = 默认首页（`DEFAULT_SETTINGS_TAB`）；代码内可直接
  // `executeCommand('memora.openSettings', 'mcp')` 直达某页（命令面板调用恒无参）。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.openSettings', (tab?: SettingsTab) =>
      openSettingsAt(tab),
    ),
  );

  // 命令：配置大模型（打开设置面板并切换到「大模型」子选项卡）
  // 保留独立命令名：既有 keybinding / 文档 / 外部脚本的落点，不因参数化而删。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.configureModel', () => openSettingsAt('config')),
  );

  // 命令：管理角色包（打开设置面板并切换到「角色」子选项卡）
  // 对话区「当前角色」徽章点击 → open_settings_tab(roles) → 本命令。
  // 只导航、不切换：切换执行仍走角色面板「设为当前」→ roles_set_active → agent.switchRolePack。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.openRoles', () => openSettingsAt('roles')),
  );

  // 命令：运行能力演示（隔离演示区 → Output Channel）
  // 在全局隔离目录装配独立 Agent，注入编排提示词跑通「搜索→抓取→写文件→总结→记忆沉淀」
  // 完整链路，Output Channel 流式呈现；完整展示内核的角色包/loop/记忆/工具/可观测能力。
  // 隔离设计：独立 projectPath 且不传 sessionStore，产物绝不污染当前工作区（用户决策）。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.demo', () => runDemoCommand(configDir)),
  );

  // ─── 记忆治理命令（宿主补齐 agent.memory.* API 消费） ───
  // 命令实现见 `commands/memory.ts`（术语消歧说明随实现一并外置）。

  // ─── 工作区信任门（项目级来源的启用时机）───
  //
  // 授予信任后**立即**补注入项目级目录并重扫，不需要用户重载窗口：
  //   ① 注入第三档 extra dir（skills 传 'project'；角色包同档位）；
  //   ② resyncUserSkills / resyncUserPacks 重扫**全部已登记目录**（内核按 extraDirs 顺序，
  //      因而项目仍排在用户之后 ⇒ 同名覆盖方向不变）；
  //   ③ 两面板重推清单（对话 composer 下拉 + 设置页列表）。
  // Agent 尚未装配时直接跳过——下次装配按 isTrusted 注入，路径不会漏。
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      syncTrustNotice();
      // 目录与信任判定同源重算：否则授予信任后项目级技能仍按旧目录（空）判源，会被误标成 user/builtin
      const dirs = readProjectAssetDirs();
      chatProvider.setSkillDirs(configDir, userSkillsDir, dirs.skills);
      settingsProvider.setProjectDirs(dirs.skills, dirs.rolePacks);
      // 多会话：所有已装配实例都要补注入（只补当前那台会让后台会话缺项目级技能）
      void applyGrantedWorkspaceTrust({
        affectedAgents: hostAgentRegistry?.list() ?? [],
        dirs,
        markRebuildPending: () => hostAgentRegistry?.markAllRebuildPending('workspace-trust') ?? 0,
        refreshSkillList: () => chatProvider.refreshSkillList(),
        report: (line) => memoraOutput.appendLine(line),
      }).catch((err) => {
        // 降级优先：注入失败不打断对话（下次装配仍会按已信任状态读取，用户也可手动刷新）
        console.warn('Memora 信任工作区后注入项目级资产失败', err);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('memora.reloadSkills', () =>
      reloadSkillsCommand(tryGetAgent, chatProvider, settingsProvider),
    ),
  );

  // 命令：导入技能 / 角色包压缩包（.zip）——三入口共用本处理器：
  //   ① 命令面板 `Memora: 导入技能或角色包`
  //   ② 设置页技能区「导入 .zip」→ import_asset_zip → executeCommand
  //   ③ 设置页角色包区「导入 .zip」→ import_asset_zip → executeCommand（与 ② 同一条通道：
  //      技能 / 角色包由压缩包内容识别，入口差异只是 UI 位置）
  // 项目级目录由 `readProjectAssetDirs()`（信任门单点）现读，命令层不自行推导路径。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.importAsset', () =>
      importAssetCommand({
        userSkillsDir,
        userRolePacksDir,
        // 内置角色包根目录：导入时同名即拒绝（与设置页来源判定的 `configDir/role-packs` 同源）
        builtinRolePacksDir: join(configDir, USER_ROLE_PACKS_DIR_NAME),
        readProjectDirs: readProjectAssetDirs,
        tryGetAgent,
        chatProvider,
        settingsProvider,
      }),
    ),
  );

  // ─── 技能启停配置变更自动同步 ───
  //
  // 契约：`memora.disabledSkills` 改完即生效——若只在 Agent 装配期读一次，
  // 用户改设置后须手动跑「Memora: 重载技能与角色包」才生效，属静默失效（坑）：
  // 「配置形态启停」承诺的是改完即生效，不该要求用户记得跑一条命令。
  //
  // 为何不必调 reloadConfig（生效路径实证，非推断）：禁用集是**读期过滤**——内核
  // `listAvailable()` 与 `get()` 读同一个 `disabledNames` 集合，而 loop 前缀由
  // `SeedPrepare.run` **每轮重建**（prepare.ts：每次回答前刷新装配视角，
  // `buildSkillList()` 无缓存、直读 listAvailable）⇒ 下一次回答即对模型生效。
  // 技能文件本身未变，重扫磁盘无意义，还会引入「忙碌态需排队」的额外语义。
  //
  // 未装配则不动作：下次装配本就按新配置注入，不该为「改一次设置」付整个 Agent 装配成本
  //（故**不用** tryGetAgent —— 它会懒装配；此处只读登记表里已存在的实例）。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // HOST-BUG-1：LLM 配置（Provider 列表 / 激活项）变更 → 对话面板重试装配。
      // 新装机首开面板装配失败（缺配置 throw）后，补全配置即自动初始化、无需重启。
      // 注册点在 activate（恒存活）；入口内部对「已就绪 / 装配在途 / 面板未开」三态安全跳过。
      if (
        e.affectsConfiguration('memora.providers') ||
        e.affectsConfiguration('memora.activeProvider')
      ) {
        void chatProvider.retryAgentAssembly().catch((err) => {
          // 降级优先：重试失败不打断用户操作（后续配置变更 / 重开面板仍可重试）
          console.warn('Memora LLM 配置变更后装配重试失败', err);
        });
      }
      // ─── 以下每个键独立判定，禁止用 return 短路 ───
      // 旧实现是「disabledSkills 未变则 return」，新增键写在它之后会被整段吞掉；
      // 三个键的语义也不同（技能启停是读期过滤 / 白名单与归档模式是运行时热更新），
      // 任一键变更都不得影响其余键的同步。
      if (e.affectsConfiguration('memora.disabledSkills')) {
        runOnAssembledAgent(
          (agent) => syncDisabledSkills(agent, chatProvider, settingsProvider),
          '技能启停配置同步',
        );
      }
      // 白名单：设置面板写入之外，用户手改 settings.json / Settings Sync 落地也必须收敛，
      // 否则「已保存但运行时仍按旧白名单」，只能重载窗口（静默失效）。
      if (e.affectsConfiguration('memora.allowedPaths')) {
        runOnAssembledAgent(
          // 与装配期同源：白名单 = 用户配置项；**不并入用户资产目录**（本轮已收回
          // LLM 对用户级的写权限，装配期与热更新两处必须口径一致，否则改一次设置就对
          // 用户目录重新放行——装配期收回、热更新放行的双头语义）。
          (agent) => agent.security?.setAllowedPaths(readAllowedPaths()),
          '允许路径配置同步',
        );
      }
      // 归档模式：同上。setArchiveMode 在对话进行中会「暂存 + 抛错」（内核 A2 契约），
      // 抛错 = 已排期到轮终补执行，不是失败——单独 catch 以免被公共壳误记为同步失败。
      if (e.affectsConfiguration('memora.archiveMode')) {
        runOnAssembledAgent((agent) => {
          try {
            agent.setArchiveMode(readArchiveMode());
          } catch (err) {
            // 预期路径（busy 暂存）：保留日志便于诊断「为什么还没切」
            console.info('Memora 归档模式变更已暂存，将在当前对话结束后生效', err);
          }
        }, '归档模式配置同步');
      }
      // MCP 配置（切片 4 起即时生效）：按 name 差分增量启停 + allowlist 只重算档位，
      // 无需重载窗口；差分细节见 host/mcp/runtime.ts，读取与装配期同源（mcpConfig.ts）。
      if (
        e.affectsConfiguration('memora.mcpServers') ||
        e.affectsConfiguration('memora.mcpToolAllowlist')
      ) {
        // 热更**生效后**回推设置面板：面板观察面必须显示生效后的真值（档位是重注册后才变的，
        // 早推 = 面板说谎）；未装配时本回调不跑，由面板自己推一次兜底。
        runOnAssembledAgent(async (agent) => {
          await applyMcpConfigChange(agent, readMcpServers(), {
            allowlist: readMcpToolAllowlist(),
            logger: createVscodeLogger(memoraOutput),
            clientVersion: extensionVersion,
          });
          settingsProvider.pushMcpStatus();
        }, 'MCP 配置热更');
      }
    }),
  );

  // 命令：查看记忆统计 / 清理过期软删除记忆 / 孤儿回收（实现见 `commands/memory.ts`）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.memoryStats', () => memoryStatsCommand(tryGetAgent)),
    vscode.commands.registerCommand('memora.cleanupMemories', () =>
      cleanupMemoriesCommand(tryGetAgent),
    ),
    vscode.commands.registerCommand('memora.runGc', () => runGcCommand(tryGetAgent)),
  );

  // ─── 恢复初始状态（清空用户级数据 · 与设置面板「安全」tab 按钮共用本函数） ───
  //
  // 单一路径：命令面板入口（memora.resetUserData）与 webview 按钮（reset_user_data 消息）
  // 都调同一个 handler——确认形态、清理顺序、reload 时机只有一处定义（实现与说明见
  // `commands/userDataReset.ts`），杜绝两条路径漂移（按钮能清、命令漏 reload 之类）。
  //
  // 清空范围 = 全部用户级存储；项目级数据（.memora/ 记忆与会话、工作区 settings）一字节不碰。
  const performUserDataReset = createUserDataResetHandler(
    {
      globalState: context.globalState,
      secrets: context.secrets,
      globalStorageDir: context.globalStorageUri.fsPath,
      packageJson: context.extension.packageJSON,
    },
    memoraOutput,
  );

  // 设置面板「安全」tab 的初始化按钮：委托同一处理器（单一路径）
  settingsProvider.setResetHandler(performUserDataReset);

  // 命令：恢复初始状态（命令面板入口，与设置面板按钮同一处理函数）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.resetUserData', async () => {
      const result = await performUserDataReset();
      // 取消：静默（用户主动选择，不弹提示）；失败：错误提示（清理幂等可重试）；
      // 成功：无需提示——窗口正在重载
      if (!result.ok && result.cancelled !== true && result.message) {
        vscode.window.showErrorMessage(`Memora ${result.message}`);
      }
    }),
  );

  // 作品投影清单：行派生在 host/workProjectionRows.ts（纯函数、可单测），
  // 消费面 = 设置页「作品和规则」选项卡；清单变更统一经 notifier 回推，无树 provider 实例。
  registerRegisterWorkCommand(context, tryGetAgent, memoraOutput, notifyWorkProjectionChanged);

  // 命令：添加到对话（实现见 `commands/addToChat.ts`）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.addToChat', (uri) =>
      addToChatCommand(uri, chatProvider),
    ),
  );

  registerResidentRuleCommands(context, tryGetAgent, notifyWorkProjectionChanged);

  // 命令：复制诊断摘要（用户报障时一条命令带走版本 / 环境 / 配置 / 最近 webview 错误 / 指标）
  // 取数与格式化分离：chatProvider 只交出原始数据（缓冲 + 指标），脱敏与排版归 hostDiagnostics
  // 模块——宿主不另拼一份「差不多」的摘要，否则两处口径漂移，用户贴给我们的和界面看到的对不上。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.copyDiagnostics', async () => {
      const data = chatProvider.getDiagnosticData();
      const snapshot = formatDiagnosticsSnapshot({
        extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
        recentHostDiags: data.recentHostDiags,
        agentMetrics: data.agentMetrics,
      });
      await vscode.env.clipboard.writeText(snapshot);
      void vscode.window.showInformationMessage('Memora 诊断摘要已复制到剪贴板');
    }),
  );
  // 会话管理入口在 webview 标题条：
  //   - 新建会话「＋」/ 历史记录（模态浮层）/ 改名笔 均由 webview 内按钮触发（W→E 消息）
  // 故 memora.clearChat / memora.switchSession 两命令不注册（「清空对话」由「删除会话记录」
  // 覆盖，会话切换走标题条按钮 + 历史浮层）。
}

/**
 * 插件停用入口
 *
 * 内核 Agent.close() 内部：
 * - 调用 sessionManager.destroy()（停定时器；检查点不落盘，
 *   进行中工具结果与幂等标记仅内存态，正常关闭即整体丢弃，无持久化保障）；
 * - 收割全部存活的后台**命令**进程（loop.shutdownBackgroundTasks → 注册表 taskkill 杀树）：
 *   turn 终态刻意不杀（跨轮存活），但扩展停用时注册表随实例销毁，不杀即 OS 层孤儿
 *   （真机观察点 ⑧ 实锤）。扩展崩溃 / 被强杀时本函数来不及执行，该场景不承诺清理。
 * 失败不阻塞插件退出。
 *
 * ⚠️ 末尾**必须 `dispose()` 登记表**（`hostAgentRegistry`）——置停用标志 + 清表，二者缺一：
 * 本函数已把所有 Agent `close()`，而 `createAgentForSession` 的复用判据只看「有没有」、
 * 不看「死没死」。若只清表不置停用，close 期间迟到的装配仍会把关闭后的实例登记回来；
 * 同一宿主进程内再次 `activate()`（VS Code 热卸载/重装载：第三方扩展 veto 未重启宿主）
 * 时新面板会绑到一台死 Agent——功能全坏且**无任何报错**（命令能调、agent 是死的）。
 * `close()` 失败也要清：半关闭的实例比「表里没有」更危险（表里没有会触发重新装配）。
 */
export async function deactivate(): Promise<void> {
  // 会话存储先摘引用，锁在**末尾**统一归还（E4 批 3）：先 close 再放锁——放锁前本窗口仍是
  // 该会话的写归属；而「锁全放」必须无条件执行（进程级 OS 句柄，漏放 = 该会话对其他窗口
  // 永久不可用），故用 try/finally 兜住，早退分支也照放。
  const store = hostSessionStore;
  hostSessionStore = null;

  /**
   * 关闭宿主拥有的记忆存储单例（所有权归宿主：Agent close 只借用、不关它）
   *
   * 装配失败（登记表里没有实例但存储已打开）与正常关闭都会走到这里；
   * 必须排在 `agent.close()` 之后，避免关闭过程中再写已关的库。
   */
  const closeHostMemoryStorage = (): void => {
    try {
      hostMemoryStorage?.close?.();
    } catch {
      // 退出路径静默降级：不阻断插件退出
    }
    hostMemoryStorage = null;
  };

  // 快照后立即置停用 + 清表（fail-closed）：close 期间迟到的装配 resolve 后会自行 close、
  // 不登记——换顺序拦不住它，只有 registry 的 disposed 状态位拦得住
  const agents = hostAgentRegistry?.list() ?? [];
  hostAgentRegistry?.dispose();
  try {
    // 没有实例也要走 finally（锁可能只因面板打开而持有，Agent 没装配照样要还）
    if (agents.length > 0) {
      // MCP 子进程先停：注销工具 + 关闭 stdio（子进程随 transport 关闭退出）。
      // 放在 agent.close() 之前——工具注销走 agent.tools，需要执行器还活着。
      await stopMcpServers();
      for (const agent of agents) {
        await agent.close();
      }
    }
  } catch {
    // 关闭失败静默降级：不阻断插件退出（VS Code 不因 deactivate 异常而阻塞）
  } finally {
    // GC 单点调度器先停：避免定时器在 Agent 关闭后继续扫已关闭的存储
    gcScheduler?.stopPeriodic();
    gcScheduler = null;
    // 共享记忆存储最后关（所有 Agent 已 close，再关库不会留下写半途）
    closeHostMemoryStorage();
    // 锁最后全放（沿用 releaseAllSessionLocks：会话锁是进程级句柄，随本进程退出彻底归还）
    store?.releaseAllSessionLocks();
  }
}
