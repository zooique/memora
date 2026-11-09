/**
 * settingsView — 设置面板 webview 运行时脚本（选项卡合并）
 *
 * 由 settingsPanelHtml.ts 的 buildHtml 引用：以工厂函数 createSettingsView 接收依赖
 * （acquireVsCodeApi / window）并初始化全部交互。
 *
 * 职责：
 *   - 选项卡栏切换（全部 tab 的清单见 `shared/settingsTabs.ts`，本文件不写 tab 名单）：
 *     点击按钮切换高亮 + 显示对应子视图；
 *   - 挂载各子视图工厂，共享同一 webview 文档，各自以 root 容器隔离 id 空间
 *     （#list/#statBar 等在各自根内不冲突，故它们是「根内唯一」而非全局唯一）；
 *   - 监听 host 的 settings_switch_tab 指令（configureModel 命令 → 大模型选项卡）。
 *
 * 挂载顺序（重要约定）：config → memory → roles → skills → mcp → security → works。**ready 握手由
 * 容器在本函数末尾统一发出**（不是某个子视图发的）：等全部子视图挂载完、消息监听器都注册
 * 之后才请 host 推送，host 侧待切选项卡的补发才安全 —— 对齐 chatPanel replaySession 的
 * ready 时序修复范式。
 *
 * 子视图已全部按 tab 外置（security 于 B7 最后迁出）：本文件是**容器**，不该长成第二个大文件，
 * 也不该承载任何单页可见文案（本地化判据按文件登记，容器残留中文会连累每一页）。
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
// MCP 子视图（观察面 + 增删改停启）已按域拆出：本文件是选项卡容器，不该长成第二个大文件
import { createMcpView } from './mcpView.js';
import { createWorksView } from './worksView.js';
// 技能子视图已按 tab 外置（分页 / 禁用名单 / 正文渐进披露自成一域；本地化判据按文件登记）
import { createSkillsView } from './skillsView.js';
// 安全子视图已按 tab 外置（B7：执行审批 / 路径白名单 / 搜索引擎 / 恢复初始状态）
import { createSecurityView } from './securityView.js';
import { populateIcons } from './icons.js';
// 全局通知 toast 单一实现（UI-TOAST-1 三面收口：settings notice 与 config 操作反馈合一）
import { showToast } from '../helpers/toast.js';
import {
  SETTINGS_TABS,
  isSettingsTab,
  settingsRootId,
  type SettingsTab,
} from '../../shared/settingsTabs.js';

/** settingsView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface SettingsViewDeps {
  /** 获取 webview 通信 API（仅 webview 上下文合法） */
  acquireVsCodeApi: () => { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象 */
  window: Window;
}

/**
 * 子视图挂载工厂的公共签名
 *
 * 六个 `createXxxView` 各自的 Deps 接口（`ConfigViewDeps` / `MemoryViewDeps` / …）结构完全一致
 * （vscode / window / root 三字段），TS 结构类型下可直接赋给本签名 ⇒ 数组驱动挂载表无需改动
 * 那六个文件。任一视图**新增必填依赖**时本表会编译红——这正是想要的：新增依赖意味着
 * 「谁提供它」需要重议，不该静默塞进容器。
 */
export type MountFactory = (deps: {
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  window: Window;
  root: HTMLElement;
}) => void;

/**
 * 子视图挂载表（**顺序 = 初始化时序**，≠ `SETTINGS_TABS` 的 UI 顺序；后者 memory 在首位）
 *
 * config / memory / roles 先（老三页），skills / mcp / security 后。改顺序前先确认无跨页依赖。
 *
 * **为什么在模块级导出**（2026-10-26）：这张表此前在 `createSettingsView` 函数作用域内 ⇒
 * `settingsTabs.ts` 文件头承诺的「加一页 = ④ 本表一行」**无法被任何测试钉住**，而漏一行的
 * 表现是「该页有按钮、无内容」，tsc 与其他测试全绿、只有真机能发现（该文件自注「④-⑥ 缺 =
 * 静默半残，测试红不了」）。导出后由 `settingsView.test.ts` 断言「表内 name 集合 ==
 * `SETTINGS_TABS`」把这条承诺变成可红的——**这是本表能被写成承诺的前提，勿再移回函数内**。
 */
export const SETTINGS_VIEW_MOUNTS: ReadonlyArray<{ name: SettingsTab; make: MountFactory }> = [
  { name: 'config', make: createConfigView },
  { name: 'memory', make: createMemoryView },
  { name: 'roles', make: createRolesView },
  { name: 'skills', make: createSkillsView },
  { name: 'mcp', make: createMcpView },
  { name: 'security', make: createSecurityView },
  { name: 'works', make: createWorksView },
];

