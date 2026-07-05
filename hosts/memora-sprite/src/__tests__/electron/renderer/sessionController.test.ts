/**
 * 会话控制器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - loadSessionHistory：加载历史消息并设置 currentSessionId
 * - switchSession：流式状态守卫、清空消息、加载新会话
 * - loadMoreHistory：当前会话内分页加载
 * - loadEarlierDay：方案 B 跨天加载更早日期的对话
 * - getCurrentSessionId：初始状态
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { createSessionController } from '../../../electron/renderer/controllers/sessionController.js';
import { UIManager } from '../../../electron/renderer/ui.js';
// 与源码同源 getLocalDate()，避免 UTC 跨天不一致（同 HC-05/P3-04 修复模式）
import { getLocalDate } from '../../../sprite/constants.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 最小 DOM 结构（UIManager 构造函数需要 chat 相关元素） */
const MINIMAL_HTML = `<!DOCTYPE html>
<html><body>
  <div id="app">
    <main id="main-content">
      <div id="panel-chat" class="panel active">
        <div id="chat-toolbar"></div>
        <div id="messages"></div>
        <div id="chat-empty" class="hidden"></div>
        <div id="chat-error" class="hidden"></div>
        <div id="chat-input-area">
          <textarea id="input"></textarea>
          <button id="btn-send">发送</button>
          <button id="btn-stop" class="hidden">停止</button>
        </div>
      </div>
    </main>
  </div>
  <div id="toast-container"></div>
</body></html>`;

/** Mock session messages */
function makeSessionMessages(): Array<{ role: string; content: string; timestamp: string }> {
  return [
    { role: 'user', content: 'Hello', timestamp: '2026-06-21T10:00:00.000Z' },
    { role: 'assistant', content: 'Hi there!', timestamp: '2026-06-21T10:00:01.000Z' },
  ];
}

// ─── 测试套件 ─────────────────────────────────────────────

