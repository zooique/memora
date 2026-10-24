/**
 * Memora — VS Code 插件入口（memora 通用落地宿主）
 *
 * 职责：
 *   - 注册侧边栏视图（对话 + 大模型配置）+ 两个通用命令（打开 / 配置大模型）
 *   - 懒加载装配 Agent（getOrCreateAgent）
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
import type { Agent, ArchiveMode, IRoundStore } from '@zooique/memora';
import { assembleAgent, createVscodeLogger } from './host/assemble.js';
import { WorkspaceSessionStore } from './host/sessionStore.js';
import { WorkspaceRoundStore, DEFAULT_SWEEP_MIN_AGE_MS } from './host/workspaceRoundStore.js';
import { WorkspaceSessionViewLoader } from './host/sessionViewLoader.js';
import { ProviderStore } from './providers/providerStore.js';
import { MemoraChatViewProvider } from '../webview/panels/chatPanel.js';
import { formatDiagnosticsSnapshot } from '../webview/panels/hostDiagnostics.js';
import { MemoraSettingsViewProvider } from '../webview/panels/settingsPanel.js';
import { openChatCommand } from './commands/openChat.js';
import { runDemoCommand } from './commands/demo.js';
import { reloadSkillsCommand } from './commands/reloadSkills.js';
import { cleanupMemoriesCommand, memoryStatsCommand, runGcCommand } from './commands/memory.js';
import { registerWorkCommand } from './commands/registerWork.js';
import { addToChatCommand } from './commands/addToChat.js';
import { createUserDataResetHandler } from './commands/userDataReset.js';
import { readDisabledSkills, syncDisabledSkills } from './host/skillSync.js';
import { FileChangeTracker } from './host/fileChangeTracker.js';
import { FileChangeView } from './host/fileChangeView.js';
import { stopMcpServers, applyMcpConfigChange } from './host/mcp/runtime.js';
import { readMcpServers, readMcpToolAllowlist } from './mcpConfig.js';
import {
  ACTIVE_ROLE_PACK_KEY,
  CONFIRM_WRITES_KEY,
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
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? join(homedir(), '.memora');
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

/** 懒加载的 Agent 单例（跨命令复用） */
let agentPromise: Promise<Agent> | null = null;

/**
 * 最近装配成功的 Agent 实例（同步引用）
 *
 * `agentPromise` 是异步的，无法同步取用；文件改动「回退本文件改动」需要**同步**拿到
 * `agent.security`（路径守卫）做写前校验，故在装配成功时缓存一份同步引用。
 * 未装配时为 null（此时恢复会被安全拒绝——降级优先，绝不无校验直写）。
 */
let currentAgent: Agent | null = null;

/**
 * 扩展版本号（MCP 客户端握手时上报给 server，仅作遥测，不参与任何判据）
 *
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
    const agent = agentPromise ? await agentPromise.catch(() => null) : null;
    if (!agent) return;
    await action(agent);
  })().catch((err) => {
    console.warn(`Memora ${failLabel}失败`, err);
  });
}

/**
 * 获取（或创建）指定工作区的 Agent 实例
 *
 * @param projectPath 工作区路径
 * @param providerStore 大模型配置存储
 * @param sessionStore 会话存储单例（SSOT：与 UI 面板共享，杜绝双实例覆盖写导致会话记录加载不全）
 * @param globalState vscode 全局状态（读取持久化的激活角色包，重启后恢复用户选择；
 *   用户级而非工作区级——角色选择是用户偏好，不随工作区漂移）
 * @param configDir 插件内置配置目录（SSOT：由 extension.extensionUri 显式定位——
 *   若在 assemble 内用 import.meta.url 相对推断，esbuild bundle 后路径漂移会导致角色包加载失败（坑））
 * @param userSkillsDir 用户技能目录（可选）
 * @param userRolePacksDir 用户角色包目录（可选，与内置包同池注入）
 * @param outputChannel VSCode 输出通道（日志对接）
 */
