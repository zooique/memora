/**
 * IPC 监听器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - 类型守卫纯函数（isObject / isProactivePromptPayload / isProjectSwitchedPayload / ...）
 * - initIpcListeners 注册的所有 IPC 监听器：
 *   - 流式输出（start/recall/thinking/toolStart/toolResult/chunk/end/aborted/contextTruncated）
 *   - 精灵输出（system / proactive 区分）
 *   - 精灵事件分发（memoryNoticed/insightGained/conflictDetected/proactivePrompt 等 17 种 type）
 *   - 应用错误 / 精灵错误 / 浮动窗口未读计数 / Agent 就绪
 *   - 配置建议推送 / 写入确认
 *   - 剪贴板三重保护（changed/sensitiveIgnored/analysisReady/analysisRejected）
 *   - 全局快捷键（quick-record / recall-memory）
 * - consumeConflictTargetId 模块级状态消费
 * - handleDecayCompleted 24h 节流
 * - handleArchiveFailed 按 stage 独立 5min 节流
 *
 * Mock 策略：
 * - window.electronAPI：通过 Object.assign 注入 mock，捕获 onXxx 注册的回调
 * - UIManager：vi.fn() 桩函数，验证调用参数
 * - vi.useFakeTimers 验证 decayCompleted 24h 节流
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isObject,
  isProactivePromptPayload,
  isProjectSwitchedPayload,
  isSkillMatchedPayload,
  isMemoryRecalledPayload,
  isDecayCompletedPayload,
  isArchiveFailedPayload,
  initIpcListeners,
  consumeConflictTargetId,
} from '../../../electron/renderer/ipcListeners.js';
import type { IpcListenerCallbacks } from '../../../electron/renderer/ipcListeners.js';
import type { UIManager } from '../../../electron/renderer/ui.js';
// ConfigFilesChangedPayload 真理源在 preload（与 settingsManagerPanel 共用同一类型契约）
import type { ConfigFilesChangedPayload } from '../../../electron/preload.js';

// ─── isObject ─────────────────────────────────────────────

describe('isObject', () => {
  it('普通对象应返回 true', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  it('数组应返回 true（typeof [] === "object"）', () => {
    expect(isObject([])).toBe(true);
  });

  it('null 应返回 false（typeof null === "object" 但需显式排除）', () => {
    expect(isObject(null)).toBe(false);
  });

  it('原始类型应返回 false', () => {
    expect(isObject(undefined)).toBe(false);
    expect(isObject('string')).toBe(false);
    expect(isObject(123)).toBe(false);
    expect(isObject(true)).toBe(false);
    expect(isObject(Symbol('s'))).toBe(false);
  });
});

// ─── isProactivePromptPayload ─────────────────────────────

describe('isProactivePromptPayload', () => {
  /** 合法 payload 工厂 */
  const validPayload = () => ({
    prompt: '建议你休息一下',
    triggers: ['长时间工作', '连续编码'],
    silent: false,
  });

  it('合法 payload 应返回 true', () => {
    expect(isProactivePromptPayload(validPayload())).toBe(true);
  });

  it('silent=true 应返回 true（静默模式合法）', () => {
    const payload = { ...validPayload(), silent: true };
    expect(isProactivePromptPayload(payload)).toBe(true);
  });

  it('triggers 空数组应返回 true（无触发原因合法）', () => {
    const payload = { ...validPayload(), triggers: [] };
    expect(isProactivePromptPayload(payload)).toBe(true);
  });

  it('prompt 非字符串应返回 false', () => {
    const payload = { ...validPayload(), prompt: 123 };
    expect(isProactivePromptPayload(payload)).toBe(false);
  });

  it('triggers 非数组应返回 false', () => {
    const payload = { ...validPayload(), triggers: '长时间工作' };
    expect(isProactivePromptPayload(payload)).toBe(false);
  });

  it('triggers 含非字符串元素应返回 false', () => {
    const payload = { ...validPayload(), triggers: ['合法', 123] };
    expect(isProactivePromptPayload(payload)).toBe(false);
  });

  it('silent 非布尔应返回 false', () => {
    const payload = { ...validPayload(), silent: 'yes' };
    expect(isProactivePromptPayload(payload)).toBe(false);
  });

  it('null 应返回 false', () => {
    expect(isProactivePromptPayload(null)).toBe(false);
  });

  it('缺少字段应返回 false', () => {
    expect(isProactivePromptPayload({ prompt: 'hi' })).toBe(false);
  });
});

// ─── isProjectSwitchedPayload ─────────────────────────────

describe('isProjectSwitchedPayload', () => {
  it('合法 payload 应返回 true', () => {
    expect(isProjectSwitchedPayload({ projectName: 'memora' })).toBe(true);
  });

  it('projectName 非字符串应返回 false', () => {
    expect(isProjectSwitchedPayload({ projectName: 123 })).toBe(false);
  });

  it('缺少 projectName 应返回 false', () => {
    expect(isProjectSwitchedPayload({ name: 'memora' })).toBe(false);
  });

  it('null 应返回 false', () => {
    expect(isProjectSwitchedPayload(null)).toBe(false);
  });
});

// ─── isSkillMatchedPayload ────────────────────────────────

describe('isSkillMatchedPayload', () => {
  it('合法 payload 应返回 true', () => {
    expect(isSkillMatchedPayload({ skill: '代码审查', score: 0.95 })).toBe(true);
  });

  it('score 为 0 应返回 true（合法边界）', () => {
    expect(isSkillMatchedPayload({ skill: '测试', score: 0 })).toBe(true);
  });

  it('skill 非字符串应返回 false', () => {
    expect(isSkillMatchedPayload({ skill: 123, score: 0.9 })).toBe(false);
  });

  it('score 非数字应返回 false', () => {
    expect(isSkillMatchedPayload({ skill: '测试', score: '0.9' })).toBe(false);
  });

  it('NaN score 应返回 true（typeof NaN === "number"，运行时由调用方校验）', () => {
    // 类型守卫仅校验类型，不校验值范围；NaN 是 number 类型
    expect(isSkillMatchedPayload({ skill: '测试', score: NaN })).toBe(true);
  });

  it('缺少字段应返回 false', () => {
    expect(isSkillMatchedPayload({ skill: '测试' })).toBe(false);
  });
});

// ─── isMemoryRecalledPayload ──────────────────────────────

describe('isMemoryRecalledPayload', () => {
  it('合法 payload 应返回 true', () => {
    expect(isMemoryRecalledPayload({ count: 5 })).toBe(true);
  });

  it('count 为 0 应返回 true（合法边界）', () => {
    expect(isMemoryRecalledPayload({ count: 0 })).toBe(true);
  });

  it('count 非数字应返回 false', () => {
    expect(isMemoryRecalledPayload({ count: '5' })).toBe(false);
  });

  it('缺少 count 应返回 false', () => {
    expect(isMemoryRecalledPayload({ total: 5 })).toBe(false);
  });
});

// ─── isDecayCompletedPayload ──────────────────────────────

describe('isDecayCompletedPayload', () => {
  it('合法 payload 应返回 true', () => {
    expect(isDecayCompletedPayload({ decayedCount: 10 })).toBe(true);
  });

  it('decayedCount 为 0 应返回 true（无衰减合法）', () => {
    expect(isDecayCompletedPayload({ decayedCount: 0 })).toBe(true);
  });

  it('decayedCount 非数字应返回 false', () => {
    expect(isDecayCompletedPayload({ decayedCount: '10' })).toBe(false);
  });

  it('缺少 decayedCount 应返回 false', () => {
    expect(isDecayCompletedPayload({ count: 10 })).toBe(false);
  });
});

