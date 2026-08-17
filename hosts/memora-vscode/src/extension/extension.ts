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
 *   - role-packs/ 内置角色包（出厂自带 doc-review 定位，可后续支持导入）
 *   - webview/    面板 UI（仅 postMessage）
 *   - shared/     extension ↔ webview 消息协议
 */
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@zooique/memora';
import { assembleAgent } from './host/assemble.js';
import { WorkspaceSessionStore } from './host/sessionStore.js';
import { ProviderStore } from './providers/providerStore.js';
import { MemoraChatViewProvider } from '../webview/panels/chatPanel.js';
import { MemoraConfigViewProvider } from '../webview/panels/providerConfigPanel.js';
import { MemoraRolePackViewProvider } from '../webview/panels/rolePackPanel.js';
import { openChatCommand } from './commands/openChat.js';
import { ACTIVE_ROLE_PACK_KEY } from '../shared/constants.js';

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
 */
function getOrCreateAgent(
  projectPath: string,
  providerStore: ProviderStore,
  sessionStore: WorkspaceSessionStore,
  globalState: vscode.Memento,
  configDir: string,
): Promise<Agent> {
  if (!agentPromise) {
    // 读取持久化的激活角色包（用户上次选择；无记录时为 undefined → 内核默认激活首个）
    const activeRolePack = globalState.get<string>(ACTIVE_ROLE_PACK_KEY);
    agentPromise = assembleAgent({
      projectPath,
      providerStore,
      sessionStore,
      activeRolePack,
      configDir,
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
  // 大模型配置存储（providerStore 供配置面板 + Agent 装配共用）
  const providerStore = new ProviderStore(context.secrets);
  // 一次性迁移：工作区 settings.json 旧 Provider 配置 → 用户级（2026-08-17 存储层级收敛，
  // 避免 Workspace 优先级覆盖 Global 新配置导致不生效）
  void providerStore.migrateFromWorkspace();

  // 插件内置配置目录（SSOT 修复 2026-08-15）：从 extensionUri 显式定位，
  // 指向 dist/extension（role-packs 等资源所在）。替代 assemble 内 import.meta.url
  // 相对推断——esbuild bundle 后路径漂移导致内置角色包加载为 0。
  const configDir = join(context.extensionUri.fsPath, 'dist', 'extension');

  // 侧边栏视图：对话面板（sessionStore 与 assemble 同路径 .memora/sessions.json）
  const workspacePath = resolveWorkspacePath();
  const sessionStore = new WorkspaceSessionStore(workspacePath);
  sessionStore.load();
  const chatProvider = new MemoraChatViewProvider(context.extensionUri, sessionStore, providerStore);
  // 注入 globalState 供角色包切换时持久化激活态（用户级，跨项目共享，2026-08-17）
  chatProvider.setGlobalState(context.globalState);
  // 打开面板即懒装配 Agent（不依赖先执行 open 命令），保证发送始终可用；
  // 装配复用同一 sessionStore 单例（SSOT），与 UI 面板共享，杜绝双实例覆盖写；
  // 装配路径与 sessionStore 同源（resolveWorkspacePath），保证读写的文件一致
  chatProvider.setAgentFactory((projectPath) =>
    getOrCreateAgent(projectPath, providerStore, sessionStore, context.globalState, configDir),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MemoraChatViewProvider.viewType, chatProvider),
  );

  // 侧边栏视图：大模型配置面板
  const configProvider = new MemoraConfigViewProvider(context.extensionUri, providerStore);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MemoraConfigViewProvider.viewType, configProvider),
  );

  // 侧边栏视图：角色管理面板（2026-08-17 独立视图）
  // 角色切换是低频需求（决定定位与工具集），从对话输入区移出独立承载；
  // 装配复用与 chat 面板同一 getOrCreateAgent 单例（SSOT），切换持久化用户级激活态
  const roleProvider = new MemoraRolePackViewProvider(context.extensionUri);
  roleProvider.setAgentFactory((projectPath) =>
    getOrCreateAgent(projectPath, providerStore, sessionStore, context.globalState, configDir),
  );
  roleProvider.setGlobalState(context.globalState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MemoraRolePackViewProvider.viewType, roleProvider),
  );

  // 命令：打开对话面板（聚焦侧边栏视图）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.open', () =>
      openChatCommand(
        (projectPath) =>
          getOrCreateAgent(projectPath, providerStore, sessionStore, context.globalState, configDir),
        chatProvider,
      ),
    ),
  );

  // 命令：配置大模型（聚焦配置侧边栏视图）
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.configureModel', () =>
      void vscode.commands.executeCommand(`${MemoraConfigViewProvider.viewType}.focus`),
    ),
  );

  // 会话管理入口已全量收敛到 webview 标题条（2026-08-17 会话管理重构）：
  //   - 新建会话「＋」/ 历史记录（模态浮层）/ 改名笔 均由 webview 内按钮触发（W→E 消息）
  //   - 原「清空对话」（clearChat）为伪需求，由「删除会话记录」覆盖（用户决策 2026-08-17）
  //   - 原「会话列表」（switchSession，QuickPick 三合一）被标题条按钮 + 历史浮层取代
  // 故 memora.clearChat / memora.switchSession 两命令不再注册。
}

/** 插件停用入口 */
export function deactivate(): void {
  // Agent 由宿主持有；如需优雅关闭可在后续阶段补充 agent.close()
}
