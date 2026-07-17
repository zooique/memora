/**
 * 预加载脚本 — quick-input 浮窗最小化安全桥接
 *
 * 与主 preload.ts 的差异：
 *   - 仅暴露 quick-input 浮窗所需的 10 个 API（vs 主 preload 的 100+）
 *   - 仅内联 8 个 quick-input 相关 IPC 通道（vs 主 preload 的 106 个通道）
 *   - 剥离高危 API：installSkill / saveLlmProvider / deleteMemory / clearAuditLog 等
 *
 * 决策依据：ADR-SP-017 §1 窗口管理器内联 IPC 模式 + 安全审计 P3 最小权限原则
 *
 * ⚠️ Sandbox 兼容性：
 * Electron sandbox: true 要求 preload 是单个 CommonJS 文件，不能有外部模块的运行时导入。
 * IPC 通道常量内联到本文件，与 channels.ts 保持同步。
 * 通过 tsconfig.preload.json 编译为 CommonJS 格式的 preload-quick-input.cjs。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// ─── 内联 IPC 通道常量（仅 quick-input 浮窗所需的 6 个通道）─────
// ⚠️ 与 channels.ts 保持同步：修改 channels.ts 时需同步更新此处的内联副本。
// 主进程使用 channels.ts（真理源），preload 使用此内联副本（sandbox 限制）。

/** 渲染→主进程 通道（仅 quick-input 相关） */
const IPC_CHANNELS = {
  QUICK_INPUT_CONFIRM: 'quick-input-confirm',
  QUICK_INPUT_CLOSE: 'quick-input-close',
  QUICK_INPUT_RESIZE: 'quick-input-resize',
  MOVE_QUICK_INPUT: 'move-quick-input',
  QUICK_INPUT_POLISH: 'quick-input-polish',
  MEMORIES_SEARCH: 'memories-search',
  SESSION_SEARCH: 'session-search',
  /** 提升记忆 score（L2 采纳反哺内核） */
  MEMORIES_BOOST: 'memories-boost',
} as const;

/** 主→渲染进程 通道（仅 quick-input 相关） */
const MAIN_TO_RENDERER_CHANNELS = {
  /** 快速输入浮窗被 show() 调用（与 channels.ts 同步，无 sprite: 前缀） */
  QUICK_INPUT_SHOW: 'quick-input-show',
} as const;

// ─── 类型定义（最小化，仅 quick-input 所需）─────

/** 记忆搜索结果（与 memoryController.ts 的 MemorySearchResult 对齐） */
interface MemorySearchHit {
  id: string;
  name: string;
  contentPreview: string;
  source: string;
  score: number;
}

/** 会话消息搜索结果 */
interface SessionMessageResult {
  date: string;
  session: string;
  role: string;
  content: string;
  timestamp: string;
}

/** 确认输入结果 */
interface ConfirmResult {
  success: boolean;
  mode: 'paste' | 'copy';
  appName?: string;
}

/** 润色结果 */
interface PolishResult {
  polished: string;
  changed: boolean;
}

/** 浮窗 show 事件载荷 */
interface QuickInputShowPayload {
  clipboardText: string | null;
  isSensitive: boolean;
}

// ─── 暴露给渲染进程的 API（仅 9 个方法）─────

const quickInputAPI = {
  /** 搜索记忆（补全候选来源之一） */
  searchMemories: (query: string): Promise<{ hits: MemorySearchHit[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_SEARCH, query),

  /** 搜索会话消息（补全候选来源之一） */
  searchSessionMessages: (query: { keyword: string; limit?: number }): Promise<{
    results: SessionMessageResult[];
  }> => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SEARCH, query),

  /**
   * 提升记忆 score（L2 采纳反哺内核）
   *
   * 用户采纳补全候选后调用，将用户行为反馈到内核 Memory.score，
   * 实现"越常用越重要"的主动学习（跨会话生效，与渲染层 adoptedTexts 互补）。
   * fire-and-forget：失败不影响补全流程。
   */
  boostMemory: (id: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_BOOST, id),

  /** 确认输入（paste + 流式锁抑制 blur） */
  confirmQuickInput: (text: string, streamMode?: boolean): Promise<ConfirmResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_CONFIRM, text, streamMode),

  /** 关闭浮窗 */
  closeQuickInput: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_CLOSE),

  /** 调整浮窗高度（72-400px 范围校验） */
  resizeQuickInput: (height: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_RESIZE, height),

  /** 拖动浮窗位置（fire-and-forget，增量移动） */
  moveQuickInput: (dx: number, dy: number): void =>
    ipcRenderer.send(IPC_CHANNELS.MOVE_QUICK_INPUT, dx, dy),

  /** LLM 文本润色（主进程调用 agent.polish?.polish()） */
  polishQuickInput: (text: string): Promise<PolishResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_POLISH, text),

  /** 监听浮窗 show 事件（替代 window focus，避免 Alt+Tab 误清空） */
  onQuickInputShow: (cb: (payload: QuickInputShowPayload) => void): void => {
    ipcRenderer.on(
      MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_SHOW,
      (_: IpcRendererEvent, payload: QuickInputShowPayload) => cb(payload),
    );
  },

  /** 移除浮窗 show 事件监听器 */
  removeQuickInputShowListener: (): void => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_SHOW);
  },
};

// ─── 暴露到渲染进程 ─────

if (typeof contextBridge !== 'undefined' && contextBridge.exposeInMainWorld) {
  contextBridge.exposeInMainWorld('electronAPI', quickInputAPI);
}