// ─── isArchiveFailedPayload（含 stage 枚举校验） ──────────────────────────────

describe('isArchiveFailedPayload', () => {
  it('合法 payload（stage=profile）应返回 true', () => {
    expect(isArchiveFailedPayload({ stage: 'profile', message: 'LLM 失败' })).toBe(true);
  });

  it('合法 payload（stage=insight）应返回 true', () => {
    expect(isArchiveFailedPayload({ stage: 'insight', message: 'LLM 失败' })).toBe(true);
  });

  it('合法 payload（stage=content）应返回 true', () => {
    // content 阶段：会话内容归档失败（SessionArchiver LLM 异常 / 写入失败）
    expect(isArchiveFailedPayload({ stage: 'content', message: '会话内容归档失败' })).toBe(true);
  });

  it('stage 为非法枚举值（autoConfig）应返回 false', () => {
    // 排雷修订：autoConfigRefiner 是"配置学习"非"归档"，不应进入 archiveFailed 事件
    expect(isArchiveFailedPayload({ stage: 'autoConfig', message: 'x' })).toBe(false);
  });

  it('stage 为任意字符串（非枚举值）应返回 false', () => {
    expect(isArchiveFailedPayload({ stage: 'unknown', message: 'x' })).toBe(false);
  });

  it('stage 非字符串应返回 false', () => {
    expect(isArchiveFailedPayload({ stage: 123, message: 'x' })).toBe(false);
  });

  it('message 非字符串应返回 false', () => {
    expect(isArchiveFailedPayload({ stage: 'profile', message: 123 })).toBe(false);
  });

  it('非对象应返回 false', () => {
    expect(isArchiveFailedPayload(null)).toBe(false);
    expect(isArchiveFailedPayload('string')).toBe(false);
    expect(isArchiveFailedPayload(undefined)).toBe(false);
  });
});

// ─── initIpcListeners · 测试辅助 ─────────────────────────────

/** UIManager 桩方法集合 */
interface UiManagerSpies {
  startStreaming: ReturnType<typeof vi.fn>;
  setMemoryRecall: ReturnType<typeof vi.fn>;
  showThinkingPhase: ReturnType<typeof vi.fn>;
  showTruncationNotice: ReturnType<typeof vi.fn>;
  showToolStart: ReturnType<typeof vi.fn>;
  updateToolResult: ReturnType<typeof vi.fn>;
  updateStreamingMessage: ReturnType<typeof vi.fn>;
  finishStreamingMessage: ReturnType<typeof vi.fn>;
  markStreamingAborted: ReturnType<typeof vi.fn>;
  appendMessage: ReturnType<typeof vi.fn>;
  clearUnreadCount: ReturnType<typeof vi.fn>;
  getCurrentPanel: ReturnType<typeof vi.fn>;
  switchPanel: ReturnType<typeof vi.fn>;
  showProactiveBanner: ReturnType<typeof vi.fn>;
  appendMilestoneBanner: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  injectErrorToStreamingMessages: ReturnType<typeof vi.fn>;
  setUnreadCount: ReturnType<typeof vi.fn>;
  showSuggestion: ReturnType<typeof vi.fn>;
  showWriteConfirmation: ReturnType<typeof vi.fn>;
  /** 剪贴板管理器 mock（v2 重构：addPendingItem + showSensitiveWarning） */
  clipboardManager: {
    addPendingItem: ReturnType<typeof vi.fn>;
    showSensitiveWarning: ReturnType<typeof vi.fn>;
  };
  showClipboardConfirmDialog: ReturnType<typeof vi.fn>;
  handleQuickRecordTrigger: ReturnType<typeof vi.fn>;
  handleRecallMemoryTrigger: ReturnType<typeof vi.fn>;
  /** P1-5：流式结束后消费待定草稿（ipcListeners.ts:936 调用；mock 曾缺失 → onStreamEnd 用例 TypeError） */
  consumePendingDrafts: ReturnType<typeof vi.fn>;
}

/** 业务回调桩方法集合 */
interface CallbackSpies {
  onMemoryNoticed: ReturnType<typeof vi.fn>;
  onInsightGained: ReturnType<typeof vi.fn>;
  onAgentReady: ReturnType<typeof vi.fn>;
  onConversationEnd: ReturnType<typeof vi.fn>;
  onAffectUpdated: ReturnType<typeof vi.fn>;
  onPresenceChanged: ReturnType<typeof vi.fn>;
  onRapportUpdated: ReturnType<typeof vi.fn>;
  onContextUpdated: ReturnType<typeof vi.fn>;
  onWorkProjectionUpdated: ReturnType<typeof vi.fn>;
  onPatternsUpdated: ReturnType<typeof vi.fn>;
  onSessionForked: ReturnType<typeof vi.fn>;
  /** 设定文件变更回调（精灵设定面板 Epic 3 · I4） */
  onConfigFilesChanged: ReturnType<typeof vi.fn>;
}

/** 捕获的 IPC onXxx 注册回调（initIpcListeners 调用后由 mock electronAPI 捕获） */
interface CapturedCallbacks {
  onStreamStart: (msg: { messageId: string; persona?: string }) => void;
  onStreamChunk: (msg: { messageId: string; text: string }) => void;
  onStreamEnd: (msg: { messageId: string }) => void;
  onStreamRecall: (msg: { messageId: string; memories: Array<{ id: string; name: string; score: number; source: string }> }) => void;
  onStreamThinking: (msg: { messageId: string; phase: string }) => void;
  onStreamToolStart: (msg: { messageId: string; toolCallId: string; name: string; args?: string }) => void;
  onStreamToolResult: (msg: { messageId: string; toolCallId: string; name: string; ok: boolean; summary?: string }) => void;
  onContextTruncated: (msg: { messageId: string; count: number }) => void;
  onStreamAborted: (msg: { messageId: string; reason: string }) => void;
  onSpriteOutput: (msg: { text: string; kind: 'proactive' | 'system' }) => void;
  onSpriteEvent: (msg: { type: string; payload: unknown; silent: boolean }) => void;
  onAppError: (error: { code: string; message: string; timestamp: string }) => void;
  onSpriteError: (msg: { text: string }) => void;
  onFloatUnread: (count: number) => void;
  onAgentReady: () => void;
  onSuggestionPush: (suggestion: unknown) => void;
  onWriteConfirmation: (info: unknown) => void;
  onClipboardChanged: (payload: { preview: string; length: number }) => void;
  onClipboardSensitiveIgnored: (payload: { type: string }) => void;
  onClipboardAnalysisReady: (payload: { content: string }) => void;
  onClipboardAnalysisRejected: (payload: { reason: string }) => void;
  onQuickRecordTrigger: () => void;
  onRecallMemoryTrigger: () => void;
  /** 设定文件变更注册回调（initIpcListeners 末尾注册，由 onConfigFilesChanged 捕获） */
  onConfigFilesChanged: (payload: ConfigFilesChangedPayload) => void;
  /** 会话状态变更注册回调（SESSION_STATUS_CHANGED IPC 监听） */
  onSessionStatusChanged: (payload: { status: string; reason?: string }) => void;
  /** 澄清问题推送注册回调（SESSION_NEED_CLARIFY IPC 监听） */
  onNeedClarify: (questions: Array<{ slot: string; question: string }>) => void;
  /** 澄清暂停超时自动续跑通知注册回调（CLARIFY_AUTO_RESOLVED IPC 监听） */
  onClarifyAutoResolved: (payload: { autoResolved: boolean }) => void;
  /** 任务表格生成通知注册回调（SPRITE_TASK_TABLE_GENERATED IPC 监听，taskTablePanelManager 刷新） */
  onTaskTableGenerated: (msg: { messageId: string; plan?: string }) => void;
}