/**
 * 初始化设置面板 webview 交互（选项卡切换 + 挂载各子视图）
 *
 * @param deps 运行时依赖（acquireVsCodeApi + window）
 */
export function createSettingsView({ acquireVsCodeApi, window }: SettingsViewDeps): void {
  const document = window.document;
  // SSOT：acquireVsCodeApi 每个 webview 只能调用一次，此处获取一次并注入各子视图，
  // 避免子视图各自调用导致后续调用返回失效对象、postMessage 静默失败（角色/记忆卡加载根因）
  const vscode = acquireVsCodeApi();

  // 填充 HTML 中的图标容器（统一 SVG 图标管理）
  populateIcons(document.body);

  // 选项卡按钮 + 各子视图根容器（HTML 骨架固定 id，查询走全局 getElementById——
  // 根容器本身是唯一 id，只有根容器【内部】的子元素才做 root 内查询隔离）
  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-btn'));
  // 根容器集合按 tab 表派生（`settingsRootId` 保证 id 与 HTML 同源）——此前 5 个 id 手写在
  // 本文件、产线 HTML、CSS 三处，加 tab 忘一处即「点了没反应」且无编译报错。
  const roots = {} as Record<SettingsTab, HTMLElement>;
  SETTINGS_TABS.forEach((tab) => {
    roots[tab] = document.getElementById(settingsRootId(tab)) as HTMLElement;
  });

  /** 切换子选项卡：高亮对应按钮 + 显示对应根容器（其余隐藏；保留子视图 DOM 不重建，无闪烁） */
  function switchTab(tab: SettingsTab): void {
    tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
    SETTINGS_TABS.forEach((key) => {
      roots[key].hidden = key !== tab;
    });
  }

  // 点击选项卡按钮切换（`data-tab` 值先由 isSettingsTab 收窄：原先是五路 `tab === 'x' || …`
  // 手写比对，漏写一路的表现是「点了没反应」而不是报错）
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (isSettingsTab(tab)) switchTab(tab);
    });
  });

  // ─── 「在设置中调整 / 编辑」导航按钮（页面级统一绑定，**勿下放到子视图**） ───
  // `open_setting` 是页面级导航意图（跳到原生设置对应键），与任何子视图的状态无关 ⇒
  // 绑在容器层、事件委托到 document：任一选项卡新增同类按钮只需写 data-setting-key，零 JS 改动；
  // 子视图后续动态插入的同类按钮也自动生效（`querySelectorAll` 快照做不到）。
  //
  // 反面教材（2026-10-24 实测）：MCP 页首版复用了 `.open-setting-btn` + data-setting-key，但绑定
  // 语句留在安全子视图内查 `#security-root` ⇒ MCP 页的「在设置中编辑」**有按钮、无监听器**，
  // 点击零反应，且无编译错、无测试红（该类按钮当时只有一条用例，且查的是安全页那颗）。
  document.addEventListener('click', (event) => {
    const btn = (event.target as Element | null)?.closest<HTMLButtonElement>('.open-setting-btn');
    const key = btn?.dataset.settingKey;
    if (!key) return;
    vscode.postMessage({ type: 'open_setting', key });
  });

  // host 指令切换（configureModel 命令 → 大模型选项卡）
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'settings_switch_tab') switchTab(msg.tab);
    // notice 是 settings 侧操作反馈（角色/模型/引擎/审批等）的唯一入口——不消费则反馈被
    // 静默丢弃（SSOT 跨侧断链）。toast 实现已收口到 helpers/toast.ts（UI-TOAST-1：与
    // config 操作反馈、chat 活动条同元素/同时长/同分级/同令牌，勿在本文件再写一份）。
    else if (msg.type === 'notice') showToast(document, msg.level, msg.message);
  });

  // 挂载各子视图（数据驱动；全部用共享 vscode 实例）。
  // 每个挂载独立 try/catch：任一子视图异常不阻断其余，尤其不能截断末尾的 ready 握手
  // （ready 未发 ⇒ host 不推数据 ⇒ 全面板空白）。表内容与顺序见模块级 SETTINGS_VIEW_MOUNTS。
  for (const { name, make } of SETTINGS_VIEW_MOUNTS) {
    try {
      make({ vscode, window, root: roots[name] });
    } catch (err) {
      console.error(`[memora-settings] ${name}View 挂载失败:`, err);
    }
  }

  // ready 握手：全部子视图挂载（消息监听器已注册）后，由容器统一通知 host 就绪；
  // host 收到后统一推送各子视图数据（对齐 chatPanel replaySession 的 ready 时序修复，
  // 避免首帧推送在监听器注册前到达而被丢弃）
  vscode.postMessage({ type: 'ready' });
}
