/**
 * settingsView — 设置面板 webview 运行时脚本（2026-08-17 选项卡合并）
 *
 * 由 settingsPanel.ts 的 buildHtml 引用：以工厂函数 createSettingsView 接收依赖
 * （acquireVsCodeApi / window）并初始化全部交互。
 *
 * 职责：
 *   - 选项卡栏切换（角色 / 大模型 / 记忆）：点击按钮切换高亮 + 显示对应子视图；
 *   - 挂载三个子视图工厂（rolesView / configView / memoryView），共享同一 webview 文档，
 *     各自以 root 容器隔离 id 空间（#list/#statBar 等在各自根内不冲突）；
 *   - 监听 host 的 settings_switch_tab 指令（configureModel 命令 → 大模型选项卡）。
 *
 * 挂载顺序（重要约定）：config → memory → roles。rolesView 在挂载末尾发送 ready 握手，
 * host 收到 ready 时全部监听器（含 settings_switch_tab 与本文件内已注册的）都已就绪，
 * 可安全补发待切选项卡 —— 对齐 chatPanel replaySession 的 ready 时序修复范式。
 *
 * 由 esbuild 以 browser/iife 打包为 dist/webview/scripts/settingsView.js，经
 * webview.asWebviewUri 在 HTML 中 <script src> 引用（CSP script-src cspSource）。
 */
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { createConfigView } from './configView.js';
import { createMemoryView } from './memoryView.js';
import { createRolesView } from './rolesView.js';

/** settingsView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface SettingsViewDeps {
  /** 获取 webview 通信 API（仅 webview 上下文合法） */
  acquireVsCodeApi: () => { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象 */
  window: Window;
}

/** 子选项卡标识（与 HTML 中 data-tab / 根容器 id 对齐） */
type SettingsTab = 'roles' | 'config' | 'memory';

/**
 * 初始化设置面板 webview 交互（选项卡切换 + 挂载三个子视图）
 *
 * @param deps 运行时依赖（acquireVsCodeApi + window）
 */
export function createSettingsView({ acquireVsCodeApi, window }: SettingsViewDeps): void {
  const document = window.document;
  // SSOT：acquireVsCodeApi 每个 webview 只能调用一次，此处获取一次并注入三个子视图，
  // 避免子视图各自调用导致后续调用返回失效对象、postMessage 静默失败（角色/记忆卡加载根因）
  const vscode = acquireVsCodeApi();

  // 选项卡按钮 + 三个子视图根容器（HTML 骨架固定 id，查询走全局 getElementById——
  // 根容器本身是唯一 id，只有根容器【内部】的子元素才做 root 内查询隔离）
  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-btn'));
  const roots: Record<SettingsTab, HTMLElement> = {
    roles: document.getElementById('roles-root') as HTMLElement,
    config: document.getElementById('config-root') as HTMLElement,
    memory: document.getElementById('memory-root') as HTMLElement,
  };

  /** 切换子选项卡：高亮对应按钮 + 显示对应根容器（其余隐藏；保留子视图 DOM 不重建，无闪烁） */
  function switchTab(tab: SettingsTab): void {
    tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
    (Object.keys(roots) as SettingsTab[]).forEach((key) => {
      roots[key].hidden = key !== tab;
    });
  }

  // 点击选项卡按钮切换
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === 'roles' || tab === 'config' || tab === 'memory') switchTab(tab);
    });
  });

  // host 指令切换（configureModel 命令 → 大模型选项卡）
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'settings_switch_tab') switchTab(msg.tab);
  });

  // 挂载三个子视图（config/memory 先，roles 后；全部用共享 vscode 实例）。
  // 初始选项卡为「记忆」，与 HTML 默认态一致（用户请求 2026-08-17）。
  // 每个挂载独立 try/catch：任一子视图挂载异常不阻断其余子视图，错误输出到 webview console。
  try {
    createConfigView({ vscode, window, root: roots.config });
  } catch (err) {
    console.error('[memora-settings] configView 挂载失败:', err);
  }
  try {
    createMemoryView({ vscode, window, root: roots.memory });
  } catch (err) {
    console.error('[memora-settings] memoryView 挂载失败:', err);
  }
  try {
    createRolesView({ vscode, window, root: roots.roles });
  } catch (err) {
    console.error('[memora-settings] rolesView 挂载失败:', err);
  }

  // ready 握手：三个子视图全部挂载（消息监听器已注册）后，由容器统一通知 host 就绪；
  // host 收到后统一推送三个子视图数据（对齐 chatPanel replaySession 的 ready 时序修复，
  // 避免首帧推送在监听器注册前到达而被丢弃）
  vscode.postMessage({ type: 'ready' });
}