/** mock electronAPI（含主动调用的方法） */
interface MockElectronAPI {
  proactivePromptShown: ReturnType<typeof vi.fn>;
  rendererLog: ReturnType<typeof vi.fn>;
}

/** 创建 mock UIManager（含 ipcListeners 使用到的全部方法） */
function createMockUiManager(): { uiManager: UIManager; spies: UiManagerSpies } {
  const spies = {
    startStreaming: vi.fn(),
    setMemoryRecall: vi.fn(),
    showThinkingPhase: vi.fn(),
    showTruncationNotice: vi.fn(),
    showToolStart: vi.fn(),
    updateToolResult: vi.fn(),
    updateStreamingMessage: vi.fn(),
    finishStreamingMessage: vi.fn(),
    markStreamingAborted: vi.fn(),
    appendMessage: vi.fn(),
    clearUnreadCount: vi.fn(),
    getCurrentPanel: vi.fn(() => 'chat'),
    switchPanel: vi.fn().mockResolvedValue(undefined),
    showProactiveBanner: vi.fn(),
    appendMilestoneBanner: vi.fn(),
    showToast: vi.fn(),
    injectErrorToStreamingMessages: vi.fn(),
    setUnreadCount: vi.fn(),
    showSuggestion: vi.fn(),
    showWriteConfirmation: vi.fn().mockResolvedValue(undefined),
    clipboardManager: {
      addPendingItem: vi.fn(),
      showSensitiveWarning: vi.fn(),
    },
    showClipboardConfirmDialog: vi.fn().mockResolvedValue(undefined),
    handleQuickRecordTrigger: vi.fn().mockResolvedValue(undefined),
    handleRecallMemoryTrigger: vi.fn().mockResolvedValue(undefined),
    consumePendingDrafts: vi.fn(),
  };
  return { uiManager: spies as Partial<UIManager> as UIManager, spies };
}

/** 初始化 IPC 监听器并返回所有 mock 引用 */
function setupIpcListeners(opts?: { currentPanel?: string }): {
  spies: UiManagerSpies;
  cb: CallbackSpies;
  api: MockElectronAPI;
  captured: CapturedCallbacks;
} {
  const { uiManager, spies } = createMockUiManager();
  if (opts?.currentPanel !== undefined) {
    spies.getCurrentPanel.mockReturnValue(opts.currentPanel);
  }

  const cb: CallbackSpies = {
    onMemoryNoticed: vi.fn(),
    onInsightGained: vi.fn(),
    onAgentReady: vi.fn(),
    onConversationEnd: vi.fn(),
    onAffectUpdated: vi.fn(),
    onPresenceChanged: vi.fn(),
    onRapportUpdated: vi.fn(),
    onContextUpdated: vi.fn(),
    onWorkProjectionUpdated: vi.fn(),
    onPatternsUpdated: vi.fn(),
    onSessionForked: vi.fn(),
    onConfigFilesChanged: vi.fn(),
  };

  const callbacks: IpcListenerCallbacks = {
    onMemoryNoticed: cb.onMemoryNoticed,
    onInsightGained: cb.onInsightGained,
    onAgentReady: cb.onAgentReady,
    onConversationEnd: cb.onConversationEnd,
    onAffectUpdated: cb.onAffectUpdated,
    onPresenceChanged: cb.onPresenceChanged,
    onRapportUpdated: cb.onRapportUpdated,
    onContextUpdated: cb.onContextUpdated,
    onWorkProjectionUpdated: cb.onWorkProjectionUpdated,
    onPatternsUpdated: cb.onPatternsUpdated,
    onSessionForked: cb.onSessionForked,
    onConfigFilesChanged: cb.onConfigFilesChanged,
  };

  const captured = {} as CapturedCallbacks;

  const api = {
    onStreamStart: vi.fn((handler: (msg: { messageId: string; persona?: string }) => void) => { captured.onStreamStart = handler; }),
    onStreamChunk: vi.fn((handler: (msg: { messageId: string; text: string }) => void) => { captured.onStreamChunk = handler; }),
    onStreamEnd: vi.fn((handler: (msg: { messageId: string }) => void) => { captured.onStreamEnd = handler; }),
    onStreamRecall: vi.fn((handler: (msg: { messageId: string; memories: Array<{ id: string; name: string; score: number; source: string }> }) => void) => { captured.onStreamRecall = handler; }),
    onStreamThinking: vi.fn((handler: (msg: { messageId: string; phase: string }) => void) => { captured.onStreamThinking = handler; }),
    onStreamToolStart: vi.fn((handler: (msg: { messageId: string; toolCallId: string; name: string; args?: string }) => void) => { captured.onStreamToolStart = handler; }),
    onStreamToolResult: vi.fn((handler: (msg: { messageId: string; toolCallId: string; name: string; ok: boolean; summary?: string }) => void) => { captured.onStreamToolResult = handler; }),
    onContextTruncated: vi.fn((handler: (msg: { messageId: string; count: number }) => void) => { captured.onContextTruncated = handler; }),
    onStreamAborted: vi.fn((handler: (msg: { messageId: string; reason: string }) => void) => { captured.onStreamAborted = handler; }),
    onSpriteOutput: vi.fn((handler: (msg: { text: string; kind: 'proactive' | 'system' }) => void) => { captured.onSpriteOutput = handler; }),
    onSpriteEvent: vi.fn((handler: (msg: { type: string; payload: unknown; silent: boolean }) => void) => { captured.onSpriteEvent = handler; }),
    onAppError: vi.fn((handler: (error: { code: string; message: string; timestamp: string }) => void) => { captured.onAppError = handler; }),
    onSpriteError: vi.fn((handler: (msg: { text: string }) => void) => { captured.onSpriteError = handler; }),
    onFloatUnread: vi.fn((handler: (count: number) => void) => { captured.onFloatUnread = handler; }),
    onAgentReady: vi.fn((handler: () => void) => { captured.onAgentReady = handler; }),
    onSuggestionPush: vi.fn((handler: (suggestion: unknown) => void) => { captured.onSuggestionPush = handler; }),
    onWriteConfirmation: vi.fn((handler: (info: unknown) => void) => { captured.onWriteConfirmation = handler; }),
    onClipboardChanged: vi.fn((handler: (payload: { preview: string; length: number }) => void) => { captured.onClipboardChanged = handler; }),
    onClipboardSensitiveIgnored: vi.fn((handler: (payload: { type: string }) => void) => { captured.onClipboardSensitiveIgnored = handler; }),
    onClipboardAnalysisReady: vi.fn((handler: (payload: { content: string }) => void) => { captured.onClipboardAnalysisReady = handler; }),
    onClipboardAnalysisRejected: vi.fn((handler: (payload: { reason: string }) => void) => { captured.onClipboardAnalysisRejected = handler; }),
    onQuickRecordTrigger: vi.fn((handler: () => void) => { captured.onQuickRecordTrigger = handler; }),
    onRecallMemoryTrigger: vi.fn((handler: () => void) => { captured.onRecallMemoryTrigger = handler; }),
    onConfigFilesChanged: vi.fn((handler: (payload: ConfigFilesChangedPayload) => void) => { captured.onConfigFilesChanged = handler; }),
    onSessionStatusChanged: vi.fn((handler: (payload: { status: string; reason?: string }) => void) => { captured.onSessionStatusChanged = handler; }),
    onNeedClarify: vi.fn((handler: (questions: Array<{ slot: string; question: string }>) => void) => { captured.onNeedClarify = handler; }),
    onClarifyAutoResolved: vi.fn((handler: (payload: { autoResolved: boolean }) => void) => { captured.onClarifyAutoResolved = handler; }),
    // 任务表格生成通知（ipcListeners.ts:942 调用；mock 曾缺失导致 initIpcListeners 顶层抛 TypeError
    // → 整个测试文件 setup 崩溃全红。preload 契约等宽原则：mock 须覆盖 ipcListeners 全部调用面）
    onTaskTableGenerated: vi.fn((handler: (msg: { messageId: string; plan?: string }) => void) => { captured.onTaskTableGenerated = handler; }),
    removeSessionStatusChangedListener: vi.fn(),
    proactivePromptShown: vi.fn(),
    rendererLog: vi.fn(),
  };

  // 注入 mock electronAPI 到 window（Object.assign 避免 as 断言）
  Object.assign(window, { electronAPI: api });

  initIpcListeners(uiManager, callbacks);

  return {
    spies,
    cb,
    api: { proactivePromptShown: api.proactivePromptShown, rendererLog: api.rendererLog },
    captured,
  };
}

