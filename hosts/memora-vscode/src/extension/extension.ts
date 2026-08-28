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
import { WorkspaceRoundStore } from './host/workspaceRoundStore.js';
import { WorkspaceSessionViewLoader } from './host/sessionViewLoader.js';
import { ProviderStore } from './providers/providerStore.js';
import { MemoraChatViewProvider } from '../webview/panels/chatPanel.js';
import { MemoraSettingsViewProvider } from '../webview/panels/settingsPanel.js';
import { openChatCommand } from './commands/openChat.js';
import { runDemoCommand } from './commands/demo.js';
import { ACTIVE_ROLE_PACK_KEY, CONFIRM_WRITES_KEY } from '../shared/constants.js';

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

/** 懒加载的 Agent 单例（跨命令复用） */
let agentPromise: Promise<Agent> | null = null;

/**
 * 获取（或创建）指定工作区的 Agent 实例
 *
 * @param projectPath 工作区路径
 * @param providerStore 大模型配置存储
 * @param sessionStore 会话存储单例（SSOT：与 UI 面板共享，杜绝双实例覆盖写导致会话记录加载不全）
 * @param globalState vscode 全局状态（读取持久化的激活角色包，重启后恢复用户选择；
 *   用户级而非工作区级——角色选择是用户偏好，2026-08-17 存储层级收敛）
 * @param configDir 插件内置配置目录（SSOT 修复：由 extension.extensionUri 显式定位，
 *   而非 assemble 内 import.meta.url 相对推断——esbuild bundle 后路径漂移导致角色包加载失败）
 * @param userSkillsDir 用户技能目录（可选，2026-08-22 新增）
 * @param userRolePacksDir 用户角色包目录（可选，2026-08-22 新增，预留扩展）
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
    // 读取持久化的激活角色包（用户上次选择；无记录时为 undefined → 内核默认激活首个）
    const activeRolePack = globalState.get<string>(ACTIVE_ROLE_PACK_KEY);
    // 读取写入二次确认开关（用户安全偏好；默认 false → owner 写文件自动批准）
    const confirmWrites = globalState.get<boolean>(CONFIRM_WRITES_KEY) ?? false;
    // 读取工作区白名单额外路径（G8：项目级设置，落 .vscode/settings.json）；
    // 项目目录基准根恒在，此处仅含用户额外目录
    const allowedPaths = vscode.workspace
      .getConfiguration('memora')
      .get<string[]>('allowedPaths', []);
    agentPromise = assembleAgent({
      projectPath,
      providerStore,
      sessionStore,
      roundStore,
      activeRolePack,
      configDir,
      userSkillsDir,
      userRolePacksDir,
      confirmWrites,
      allowedPaths,
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
  // 一次性迁移：工作区 settings.json 旧 Provider 配置 → 用户级（2026-08-17 存储层级收敛，
  // 避免 Workspace 优先级覆盖 Global 新配置导致不生效）
  void providerStore.migrateFromWorkspace();

  // 插件内置配置目录（SSOT 修复 2026-08-15）：从 extensionUri 显式定位，
  // 指向 dist/extension（role-packs 等资源所在）。替代 assemble 内 import.meta.url
  // 相对推断——esbuild bundle 后路径漂移导致内置角色包加载为 0。
  const configDir = join(context.extensionUri.fsPath, 'dist', 'extension');

  // 用户技能目录（2026-08-22 新增）：使用 VS Code 全局存储目录
  // 路径示例：C:\Users\SJ\AppData\Roaming\Code\User\globalStorage\zooique.memora-vscode\skills\
  // 与内置技能分离，支持用户独立管理；目录不存在时自动创建
  const userSkillsDir = join(context.globalStorageUri.fsPath, 'skills');
  void mkdir(userSkillsDir, { recursive: true }).catch(() => {
    // 目录创建失败不阻塞插件启动，用户技能功能不可用而已
  });

  // 用户角色包目录（2026-08-22 新增，预留扩展点）：
  // 
  // ⚠️ 当前状态：角色包**不开放给用户**，仅支持内置角色包
  // - 内置角色包：构建期从内核 role-packs/ 同步，存储在插件安装目录的 dist/extension/role-packs/
  // - 用户角色包：当前禁止创建/加载，目录仅为未来开放预留
  //
  // 设计决策（2026-08-22）：
  // - 与技能系统不同，角色包包含更复杂的 persona.md + rules.md + skills/ 结构
  // - 开放用户角色包需要设计校验机制、安全检查和版本兼容策略
  // - 当前阶段优先验证内置角色包的价值，待用户场景明确后再开放
  //
  // 若未来开放用户角色包：
  // 1. 宿主侧新增角色包管理 UI（创建/导入/删除）
  // 2. 内核侧 loadExtraDir() 已就绪，可直接复用
  // 3. 参考用户技能的 globalStorage 方案，路径统一管理
  const userRolePacksDir = join(context.globalStorageUri.fsPath, 'role-packs');
  void mkdir(userRolePacksDir, { recursive: true }).catch(() => {
    // 目录创建失败不阻塞插件启动
  });

  // 侧边栏视图：对话面板（sessionStore 与 assemble 同路径 .memora/sessions.json）
  const workspacePath = resolveWorkspacePath();

  // Round-based 存储层（SSOT：WorkspaceSessionStore 与 Agent 共享同一 WorkspaceRoundStore 实例，
  // 杜绝双实例覆盖写 / 缓存漂移——否则 UI 重载历史读不到 Agent 刚写入的 Round）
  const roundStore = new WorkspaceRoundStore(workspacePath);
  roundStore.load();
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
  // 注入技能聚合目录：composer 动态技能下拉与设置面板同一清单来源（SSOT 收紧 2026-08-25）
  chatProvider.setSkillDirs(configDir, userSkillsDir);
  // 打开面板即懒装配 Agent（不依赖先执行 open 命令），保证发送始终可用；
  // 装配复用同一 sessionStore 单例（SSOT），与 UI 面板共享，杜绝双实例覆盖写；
  // 装配路径与 sessionStore 同源（resolveWorkspacePath），保证读写的文件一致
  chatProvider.setAgentFactory((projectPath) =>
    getOrCreateAgent(projectPath, providerStore, sessionStore, roundStore, context.globalState, configDir, userSkillsDir, userRolePacksDir, memoraOutput),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MemoraChatViewProvider.viewType, chatProvider),
  );

  // 侧边栏视图：设置面板（2026-08-17 选项卡合并：角色 / 大模型 / 记忆 合一）
  // 三个子视图均为低频操作（角色切换、模型配置、记忆浏览），合并为单一「设置」视图、
  // 内部按钮切换，避免活动栏底部 4 个选项卡拥挤（用户反馈 2026-08-17）。
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
  // 设置视图合并后（2026-08-17），先记录待切选项卡再聚焦；视图未就绪时由 settingsPanel
  // 在 ready 握手后补发 settings_switch_tab，保证命令落点与用户意图一致。
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.configureModel', () => {
      settingsProvider.switchTab('config');
      void vscode.commands.executeCommand(`${MemoraSettingsViewProvider.viewType}.focus`);
    }),
  );

  // 命令：运行能力演示（隔离演示区 → Output Channel，2026-08-22）
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

  // 命令：查看记忆统计（agent.memory + agent.getMetrics()）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.memoryStats', async () => {
      const agent = await getAgentForCommand();
      if (!agent) {
        vscode.window.showWarningMessage('Memora Agent 未就绪，无法查看记忆统计');
        return;
      }
      const mem = agent.memory;
      const activeCount = mem?.list(1000).length ?? 0;
      const deletedCount = mem?.listDeleted(1000).length ?? 0;
      // 来源分布：从 list() 结果自行统计（MemoryInspector 未暴露 getAllSources 公开方法）
      const sourceMap = new Map<string, number>();
      if (mem) {
        for (const m of mem.list(1000)) {
          sourceMap.set(m.source, (sourceMap.get(m.source) ?? 0) + 1);
        }
      }
      const sourceSummary = [...sourceMap.entries()].map(([src, cnt]) => `${src}: ${cnt}`).join(', ') || '—';
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
        '将永久删除 30 天前的软删除记忆，此操作不可撤销。',
        { modal: true },
        '确认清理',
        '取消',
      );
      if (confirmed !== '确认清理') return;
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const purged = agent.memory.writePurgeExpired(thirtyDaysAgo);
        vscode.window.showInformationMessage(`已清理 ${purged} 条过期记忆`);
      } catch (err) {
        vscode.window.showErrorMessage(`清理失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

﻿  // 命令：立即执行孤儿 Round 垃圾回收（agent.gcNow() 手动触发入口）
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
  // 会话管理入口已全量收敛到 webview 标题条（2026-08-17 会话管理重构）：
  //   - 新建会话「＋」/ 历史记录（模态浮层）/ 改名笔 均由 webview 内按钮触发（W→E 消息）
  //   - 原「清空对话」（clearChat）为伪需求，由「删除会话记录」覆盖（用户决策 2026-08-17）
  //   - 原「会话列表」（switchSession，QuickPick 三合一）被标题条按钮 + 历史浮层取代
  // 故 memora.clearChat / memora.switchSession 两命令不再注册。
}

/**
 * 插件停用入口
 *
 * D1-①（2026-08-26）：优雅关闭前落盘未收尾轮的检查点。内核 Agent.close() 内部调用
 * sessionManager.flushOnShutdown()——覆盖「logToolExecution 标脏后、未到 completeRound」
 * 的关闭窗口，避免进行中工具结果与幂等标记在正常关闭时丢失。失败不阻塞插件退出。
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






