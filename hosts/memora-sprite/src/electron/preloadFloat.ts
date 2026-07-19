/**
 * 预加载脚本 — 浮动窗口最小化安全桥接
 *
 * 与主 preload.ts 的差异：
 *   - 仅暴露浮动窗口所需的 12 个 API（4 动作 + 8 事件监听，vs 主 preload 的全量 API）
 *   - 仅内联 8 个浮动窗口相关 IPC 通道（4 渲染→主 + 4 主→渲染）
 *   - 剥离高危 API：deleteMemory / installSkill / saveLlmProvider / clearAuditLog 等
 *
 * 决策依据：ADR-SP-017 §1 窗口管理器内联 IPC 模式 + security_rules.md P3 最小权限原则
 * 浮动窗口作为独立窗口等价触发 ADR-SP-017 §何时回顾 L105"当 quick-input 窗口数 > 1 时评估"
 *
 * ⚠️ Sandbox 兼容性：
 * Electron sandbox: true 要求 preload 是单个 CommonJS 文件，不能有外部模块的运行时导入。
 * IPC 通道常量内联到本文件，与 channels.ts 保持手动同步。
 * 通过 tsconfig.preload.json 编译为 CommonJS 格式的 preloadFloat.cjs。
 *
 * 与 channels.ts 同步约定：
 * 参照 preloadQuickInput.ts 模式，本文件不新增 parity 测试
 * （channelParity.test.ts 仅断言主 preload.ts 键集与 channels.ts 完全相同）。
 * 修改 channels.ts 中以下 8 个通道时需同步更新本文件内联副本：
 *   渲染→主：MOVE_FLOAT_WINDOW / SAVE_FLOAT_POSITION / EXPAND_TO_FULL / FLOAT_CONTEXT_MENU
 *   主→渲染：FLOAT_UNREAD / FLOAT_LAST_MESSAGE / SPRITE_EVENT / THEME_BROADCAST
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// ─── 内联 IPC 通道常量（仅浮动窗口所需的 8 个）─────
// ⚠️ 与 channels.ts 保持同步：修改 channels.ts 时需同步更新此处的内联副本。
// 主进程使用 channels.ts（真理源），preload 使用此内联副本（sandbox 限制）。

/** 渲染→主进程 通道（仅浮动窗口相关，4 个） */
const IPC_CHANNELS = {
  /** 拖动浮动窗口（fire-and-forget，增量移动） */
  MOVE_FLOAT_WINDOW: 'move-float-window',
  /** 拖动结束保存最终位置 */
  SAVE_FLOAT_POSITION: 'save-float-position',
  /** 单击展开为完整窗口 */
  EXPAND_TO_FULL: 'expand-to-full',
  /** 右键显示上下文菜单 */
  FLOAT_CONTEXT_MENU: 'float-context-menu',
} as const;

/** 主→渲染进程 通道（仅浮动窗口相关，4 个） */
const MAIN_TO_RENDERER_CHANNELS = {
  /** 未读消息计数推送（更新浮动窗口 badge） */
  FLOAT_UNREAD: 'float-unread',
  /** 最后一条助手消息推送（浮动窗口 hover 预览） */
  FLOAT_LAST_MESSAGE: 'float-last-message',
  /** 精灵事件推送（在场状态变化、感知事件等） */
  SPRITE_EVENT: 'sprite-event',
  /** 主题变更广播（完整窗口 → 浮动窗口同步） */
  THEME_BROADCAST: 'theme-broadcast',
} as const;

// ─── 类型定义（仅浮动窗口所需）─────

/** 精灵事件消息结构（与主 preload.ts onSpriteEvent 一致） */
interface SpriteEventMessage {
  /** 事件类型（如 presenceChanged） */
  type: string;
  /** 事件载荷（按 type 不同结构不同） */
  payload: unknown;
  /** 是否静默（true 不弹通知，仅视觉反馈） */
  silent: boolean;
}

// ─── 暴露给渲染进程的 API（浮动窗口动作 + 事件监听器移除）─────

const floatAPI = {
  // ─── 浮动窗口动作（4 个，渲染→主 fire-and-forget） ─────────

  /** 拖动浮动窗口（渲染进程捕获 mousedown/mousemove，IPC 通知主进程增量移动） */
  moveFloatWindow: (dx: number, dy: number): void =>
    ipcRenderer.send(IPC_CHANNELS.MOVE_FLOAT_WINDOW, dx, dy),

  /** 拖动结束保存最终位置（持久化到 windowStateManager） */
  saveFloatPosition: (): void =>
    ipcRenderer.send(IPC_CHANNELS.SAVE_FLOAT_POSITION),

  /** 单击展开为完整窗口（仅 tray 态触发，主进程切换窗口状态） */
  expandToFull: (): void =>
    ipcRenderer.send(IPC_CHANNELS.EXPAND_TO_FULL),

  /** 右键显示上下文菜单（主进程使用 Electron 原生 Menu） */
  showFloatContextMenu: (): void =>
    ipcRenderer.send(IPC_CHANNELS.FLOAT_CONTEXT_MENU),

  // ─── 未读消息计数监听（1 on + 1 remove） ─────────

  /** 监听未读消息计数变化（更新浮动窗口 badge） */
  onFloatUnread: (cb: (count: number) => void): void => {
    ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD, (_: IpcRendererEvent, count: number) => cb(count));
  },

  /** 移除未读消息计数监听器 */
  removeFloatUnreadListener: (): void => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD);
  },

  // ─── 最后一条消息预览（1 on + 1 remove） ─────────

  /** 监听最后一条助手消息推送（浮动窗口 hover 预览，P4-1） */
  onLastMessage: (cb: (text: string) => void): void => {
    ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.FLOAT_LAST_MESSAGE, (_: IpcRendererEvent, text: string) => cb(text));
  },

  /** 移除最后一条消息监听器 */
  removeLastMessageListener: (): void => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.FLOAT_LAST_MESSAGE);
  },

  // ─── 精灵事件（1 on + 1 remove） ─────────

  /** 监听精灵事件（在场状态变化、感知事件等，与完整窗口同通道） */
  onSpriteEvent: (cb: (msg: SpriteEventMessage) => void): void => {
    ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, (_: IpcRendererEvent, msg: SpriteEventMessage) => cb(msg));
  },

  /** 移除精灵事件监听器 */
  removeSpriteEventListener: (): void => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT);
  },

  // ─── 主题广播（1 on + 1 remove） ─────────

  /** 监听主题变更广播（完整窗口切换主题时同步到浮动窗口） */
  onThemeBroadcast: (cb: (theme: 'light' | 'dark') => void): void => {
    ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.THEME_BROADCAST, (_: IpcRendererEvent, theme: 'light' | 'dark') => cb(theme));
  },

  /** 移除主题广播监听器 */
  removeThemeBroadcastListener: (): void => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.THEME_BROADCAST);
  },
};

// ─── 暴露到渲染进程 ─────

// 条件保护——测试环境（vitest）无 contextBridge，直接调用会抛错阻断测试
// sandbox 环境下 contextBridge 始终存在，此条件不影响生产运行
if (typeof contextBridge !== 'undefined' && contextBridge.exposeInMainWorld) {
  // 暴露名保持 'electronAPI'（与主 preload 同名），渲染层 float.ts 无感切换
  contextBridge.exposeInMainWorld('electronAPI', floatAPI);
}