/** 触发精灵事件（简化测试调用） */
function triggerSpriteEvent(captured: CapturedCallbacks, type: string, payload: unknown, silent = false): void {
  captured.onSpriteEvent({ type, payload, silent });
}

// ─── initIpcListeners · 流式输出监听 ─────────────────────

describe('initIpcListeners · 流式输出', () => {
  let spies: UiManagerSpies;
  let cb: CallbackSpies;
  let captured: CapturedCallbacks;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setup = setupIpcListeners();
    spies = setup.spies;
    cb = setup.cb;
    captured = setup.captured;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('onStreamStart → 调用 startStreaming(messageId, persona)', () => {
    captured.onStreamStart({ messageId: 'msg-1', persona: 'coder' });
    expect(spies.startStreaming).toHaveBeenCalledWith('msg-1', 'coder');
  });

  it('onStreamStart → 无 persona 时调用 startStreaming(messageId, undefined)', () => {
    captured.onStreamStart({ messageId: 'msg-2' });
    expect(spies.startStreaming).toHaveBeenCalledWith('msg-2', undefined);
  });

  it('onStreamRecall → 调用 setMemoryRecall(messageId, memories)', () => {
    const memories = [{ id: 'm1', name: '记忆1', score: 0.9, source: 'profile' }];
    captured.onStreamRecall({ messageId: 'msg-1', memories });
    expect(spies.setMemoryRecall).toHaveBeenCalledWith('msg-1', memories);
  });

  it('onStreamThinking → 调用 showThinkingPhase(messageId, phase)', () => {
    captured.onStreamThinking({ messageId: 'msg-1', phase: '正在回忆...' });
    expect(spies.showThinkingPhase).toHaveBeenCalledWith('msg-1', '正在回忆...');
  });

  it('onContextTruncated → 调用 showTruncationNotice(messageId, count)', () => {
    captured.onContextTruncated({ messageId: 'msg-1', count: 5 });
    expect(spies.showTruncationNotice).toHaveBeenCalledWith('msg-1', 5);
  });

  it('onStreamToolStart → 调用 showToolStart(messageId, toolCallId, name, args)', () => {
    captured.onStreamToolStart({ messageId: 'msg-1', toolCallId: 'tc-1', name: 'read_file', args: '{}' });
    expect(spies.showToolStart).toHaveBeenCalledWith('msg-1', 'tc-1', 'read_file', '{}');
  });

  it('onStreamToolResult → 调用 updateToolResult(messageId, toolCallId, name, ok, summary)', () => {
    captured.onStreamToolResult({ messageId: 'msg-1', toolCallId: 'tc-1', name: 'read_file', ok: true, summary: '读取成功' });
    expect(spies.updateToolResult).toHaveBeenCalledWith('msg-1', 'tc-1', 'read_file', true, '读取成功');
  });

  it('onStreamChunk → 调用 updateStreamingMessage(messageId, text)', () => {
    captured.onStreamChunk({ messageId: 'msg-1', text: '你好' });
    expect(spies.updateStreamingMessage).toHaveBeenCalledWith('msg-1', '你好');
  });

  it('onStreamEnd → 调用 finishStreamingMessage + onConversationEnd 回调', () => {
    captured.onStreamEnd({ messageId: 'msg-1' });
    expect(spies.finishStreamingMessage).toHaveBeenCalledWith('msg-1');
    expect(cb.onConversationEnd).toHaveBeenCalledTimes(1);
  });

  it('onStreamAborted → 调用 markStreamingAborted(messageId, reason)', () => {
    captured.onStreamAborted({ messageId: 'msg-1', reason: '用户中断' });
    expect(spies.markStreamingAborted).toHaveBeenCalledWith('msg-1', '用户中断');
  });
});

// ─── initIpcListeners · 精灵输出监听 ─────────────────────

describe('initIpcListeners · 精灵输出', () => {
  let spies: UiManagerSpies;
  let api: MockElectronAPI;
  let captured: CapturedCallbacks;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setup = setupIpcListeners();
    spies = setup.spies;
    api = setup.api;
    captured = setup.captured;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kind="system" → 仅 appendMessage，不调用 proactivePromptShown', () => {
    captured.onSpriteOutput({ text: '系统消息', kind: 'system' });
    expect(spies.appendMessage).toHaveBeenCalledWith({ role: 'system', content: '系统消息' });
    expect(spies.clearUnreadCount).not.toHaveBeenCalled();
    expect(api.proactivePromptShown).not.toHaveBeenCalled();
  });

  it('kind="proactive" → appendMessage + proactivePromptShown（不清除未读计数）', () => {
    captured.onSpriteOutput({ text: '主动提示', kind: 'proactive' });
    expect(spies.appendMessage).toHaveBeenCalledWith({ role: 'system', content: '主动提示' });
    // 未读计数清零统一由 onExpandToFull → resetUnreadCount 处理，
    // 此处不应清零（避免误清主进程在完整窗口不可见时累积的未读）
    expect(spies.clearUnreadCount).not.toHaveBeenCalled();
    expect(api.proactivePromptShown).toHaveBeenCalledTimes(1);
  });
});

// ─── initIpcListeners · 精灵事件分发 ─────────────────────