function getOrCreateAgent(
  projectPath: string,
  providerStore: ProviderStore,
  sessionStore: WorkspaceSessionStore,
  roundStore: IRoundStore,
  globalState: vscode.Memento,
  configDir: string,
  userSkillsDir?: string,
  userRolePacksDir?: string,
  outputChannel?: vscode.OutputChannel,
): Promise<Agent> {
  if (!agentPromise) {
    // 读取持久化的激活角色包（用户上次选择；无记录时为 undefined → 内核 §4.1 单链落兜底包）
    const activeRolePack = globalState.get<string>(ACTIVE_ROLE_PACK_KEY);
    // 读取角色包组（会议名单，用户级数据；无记录为空数组）
    const rolePackTeams =
      globalState.get<{ leader: string; members: string[] }[]>(ROLE_PACK_TEAMS_KEY) ?? [];
    // 读取写入二次确认开关（用户安全偏好；默认 false → owner 写文件自动批准）
    const confirmWrites = globalState.get<boolean>(CONFIRM_WRITES_KEY) ?? false;
    // 读取脚本/代码执行确认开关（用户安全偏好；默认 false → owner 脚本执行自动批准）
    const confirmScripts = globalState.get<boolean>(CONFIRM_SCRIPTS_KEY) ?? false;
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
    agentPromise = assembleAgent({
      projectPath,
      // 项目搜索根 = 真实工作区文件夹（无 folder 时 undefined → 不注入 search_project）
      projectSearchRoot: resolveProjectSearchRoot(),
      providerStore,
      sessionStore,
      roundStore,
      activeRolePack,
      rolePackTeams,
      configDir,
      searchEngine,
      customSearchEngines,
      archiveMode,
      userSkillsDir,
      userRolePacksDir,
      confirmWrites,
      confirmScripts,
      allowedPaths,
      disabledSkills,
      scriptNodePath: scriptNodePath || undefined,
      // MCP server（用户级设置；装配末尾接入并注册工具，失败只影响该 server）
      mcpServers: readMcpServers(),
      // MCP 工具免确认 allowlist（同名寻址键，按原名；空 = 全部逐次确认）
      mcpToolAllowlist: readMcpToolAllowlist(),
      extensionVersion: extensionVersion || undefined,
      outputChannel,
    }).catch((err) => {
      // 装配失败则重置，下次命令重试
      agentPromise = null;
      throw err;
    });
  }
  // 缓存同步引用（供文件改动「回退本文件改动」同步取 agent.security 做写前校验）；
  // 两参 then：装配失败分支显式吞掉，避免产生未处理的 rejection。
  void agentPromise.then(
    (agent) => {
      currentAgent = agent;
    },
    () => {
      // 装配失败：调用方各自处理；此处仅维护同步引用，不重复处理
    },
  );
  return agentPromise;
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

  // 用户角色包目录（对齐技能系统）
  //
  // 双池注入：内置角色包（dist/extension/role-packs/，构建期从内核同步）
  //   + 用户角色包（globalStorageUri/role-packs/，运行态经内核 loadExtraDir() 注入同池切换）。
  //
  // 使用方式：用户在此目录放置角色包文件夹（manifest.json + persona.md/rules.md/skills/）即生效；
  //   同名冲突内置优先（内核 loadExtraDir 跳过重名用户包）。目录创建失败不阻塞插件启动。
  // （目录名常量 USER_ROLE_PACKS_DIR_NAME 与「初始化」清空目标共用，禁散落字面量）
  const userRolePacksDir = join(context.globalStorageUri.fsPath, USER_ROLE_PACKS_DIR_NAME);
  void mkdir(userRolePacksDir, { recursive: true }).catch(() => {
    // 目录创建失败不阻塞插件启动
  });

  // 侧边栏视图：对话面板（sessionStore 与 assemble 同路径 .memora/sessions.json）
  const workspacePath = resolveWorkspacePath();

  /**
   * 统一装配入口（**唯一调用面**）
   *
   * 此前四处（chat 工厂 / settings 工厂 / open 命令 / 命令侧取 Agent）各抄一遍九个实参，
   * 装配签名一改就要在四处同步——漏一处就是「某个入口装出来的 Agent 少读一项配置」，
   * 而且没有测试会红。收成一个闭包后，装配参数只有这一处定义。
   *
   * @param projectPath 工作区路径（仅首次装配生效；后续调用复用同一 Agent 单例）
   */
  const getAgent = (projectPath: string): Promise<Agent> =>
    getOrCreateAgent(
      projectPath,
      providerStore,
      sessionStore,
      roundStore,
      context.globalState,
      configDir,
      userSkillsDir,
      userRolePacksDir,
      memoraOutput,
    );

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
  // 孤儿清扫（0 引用 Round 统一回收）：删除会话/截断后遗留的无引用轮
  // 在启动时物理清理，防磁盘膨胀与「0 引用卡片滞留」（引用归 SessionStore、物理归 RoundStore）
  // 存活保护必须显式带上：进行中轮（pending）refCount 恒为 0，无保护会删掉
  // 「用户已提问、LLM 尚未作答」的轮（重载/崩溃重启时静默丢失用户提问）。
  const sweptIds = roundStore.sweepOrphans(DEFAULT_SWEEP_MIN_AGE_MS);
  if (sweptIds.length > 0) {
    console.info(`Memora 启动清扫无引用问答闭环 ${sweptIds.length} 条`);
    // 对称的另一半：被清扫轮的 round-summary 摘要暂存，
    // 待 Agent 装配后延迟联动软删——清扫发生在启动时 Agent 尚未装配，无法直接访问记忆库。
    // 详见 setAgentFactory 处的消费逻辑。
    pendingSweptRoundIds.push(...sweptIds);
  }
  const sessionStore = new WorkspaceSessionStore(workspacePath, roundStore);
  sessionStore.load();

  // 视图加载器：将 Session（Round ID 列表）+ RoundStore 组合为完整视图
  const viewLoader = new WorkspaceSessionViewLoader(roundStore, sessionStore);

  const chatProvider = new MemoraChatViewProvider(
    context.extensionUri,
    sessionStore,
    providerStore,
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
    getSecurityGuard: () => currentAgent?.security ?? undefined,
    // 判据同源：与内核装配读的是同一配置键（extension.ts 装配处同读 CONFIRM_WRITES_KEY）
    isConfirmWrites: () => context.globalState.get<boolean>(CONFIRM_WRITES_KEY) ?? false,
    // 诊断日志：装饰/打开/恢复的失败必须留痕（真机曾因静默吞异常导致「打开了但看不出改了哪里」无从定位）
    log: (message) => memoraOutput.appendLine(message),
  });
  fileChangeView.register(context);
  chatProvider.setFileChangeSink(fileChangeView);
  // 未确认改动集变化 → 推给对话区常驻条；webview ready 时 chatPanel 会主动补推一次
  // （两个时机缺一即漏面：只推变化 ⇒ 面板重开常驻条消失）
  chatProvider.setFileChangesProvider(() => fileChangeView.snapshotFiles());
  context.subscriptions.push(fileChangeView.onDidChange(() => chatProvider.pushFileChanges()));
  // 注入技能聚合目录：composer 动态技能下拉与设置面板同一清单来源（SSOT）
  chatProvider.setSkillDirs(configDir, userSkillsDir);
  // 打开面板即懒装配 Agent（不依赖先执行 open 命令），保证发送始终可用；
  // 装配复用同一 sessionStore 单例（SSOT），与 UI 面板共享，杜绝双实例覆盖写；
  // 装配路径与 sessionStore 同源（resolveWorkspacePath），保证读写的文件一致
  chatProvider.setAgentFactory((projectPath) => {
    const agentPromise = getAgent(projectPath);
    // 孤儿轮摘要延迟联动：启动清扫发生 Agent 尚未装配，
    // Agent 首次就绪后补做「对称的另一半」——软删被清扫轮的 round-summary
    // （与手动删会话同语义：脱钩溯源 + 进回收站，可恢复为无溯源独立记忆）。
    // 消费语义：**软删成功后才清空 pending**——失败/未就绪保留待下次装配重试，
    // 避免「清空了却未删」导致的永久悬空（软删由存储端 deletedAt 过滤，幂等，重复消费无害）。
    if (pendingSweptRoundIds.length > 0) {
      void agentPromise.then((agent) => {
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
    return agentPromise;
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MemoraChatViewProvider.viewType, chatProvider),
  );

  // 侧边栏视图：设置面板（角色 / 大模型 / 记忆 / 技能 / MCP / 安全 选项卡合一）
  // 各子视图均为低频操作，合并为单一「设置」视图、
  // 内部按钮切换，避免活动栏底部选项卡拥挤（用户反馈）。
  // 装配复用与 chat 面板同一 getOrCreateAgent 单例（SSOT），角色切换持久化用户级激活态；
  // providerStore 注入供大模型子视图读写（与 chat 面板共用一个 store 单例）。
  const settingsProvider = new MemoraSettingsViewProvider(context.extensionUri, providerStore);
  settingsProvider.setAgentFactory(getAgent);
  settingsProvider.setGlobalState(context.globalState);
  // 注入技能目录：用户目录（打开目录按钮）+ 内置配置目录（三源技能来源判定，SSOT 收紧）
  settingsProvider.setUserSkillsDir(userSkillsDir);
  settingsProvider.setConfigDir(configDir);
  // 注入用户角色包目录（打开目录按钮 + 角色来源判定，对齐技能系统）
  settingsProvider.setUserRolePacksDir(userRolePacksDir);
  // 注入对话面板提供者：角色 handoff 预填需从设置视图跨 webview 投递到对话视图
  settingsProvider.setChatProvider(chatProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      MemoraSettingsViewProvider.viewType,
      settingsProvider,
    ),
  );

  // 命令：打开对话面板（聚焦侧边栏视图）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.open', () => openChatCommand(getAgent, chatProvider)),
  );

  // 命令：配置大模型（聚焦设置视图并切换到「大模型」子选项卡）
  // 先记录待切选项卡再聚焦；视图未就绪时由 settingsPanel
  // 在 ready 握手后补发 settings_switch_tab，保证命令落点与用户意图一致。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.configureModel', () => {
      settingsProvider.switchTab('config');
      void vscode.commands.executeCommand(`${MemoraSettingsViewProvider.viewType}.focus`);
    }),
  );

  // 命令：管理角色包（聚焦设置视图并切换到「角色」子选项卡）
  // 对话区「当前角色」徽章点击 → open_settings_tab(roles) → 本命令；与 configureModel 同款两行模式
  // （先记待切选项卡再聚焦；视图未就绪时由 settingsPanel 在 ready 握手后补发 settings_switch_tab）。
  // 只导航、不切换：切换执行仍走角色视图「设为当前」→ roles_set_active → agent.switchRolePack。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.openRoles', () => {
      settingsProvider.switchTab('roles');
      void vscode.commands.executeCommand(`${MemoraSettingsViewProvider.viewType}.focus`);
    }),
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

  // 命令：重载技能与角色包（实现见 `commands/reloadSkills.ts`，忙碌态语义随实现外置）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.reloadSkills', () =>
      reloadSkillsCommand(tryGetAgent, chatProvider, settingsProvider),
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
  //（故**不用** tryGetAgent —— 它会懒装配；此处只读已存在的 agentPromise）。
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

  // 命令：登记作品投影（实现见 `commands/registerWork.ts`）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.registerWork', (uri) =>
      registerWorkCommand(uri, tryGetAgent, memoraOutput),
    ),
  );

  // 命令：添加到对话（实现见 `commands/addToChat.ts`）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.addToChat', (uri) =>
      addToChatCommand(uri, chatProvider),
    ),
  );

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
 * ⚠️ 末尾**必须复位两个模块级单例**（`agentPromise` / `currentAgent`）：
 * 本函数已把 Agent `close()`，而 `getOrCreateAgent` 的复用判据只看「有没有」、
 * 不看「死没死」。若不清引用，同一扩展宿主进程内再次 `activate()`
 * 时——即 VS Code 热卸载/重装载路径（真机实证：扩展宿主因第三方扩展 veto 未重启时
 * 走的正是这条）——新面板会绑到一个已关闭的 Agent：功能全坏且**无任何报错**
 * （命令能调、agent 是死的，最难查的那种）。
 * `close()` 失败也要清：半关闭的实例比 `null` 更危险（`null` 会触发重新装配）。
 */
export async function deactivate(): Promise<void> {
  if (!agentPromise) return;
  try {
    // MCP 子进程先停：注销工具 + 关闭 stdio（子进程随 transport 关闭退出）。
    // 放在 agent.close() 之前——工具注销走 agent.tools，需要执行器还活着。
    await stopMcpServers();
    const agent = await agentPromise;
    await agent.close();
  } catch {
    // 关闭失败静默降级：不阻断插件退出（VS Code 不因 deactivate 异常而阻塞）
  } finally {
    agentPromise = null;
    currentAgent = null;
  }
}
