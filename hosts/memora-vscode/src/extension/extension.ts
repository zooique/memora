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
import type { Agent, IRoundStore } from '@zooique/memora';
import { accumulateStream } from '@zooique/memora';
import { assembleAgent } from './host/assemble.js';
import { WorkspaceSessionStore } from './host/sessionStore.js';
import { WorkspaceRoundStore, DEFAULT_SWEEP_MIN_AGE_MS } from './host/workspaceRoundStore.js';
import { WorkspaceSessionViewLoader } from './host/sessionViewLoader.js';
import { ProviderStore } from './providers/providerStore.js';
import { MemoraChatViewProvider } from '../webview/panels/chatPanel.js';
import { MemoraSettingsViewProvider } from '../webview/panels/settingsPanel.js';
import { openChatCommand } from './commands/openChat.js';
import { runDemoCommand } from './commands/demo.js';
import { ACTIVE_ROLE_PACK_KEY, CONFIRM_WRITES_KEY, CONFIRM_SCRIPTS_KEY, ROLE_PACK_TEAMS_KEY, MEMORY_RECYCLE_RETENTION_DAYS } from '../shared/constants.js';

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
 * 读取「禁用的技能名」配置（S4 技能启停，**唯一读取点**）
 *
 * 三处消费共用本函数：① 装配期注入；② 配置变更监听；③ 手动重载命令。
 * 各自内联 `getConfiguration` 会让**键名与默认值**在三个地方各存一份，改一处漏两处。
 *
 * ⚠️ 真源是内核 `disabledNames`（本函数只负责把配置取出来喂给它）；宿主不自存副本、
 * UI 不另读本配置 —— 否则 `reloadConfig` 重设后两源分叉，出现「UI 说已禁用、实际仍生效」。
 */
function readDisabledSkills(): string[] {
  return vscode.workspace.getConfiguration('memora').get<string[]>('disabledSkills', []);
}

/**
 * 技能启停（S4）同步：把宿主配置的禁用集喂给内核 + 刷新**两条** UI 消费通道。
 *
 * 单一实现 —— 配置变更监听与「Memora: 重载技能与角色包」命令共用，防两处各写一份。
 *
 * 消费通道必须枚举完整（缺一即「只刷一半」，SKILL-S2 血训）：
 *   ① 对话区技能下拉 + chip 标注 → `chatProvider.refreshSkillList()`
 *   ② 设置页技能卡片（「已禁用」徽章 + health） → `settingsProvider.refreshSkillList()`
 *
 * 内核侧 `setDisabledSkills` 为纯内存 clear+add（幂等、无 IO），故本函数可安全重复调用。
 */
function syncDisabledSkills(
  agent: Agent,
  chatProvider: MemoraChatViewProvider,
  settingsProvider: MemoraSettingsViewProvider,
): void {
  agent.skills?.setDisabledSkills(readDisabledSkills());
  chatProvider.refreshSkillList();
  // 设置页刷新为异步（含逐项 health 校验）：显式接住 rejection —— 刷新失败只影响设置页
  // 展示（下次打开设置页会重新加载），不得冒泡成未处理异常打断调用方
  void settingsProvider.refreshSkillList().catch((err) => {
    console.warn('Memora 技能清单刷新（设置页）失败', err);
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
 * @param outputChannel VSCode 输出通道（G7：日志对接）
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
    const rolePackTeams = globalState.get<{ leader: string; members: string[] }[]>(ROLE_PACK_TEAMS_KEY) ?? [];
    // 读取写入二次确认开关（用户安全偏好；默认 false → owner 写文件自动批准）
    const confirmWrites = globalState.get<boolean>(CONFIRM_WRITES_KEY) ?? false;
    // 读取脚本/代码执行确认开关（用户安全偏好；默认 false → owner 脚本执行自动批准）
    const confirmScripts = globalState.get<boolean>(CONFIRM_SCRIPTS_KEY) ?? false;
    // 读取工作区白名单额外路径（G8：项目级设置，落 .vscode/settings.json）；
    // 项目目录基准根恒在，此处仅含用户额外路径
    const allowedPaths = vscode.workspace
      .getConfiguration('memora')
      .get<string[]>('allowedPaths', []);
    // 内置网页搜索引擎（方案 A：memora.searchEngine 设置，'auto' = Bing→DuckDuckGo 默认链）
    const searchEngine = vscode.workspace
      .getConfiguration('memora')
      .get<'auto' | 'bing' | 'baidu' | 'sogou'>('searchEngine', 'auto');
    // 禁用的技能名清单（配置形态启停）：命中技能对 LLM 全链不可用
    // （L1 清单 / list_skills / read_skill / L3 全不可达）。此处只是**装配期快照**；
    // 用户改设置由 activate 内的配置监听实时重设，无需重新装配。
    const disabledSkills = readDisabledSkills();
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
      userSkillsDir,
      userRolePacksDir,
      confirmWrites,
      confirmScripts,
      allowedPaths,
      disabledSkills,
      outputChannel,
    }).catch(
      (err) => {
        // 装配失败则重置，下次命令重试
        agentPromise = null;
        throw err;
      },
    );
  }
  return agentPromise;
}