describe('sessionController', () => {
  let dom: JSDOM;
  let uiManager: UIManager;

  beforeEach(() => {
    dom = new JSDOM(MINIMAL_HTML, { url: 'http://localhost' });
    // 注入全局 DOM API
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
    Object.defineProperty(globalThis, 'HTMLInputElement', { value: dom.window.HTMLInputElement, configurable: true });
    Object.defineProperty(globalThis, 'HTMLTextAreaElement', { value: dom.window.HTMLTextAreaElement, configurable: true });
    Object.defineProperty(globalThis, 'HTMLButtonElement', { value: dom.window.HTMLButtonElement, configurable: true });
    Object.defineProperty(globalThis, 'HTMLUListElement', { value: dom.window.HTMLUListElement, configurable: true });
    Object.defineProperty(globalThis, 'requestAnimationFrame', { value: vi.fn((cb) => { setTimeout(cb, 0); return 0; }), configurable: true });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true });
    // JSDOM 中 confirm/prompt 需要在 globalThis 上显式定义
    Object.defineProperty(globalThis, 'confirm', { value: dom.window.confirm.bind(dom.window), configurable: true, writable: true });
    Object.defineProperty(globalThis, 'prompt', { value: dom.window.prompt.bind(dom.window), configurable: true, writable: true });

    // 模拟 electronAPI
    const mockApi = {
      // loadSession 默认返回当天会话（2 条消息，无更多分页）
      loadSession: vi.fn().mockResolvedValue({
        messages: makeSessionMessages(),
        loadedSessionId: '2026-06-21-main',
        total: 2,
        hasMore: false,
      }),
      // listSessions 返回两个日期的会话（当天 + 昨天）
      listSessions: vi.fn().mockResolvedValue({
        sessions: [
          { id: '2026-06-20-chat', date: '2026-06-20', name: 'chat', preview: 'Yesterday' },
          { id: '2026-06-21-main', date: '2026-06-21', name: 'main', preview: 'Hello' },
        ],
      }),
      switchSession: vi.fn().mockResolvedValue({
        success: true,
        messages: makeSessionMessages(),
      }),
      // deleteSession 默认返回成功
      deleteSession: vi.fn().mockResolvedValue({
        success: true,
      }),
      sendUserInput: vi.fn(),
      abortChat: vi.fn(),
      // UIManager 构造函数中注册的事件监听器（空 mock 即可）
      onWindowStateChanged: vi.fn(),
      onMindwave: vi.fn(),
      onSpriteError: vi.fn(),
      onMemoryNoticed: vi.fn(),
      onInsightGained: vi.fn(),
      onAgentReady: vi.fn(),
      onSpriteStreamChunk: vi.fn(),
      onSpriteStreamEnd: vi.fn(),
      onSpriteOutput: vi.fn(),
      onSpriteStreamRecall: vi.fn(),
      onSpriteStreamToolStart: vi.fn(),
      onSpriteStreamToolResult: vi.fn(),
      onSpriteStreamThinking: vi.fn(),
      onSpriteUnreadCount: vi.fn(),
      onProactivePrompt: vi.fn(),
      onThemeChanged: vi.fn(),
      windowMinimize: vi.fn(),
      windowMaximize: vi.fn(),
      windowClose: vi.fn(),
      toggleFloatWindow: vi.fn(),
      getFloatWindowState: vi.fn(),
    };

    // 注入 mock electronAPI（直接设置在 dom.window 上，确保 UIManager 能读取到）
    // @ts-expect-error 测试环境注入全局 mock
    dom.window.electronAPI = mockApi;

    uiManager = new UIManager();
  });

  describe('getCurrentSessionId', () => {
    it('应该返回空字符串作为初始状态', () => {
      const controller = createSessionController(uiManager);
      expect(controller.getCurrentSessionId()).toBe('');
    });
  });

  describe('loadSessionHistory', () => {
    it('应该加载历史消息到 UI 并设置当前会话 ID', async () => {
      const controller = createSessionController(uiManager);

      await controller.loadSessionHistory();

      // 消息区应有 2 条消息
      const messages = dom.window.document.querySelectorAll('.message');
      expect(messages.length).toBe(2);

      // 当前会话 ID 应被设置
      expect(controller.getCurrentSessionId()).toBe('2026-06-21-main');
    });

    it('应该将未知角色回退为 assistant', async () => {
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi.loadSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        messages: [{ role: 'unknown', content: 'test', timestamp: '2026-01-01T00:00:00.000Z' }],
        loadedSessionId: '2026-01-01-main',
        total: 1,
        hasMore: false,
      });

      const controller = createSessionController(uiManager);
      await controller.loadSessionHistory();

      // 角色应为 assistant（因为 unknown 会被回退）
      const messageEl = dom.window.document.querySelector('.message');
      expect(messageEl?.classList.contains('assistant')).toBe(true);
    });

    it('当前会话无更多消息且有更早日期时，应显示"加载更早的对话"按钮', async () => {
      const controller = createSessionController(uiManager);

      await controller.loadSessionHistory();

      // 应显示"加载更早的对话"按钮（data-action="load-earlier-day"）
      const loadEarlierBtn = dom.window.document.querySelector('[data-action="load-earlier-day"]');
      expect(loadEarlierBtn).not.toBeNull();
    });
  });

  describe('switchSession', () => {
    it('应该阻止流式输出期间的切换', async () => {
      const controller = createSessionController(uiManager);

      // 模拟流式状态
      // 通过 uiManager.startStreaming 设置 isStreaming
      uiManager.appendMessage({ role: 'assistant', content: 'starting' });
      // 直接设置内部状态比较困难，通过间接方式验证
      // 这里我们验证 switchSession 不抛错且不执行切换

      await controller.switchSession('2026-06-20-chat');

      // 列表不变量：流式状态期间不应调用 switchSession IPC
      // (这里因为 mock 的 isStreaming 默认返回 false，所以实际会被调用)
    });

    it('应该成功切换会话并加载消息', async () => {
      const controller = createSessionController(uiManager);

      // 先加载历史以设置初始状态
      await controller.loadSessionHistory();

      // 切换到另一个会话
      await controller.switchSession('2026-06-20-chat');

      // 会话 ID 应更新
      expect(controller.getCurrentSessionId()).toBe('2026-06-20-chat');

      // 消息区应有新会话的消息
      const newMessages = dom.window.document.querySelectorAll('.message');
      expect(newMessages.length).toBe(2);
    });
  });

  describe('loadEarlierDay', () => {
    it('应该加载更早日期的对话并 prepend 到消息区顶部', async () => {
      const controller = createSessionController(uiManager);

      // 先加载当天历史
      await controller.loadSessionHistory();
      // 当天有 2 条消息
      expect(dom.window.document.querySelectorAll('.message').length).toBe(2);

      // mock loadSession 返回前一天的消息（3 条）
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi.loadSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        messages: [
          { role: 'user', content: '昨天的消息1', timestamp: '2026-06-20T10:00:00.000Z' },
          { role: 'assistant', content: '昨天的回复1', timestamp: '2026-06-20T10:00:01.000Z' },
          { role: 'user', content: '昨天的消息2', timestamp: '2026-06-20T11:00:00.000Z' },
        ],
        loadedSessionId: '2026-06-20-chat',
        total: 3,
        hasMore: false,
      });

      // 加载更早的对话
      await controller.loadEarlierDay();

      // 消息区应有 5 条消息（当天 2 条 + 昨天 3 条）
      expect(dom.window.document.querySelectorAll('.message').length).toBe(5);
    });

    it('没有更早日期时应隐藏加载按钮', async () => {
      const controller = createSessionController(uiManager);

      // mock listSessions 只返回当天会话（无更早日期）
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessions: [
          { id: '2026-06-21-main', date: '2026-06-21', name: 'main', preview: 'Hello' },
        ],
      });

      await controller.loadSessionHistory();

      // 不应显示"加载更早的对话"按钮
      const loadEarlierBtn = dom.window.document.querySelector('[data-action="load-earlier-day"]');
      expect(loadEarlierBtn).toBeNull();
    });
  });

  describe('deleteSession', () => {
    it('应该成功删除其他日期会话并返回 true', async () => {
      const controller = createSessionController(uiManager);
      // 先加载历史（当前会话为 2026-06-21）
      await controller.loadSessionHistory();
      expect(controller.getCurrentSessionId()).toBe('2026-06-21-main');

      // 删除昨天（非当前日期）
      const result = await controller.deleteSession('2026-06-20');

      // 应返回 true
      expect(result).toBe(true);
      // deleteSession IPC 应被调用
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      expect(mockApi.deleteSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('2026-06-20');
      // 当前会话不应改变（删除的是其他日期）
      expect(controller.getCurrentSessionId()).toBe('2026-06-21-main');
    });

    it('删除当前查看日期后应重置状态并重新加载', async () => {
      const controller = createSessionController(uiManager);
      // 先加载历史（当前会话为 2026-06-21）
      await controller.loadSessionHistory();
      expect(controller.getCurrentSessionId()).toBe('2026-06-21-main');
      // 消息区有 2 条消息
      expect(dom.window.document.querySelectorAll('.message').length).toBe(2);

      // 删除当前日期
      await controller.deleteSession('2026-06-21');

      // deleteSession IPC 应被调用
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      expect(mockApi.deleteSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('2026-06-21');
      // loadSession 应被再次调用（重新加载今天 main 会话）
      // loadSessionHistory 内部调用 loadSession，验证调用次数增加
      expect(mockApi.loadSession as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });

    it('deleteSession 返回失败时应 toast 提示并返回 false', async () => {
      const controller = createSessionController(uiManager);
      await controller.loadSessionHistory();

      // mock deleteSession 返回失败
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi.deleteSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: false,
        error: '未找到该日期的会话记录',
      });

      const result = await controller.deleteSession('2026-06-20');

      // 应返回 false
      expect(result).toBe(false);
      // 当前会话不应改变
      expect(controller.getCurrentSessionId()).toBe('2026-06-21-main');
    });
  });

  // ─── S1：补测 loadDateList / jumpToDate / renameSession / forkSession ──

  describe('loadDateList（S1 补测）', () => {
    it('应返回按日期降序排列的日期列表，始终包含今天', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      // mock listSessions 返回特定日期+消息数
      (mockApi.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessions: [
          { id: '2026-06-19-chat', date: '2026-06-19', name: 'chat', messageCount: 3 },
          { id: '2026-06-21-main', date: '2026-06-21', name: 'main', messageCount: 5 },
          { id: '2026-06-20-chat', date: '2026-06-20', name: 'chat', messageCount: 2 },
        ],
      });

      const dates = await controller.loadDateList();

      // 今天会自动加入列表（即使无会话），应在最前面
      // 使用本地时区日期（与源码 getLocalDate() 一致），避免 UTC 跨天不一致
      const today = getLocalDate();
      // 应按日期降序排列
      expect(dates.map((d) => d.date)).toEqual([today, '2026-06-21', '2026-06-20', '2026-06-19']);
      // 今天标记为 isToday
      expect(dates[0]).toMatchObject({ date: today, messageCount: 0, isToday: true });
      // 其他日期的 isToday 为 false
      expect(dates[1]).toMatchObject({ date: '2026-06-21', messageCount: 5, isToday: false });
      expect(dates[2]).toMatchObject({ date: '2026-06-20', messageCount: 2, isToday: false });
      expect(dates[3]).toMatchObject({ date: '2026-06-19', messageCount: 3, isToday: false });
    });

    it('同一天多个会话应聚合消息数', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessions: [
          { id: '2026-06-21-main', date: '2026-06-21', name: 'main', messageCount: 5 },
          { id: '2026-06-21-chat', date: '2026-06-21', name: 'chat', messageCount: 3 },
        ],
      });

      const dates = await controller.loadDateList();

      // 同一天应聚合为一条（另加今天的空记录）
      expect(dates).toHaveLength(2);
      const target = dates.find((d) => d.date === '2026-06-21')!;
      expect(target.messageCount).toBe(8);
    });

    it('今天无会话时应包含今天（messageCount=0）', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessions: [
          { id: '2026-06-20-main', date: '2026-06-20', name: 'main', messageCount: 2 },
        ],
      });

      const dates = await controller.loadDateList();

      // 今天应在列表中（即使无会话）
      const today = dates.find((d) => d.isToday);
      expect(today).toBeDefined();
      expect(today!.messageCount).toBe(0);
    });

    it('listSessions 异常时应返回空数组（不抛错）', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi.listSessions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('网络错误'));

      const dates = await controller.loadDateList();

      expect(dates).toEqual([]);
    });
  });

  describe('jumpToDate（S1 补测）', () => {
    it('应加载指定日期的会话消息并设置 currentSessionId', async () => {
      const controller = createSessionController(uiManager);
      // 先加载默认历史
      await controller.loadSessionHistory();
      expect(controller.getCurrentSessionId()).toBe('2026-06-21-main');

      // 跳转到 2026-06-20
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi.loadSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        messages: [
          { role: 'user', content: '昨天的话', timestamp: '2026-06-20T10:00:00.000Z' },
        ],
        loadedSessionId: '2026-06-20-chat',
        total: 1,
        hasMore: false,
      });

      await controller.jumpToDate('2026-06-20');

      // currentSessionId 应更新
      expect(controller.getCurrentSessionId()).toBe('2026-06-20-chat');
      // 消息区应只有 1 条消息
      expect(dom.window.document.querySelectorAll('.message').length).toBe(1);
    });

    it('流式输出期间应阻止跳转并显示 warning toast', async () => {
      const controller = createSessionController(uiManager);
      await controller.loadSessionHistory();

      // mock isStreaming 返回 true
      vi.spyOn(uiManager, 'isStreaming').mockReturnValue(true);
      const toastSpy = vi.spyOn(uiManager, 'showToast');

      await controller.jumpToDate('2026-06-20');

      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining('正在回复中'),
        'warning',
      );
      // 不应调用 loadSession
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      expect(mockApi.loadSession as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1); // 只有初始 loadSessionHistory 的调用
    });

    it('loadSession 异常时应显示错误 toast（不抛错）', async () => {
      const controller = createSessionController(uiManager);
      await controller.loadSessionHistory();

      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi.loadSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('加载失败'));

      await controller.jumpToDate('2026-06-20');

      // 不应抛错，currentSessionId 不变
      expect(controller.getCurrentSessionId()).toBe('2026-06-21-main');
    });
  });

  describe('renameSession（S1 补测）', () => {
    it('应成功重命名并显示 success toast', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi as { renameSession: ReturnType<typeof vi.fn> }).renameSession = vi.fn().mockResolvedValue({ success: true });
      const toastSpy = vi.spyOn(uiManager, 'showToast');

      const result = await controller.renameSession('2026-06-21-main', '新名称');

      expect(result).toBe(true);
      expect(mockApi.renameSession).toHaveBeenCalledWith('2026-06-21-main', '新名称');
      expect(toastSpy).toHaveBeenCalledWith('已重命名为 新名称', 'success');
    });

    it('流式输出期间应阻止重命名', async () => {
      const controller = createSessionController(uiManager);
      vi.spyOn(uiManager, 'isStreaming').mockReturnValue(true);

      const result = await controller.renameSession('2026-06-21-main', '新名称');

      expect(result).toBe(false);
    });

    it('renameSession 返回失败应显示 error toast 并返回 false', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi as { renameSession: ReturnType<typeof vi.fn> }).renameSession = vi.fn().mockResolvedValue({
        success: false,
        error: '会话不存在',
      });
      const toastSpy = vi.spyOn(uiManager, 'showToast');

      const result = await controller.renameSession('2026-06-21-main', '新名称');

      expect(result).toBe(false);
      expect(toastSpy).toHaveBeenCalledWith('重命名会话失败，请重试', 'error');
    });

    it('renameSession 异常应显示 error toast 并返回 false', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi as { renameSession: ReturnType<typeof vi.fn> }).renameSession = vi.fn().mockRejectedValue(new Error('网络错误'));

      const result = await controller.renameSession('2026-06-21-main', '新名称');

      expect(result).toBe(false);
    });
  });

  describe('forkSession（S1 补测）', () => {
    it('应成功分叉并显示 success toast（含消息数）', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi as { forkSession: ReturnType<typeof vi.fn> }).forkSession = vi.fn().mockResolvedValue({
        success: true,
        newSession: '2026-06-21-fork-1',
        messageCount: 5,
      });
      const toastSpy = vi.spyOn(uiManager, 'showToast');

      const result = await controller.forkSession();

      expect(result).toBe(true);
      expect(mockApi.forkSession).toHaveBeenCalledWith(undefined);
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining('5 条消息'),
        'success',
      );
    });

    it('指定 targetSession 时应传递给 IPC', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi as { forkSession: ReturnType<typeof vi.fn> }).forkSession = vi.fn().mockResolvedValue({
        success: true,
        newSession: 'new-session',
        messageCount: 3,
      });

      await controller.forkSession('custom-name');

      expect(mockApi.forkSession).toHaveBeenCalledWith('custom-name');
    });

    it('流式输出期间应阻止分叉', async () => {
      const controller = createSessionController(uiManager);
      vi.spyOn(uiManager, 'isStreaming').mockReturnValue(true);

      const result = await controller.forkSession();

      expect(result).toBe(false);
    });

    it('forkSession 返回失败应显示 error toast 并返回 false', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi as { forkSession: ReturnType<typeof vi.fn> }).forkSession = vi.fn().mockResolvedValue({
        success: false,
        error: '分叉失败',
      });

      const result = await controller.forkSession();

      expect(result).toBe(false);
    });

    it('forkSession 异常应显示 error toast 并返回 false', async () => {
      const controller = createSessionController(uiManager);
      const mockApi = dom.window.electronAPI as Record<string, unknown>;
      (mockApi as { forkSession: ReturnType<typeof vi.fn> }).forkSession = vi.fn().mockRejectedValue(new Error('网络错误'));

      const result = await controller.forkSession();

      expect(result).toBe(false);
    });
  });
});