describe('initIpcListeners · 精灵事件分发', () => {
  let spies: UiManagerSpies;
  let cb: CallbackSpies;
  let api: MockElectronAPI;
  let captured: CapturedCallbacks;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setup = setupIpcListeners();
    spies = setup.spies;
    cb = setup.cb;
    api = setup.api;
    captured = setup.captured;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── 基础事件（无 payload） ───

  it('memoryNoticed → 触发 onMemoryNoticed 回调', () => {
    triggerSpriteEvent(captured, 'memoryNoticed', null, false);
    expect(cb.onMemoryNoticed).toHaveBeenCalledTimes(1);
  });

  it('insightGained → 触发 onInsightGained 回调', () => {
    triggerSpriteEvent(captured, 'insightGained', null, false);
    expect(cb.onInsightGained).toHaveBeenCalledTimes(1);
  });

  // ─── proactivePrompt（主动提示） ───

  it('proactivePrompt 非静默非里程碑 → showProactiveBanner + proactivePromptShown', () => {
    triggerSpriteEvent(captured, 'proactivePrompt', {
      prompt: '建议休息',
      triggers: ['长时间工作'],
      silent: false,
    }, false);
    expect(spies.showProactiveBanner).toHaveBeenCalledWith('建议休息', false, ['长时间工作']);
    expect(spies.appendMilestoneBanner).not.toHaveBeenCalled();
    expect(api.proactivePromptShown).toHaveBeenCalledTimes(1);
  });

  it('proactivePrompt 静默模式 → 不弹窗，不调用 proactivePromptShown', () => {
    triggerSpriteEvent(captured, 'proactivePrompt', {
      prompt: '建议休息',
      triggers: [],
      silent: true,
    }, false);
    expect(spies.showProactiveBanner).not.toHaveBeenCalled();
    expect(spies.appendMilestoneBanner).not.toHaveBeenCalled();
    expect(api.proactivePromptShown).not.toHaveBeenCalled();
  });

  it('proactivePrompt 里程碑 → appendMilestoneBanner + proactivePromptShown', () => {
    triggerSpriteEvent(captured, 'proactivePrompt', {
      prompt: '里程碑达成！',
      triggers: ['milestone'],
      silent: false,
      isMilestone: true,
    }, false);
    expect(spies.appendMilestoneBanner).toHaveBeenCalledWith('里程碑达成！');
    expect(spies.showProactiveBanner).not.toHaveBeenCalled();
    expect(api.proactivePromptShown).toHaveBeenCalledTimes(1);
  });

  it('proactivePrompt 面板不在 chat 时 → 先 switchPanel("chat") 再显示 banner', () => {
    // 重新初始化，当前面板设为 memories
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setup = setupIpcListeners({ currentPanel: 'memories' });
    triggerSpriteEvent(setup.captured, 'proactivePrompt', {
      prompt: '建议休息',
      triggers: [],
      silent: false,
    }, false);
    expect(setup.spies.switchPanel).toHaveBeenCalledWith('chat');
    expect(setup.spies.showProactiveBanner).toHaveBeenCalledTimes(1);
  });

  it('proactivePrompt 无效 payload → reportError，不调用 UI 方法', () => {
    triggerSpriteEvent(captured, 'proactivePrompt', { prompt: 123 }, false);
    expect(spies.showProactiveBanner).not.toHaveBeenCalled();
    expect(spies.appendMilestoneBanner).not.toHaveBeenCalled();
    expect(api.proactivePromptShown).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[handleProactivePrompt]', expect.anything());
  });

  // ─── conflictDetected（冲突检测） ───

  it('conflictDetected → showProactiveBanner 含 conflict trigger', () => {
    triggerSpriteEvent(captured, 'conflictDetected', {
      newMemoryId: 'm1',
      newInsight: '新洞察',
      targetId: 'target-1',
      targetContent: '旧记忆',
    }, false);
    expect(spies.showProactiveBanner).toHaveBeenCalledWith(
      expect.stringContaining('检测到记忆冲突'),
      false,
      ['conflict'],
    );
  });

  it('conflictDetected 无效 payload → reportError', () => {
    triggerSpriteEvent(captured, 'conflictDetected', { newMemoryId: 123 }, false);
    expect(spies.showProactiveBanner).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[handleConflictDetected]', expect.anything());
  });

  // ─── projectSwitched（项目切换） ───

  it('projectSwitched 非静默 → showToast；静默 → 不 showToast', () => {
    triggerSpriteEvent(captured, 'projectSwitched', { projectName: 'memora' }, false);
    expect(spies.showToast).toHaveBeenCalledWith('已切换到项目：memora', 'info', expect.any(Number));

    spies.showToast.mockClear();
    triggerSpriteEvent(captured, 'projectSwitched', { projectName: 'memora' }, true);
    expect(spies.showToast).not.toHaveBeenCalled();
  });

  it('projectSwitched 无效 payload → reportError', () => {
    triggerSpriteEvent(captured, 'projectSwitched', { name: 'memora' }, false);
    expect(spies.showToast).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[handleProjectSwitched]', expect.anything());
  });

  // ─── skillMatched（技能匹配） ───
  //
  // 阈值真理源说明：renderer 不再二次过滤分数——内核 SkillManager.match() 已用
  // SKILL_MATCH_MIN_SCORE (0.3) 过滤低匹配度技能，凡到达此处的 skillMatched 事件
  // score 均 ≥ 0.3（trigger 命中则 = 1.0），renderer 直接弹 toast。

  it('skillMatched 非静默 → showToast（内核已过滤低分，renderer 不二次过滤）', () => {
    triggerSpriteEvent(captured, 'skillMatched', { skill: '代码审查', score: 0.9 }, false);
    expect(spies.showToast).toHaveBeenCalledWith('匹配到技能：代码审查', 'info', expect.any(Number));

    // 内核过滤后到达 renderer 的事件 score 均 ≥ 0.3，即使低分（如 0.33）也弹 toast
    spies.showToast.mockClear();
    triggerSpriteEvent(captured, 'skillMatched', { skill: '测试', score: 0.33 }, false);
    expect(spies.showToast).toHaveBeenCalledWith('匹配到技能：测试', 'info', expect.any(Number));
  });

  it('skillMatched 静默模式 → 不 showToast', () => {
    triggerSpriteEvent(captured, 'skillMatched', { skill: '代码审查', score: 0.9 }, true);
    expect(spies.showToast).not.toHaveBeenCalled();
  });

  // ─── memoryRecalled（记忆召回） ───

  it('memoryRecalled count>0 → showToast；count<=0 → 不 showToast', () => {
    triggerSpriteEvent(captured, 'memoryRecalled', { count: 3 }, false);
    expect(spies.showToast).toHaveBeenCalledWith('想起 3 条记忆', 'info', expect.any(Number));

    spies.showToast.mockClear();
    triggerSpriteEvent(captured, 'memoryRecalled', { count: 0 }, false);
    expect(spies.showToast).not.toHaveBeenCalled();
  });

  it('memoryRecalled 静默模式 → 不 showToast', () => {
    triggerSpriteEvent(captured, 'memoryRecalled', { count: 5 }, true);
    expect(spies.showToast).not.toHaveBeenCalled();
  });

  // ─── decayCompleted（记忆衰减完成，24h 节流） ───

  it('decayCompleted 应遵守 24h 节流（首次显示 → 1h 后节流 → 25h 后再显示）', () => {
    vi.useFakeTimers();
    // 设为远期时间，确保之前的 lastDecayNoticeTime 已过期
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));

    // 首次触发：显示 toast
    triggerSpriteEvent(captured, 'decayCompleted', { decayedCount: 5 }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    // 1h 后再次触发：节流，不显示
    vi.setSystemTime(new Date('2099-01-01T01:00:00Z'));
    triggerSpriteEvent(captured, 'decayCompleted', { decayedCount: 3 }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    // 25h 后再次触发：超过 24h，显示
    vi.setSystemTime(new Date('2099-01-02T01:00:00Z'));
    triggerSpriteEvent(captured, 'decayCompleted', { decayedCount: 2 }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('decayCompleted decayedCount<=0 → 不 showToast', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-03-01T00:00:00Z'));
    triggerSpriteEvent(captured, 'decayCompleted', { decayedCount: 0 }, false);
    expect(spies.showToast).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('decayCompleted 无效 payload → reportError', () => {
    triggerSpriteEvent(captured, 'decayCompleted', { count: 5 }, false);
    expect(console.error).toHaveBeenCalledWith('[handleDecayCompleted]', expect.anything());
  });

  // ─── trashPurged（回收站清理） ───

  it('trashPurged purgedCount>0 非静默 → showToast', () => {
    triggerSpriteEvent(captured, 'trashPurged', { purgedCount: 3 }, false);
    expect(spies.showToast).toHaveBeenCalledWith(
      '已自动清理 3 条过期记忆',
      'info',
      expect.any(Number),
    );
  });

  it('trashPurged 静默或 purgedCount<=0 → 不 showToast', () => {
    triggerSpriteEvent(captured, 'trashPurged', { purgedCount: 3 }, true);
    expect(spies.showToast).not.toHaveBeenCalled();

    triggerSpriteEvent(captured, 'trashPurged', { purgedCount: 0 }, false);
    expect(spies.showToast).not.toHaveBeenCalled();
  });

  // ─── archiveFailed（归档失败，按 stage 独立 5min 节流） ───

  it('archiveFailed 应遵守 5min 节流（首次显示 → 4min 后节流 → 5min 后再显示）', () => {
    vi.useFakeTimers();
    // 设为远期时间，确保模块级 lastArchiveFailedTime 已过期
    vi.setSystemTime(new Date('2099-08-01T00:00:00Z'));

    // 首次触发 profile：显示 warning toast
    triggerSpriteEvent(captured, 'archiveFailed', { stage: 'profile', message: '失败1' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    // 4min 后同 stage 再次触发：节流，不显示
    vi.setSystemTime(new Date('2099-08-01T00:04:00Z'));
    triggerSpriteEvent(captured, 'archiveFailed', { stage: 'profile', message: '失败2' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    // 5min01s 后同 stage 再次触发：超过 5min 窗口，显示
    vi.setSystemTime(new Date('2099-08-01T00:05:01Z'));
    triggerSpriteEvent(captured, 'archiveFailed', { stage: 'profile', message: '失败3' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('archiveFailed 不同 stage 独立节流（profile 节流中 insight 仍显示）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-09-01T00:00:00Z'));

    // profile 首次：显示
    triggerSpriteEvent(captured, 'archiveFailed', { stage: 'profile', message: 'profile 失败' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    // 紧接 insight 首次：显示（不同 stage 独立计时，不受 profile 节流影响）
    triggerSpriteEvent(captured, 'archiveFailed', { stage: 'insight', message: 'insight 失败' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('archiveFailed content stage 独立节流（profile 节流中 content 仍显示）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-11-01T00:00:00Z'));

    // profile 首次：显示
    triggerSpriteEvent(captured, 'archiveFailed', { stage: 'profile', message: 'profile 失败' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    // 紧接 content 首次：显示（会话内容归档失败独立计时，不受 profile 节流影响）
    triggerSpriteEvent(captured, 'archiveFailed', { stage: 'content', message: '会话内容归档失败' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('archiveFailed 有效 payload → showToast 含 stage 中文标签（warning 类型）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-10-01T00:00:00Z'));

    triggerSpriteEvent(captured, 'archiveFailed', { stage: 'insight', message: 'LLM 异常' }, false);
    // UX-14：handleArchiveFailed 改用 getArchiveFailedMessage 固定文案，不再直传内核 message
    expect(spies.showToast).toHaveBeenCalledWith(
      expect.stringContaining('洞察提取归档失败'),
      'warning',
      expect.any(Number),
    );

    vi.useRealTimers();
  });

  // ─── dedupCompleted（语义去重完成，24h 节流） ───

  it('dedupCompleted 应遵守 24h 节流（首次显示 → 1h 后节流 → 25h 后再显示）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-04-01T00:00:00Z'));

    triggerSpriteEvent(captured, 'dedupCompleted', { deduplicatedCount: 5, demotedIds: ['a', 'b'] }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2099-04-01T01:00:00Z'));
    triggerSpriteEvent(captured, 'dedupCompleted', { deduplicatedCount: 3, demotedIds: ['c'] }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2099-04-02T01:00:00Z'));
    triggerSpriteEvent(captured, 'dedupCompleted', { deduplicatedCount: 2, demotedIds: ['d'] }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('dedupCompleted deduplicatedCount<=0 → 不 showToast', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-05-01T00:00:00Z'));
    triggerSpriteEvent(captured, 'dedupCompleted', { deduplicatedCount: 0, demotedIds: [] }, false);
    expect(spies.showToast).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('dedupCompleted 有效 payload → showToast 含整理条数（info 类型）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-06-01T00:00:00Z'));
    triggerSpriteEvent(captured, 'dedupCompleted', { deduplicatedCount: 4, demotedIds: ['x'] }, false);
    expect(spies.showToast).toHaveBeenCalledWith(
      expect.stringContaining('已自动整理 4 条相似记忆'),
      'info',
      expect.any(Number),
    );
    vi.useRealTimers();
  });

  it('dedupCompleted 无效 payload → reportError', () => {
    triggerSpriteEvent(captured, 'dedupCompleted', { count: 5 }, false);
    expect(console.error).toHaveBeenCalledWith('[handleDedupCompleted]', expect.anything());
  });

  // ─── boostPersistFailed（记忆权重持久化失败，24h 节流） ───

  it('boostPersistFailed 应遵守 24h 节流（首次显示 → 1h 后节流 → 25h 后再显示）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-07-01T00:00:00Z'));

    triggerSpriteEvent(captured, 'boostPersistFailed', { memoryId: 'm1', message: '写入失败' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2099-07-01T01:00:00Z'));
    triggerSpriteEvent(captured, 'boostPersistFailed', { memoryId: 'm2', message: '写入失败' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2099-07-02T01:00:00Z'));
    triggerSpriteEvent(captured, 'boostPersistFailed', { memoryId: 'm3', message: '写入失败' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('boostPersistFailed 有效 payload → showToast 不泄露内核错误细节（warning 类型）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-08-01T00:00:00Z'));
    triggerSpriteEvent(captured, 'boostPersistFailed', { memoryId: 'm1', message: 'ECONNREFUSED 内部细节' }, false);
    const call = spies.showToast.mock.calls[0];
    expect(call[1]).toBe('warning');
    expect(call[0]).not.toContain('ECONNREFUSED');
    vi.useRealTimers();
  });

  it('boostPersistFailed 无效 payload → reportError', () => {
    triggerSpriteEvent(captured, 'boostPersistFailed', { id: 'x' }, false);
    expect(console.error).toHaveBeenCalledWith('[handleBoostPersistFailed]', expect.anything());
  });

  // ─── configReloaded（配置热重载，5min 节流） ───

  it('configReloaded 应遵守 5min 节流（首次显示 → 1min 后节流 → 6min 后再显示）', () => {
    vi.useFakeTimers();
    const base = new Date('2099-12-01T00:00:00Z').getTime();
    vi.setSystemTime(base);

    triggerSpriteEvent(captured, 'configReloaded', { source: 'persona' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    // 1 分钟后：节流生效
    vi.setSystemTime(base + 60 * 1000);
    triggerSpriteEvent(captured, 'configReloaded', { source: 'skill' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    // 6 分钟后：可再次显示
    vi.setSystemTime(base + 6 * 60 * 1000);
    triggerSpriteEvent(captured, 'configReloaded', { source: 'rule' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('configReloaded 有效 payload → showToast 显示 info 类型短提示', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-12-02T00:00:00Z'));
    triggerSpriteEvent(captured, 'configReloaded', { source: 'persona' }, false);
    expect(spies.showToast).toHaveBeenCalledWith(
      '配置已自动更新',
      'info',
      expect.any(Number),
    );
    vi.useRealTimers();
  });

  it('configReloaded 无效 payload → reportError', () => {
    triggerSpriteEvent(captured, 'configReloaded', { source: 123 }, false);
    expect(console.error).toHaveBeenCalledWith('[handleConfigReloaded]', expect.anything());
  });

  // ─── guardrailError（护栏正则编译失败，5min 节流） ───

  it('guardrailError 应遵守 5min 节流（首次显示 → 1min 后节流 → 6min 后再显示）', () => {
    vi.useFakeTimers();
    const base = new Date('2099-12-01T00:00:00Z').getTime();
    vi.setSystemTime(base);

    triggerSpriteEvent(captured, 'guardrailError', { rule: '禁止暴力', message: 'Invalid regex' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    // 1 分钟后：节流生效
    vi.setSystemTime(base + 60 * 1000);
    triggerSpriteEvent(captured, 'guardrailError', { rule: '禁止暴力', message: 'Invalid regex' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(1);

    // 6 分钟后：可再次显示
    vi.setSystemTime(base + 6 * 60 * 1000);
    triggerSpriteEvent(captured, 'guardrailError', { rule: '敏感词', message: 'Invalid regex' }, false);
    expect(spies.showToast).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('guardrailError 有效 payload → showToast 包含规则名（warning 类型）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-12-03T00:00:00Z'));
    triggerSpriteEvent(captured, 'guardrailError', { rule: '禁止暴力', message: 'Invalid regex' }, false);
    expect(spies.showToast).toHaveBeenCalledWith(
      expect.stringContaining('禁止暴力'),
      'warning',
      expect.any(Number),
    );
    vi.useRealTimers();
  });

  it('guardrailError 无效 payload → reportError', () => {
    triggerSpriteEvent(captured, 'guardrailError', { name: '禁止暴力' }, false);
    expect(console.error).toHaveBeenCalledWith('[handleGuardrailError]', expect.anything());
  });

  it('archiveFailed content stage → showToast 含"会话内容"中文标签', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-12-01T00:00:00Z'));

    triggerSpriteEvent(captured, 'archiveFailed', { stage: 'content', message: 'LLM 不可用' }, false);
    // UX-14：handleArchiveFailed 改用 getArchiveFailedMessage 固定文案
    expect(spies.showToast).toHaveBeenCalledWith(
      expect.stringContaining('会话内容归档失败'),
      'warning',
      expect.any(Number),
    );

    vi.useRealTimers();
  });

  it('archiveFailed 无效 payload（stage 非法枚举）→ reportError', () => {
    triggerSpriteEvent(captured, 'archiveFailed', { stage: 'autoConfig', message: 'x' }, false);
    expect(console.error).toHaveBeenCalledWith('[handleArchiveFailed]', expect.anything());
    expect(spies.showToast).not.toHaveBeenCalled();
  });

  // ─── 感知数据事件（affectUpdated / presenceChanged / rapportUpdated / contextUpdated / patternsUpdated / workProjectionUpdated / sessionForked） ───

  it('affectUpdated 有效 payload → 触发 onAffectUpdated 回调', () => {
    const payload = { warmth: 0.8, playfulness: 0.5, directness: 0.7, initiative: 0.6 };
    triggerSpriteEvent(captured, 'affectUpdated', payload, false);
    expect(cb.onAffectUpdated).toHaveBeenCalledWith(payload);
  });

  it('affectUpdated 无效 payload → reportError', () => {
    triggerSpriteEvent(captured, 'affectUpdated', { warmth: 'high' }, false);
    expect(console.error).toHaveBeenCalledWith('[handleAffectUpdated]', expect.anything());
    expect(cb.onAffectUpdated).not.toHaveBeenCalled();
  });

  it('presenceChanged 有效 payload → 触发 onPresenceChanged 回调', () => {
    const payload = { state: 'away', timestamp: '2026-07-12T10:00:00Z', reason: '用户离开' };
    triggerSpriteEvent(captured, 'presenceChanged', payload, false);
    expect(cb.onPresenceChanged).toHaveBeenCalledWith(payload);
  });

  it('rapportUpdated 有效 payload → 触发 onRapportUpdated 回调', () => {
    const payload = { trust: 0.7, familiarity: 0.5, level: 'familiar', description: '熟悉' };
    triggerSpriteEvent(captured, 'rapportUpdated', payload, false);
    expect(cb.onRapportUpdated).toHaveBeenCalledWith(payload);
  });

  it('contextUpdated 有效 payload → 触发 onContextUpdated 回调', () => {
    const payload = { rhythm: 'normal', coherence: 'focused', depth: 'moderate', dominantSource: 'chat', description: '正常对话' };
    triggerSpriteEvent(captured, 'contextUpdated', payload, false);
    expect(cb.onContextUpdated).toHaveBeenCalledWith(payload);
  });

  it('patternsUpdated 有效 payload → 触发 onPatternsUpdated 回调', () => {
    const payload = { patterns: [{ type: 'topic', summary: '编程话题', confidence: 0.8 }] };
    triggerSpriteEvent(captured, 'patternsUpdated', payload, false);
    expect(cb.onPatternsUpdated).toHaveBeenCalledWith(payload);
  });

  it('workProjectionUpdated 有效 payload → 触发 onWorkProjectionUpdated 回调', () => {
    const payload = { sourcePath: '/tmp/test.md', summary: '测试文件' };
    triggerSpriteEvent(captured, 'workProjectionUpdated', payload, false);
    expect(cb.onWorkProjectionUpdated).toHaveBeenCalledWith(payload);
  });

  it('sessionForked 有效 payload → 触发 onSessionForked 回调', () => {
    const payload = { from: 'session-1', to: 'session-2', messageCount: 10 };
    triggerSpriteEvent(captured, 'sessionForked', payload, false);
    expect(cb.onSessionForked).toHaveBeenCalledWith(payload);
  });

  it('sessionForked 无效 payload → reportError，不触发回调', () => {
    triggerSpriteEvent(captured, 'sessionForked', { from: 123 }, false);
    expect(console.error).toHaveBeenCalledWith('[handleSessionForked]', expect.anything());
    expect(cb.onSessionForked).not.toHaveBeenCalled();
  });

  it('未知 type → 不触发任何回调或 UI 方法', () => {
    triggerSpriteEvent(captured, 'unknownType', { foo: 'bar' }, false);
    expect(cb.onMemoryNoticed).not.toHaveBeenCalled();
    expect(cb.onInsightGained).not.toHaveBeenCalled();
    expect(spies.showToast).not.toHaveBeenCalled();
    expect(spies.showProactiveBanner).not.toHaveBeenCalled();
  });
});

// ─── initIpcListeners · 错误与状态监听 ─────────────────────

describe('initIpcListeners · 错误与状态监听', () => {
  let spies: UiManagerSpies;
  let cb: CallbackSpies;
  let captured: CapturedCallbacks;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setup = setupIpcListeners();
    spies = setup.spies;
    cb = setup.cb;
    captured = setup.captured;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('onAppError → showToast("error") + reportError', () => {
    const error = { code: 'ERR_001', message: '测试错误', timestamp: '2026-07-12T10:00:00Z' };
    captured.onAppError(error);
    // UX-REVIEW-M5：应用级 error toast 使用 formatErrorMessage 分类映射，避免暴露技术细节
    // '测试错误' 不匹配任何已知错误模式，回退到通用文案
    expect(spies.showToast).toHaveBeenCalledWith('应用操作失败，请稍后重试。如持续出现，请检查网络或重启应用', 'error');
    expect(console.error).toHaveBeenCalledWith('[ERR_001]', error);
  });

  it('onSpriteError → injectErrorToStreamingMessages + showToast("error")', () => {
    captured.onSpriteError({ text: '对话出错' });
    expect(spies.injectErrorToStreamingMessages).toHaveBeenCalledWith('对话出错');
    expect(spies.showToast).toHaveBeenCalledWith('对话出错', 'error');
    expect(console.error).toHaveBeenCalledWith('[sprite-error]', '对话出错');
  });

  it('onFloatUnread → setUnreadCount(count)', () => {
    captured.onFloatUnread(5);
    expect(spies.setUnreadCount).toHaveBeenCalledWith(5);
  });

  it('onAgentReady → showToast("success") + onAgentReady 回调', () => {
    captured.onAgentReady();
    expect(spies.showToast).toHaveBeenCalledWith('精灵已就绪，可以开始对话了', 'success');
    expect(cb.onAgentReady).toHaveBeenCalledTimes(1);
  });

  it('onClarifyAutoResolved → 在对话区插入超时自动继续的系统提示', () => {
    captured.onClarifyAutoResolved({ autoResolved: true });
    expect(spies.appendMessage).toHaveBeenCalledTimes(1);
    expect(spies.appendMessage).toHaveBeenCalledWith({
      role: 'system',
      content: expect.stringContaining('暂停询问超时未响应，已自动继续'),
    });
  });
});

// ─── initIpcListeners · 配置建议与写入确认 ─────────────────────

describe('initIpcListeners · 配置建议与写入确认', () => {
  let spies: UiManagerSpies;
  let captured: CapturedCallbacks;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setup = setupIpcListeners();
    spies = setup.spies;
    captured = setup.captured;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('onSuggestionPush → showSuggestion(suggestion)', () => {
    const suggestion = { type: 'rule', name: '测试规则', content: '规则内容', confidence: 0.9 };
    captured.onSuggestionPush(suggestion);
    expect(spies.showSuggestion).toHaveBeenCalledWith(suggestion);
  });

  it('onWriteConfirmation → showWriteConfirmation(info)', () => {
    const info = { requestId: 'req-1', targetPath: '/tmp/test.md', tool: 'write_file', permission: 'owner', needsConfirm: true };
    captured.onWriteConfirmation(info);
    expect(spies.showWriteConfirmation).toHaveBeenCalledWith(info);
  });
});

// ─── initIpcListeners · 剪贴板三重保护 ─────────────────────

describe('initIpcListeners · 剪贴板三重保护', () => {
  let spies: UiManagerSpies;
  let captured: CapturedCallbacks;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setup = setupIpcListeners();
    spies = setup.spies;
    captured = setup.captured;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('onClipboardChanged → clipboardManager.addPendingItem(preview, length, content)（v2 重构：被动累积）', () => {
    // payload.content 可选（敏感内容已脱敏时不传），addPendingItem 第三参数接收 undefined
    captured.onClipboardChanged({ preview: '剪贴板预览内容', length: 100 });
    expect(spies.clipboardManager.addPendingItem).toHaveBeenCalledTimes(1);
    expect(spies.clipboardManager.addPendingItem).toHaveBeenCalledWith('剪贴板预览内容', 100, undefined);
  });

  it('onClipboardSensitiveIgnored → clipboardManager.showSensitiveWarning(type)（保护性主动提醒）', () => {
    captured.onClipboardSensitiveIgnored({ type: 'password' });
    expect(spies.clipboardManager.showSensitiveWarning).toHaveBeenCalledTimes(1);
    expect(spies.clipboardManager.showSensitiveWarning).toHaveBeenCalledWith('password');
  });

  it('onClipboardAnalysisReady → showClipboardConfirmDialog(content)', () => {
    captured.onClipboardAnalysisReady({ content: '剪贴板内容' });
    expect(spies.showClipboardConfirmDialog).toHaveBeenCalledWith('剪贴板内容');
  });

  it('onClipboardAnalysisRejected → showToast("warning") 含 reason', () => {
    captured.onClipboardAnalysisRejected({ reason: '内容过长' });
    expect(spies.showToast).toHaveBeenCalledWith('剪贴板内容被拦截：内容过长', 'warning');
  });
});

// ─── initIpcListeners · 全局快捷键 ─────────────────────

describe('initIpcListeners · 全局快捷键', () => {
  let spies: UiManagerSpies;
  let captured: CapturedCallbacks;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setup = setupIpcListeners();
    spies = setup.spies;
    captured = setup.captured;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('onQuickRecordTrigger → handleQuickRecordTrigger()', () => {
    captured.onQuickRecordTrigger();
    expect(spies.handleQuickRecordTrigger).toHaveBeenCalledTimes(1);
  });

  it('onRecallMemoryTrigger → handleRecallMemoryTrigger()', () => {
    captured.onRecallMemoryTrigger();
    expect(spies.handleRecallMemoryTrigger).toHaveBeenCalledTimes(1);
  });
});

// ─── consumeConflictTargetId ─────────────────────────────

describe('consumeConflictTargetId', () => {
  let captured: CapturedCallbacks;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setup = setupIpcListeners();
    captured = setup.captured;
    // 清除上次测试残留的冲突状态
    consumeConflictTargetId();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无冲突时调用 → 返回 null', () => {
    expect(consumeConflictTargetId()).toBeNull();
  });

  it('conflictDetected 事件后调用 → 返回 targetId，再次调用返回 null', () => {
    triggerSpriteEvent(captured, 'conflictDetected', {
      newMemoryId: 'm1',
      newInsight: '新洞察',
      targetId: 'target-abc',
      targetContent: '旧记忆',
    }, false);

    // 第一次消费：返回 targetId
    expect(consumeConflictTargetId()).toBe('target-abc');
    // 第二次消费：已清空，返回 null
    expect(consumeConflictTargetId()).toBeNull();
  });
});