/** 插件激活入口 */
export function activate(context: vscode.ExtensionContext): void {
  // G7：创建日志输出通道 —— 内核日志将导向此通道，用户可在 VS Code 输出面板查看
  const memoraOutput = vscode.window.createOutputChannel('Memora');
  context.subscriptions.push(memoraOutput);

  // 大模型配置存储（providerStore 供配置面板 + Agent 装配共用）
  const providerStore = new ProviderStore(context.secrets);
  // 一次性迁移：工作区 settings.json 旧 Provider 配置 → 用户级
  // （避免 Workspace 优先级覆盖 Global 新配置导致不生效）
  void providerStore.migrateFromWorkspace();
  // 一次性迁移：旧全局 memora.maxContextTokens → 首个 Provider 的 contextWindow
  // （窗口上限为 per-LLM 配置，全局键仅作迁移来源；详见 ADR-029）
  void providerStore.migrateMaxContextTokens();

  // 插件内置配置目录（SSOT）：从 extensionUri 显式定位，
  // 指向 dist/extension（role-packs 等资源所在）。若在 assemble 内用 import.meta.url
  // 相对推断，esbuild bundle 后路径漂移会导致内置角色包加载为 0（坑）。
  const configDir = join(context.extensionUri.fsPath, 'dist', 'extension');

  // 用户技能目录：使用 VS Code 全局存储目录
  // 路径示例：C:\Users\SJ\AppData\Roaming\Code\User\globalStorage\zooique.memora-vscode\skills\
  // 与内置技能分离，支持用户独立管理；目录不存在时自动创建
  const userSkillsDir = join(context.globalStorageUri.fsPath, 'skills');
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
  const userRolePacksDir = join(context.globalStorageUri.fsPath, 'role-packs');
  void mkdir(userRolePacksDir, { recursive: true }).catch(() => {
    // 目录创建失败不阻塞插件启动
  });

  // 侧边栏视图：对话面板（sessionStore 与 assemble 同路径 .memora/sessions.json）
  const workspacePath = resolveWorkspacePath();

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

  const chatProvider = new MemoraChatViewProvider(context.extensionUri, sessionStore, providerStore);
  // 注入 Round-based 视图加载器（用于加载 round-based 会话的历史消息）
  // 未注入时 chatPanel 仅支持 legacy 模式（向后兼容）
  chatProvider.setViewLoader(viewLoader);
  // 注入过程事件落盘目标（v1.5）：与 viewLoader 同一 WorkspaceRoundStore 单例，生命周期原子一致
  chatProvider.setRoundStore(roundStore);
  // 注入技能聚合目录：composer 动态技能下拉与设置面板同一清单来源（SSOT）
  chatProvider.setSkillDirs(configDir, userSkillsDir);
  // 打开面板即懒装配 Agent（不依赖先执行 open 命令），保证发送始终可用；
  // 装配复用同一 sessionStore 单例（SSOT），与 UI 面板共享，杜绝双实例覆盖写；
  // 装配路径与 sessionStore 同源（resolveWorkspacePath），保证读写的文件一致
  chatProvider.setAgentFactory((projectPath) => {
    const agentPromise = getOrCreateAgent(
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

  // 侧边栏视图：设置面板（角色 / 大模型 / 记忆 选项卡合一）
  // 三个子视图均为低频操作（角色切换、模型配置、记忆浏览），合并为单一「设置」视图、
  // 内部按钮切换，避免活动栏底部选项卡拥挤（用户反馈）。
  // 装配复用与 chat 面板同一 getOrCreateAgent 单例（SSOT），角色切换持久化用户级激活态；
  // providerStore 注入供大模型子视图读写（与 chat 面板共用一个 store 单例）。
  const settingsProvider = new MemoraSettingsViewProvider(context.extensionUri, providerStore);
  settingsProvider.setAgentFactory((projectPath) =>
    getOrCreateAgent(projectPath, providerStore, sessionStore, roundStore, context.globalState, configDir, userSkillsDir, userRolePacksDir, memoraOutput),
  );
  settingsProvider.setGlobalState(context.globalState);
  // 注入技能目录：用户目录（打开目录按钮）+ 内置配置目录（三源技能来源判定，SSOT 收紧）
  settingsProvider.setUserSkillsDir(userSkillsDir);
  settingsProvider.setConfigDir(configDir);
  // 注入用户角色包目录（打开目录按钮 + 角色来源判定，对齐技能系统）
  settingsProvider.setUserRolePacksDir(userRolePacksDir);
  // 注入对话面板提供者：角色 handoff 预填需从设置视图跨 webview 投递到对话视图
  settingsProvider.setChatProvider(chatProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MemoraSettingsViewProvider.viewType, settingsProvider),
  );

  // 命令：打开对话面板（聚焦侧边栏视图）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.open', () =>
      openChatCommand(
        (projectPath) =>
          getOrCreateAgent(projectPath, providerStore, sessionStore, roundStore, context.globalState, configDir, userSkillsDir, userRolePacksDir, memoraOutput),
        chatProvider,
      ),
    ),
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

  // 命令：运行能力演示（隔离演示区 → Output Channel）
  // 在全局隔离目录装配独立 Agent，注入编排提示词跑通「搜索→抓取→写文件→总结→记忆沉淀」
  // 完整链路，Output Channel 流式呈现；完整展示内核的角色包/loop/记忆/工具/可观测能力。
  // 隔离设计：独立 projectPath 且不传 sessionStore，产物绝不污染当前工作区（用户决策）。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.demo', () => runDemoCommand(configDir)),
  );

  // ─── 记忆治理命令（宿主补齐 agent.memory.* / agent.governance.* API 消费） ───

  /** 获取当前工作区的 Agent 实例（懒装配，已装配则直接返回缓存） */
  const getAgentForCommand = async (): Promise<Agent | null> => {
    try {
      return await getOrCreateAgent(workspacePath, providerStore, sessionStore, roundStore, context.globalState, configDir, userSkillsDir, userRolePacksDir, memoraOutput);
    } catch {
      return null;
    }
  };

  // 命令：重载技能与角色包（技能系统热重载入口）
  // 技能是角色包作者的高频手改对象，此入口免去改/加技能文件后 Reload Window 才生效。
  //
  // ⚠ 忙碌态必须「分两次带 source」调用 —— 判据同源：agent.isBusy 读的正是内核
  // reloadConfig 守门用的同一个 chatLockManager.isBusy。
  //   内核在对话中**只暂存带 source 的请求**（agent.ts：「undefined（全量）不暂存——无具体来源，
  // 补执行语义不明」）⇒ 无参调用在对话中会把用户的重载请求**静默丢弃**
  // （既没重载、也没排队），此时提示「重载失败」不实（内核在守门处即返回，未尝试重载）（坑）。
  //   故空闲走一次全量；忙碌则分两次带 source 调用（两条都进 pendingConfigReload，
  // 由 flushPendingConfigReload 在 turn 结束后补执行），并如实告知「已提交」。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.reloadSkills', async () => {
      const agent = await getAgentForCommand();
      if (!agent) {
        vscode.window.showWarningMessage('Memora Agent 未就绪，无法重载技能');
        return;
      }
      // 禁用集 + UI 同步（S4 启停闭环）：配置变更本身已由 onDidChangeConfiguration 监听
      // 自动完成；此处保留为**幂等兜底**——reloadConfig 会重扫技能池（增删技能后清单变化），
      // 重设一次保证「手动重载后 UI 与内核一致」，且万一监听未触发仍有手动救济路径。
      syncDisabledSkills(agent, chatProvider, settingsProvider);
      if (agent.isBusy) {
        // allSettled：忙碌态两次调用都会以 chatBusyError 结束（守门发生在任何 IO 之前），
        // 属预期路径，不该冒泡成未处理异常。
        await Promise.allSettled([
          agent.reloadConfig('skill'),
          agent.reloadConfig('rolePack'),
        ]);
        // 措辞须对两种时序都成立：判据为真后锁可能瞬间释放（此时两次调用会真的立即生效）。
        vscode.window.showInformationMessage(
          '技能重载请求已提交；若对话仍在进行，将在对话空闲时自动生效',
        );
        return;
      }
      try {
        const result = await agent.reloadConfig();
        vscode.window.showInformationMessage(
          `技能已重载：全局技能 ${result.skill} 个 / 角色包技能 ${result.rolePack} 个`,
        );
      } catch (err) {
        vscode.window.showWarningMessage(
          `技能重载失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
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
  //（故**不用** getAgentForCommand —— 它会懒装配；此处只读已存在的 agentPromise）。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('memora.disabledSkills')) return;
      void (async () => {
        const agent = agentPromise ? await agentPromise.catch(() => null) : null;
        if (!agent) return;
        syncDisabledSkills(agent, chatProvider, settingsProvider);
      })().catch((err) => {
        // 降级优先：同步失败不打断用户当前操作——禁用集在下次装配时仍会按新配置注入
        console.warn('Memora 技能启停配置同步失败', err);
      });
    }),
  );

  // 命令：查看记忆统计（agent.memory + agent.getMetrics()）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.memoryStats', async () => {
      const agent = await getAgentForCommand();
      if (!agent) {
        vscode.window.showWarningMessage('Memora Agent 未就绪，无法查看记忆统计');
        return;
      }
      const mem = agent.memory;
      // 统计口径 SSOT = 内核 memory.stats()（total = 活跃数，bySource = 来源分布；走
      // sourceCountCache / getAllSources 增量缓存，精确且免全量列举）。若用 list(1000)
      // 自行聚合，superseded 与来源分布超 1000 条时双双低报（坑）。
      const stats = mem?.stats();
      const activeCount = stats?.total ?? 0;
      const deletedCount = mem?.listDeleted().length ?? 0;
      const sourceSummary =
        Object.entries(stats?.bySource ?? {})
          .map(([src, cnt]) => `${src}: ${cnt}`)
          .join(', ') || '—';
      vscode.window.showInformationMessage(
        `记忆统计：活跃 ${activeCount} 条，回收站 ${deletedCount} 条 | 来源分布：${sourceSummary}`,
      );
    }),
  );

  // 命令：清理过期软删除记忆（agent.memory.writePurgeExpired()）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.cleanupMemories', async () => {
      const agent = await getAgentForCommand();
      if (!agent?.memory) {
        vscode.window.showWarningMessage('Memora Agent 未就绪，无法清理记忆');
        return;
      }
      // 确认对话框——防止误操作
      const confirmed = await vscode.window.showWarningMessage(
        `将永久删除 ${MEMORY_RECYCLE_RETENTION_DAYS} 天前的软删除记忆，此操作不可撤销。`,
        { modal: true },
        '确认清理',
        '取消',
      );
      if (confirmed !== '确认清理') return;
      try {
        // 保留期 SSOT = shared/constants（与设置面板「清理过期」同源，改一处即两侧同步）
        const cutoff = new Date(Date.now() - MEMORY_RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const purged = agent.memory.writePurgeExpired(cutoff);
        vscode.window.showInformationMessage(`已清理 ${purged} 条过期记忆`);
      } catch (err) {
        vscode.window.showErrorMessage(`清理失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

// 命令：立即执行孤儿 Round 垃圾回收（agent.gcNow() 手动触发入口）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.runGc', async () => {
      const agent = await getAgentForCommand();
      if (!agent) {
        vscode.window.showWarningMessage('Memora Agent 未就绪，无法执行垃圾回收');
        return;
      }
      try {
        const stats = agent.gcNow();
        vscode.window.showInformationMessage(
          `孤儿回收完成：扫描 ${stats.scanned} 个问答闭环，清理 ${stats.deleted} 个孤立 Round + ${stats.memoryCleaned} 条摘要`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`垃圾回收失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  // 命令：登记作品投影（极简触发器——右键文件即登记，LLM 自动生成描述）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.registerWork', async (uri) => {
      // 仅支持从右键菜单触发（必须带 uri 参数）
      const uris = Array.isArray(uri) ? uri : (uri ? [uri] : []);
      if (uris.length === 0) {
        vscode.window.showWarningMessage('请在文件上右键，选择「Memora: 登记作品投影」');
        return;
      }
      
      // 提取第一个文件路径
      const targetUri = uris[0];
      const relativePath = vscode.workspace.asRelativePath(targetUri);
      
      // 显示进度
      vscode.window.showInformationMessage('正在登记：' + relativePath + ' ...');
      
      const agent = await getAgentForCommand();
      if (!agent?.works) {
        vscode.window.showWarningMessage('Memora Agent 未就绪，无法登记作品');
        return;
      }
      
      // 文件内容裁切上限：超长文件只取头部
      const DESCRIPTION_MAX_INPUT_CHARS = 8000;
      // 输出 token 上限：推理模型（R1/QwQ）需预留 reasoning_content 预算，过小会导致 content 空
      const DESCRIPTION_MAX_TOKENS = 4096;

      try {
        // 读取文件内容（按上限裁切，超长文件仅取头部并标注，保持上下文足够且成本可控）
        const fileContent = await vscode.workspace.fs.readFile(targetUri);
        const fullText = Buffer.from(fileContent).toString('utf-8');
        const truncated = fullText.length > DESCRIPTION_MAX_INPUT_CHARS;
        const text = (truncated ? fullText.substring(0, DESCRIPTION_MAX_INPUT_CHARS) : fullText)
          + (truncated ? `\n\n（以下仅文件开头前 ${DESCRIPTION_MAX_INPUT_CHARS} 字符，内容可能不完整）` : '');

        // 调用 LLM 生成一句话描述
        // prompt 显式传入文件名 + 禁止复述标题，迫使模型提炼要点而非回声文件名
        const baseNameHint = relativePath.split(/[\\/]/).pop() ?? '';
        const prompt =
          `文件名：${baseNameHint}\n` +
          `请用一句话（不超过 25 字）概括该文件的核心内容或用途，` +
          `不要简单重复文件名，要提炼它具体讲了什么、解决什么问题或包含哪些要点：\n\n` +
          text;
        let description = '';
        try {
          const raw = await accumulateStream(agent.provider, [
            { role: 'system', content: '你是文件描述生成器，只输出一句中文描述，不要解释。' },
            { role: 'user', content: prompt },
          ], { maxTokens: DESCRIPTION_MAX_TOKENS });
          // 诊断日志：区分"模型返回空"与"返回纯空白被 trim 掉"
          memoraOutput.appendLine(`[作品投影] LLM 原始返回 len=${raw.length} content=${JSON.stringify(raw)}`);
          description = raw.trim();
        } catch (llmErr) {
          // LLM 调用异常（鉴权/网络/超时）→ 不静默吞：打到输出通道 + 告警，留文件名兜底
          const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
          memoraOutput.appendLine(`[作品投影] LLM 生成描述失败：${msg}`);
          vscode.window.showWarningMessage('LLM 生成描述失败（详见 Memora 输出通道），已用文件名兜底：' + msg);
        }

        // 优雅降级：LLM 未返回有效描述时，用文件名（去扩展名）兜底，避免写空 description
        if (!description) {
          description = relativePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'unknown';
          memoraOutput.appendLine(`[作品投影] LLM 未返回描述，已用文件名兜底：${description}`);
          vscode.window.showWarningMessage('LLM 未返回描述，已用文件名「' + description + '」兜底');
        } else {
          memoraOutput.appendLine(`[作品投影] LLM 生成描述：${description}`);
        }

        // 登记投影
        const result = await agent.works.registerWork(relativePath, description);
        if (result) {
          vscode.window.showInformationMessage('作品登记成功：' + result.name + ' | ' + description);
        } else {
          vscode.window.showErrorMessage('作品登记失败，路径可能越界或发生其他错误');
        }
      } catch (err) {
        vscode.window.showErrorMessage('登记失败：' + (err instanceof Error ? err.message : String(err)));
      }
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
 * 内核 Agent.close() 内部调用 sessionManager.flushOnShutdown()（纯内存清脏 no-op——
 * 检查点不落盘，进行中工具结果与幂等标记仅内存态，正常关闭即整体丢弃，无持久化保障）。
 * 失败不阻塞插件退出。
 */
export async function deactivate(): Promise<void> {
  if (!agentPromise) return;
  try {
    const agent = await agentPromise;
    await agent.close();
  } catch {
    // 关闭失败静默降级：不阻断插件退出（VS Code 不因 deactivate 异常而阻塞）
  }
}






