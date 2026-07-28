/**
 * uiDelegations 委托群单元测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - chatDelegations：消息渲染/流式/Toast/ProactiveBanner/StartupSummary 委托
 * - dashboardDelegations：Dashboard/Perception 委托（含多目标委托）
 * - memoryDelegations：Memory 面板委托（含返回值/async 委托）
 * - miscDelegations：杂项委托（含 async/返回值）
 * - personaThemeDelegations：Persona/Theme 委托（含多目标 onMemoryRecallClick）
 * - settingsModalDelegations：Settings/Modal/PanelError/SkillDrop 委托
 *
 * 测试策略：
 * - 单元测试：mock this 上下文（UIManager 持有的子模块均为 vi.fn 容器）
 * - 验证委托映射正确：方法调用转发到正确的子模块方法
 * - 验证参数透传完整：不丢失/篡改参数
 * - 验证多目标委托：两个子模块都被调用
 * - 验证返回值/async 委托：Promise 和返回值正确透传
 *
 * 设计依据：ADR-SP-016 Mixin 拆分模式，委托群为纯透传，
 * 测试聚焦"映射正确性"而非"业务逻辑"。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { chatDelegations } from '../../../electron/renderer/helpers/ui-delegations/chatDelegations.js';
import { dashboardDelegations } from '../../../electron/renderer/helpers/ui-delegations/dashboardDelegations.js';
import { memoryDelegations } from '../../../electron/renderer/helpers/ui-delegations/memoryDelegations.js';
import { miscDelegations } from '../../../electron/renderer/helpers/ui-delegations/miscDelegations.js';
import { personaThemeDelegations } from '../../../electron/renderer/helpers/ui-delegations/personaThemeDelegations.js';
import { settingsModalDelegations } from '../../../electron/renderer/helpers/ui-delegations/settingsModalDelegations.js';
import type { UIManager } from '../../../electron/renderer/ui.js';

// ─── Mock 工厂 ─────────────────────────────────────────────

/**
 * 创建 mock UIManager 上下文
 *
 * 委托方法的 this 类型为 UIManager，实际只访问其持有的子模块实例。
 * 用深度 Proxy 动态返回 vi.fn() 容器，支持任意层级的属性访问
 * （如 mock.perceptionCoordinator.dashboardPanel.xxx）。
 *
 * 每个 createDeepMock() 既是 vi.fn()（可调用、支持 mock API）又是 Proxy
 * （属性访问返回新的 createDeepMock()），确保多级嵌套路径正确工作。
 */

// vi.fn() 的 mock API 属性集合——这些属性从 vi.fn() 自身获取，不返回嵌套 mock
const MOCK_API_PROPS = new Set([
  'mock', '_isMockFunction', 'mockReturnValue', 'mockReturnValueOnce',
  'mockResolvedValue', 'mockResolvedValueOnce', 'mockRejectedValue', 'mockRejectedValueOnce',
  'mockImplementation', 'mockImplementationOnce', 'mockReset', 'mockClear',
  'mockRestore', 'getMockName', 'withImplementation',
]);

/**
 * 创建深度嵌套的 mock 函数
 *
 * 返回一个既是 vi.fn() 又是 Proxy 的对象：
 * - 可调用（vi.fn() 特性，记录调用用于断言）
 * - mock API 属性（mockReturnValue 等）从 vi.fn() 获取
 * - 其他属性访问返回新的 createDeepMock()，支持任意深度嵌套
 */
function createDeepMock(): ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>> {
  const fn = vi.fn();
  const cache = new Map<string, ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>>();
  return new Proxy(fn, {
    get(target, prop: string | symbol, receiver: any) {
      // Symbol 属性和 thenable 检查属性从 target 获取（返回 undefined 避免被当作 Promise）
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally') {
        return Reflect.get(target, prop, receiver);
      }
      // vi.fn() 的 mock API 从 target 获取
      if (MOCK_API_PROPS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }
      // 其他属性返回嵌套 mock（支持任意深度访问）
      if (!cache.has(prop)) {
        cache.set(prop, createDeepMock());
      }
      return cache.get(prop);
    },
  }) as ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>;
}

function createMockThis(): UIManager & Record<string, ReturnType<typeof vi.fn>> {
  const cache = new Map<string, ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>>();
  const proxy = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (!cache.has(prop)) {
          cache.set(prop, createDeepMock());
        }
        return cache.get(prop);
      },
    },
  );
  return proxy as unknown as UIManager & Record<string, ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── 1. chatDelegations ──────────────────────────────────

describe('chatDelegations', () => {
  it('appendMessage 应委托到 chatPanel.appendMessage 并返回 HTMLElement', () => {
    const mock = createMockThis();
    const fakeEl = document.createElement('div');
    mock.chatPanel.appendMessage.mockReturnValue(fakeEl);
    const msg = { id: 'm1', role: 'user' as const, content: 'hi' };
    const result = chatDelegations.appendMessage.call(mock as UIManager, msg);
    expect(mock.chatPanel.appendMessage).toHaveBeenCalledWith(msg);
    expect(result).toBe(fakeEl);
  });

  it('showProactiveBanner 应使用默认参数委托到 proactiveBanner', () => {
    const mock = createMockThis();
    chatDelegations.showProactiveBanner.call(mock as UIManager, '提示');
    expect(mock.proactiveBanner.showProactiveBanner).toHaveBeenCalledWith('提示', false, []);
  });

  it('showProactiveBanner 应透传完整参数', () => {
    const mock = createMockThis();
    chatDelegations.showProactiveBanner.call(mock as UIManager, '里程碑', true, ['t1']);
    expect(mock.proactiveBanner.showProactiveBanner).toHaveBeenCalledWith('里程碑', true, ['t1']);
  });

  it('showToast 应使用默认 type=info 委托到 toastManager', () => {
    const mock = createMockThis();
    chatDelegations.showToast.call(mock as UIManager, '消息');
    expect(mock.toastManager.showToast).toHaveBeenCalledWith('消息', 'info', undefined, undefined);
  });

  it('showToast 应透传完整参数', () => {
    const mock = createMockThis();
    chatDelegations.showToast.call(mock as UIManager, '错误', 'error', 3000, { dismissible: true });
    expect(mock.toastManager.showToast).toHaveBeenCalledWith('错误', 'error', 3000, { dismissible: true });
  });

  it('showStartupSummary 应委托到 chatPanel.showStartupSummary', () => {
    const mock = createMockThis();
    const summary = {
      totalMemories: 10,
      totalInsights: 5,
      skillCount: 2,
      decay: { runCount: 3, totalDecayedCount: 1 },
      perception: { warmth: 0.8, rapportLevel: 'high', rapportDescription: '融洽' },
      healthStatus: 'healthy' as const,
    };
    chatDelegations.showStartupSummary.call(mock as UIManager, summary);
    expect(mock.chatPanel.showStartupSummary).toHaveBeenCalledWith(summary);
  });

  it('initProactiveBannerButtons 应透传 handlers 对象', () => {
    const mock = createMockThis();
    const handlers = { onView: vi.fn(), onLater: vi.fn(), onSilent: vi.fn() };
    chatDelegations.initProactiveBannerButtons.call(mock as UIManager, handlers);
    expect(mock.proactiveBanner.initProactiveBannerButtons).toHaveBeenCalledWith(handlers);
  });

  it('流式消息委托应正确透传 messageId 和 text', () => {
    const mock = createMockThis();
    chatDelegations.updateStreamingMessage.call(mock as UIManager, 'm1', 'text');
    chatDelegations.finishStreamingMessage.call(mock as UIManager, 'm1');
    chatDelegations.startStreaming.call(mock as UIManager, 'm1');
    expect(mock.chatPanel.updateStreamingMessage).toHaveBeenCalledWith('m1', 'text');
    expect(mock.chatPanel.finishStreamingMessage).toHaveBeenCalledWith('m1');
    expect(mock.chatPanel.startStreaming).toHaveBeenCalledWith('m1', undefined);
  });

  it('startStreaming 委托应透传 persona 到 chatPanel（消息底部角色标签）', () => {
    const mock = createMockThis();
    chatDelegations.startStreaming.call(mock as UIManager, 'm1', 'coder');
    expect(mock.chatPanel.startStreaming).toHaveBeenCalledWith('m1', 'coder');
  });

  it('工具调用委托应透传完整参数', () => {
    const mock = createMockThis();
    chatDelegations.showToolStart.call(mock as UIManager, 'm1', 'tc1', 'search', '{"q":"x"}');
    chatDelegations.updateToolResult.call(mock as UIManager, 'm1', 'tc1', 'search', true, '找到 3 条');
    expect(mock.chatPanel.showToolStart).toHaveBeenCalledWith('m1', 'tc1', 'search', '{"q":"x"}');
    expect(mock.chatPanel.updateToolResult).toHaveBeenCalledWith('m1', 'tc1', 'search', true, '找到 3 条');
  });

  // 测试目的：appendMilestoneBanner 应透传里程碑文本
  it('appendMilestoneBanner 应透传里程碑文本', () => {
    const mock = createMockThis();
    chatDelegations.appendMilestoneBanner.call(mock as UIManager, '达成里程碑');
    expect(mock.chatPanel.appendMilestoneBanner).toHaveBeenCalledWith('达成里程碑');
  });

  // 测试目的：setMemoryRecall 应透传 messageId 和召回记忆数组
  it('setMemoryRecall 应透传 messageId 和 memories 数组', () => {
    const mock = createMockThis();
    const memories = [{ id: 'm1', name: '记忆', score: 0.9, source: 'conv' }];
    chatDelegations.setMemoryRecall.call(mock as UIManager, 'msg-1', memories);
    expect(mock.chatPanel.setMemoryRecall).toHaveBeenCalledWith('msg-1', memories);
  });

  // 测试目的：showThinkingPhase 应透传 messageId 和阶段名称
  it('showThinkingPhase 应透传 messageId 和阶段名称', () => {
    const mock = createMockThis();
    chatDelegations.showThinkingPhase.call(mock as UIManager, 'm1', 'analyzing');
    expect(mock.chatPanel.showThinkingPhase).toHaveBeenCalledWith('m1', 'analyzing');
  });

  // 测试目的：showTruncationNotice 应透传 messageId 和截断数量
  it('showTruncationNotice 应透传 messageId 和截断数量', () => {
    const mock = createMockThis();
    chatDelegations.showTruncationNotice.call(mock as UIManager, 'm1', 5);
    expect(mock.chatPanel.showTruncationNotice).toHaveBeenCalledWith('m1', 5);
  });

  // 测试目的：stopAllStreaming 应委托到 chatPanel.stopAllStreaming
  it('stopAllStreaming 应委托到 chatPanel.stopAllStreaming', () => {
    const mock = createMockThis();
    chatDelegations.stopAllStreaming.call(mock as UIManager);
    expect(mock.chatPanel.stopAllStreaming).toHaveBeenCalled();
  });

  // 测试目的：clearMessages 应委托到 chatPanel.clearMessages
  it('clearMessages 应委托到 chatPanel.clearMessages', () => {
    const mock = createMockThis();
    chatDelegations.clearMessages.call(mock as UIManager);
    expect(mock.chatPanel.clearMessages).toHaveBeenCalled();
  });

  // 测试目的：appendMessages 应透传消息数组（默认不前置）
  it('appendMessages 应透传消息数组（默认不前置）', () => {
    const mock = createMockThis();
    const messages = [{ id: 'm1', role: 'user' as const, content: 'hi' }];
    chatDelegations.appendMessages.call(mock as UIManager, messages);
    expect(mock.chatPanel.appendMessages).toHaveBeenCalledWith(messages, undefined);
  });

  // 测试目的：appendMessages 应透传 prepend=true 场景
  it('appendMessages 应透传 prepend=true 场景', () => {
    const mock = createMockThis();
    const messages = [{ id: 'm1', role: 'user' as const, content: 'hi' }];
    chatDelegations.appendMessages.call(mock as UIManager, messages, true);
    expect(mock.chatPanel.appendMessages).toHaveBeenCalledWith(messages, true);
  });

  // 测试目的：showLoadMore 应透传剩余数量和点击回调
  it('showLoadMore 应透传剩余数量和点击回调', () => {
    const mock = createMockThis();
    const onClick = vi.fn();
    chatDelegations.showLoadMore.call(mock as UIManager, 10, onClick);
    expect(mock.chatPanel.showLoadMore).toHaveBeenCalledWith(10, onClick);
  });

  // 测试目的：hideLoadMore 应委托到 chatPanel.hideLoadMore
  it('hideLoadMore 应委托到 chatPanel.hideLoadMore', () => {
    const mock = createMockThis();
    chatDelegations.hideLoadMore.call(mock as UIManager);
    expect(mock.chatPanel.hideLoadMore).toHaveBeenCalled();
  });

  // 测试目的：showLoadEarlierDay 应透传点击回调
  it('showLoadEarlierDay 应透传点击回调', () => {
    const mock = createMockThis();
    const onClick = vi.fn();
    chatDelegations.showLoadEarlierDay.call(mock as UIManager, onClick);
    expect(mock.chatPanel.showLoadEarlierDay).toHaveBeenCalledWith(onClick);
  });

  // 测试目的：injectErrorToStreamingMessages 应透传错误文本
  it('injectErrorToStreamingMessages 应透传错误文本', () => {
    const mock = createMockThis();
    chatDelegations.injectErrorToStreamingMessages.call(mock as UIManager, '流式中断');
    expect(mock.chatPanel.injectErrorToStreamingMessages).toHaveBeenCalledWith('流式中断');
  });

  // 测试目的：markStreamingAborted 应透传 messageId 和原因
  it('markStreamingAborted 应透传 messageId 和原因', () => {
    const mock = createMockThis();
    chatDelegations.markStreamingAborted.call(mock as UIManager, 'm1', 'user-cancelled');
    expect(mock.chatPanel.markStreamingAborted).toHaveBeenCalledWith('m1', 'user-cancelled');
  });

  // 测试目的：showEmptyState 应委托到 chatPanel.showEmptyState
  it('showEmptyState 应委托到 chatPanel.showEmptyState', () => {
    const mock = createMockThis();
    chatDelegations.showEmptyState.call(mock as UIManager);
    expect(mock.chatPanel.showEmptyState).toHaveBeenCalled();
  });

  // 测试目的：hideEmptyState 应委托到 chatPanel.hideEmptyState
  it('hideEmptyState 应委托到 chatPanel.hideEmptyState', () => {
    const mock = createMockThis();
    chatDelegations.hideEmptyState.call(mock as UIManager);
    expect(mock.chatPanel.hideEmptyState).toHaveBeenCalled();
  });

  // 测试目的：onSuggestionClick 应透传建议点击回调
  it('onSuggestionClick 应透传建议点击回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    chatDelegations.onSuggestionClick.call(mock as UIManager, cb);
    expect(mock.chatPanel.onSuggestionClick).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onErrorRetry 应透传错误重试回调
  it('onErrorRetry 应透传错误重试回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    chatDelegations.onErrorRetry.call(mock as UIManager, cb);
    expect(mock.chatPanel.onErrorRetry).toHaveBeenCalledWith(cb);
  });

  // 测试目的：hideProactiveBanner 应委托到 proactiveBanner.hideProactiveBanner
  it('hideProactiveBanner 应委托到 proactiveBanner.hideProactiveBanner', () => {
    const mock = createMockThis();
    chatDelegations.hideProactiveBanner.call(mock as UIManager);
    expect(mock.proactiveBanner.hideProactiveBanner).toHaveBeenCalled();
  });

  // 测试目的：showArchiveButton 应委托到 chatPanel.showArchiveButton
  it('showArchiveButton 应委托到 chatPanel.showArchiveButton', () => {
    const mock = createMockThis();
    chatDelegations.showArchiveButton.call(mock as UIManager);
    expect(mock.chatPanel.showArchiveButton).toHaveBeenCalled();
  });
});

// ─── 2. dashboardDelegations ─────────────────────────────

describe('dashboardDelegations', () => {
  it('renderDashboardStats 应透传 DashboardViewModel', () => {
    const mock = createMockThis();
    const data = { totalMemories: 10 } as never;
    dashboardDelegations.renderDashboardStats.call(mock as UIManager, data);
    expect(mock.perceptionCoordinator.dashboardPanel.renderDashboardStats).toHaveBeenCalledWith(data);
  });

  it('onPartnerMemoryClick 应多目标委托到 memoryPanel 和 perceptionPanel', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    dashboardDelegations.onPartnerMemoryClick.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onPartnerMemoryClick).toHaveBeenCalledWith(cb);
    expect(mock.perceptionCoordinator.perceptionPanel.onMemoryClick).toHaveBeenCalledWith(cb);
  });

  it('updateAffectDisplay 应多目标委托到 perceptionPanel 和 spriteStatusPopover', () => {
    const mock = createMockThis();
    const affect = { warmth: 0.8 } as never;
    dashboardDelegations.updateAffectDisplay.call(mock as UIManager, affect);
    expect(mock.perceptionCoordinator.perceptionPanel.updateAffectDisplay).toHaveBeenCalledWith(affect);
    expect(mock.perceptionCoordinator.spriteStatusPopover.updateAffect).toHaveBeenCalledWith(affect);
  });

  it('updateRapportDisplay 应多目标委托到 perceptionPanel 和 spriteStatusPopover', () => {
    const mock = createMockThis();
    const rapport = { level: 'high' } as never;
    dashboardDelegations.updateRapportDisplay.call(mock as UIManager, rapport);
    expect(mock.perceptionCoordinator.perceptionPanel.updateRapportDisplay).toHaveBeenCalledWith(rapport);
    expect(mock.perceptionCoordinator.spriteStatusPopover.updateRapport).toHaveBeenCalledWith(rapport);
  });

  it('updateContextDisplay 应多目标委托到 perceptionPanel 和 spriteStatusPopover', () => {
    const mock = createMockThis();
    const ctx = { focus: 'coding' } as never;
    dashboardDelegations.updateContextDisplay.call(mock as UIManager, ctx);
    expect(mock.perceptionCoordinator.perceptionPanel.updateContextDisplay).toHaveBeenCalledWith(ctx);
    expect(mock.perceptionCoordinator.spriteStatusPopover.updateContext).toHaveBeenCalledWith(ctx);
  });

  it('repaintCanvasOnThemeChange 应多目标委托到 dashboardPanel 和 memoryPanel', () => {
    const mock = createMockThis();
    dashboardDelegations.repaintCanvasOnThemeChange.call(mock as UIManager);
    expect(mock.perceptionCoordinator.dashboardPanel.repaintOnThemeChange).toHaveBeenCalled();
    expect(mock.memoryPanel.repaintOnThemeChange).toHaveBeenCalled();
  });

  it('showMemoryListError 应透传 listEl 元素', () => {
    const mock = createMockThis();
    const el = document.createElement('div');
    dashboardDelegations.showMemoryListError.call(mock as UIManager, el);
    expect(mock.perceptionCoordinator.dashboardPanel.showMemoryListError).toHaveBeenCalledWith(el);
  });

  it('pulseCounter 应透传 id', () => {
    const mock = createMockThis();
    dashboardDelegations.pulseCounter.call(mock as UIManager, 'counter-1');
    expect(mock.perceptionCoordinator.dashboardPanel.pulseCounter).toHaveBeenCalledWith('counter-1');
  });
});

// ─── 3. memoryDelegations ───────────────────────────────

describe('memoryDelegations', () => {
  it('getAddMemoryFormData 应返回 memoryPanel.getAddMemoryFormData 的结果', () => {
    const mock = createMockThis();
    const formData = { source: 'conv', name: 'n', content: 'c' };
    mock.memoryPanel.getAddMemoryFormData.mockReturnValue(formData);
    const result = memoryDelegations.getAddMemoryFormData.call(mock as UIManager);
    expect(mock.memoryPanel.getAddMemoryFormData).toHaveBeenCalled();
    expect(result).toBe(formData);
  });

  it('getCurrentMemoryId 应返回 memoryPanel.getCurrentMemoryId 的结果', () => {
    const mock = createMockThis();
    mock.memoryPanel.getCurrentMemoryId.mockReturnValue('mem-1');
    const result = memoryDelegations.getCurrentMemoryId.call(mock as UIManager);
    expect(result).toBe('mem-1');
  });

  it('hasGraphData 应返回 memoryPanel.hasGraphData 的布尔结果', () => {
    const mock = createMockThis();
    mock.memoryPanel.hasGraphData.mockReturnValue(true);
    const result = memoryDelegations.hasGraphData.call(mock as UIManager);
    expect(result).toBe(true);
  });

  it('switchMemoryView 应委托到 memoryPanel.switchView', () => {
    const mock = createMockThis();
    memoryDelegations.switchMemoryView.call(mock as UIManager, 'graph');
    expect(mock.memoryPanel.switchView).toHaveBeenCalledWith('graph');
  });

  it('renderMemoryList 应透传 memories 和可选 searchQuery', () => {
    const mock = createMockThis();
    const memories = [{ id: 'm1', name: 'n', source: 's' }] as never;
    memoryDelegations.renderMemoryList.call(mock as UIManager, memories, 'query');
    expect(mock.memoryPanel.renderMemoryList).toHaveBeenCalledWith(memories, 'query');
  });

  it('highlightGraphNodes 应透传 nodeIds（含 null 场景）', () => {
    const mock = createMockThis();
    memoryDelegations.highlightGraphNodes.call(mock as UIManager, ['n1', 'n2']);
    expect(mock.memoryPanel.highlightGraphNodes).toHaveBeenCalledWith(['n1', 'n2']);
    memoryDelegations.highlightGraphNodes.call(mock as UIManager, null);
    expect(mock.memoryPanel.highlightGraphNodes).toHaveBeenCalledWith(null);
  });

  it('onCleanupRequest 应透传回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    // 委托方法签名为 void，不返回值（仅验证委托调用正确）
    memoryDelegations.onCleanupRequest.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onCleanupRequest).toHaveBeenCalledWith(cb);
  });

  it('onRelationEdit 应透传 4 参数', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onRelationEdit.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onRelationEdit).toHaveBeenCalledWith(cb);
  });

  it('renderRecycleBinList 应透传 memories 数组', () => {
    const mock = createMockThis();
    const memories = [{ id: 'm1', name: 'n', source: 's', contentPreview: 'p', deletedAt: '2026-07-12' }];
    memoryDelegations.renderRecycleBinList.call(mock as UIManager, memories);
    expect(mock.memoryPanel.renderRecycleBinList).toHaveBeenCalledWith(memories);
  });

  // 测试目的：dismissMemoryAnalysisPanels 应委托到 memoryPanel.dismissAnalysisPanels
  it('dismissMemoryAnalysisPanels 应委托到 memoryPanel.dismissAnalysisPanels', () => {
    const mock = createMockThis();
    memoryDelegations.dismissMemoryAnalysisPanels.call(mock as UIManager);
    expect(mock.memoryPanel.dismissAnalysisPanels).toHaveBeenCalled();
  });

  // 测试目的：showMemoryDetail 应透传 MemoryDetail 对象
  it('showMemoryDetail 应透传 MemoryDetail 对象', () => {
    const mock = createMockThis();
    const detail = {
      id: 'm1',
      name: '记忆名',
      source: 'conv',
      score: 0.9,
      content: '内容',
      createdAt: '2026-07-12',
      accessedAt: '2026-07-13',
      relations: [],
    } as never;
    memoryDelegations.showMemoryDetail.call(mock as UIManager, detail);
    expect(mock.memoryPanel.showMemoryDetail).toHaveBeenCalledWith(detail);
  });

  // 测试目的：showMemoryLineage 应透传 RelationPath 数组
  it('showMemoryLineage 应透传 RelationPath 数组', () => {
    const mock = createMockThis();
    const path = [{ sourceId: 's1', targetId: 't1', type: 'supports', weight: 0.8 }] as never;
    memoryDelegations.showMemoryLineage.call(mock as UIManager, path);
    expect(mock.memoryPanel.showMemoryLineage).toHaveBeenCalledWith(path);
  });

  // 测试目的：showMemoryLineageError 应透传 onRetry 回调（注意目标方法名为 showLineageError）
  it('showMemoryLineageError 应透传 onRetry 回调到 showLineageError', () => {
    const mock = createMockThis();
    const retry = vi.fn();
    memoryDelegations.showMemoryLineageError.call(mock as UIManager, retry);
    expect(mock.memoryPanel.showLineageError).toHaveBeenCalledWith(retry);
  });

  // 测试目的：showMemoryNeighbors 应透传 RelationNeighbor 数组
  it('showMemoryNeighbors 应透传 RelationNeighbor 数组', () => {
    const mock = createMockThis();
    const neighbors = [{ id: 'n1', name: '邻居', source: 'conv', relationType: 'supports' }] as never;
    memoryDelegations.showMemoryNeighbors.call(mock as UIManager, neighbors);
    expect(mock.memoryPanel.showMemoryNeighbors).toHaveBeenCalledWith(neighbors);
  });

  // 测试目的：showMemoryNeighborsError 应透传 onRetry 回调（注意目标方法名为 showNeighborsError）
  it('showMemoryNeighborsError 应透传 onRetry 回调到 showNeighborsError', () => {
    const mock = createMockThis();
    const retry = vi.fn();
    memoryDelegations.showMemoryNeighborsError.call(mock as UIManager, retry);
    expect(mock.memoryPanel.showNeighborsError).toHaveBeenCalledWith(retry);
  });

  // 测试目的：clearAddMemoryForm 应委托到 memoryPanel.clearAddMemoryForm
  it('clearAddMemoryForm 应委托到 memoryPanel.clearAddMemoryForm', () => {
    const mock = createMockThis();
    memoryDelegations.clearAddMemoryForm.call(mock as UIManager);
    expect(mock.memoryPanel.clearAddMemoryForm).toHaveBeenCalled();
  });

  // 测试目的：onMemorySearch 应透传查询回调
  it('onMemorySearch 应透传查询回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onMemorySearch.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onMemorySearch).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onMemoryFilter 应透传来源过滤回调
  it('onMemoryFilter 应透传来源过滤回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onMemoryFilter.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onMemoryFilter).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onMemoryClick 应透传点击回调
  it('onMemoryClick 应透传点击回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onMemoryClick.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onMemoryClick).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onMemoryDelete 应透传删除回调
  it('onMemoryDelete 应透传删除回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onMemoryDelete.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onMemoryDelete).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onMemoryAdd 应透传新增回调（含 source/name/content 字段）
  it('onMemoryAdd 应透传新增回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onMemoryAdd.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onMemoryAdd).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onMemoryEdit 应透传编辑回调（id + content）
  it('onMemoryEdit 应透传编辑回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onMemoryEdit.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onMemoryEdit).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onMemoryDiscuss 应透传讨论回调
  it('onMemoryDiscuss 应透传讨论回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onMemoryDiscuss.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onMemoryDiscuss).toHaveBeenCalledWith(cb);
  });

  // 测试目的：loadGraphData 应透传 RelationGraphData
  it('loadGraphData 应透传 RelationGraphData', () => {
    const mock = createMockThis();
    const graphData = { nodes: [], edges: [] } as never;
    memoryDelegations.loadGraphData.call(mock as UIManager, graphData);
    expect(mock.memoryPanel.loadGraphData).toHaveBeenCalledWith(graphData);
  });

  // 测试目的：selectGraphNode 应透传 nodeId（含 null 场景）
  it('selectGraphNode 应透传 nodeId（含 null 场景）', () => {
    const mock = createMockThis();
    memoryDelegations.selectGraphNode.call(mock as UIManager, 'node-1');
    expect(mock.memoryPanel.selectGraphNode).toHaveBeenCalledWith('node-1');
    memoryDelegations.selectGraphNode.call(mock as UIManager, null);
    expect(mock.memoryPanel.selectGraphNode).toHaveBeenCalledWith(null);
  });

  // 测试目的：clearGraphHighlights 应委托到 memoryPanel.clearGraphHighlights
  it('clearGraphHighlights 应委托到 memoryPanel.clearGraphHighlights', () => {
    const mock = createMockThis();
    memoryDelegations.clearGraphHighlights.call(mock as UIManager);
    expect(mock.memoryPanel.clearGraphHighlights).toHaveBeenCalled();
  });

  // 测试目的：onMoreMenuAction 应透传 action 回调
  it('onMoreMenuAction 应透传 action 回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onMoreMenuAction.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onMoreMenuAction).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onRecycleBinAction 应透传 restore/purge + id 回调
  it('onRecycleBinAction 应透传 restore/purge 回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onRecycleBinAction.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onRecycleBinAction).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onRecycleBinBatchAction 应透传 restore-all/purge-all 回调
  it('onRecycleBinBatchAction 应透传 restore-all/purge-all 回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onRecycleBinBatchAction.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onRecycleBinBatchAction).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onSortChange 应透传排序变更回调
  it('onSortChange 应透传排序变更回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onSortChange.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onSortChange).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onTimeRangeChange 应透传时间范围变更回调
  it('onTimeRangeChange 应透传时间范围变更回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onTimeRangeChange.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onTimeRangeChange).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onCleanupConfirm 应透传清理确认回调（返回 Promise<void>）
  it('onCleanupConfirm 应透传清理确认回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onCleanupConfirm.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onCleanupConfirm).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onViewSwitch 应透传视图切换回调
  it('onViewSwitch 应透传视图切换回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onViewSwitch.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onViewSwitch).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onGraphContextMenuAction 应透传右键菜单 action + nodeId 回调
  it('onGraphContextMenuAction 应透传右键菜单回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onGraphContextMenuAction.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onGraphContextMenuAction).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onRelationDelete 应透传关系删除回调（sourceId + targetId + type）
  it('onRelationDelete 应透传关系删除回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onRelationDelete.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onRelationDelete).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onRelationCreate 应透传关系创建回调（含 weight）
  it('onRelationCreate 应透传关系创建回调', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    memoryDelegations.onRelationCreate.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onRelationCreate).toHaveBeenCalledWith(cb);
  });
});

// ─── 4. miscDelegations ─────────────────────────────────

describe('miscDelegations', () => {
  it('openCommandPalette 应委托到 commandPaletteManager.open', () => {
    const mock = createMockThis();
    miscDelegations.openCommandPalette.call(mock as UIManager);
    expect(mock.commandPaletteManager.open).toHaveBeenCalled();
  });

  it('refreshTokenUsage 应 void 委托到 inputAreaManager.refreshTokenUsage', () => {
    const mock = createMockThis();
    mock.inputAreaManager.refreshTokenUsage.mockReturnValue(Promise.resolve());
    miscDelegations.refreshTokenUsage.call(mock as UIManager);
    expect(mock.inputAreaManager.refreshTokenUsage).toHaveBeenCalled();
  });

  it('showClipboardConfirmDialog 应 async 委托并 await', async () => {
    const mock = createMockThis();
    mock.clipboardManager.showClipboardConfirmDialog.mockResolvedValue(undefined);
    await miscDelegations.showClipboardConfirmDialog.call(mock as UIManager, '内容');
    expect(mock.clipboardManager.showClipboardConfirmDialog).toHaveBeenCalledWith('内容');
  });

  it('handleQuickRecordTrigger 应 async 委托到 panelRouter', async () => {
    const mock = createMockThis();
    mock.panelRouter.handleQuickRecordTrigger.mockResolvedValue(undefined);
    await miscDelegations.handleQuickRecordTrigger.call(mock as UIManager);
    expect(mock.panelRouter.handleQuickRecordTrigger).toHaveBeenCalled();
  });

  it('handleRecallMemoryTrigger 应 async 委托到 panelRouter', async () => {
    const mock = createMockThis();
    mock.panelRouter.handleRecallMemoryTrigger.mockResolvedValue(undefined);
    await miscDelegations.handleRecallMemoryTrigger.call(mock as UIManager);
    expect(mock.panelRouter.handleRecallMemoryTrigger).toHaveBeenCalled();
  });

  it('shouldShowOnboarding 应返回布尔结果', () => {
    const mock = createMockThis();
    mock.onboardingManager.shouldShowOnboarding.mockReturnValue(true);
    const result = miscDelegations.shouldShowOnboarding.call(mock as UIManager, true);
    expect(mock.onboardingManager.shouldShowOnboarding).toHaveBeenCalledWith(true);
    expect(result).toBe(true);
  });

  it('updateDateNavAvailableDates 应透传 dates 和可选 counts', () => {
    const mock = createMockThis();
    const counts = new Map([['2026-07-12', 3]]);
    miscDelegations.updateDateNavAvailableDates.call(mock as UIManager, ['2026-07-12'], counts);
    expect(mock.dateNavManager.updateAvailableDates).toHaveBeenCalledWith(['2026-07-12'], counts);
  });

  it('prefillChatInput 应委托到 inputAreaManager.setValue', () => {
    const mock = createMockThis();
    miscDelegations.prefillChatInput.call(mock as UIManager, '预填文本');
    expect(mock.inputAreaManager.setValue).toHaveBeenCalledWith('预填文本');
  });

  it('onSearchResultClick 应委托到 searchMessagesManager.onResultClick', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    miscDelegations.onSearchResultClick.call(mock as UIManager, cb);
    expect(mock.searchMessagesManager.onResultClick).toHaveBeenCalledWith(cb);
  });

  // 测试目的：showSuggestion 应透传 ConfigSuggestionPayload 到 suggestionCard
  it('showSuggestion 应透传 ConfigSuggestionPayload 到 suggestionCard', () => {
    const mock = createMockThis();
    const suggestion = {
      type: 'rule' as const,
      name: '建议名',
      content: '建议内容',
      confidence: 0.85,
      source: 'auto-config-refiner',
    };
    miscDelegations.showSuggestion.call(mock as UIManager, suggestion);
    expect(mock.suggestionCard.showSuggestion).toHaveBeenCalledWith(suggestion);
  });

  // 测试目的：scrollToBottom 应委托到 scrollController.scrollToBottom
  it('scrollToBottom 应委托到 scrollController.scrollToBottom', () => {
    const mock = createMockThis();
    miscDelegations.scrollToBottom.call(mock as UIManager);
    expect(mock.scrollController.scrollToBottom).toHaveBeenCalled();
  });

  // 测试目的：forceScrollToBottom 应委托到 scrollController.forceScrollToBottom
  it('forceScrollToBottom 应委托到 scrollController.forceScrollToBottom', () => {
    const mock = createMockThis();
    miscDelegations.forceScrollToBottom.call(mock as UIManager);
    expect(mock.scrollController.forceScrollToBottom).toHaveBeenCalled();
  });

  // 测试目的：updateMaximizeButton 应透传 maximized 布尔值到 panelRouter
  it('updateMaximizeButton 应透传 maximized 布尔值到 panelRouter', () => {
    const mock = createMockThis();
    miscDelegations.updateMaximizeButton.call(mock as UIManager, true);
    expect(mock.panelRouter.updateMaximizeButton).toHaveBeenCalledWith(true);
    miscDelegations.updateMaximizeButton.call(mock as UIManager, false);
    expect(mock.panelRouter.updateMaximizeButton).toHaveBeenCalledWith(false);
  });

  // 测试目的：onDateNavJump 应透传日期跳转回调到 dateNavManager
  it('onDateNavJump 应透传日期跳转回调到 dateNavManager', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    miscDelegations.onDateNavJump.call(mock as UIManager, cb);
    expect(mock.dateNavManager.onDateNavJump).toHaveBeenCalledWith(cb);
  });

  // 测试目的：setDateNavCurrentDate 应透传日期字符串到 dateNavManager.setCurrentDate
  it('setDateNavCurrentDate 应透传日期字符串到 dateNavManager.setCurrentDate', () => {
    const mock = createMockThis();
    miscDelegations.setDateNavCurrentDate.call(mock as UIManager, '2026-07-13');
    expect(mock.dateNavManager.setCurrentDate).toHaveBeenCalledWith('2026-07-13');
  });

  // 测试目的：onDateNavDelete 应透传日期删除回调到 dateNavManager
  it('onDateNavDelete 应透传日期删除回调到 dateNavManager', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    miscDelegations.onDateNavDelete.call(mock as UIManager, cb);
    expect(mock.dateNavManager.onDateNavDelete).toHaveBeenCalledWith(cb);
  });

  // 测试目的：onBackToToday 应透传回到今天回调到 dateNavManager
  it('onBackToToday 应透传回到今天回调到 dateNavManager', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    miscDelegations.onBackToToday.call(mock as UIManager, cb);
    expect(mock.dateNavManager.onBackToToday).toHaveBeenCalledWith(cb);
  });

  // 测试目的：showClipboardConfirmDialog 应委托到 clipboardManager.showClipboardConfirmDialog
  it('showClipboardConfirmDialog 应委托到 clipboardManager.showClipboardConfirmDialog', async () => {
    const mock = createMockThis();
    await miscDelegations.showClipboardConfirmDialog.call(mock as UIManager, '测试内容');
    expect(mock.clipboardManager.showClipboardConfirmDialog).toHaveBeenCalledWith('测试内容');
  });

  // 测试目的：showOnboardingDialog 应委托到 onboardingManager.showOnboardingDialog
  it('showOnboardingDialog 应委托到 onboardingManager.showOnboardingDialog', () => {
    const mock = createMockThis();
    miscDelegations.showOnboardingDialog.call(mock as UIManager);
    expect(mock.onboardingManager.showOnboardingDialog).toHaveBeenCalled();
  });

  // 测试目的：scrollToMemory 应透传 memory id 到 memoryPanel.scrollToMemory
  it('scrollToMemory 应透传 memory id 到 memoryPanel.scrollToMemory', () => {
    const mock = createMockThis();
    miscDelegations.scrollToMemory.call(mock as UIManager, 'mem-1');
    expect(mock.memoryPanel.scrollToMemory).toHaveBeenCalledWith('mem-1');
  });
});

// ─── 5. personaThemeDelegations ─────────────────────────

describe('personaThemeDelegations', () => {
  it('onMemoryRecallClick 应多目标委托到 personaPanel 和 chatPanel', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    personaThemeDelegations.onMemoryRecallClick.call(mock as UIManager, cb);
    expect(mock.personaPanel.onMemoryRecallClick).toHaveBeenCalledWith(cb);
    expect(mock.chatPanel.setMemoryRecallClickCallback).toHaveBeenCalledWith(cb);
  });

  it('getThemeMode 应返回 themeManager.getThemeMode 的结果', () => {
    const mock = createMockThis();
    mock.themeManager.getThemeMode.mockReturnValue('dark');
    const result = personaThemeDelegations.getThemeMode.call(mock as UIManager);
    expect(result).toBe('dark');
  });

  it('setTheme 应委托到 themeManager.setTheme', () => {
    const mock = createMockThis();
    personaThemeDelegations.setTheme.call(mock as UIManager, 'auto');
    expect(mock.themeManager.setTheme).toHaveBeenCalledWith('auto');
  });

  it('onArchiveModeChange 应委托到 settingsPanelManager', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    personaThemeDelegations.onArchiveModeChange.call(mock as UIManager, cb);
    expect(mock.settingsPanelManager.onArchiveModeChange).toHaveBeenCalledWith(cb);
  });

  it('renderPersonaDropdown 应透传 personas 数组', () => {
    const mock = createMockThis();
    const personas = [{ name: '精灵', mode: 'auto' }] as never;
    personaThemeDelegations.renderPersonaDropdown.call(mock as UIManager, personas);
    expect(mock.personaPanel.renderPersonaDropdown).toHaveBeenCalledWith(personas);
  });

  // 测试目的：updateActivePersona 应透传角色名到 personaPanel
  it('updateActivePersona 应透传角色名到 personaPanel', () => {
    const mock = createMockThis();
    personaThemeDelegations.updateActivePersona.call(mock as UIManager, '精灵');
    expect(mock.personaPanel.updateActivePersona).toHaveBeenCalledWith('精灵');
  });

  // 测试目的：updatePersonaModeBadge 应透传模式字符串到 personaPanel
  it('updatePersonaModeBadge 应透传模式字符串到 personaPanel', () => {
    const mock = createMockThis();
    personaThemeDelegations.updatePersonaModeBadge.call(mock as UIManager, 'auto');
    expect(mock.personaPanel.updatePersonaModeBadge).toHaveBeenCalledWith('auto');
  });

  // 测试目的：onPersonaSwitch 应透传角色切换回调到 personaPanel
  it('onPersonaSwitch 应透传角色切换回调到 personaPanel', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    personaThemeDelegations.onPersonaSwitch.call(mock as UIManager, cb);
    expect(mock.personaPanel.onPersonaSwitch).toHaveBeenCalledWith(cb);
  });

  // 测试目的：triggerMemoryRecall 应透传 memoryId 到 personaPanel.triggerMemoryRecallClick
  it('triggerMemoryRecall 应透传 memoryId 到 personaPanel.triggerMemoryRecallClick', () => {
    const mock = createMockThis();
    personaThemeDelegations.triggerMemoryRecall.call(mock as UIManager, 'mem-1');
    expect(mock.personaPanel.triggerMemoryRecallClick).toHaveBeenCalledWith('mem-1');
  });

  // 测试目的：onThemeChange 应透传主题变更回调到 themeManager
  it('onThemeChange 应透传主题变更回调到 themeManager', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    personaThemeDelegations.onThemeChange.call(mock as UIManager, cb);
    expect(mock.themeManager.onThemeChange).toHaveBeenCalledWith(cb);
  });

  // 测试目的：syncThemeRadios 应透传主题到 themeManager.syncThemeRadios
  it('syncThemeRadios 应透传主题到 themeManager.syncThemeRadios', () => {
    const mock = createMockThis();
    personaThemeDelegations.syncThemeRadios.call(mock as UIManager, 'dark');
    expect(mock.themeManager.syncThemeRadios).toHaveBeenCalledWith('dark');
  });
});

// ─── 6. settingsModalDelegations ─────────────────────────

describe('settingsModalDelegations', () => {
  it('loadUserProfile 应 async 委托到 profilePanel.load', async () => {
    const mock = createMockThis();
    mock.profilePanel.load.mockResolvedValue(undefined);
    await settingsModalDelegations.loadUserProfile.call(mock as UIManager);
    expect(mock.profilePanel.load).toHaveBeenCalled();
  });

  it('loadWorkProjections 应 async 委托到 workProjectionPanel.load', async () => {
    const mock = createMockThis();
    mock.workProjectionPanel.load.mockResolvedValue(undefined);
    await settingsModalDelegations.loadWorkProjections.call(mock as UIManager);
    expect(mock.workProjectionPanel.load).toHaveBeenCalled();
  });

  it('loadAuditLog 应 async 委托到 auditPanel.load', async () => {
    const mock = createMockThis();
    mock.auditPanel.load.mockResolvedValue(undefined);
    await settingsModalDelegations.loadAuditLog.call(mock as UIManager);
    expect(mock.auditPanel.load).toHaveBeenCalled();
  });

  it('onProviderChanged 应 void 委托到 inputAreaManager.loadProviderSelector', () => {
    const mock = createMockThis();
    mock.inputAreaManager.loadProviderSelector.mockReturnValue(Promise.resolve());
    settingsModalDelegations.onProviderChanged.call(mock as UIManager);
    expect(mock.inputAreaManager.loadProviderSelector).toHaveBeenCalled();
  });

  it('collectConfigFromForm 应返回 settingsPanelManager.collectConfigFromForm 的结果', () => {
    const mock = createMockThis();
    const form = { archiveMode: 'full' } as never;
    mock.settingsPanelManager.collectConfigFromForm.mockReturnValue(form);
    const result = settingsModalDelegations.collectConfigFromForm.call(mock as UIManager);
    expect(result).toBe(form);
  });

  it('isSettingsDirty 应返回 settingsPanelManager.isDirty 的布尔结果', () => {
    const mock = createMockThis();
    mock.settingsPanelManager.isDirty.mockReturnValue(true);
    const result = settingsModalDelegations.isSettingsDirty.call(mock as UIManager);
    expect(result).toBe(true);
  });

  it('showSettingsError 应委托到 panelErrorBannerManager.showPanelError（panelId="settings"）', () => {
    const mock = createMockThis();
    const retry = vi.fn();
    settingsModalDelegations.showSettingsError.call(mock as UIManager, '错误', retry);
    expect(mock.panelErrorBannerManager.showPanelError).toHaveBeenCalledWith('settings', '错误', retry);
  });

  it('hideSettingsError 应委托到 panelErrorBannerManager.hidePanelError（panelId="settings"）', () => {
    const mock = createMockThis();
    settingsModalDelegations.hideSettingsError.call(mock as UIManager);
    expect(mock.panelErrorBannerManager.hidePanelError).toHaveBeenCalledWith('settings');
  });

  it('showConfirmDialog 应返回 Promise<boolean>', async () => {
    const mock = createMockThis();
    mock.modalManager.showConfirmDialog.mockResolvedValue(true);
    const options = { message: '确认？' } as never;
    const result = await settingsModalDelegations.showConfirmDialog.call(mock as UIManager, options);
    expect(mock.modalManager.showConfirmDialog).toHaveBeenCalledWith(options);
    expect(result).toBe(true);
  });

  it('showInputDialog 应返回 Promise<string|null>', async () => {
    const mock = createMockThis();
    mock.modalManager.showInputDialog.mockResolvedValue('用户输入');
    const options = { message: '请输入' };
    const result = await settingsModalDelegations.showInputDialog.call(mock as UIManager, options);
    expect(mock.modalManager.showInputDialog).toHaveBeenCalledWith(options);
    expect(result).toBe('用户输入');
  });

  it('resetSettingsFormDirty 应委托到 settingsPanelManager.resetFormDirty', () => {
    const mock = createMockThis();
    settingsModalDelegations.resetSettingsFormDirty.call(mock as UIManager);
    expect(mock.settingsPanelManager.resetFormDirty).toHaveBeenCalled();
  });

  // 测试目的：setClearAuditLogCallback 应透传清空审计日志回调到 auditPanel
  it('setClearAuditLogCallback 应透传清空审计日志回调到 auditPanel', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    settingsModalDelegations.setClearAuditLogCallback.call(mock as UIManager, cb);
    expect(mock.auditPanel.setClearAuditLogCallback).toHaveBeenCalledWith(cb);
  });

  // 测试目的：setConfirmProfileCallback 应透传确认画像回调到 profilePanel
  it('setConfirmProfileCallback 应透传确认画像回调到 profilePanel', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    settingsModalDelegations.setConfirmProfileCallback.call(mock as UIManager, cb);
    expect(mock.profilePanel.setConfirmProfileCallback).toHaveBeenCalledWith(cb);
  });

  // 测试目的：setRejectProfileCallback 应透传拒绝画像回调到 profilePanel
  it('setRejectProfileCallback 应透传拒绝画像回调到 profilePanel', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    settingsModalDelegations.setRejectProfileCallback.call(mock as UIManager, cb);
    expect(mock.profilePanel.setRejectProfileCallback).toHaveBeenCalledWith(cb);
  });

  // 测试目的：loadEmbeddingConfig 应透传 embedding 配置到 settingsPanelManager
  it('loadEmbeddingConfig 应透传 embedding 配置到 settingsPanelManager', () => {
    const mock = createMockThis();
    const data = { embedding: { model: 'text-embedding-3', baseUrl: 'https://api', apiKey: 'k' } };
    settingsModalDelegations.loadEmbeddingConfig.call(mock as UIManager, data);
    expect(mock.settingsPanelManager.loadEmbeddingConfig).toHaveBeenCalledWith(data);
  });

  // 测试目的：loadEmbeddingConfig 应透传 embedding=null 场景
  it('loadEmbeddingConfig 应透传 embedding=null 场景', () => {
    const mock = createMockThis();
    const data = { embedding: null };
    settingsModalDelegations.loadEmbeddingConfig.call(mock as UIManager, data);
    expect(mock.settingsPanelManager.loadEmbeddingConfig).toHaveBeenCalledWith(data);
  });

  // 测试目的：loadProjectsToForm 应透传项目列表和选中路径
  it('loadProjectsToForm 应透传项目列表和选中路径', () => {
    const mock = createMockThis();
    const projects = [{ name: 'p1', path: '/p1' }];
    settingsModalDelegations.loadProjectsToForm.call(mock as UIManager, projects, '/p1');
    expect(mock.settingsPanelManager.loadProjectsToForm).toHaveBeenCalledWith(projects, '/p1');
  });

  // 测试目的：onConfigSave 应透传配置保存回调到 settingsPanelManager
  it('onConfigSave 应透传配置保存回调到 settingsPanelManager', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    settingsModalDelegations.onConfigSave.call(mock as UIManager, cb);
    expect(mock.settingsPanelManager.onConfigSave).toHaveBeenCalledWith(cb);
  });

  // 测试目的：updateAgentStatusIndicator 应透传状态和可选消息
  it('updateAgentStatusIndicator 应透传状态和可选消息', () => {
    const mock = createMockThis();
    settingsModalDelegations.updateAgentStatusIndicator.call(mock as UIManager, 'ready');
    expect(mock.settingsPanelManager.updateAgentStatusIndicator).toHaveBeenCalledWith('ready', undefined);
    settingsModalDelegations.updateAgentStatusIndicator.call(mock as UIManager, 'error', '出错了');
    expect(mock.settingsPanelManager.updateAgentStatusIndicator).toHaveBeenCalledWith('error', '出错了');
  });

  // 测试目的：showPanelError 应透传 panelId + message + retryCallback
  it('showPanelError 应透传 panelId + message + retryCallback', () => {
    const mock = createMockThis();
    const retry = vi.fn();
    settingsModalDelegations.showPanelError.call(mock as UIManager, 'memory', '错误', retry);
    expect(mock.panelErrorBannerManager.showPanelError).toHaveBeenCalledWith('memory', '错误', retry);
  });

  // 测试目的：hidePanelError 应透传 panelId
  it('hidePanelError 应透传 panelId', () => {
    const mock = createMockThis();
    settingsModalDelegations.hidePanelError.call(mock as UIManager, 'memory');
    expect(mock.panelErrorBannerManager.hidePanelError).toHaveBeenCalledWith('memory');
  });

  // 测试目的：showModal 应透传 modalId
  it('showModal 应透传 modalId', () => {
    const mock = createMockThis();
    settingsModalDelegations.showModal.call(mock as UIManager, 'settings-modal');
    expect(mock.modalManager.showModal).toHaveBeenCalledWith('settings-modal');
  });

  // 测试目的：hideModal 应透传 modalId
  it('hideModal 应透传 modalId', () => {
    const mock = createMockThis();
    settingsModalDelegations.hideModal.call(mock as UIManager, 'settings-modal');
    expect(mock.modalManager.hideModal).toHaveBeenCalledWith('settings-modal');
  });

  // 测试目的：onSkillInstalled 应透传技能安装回调到 skillDropManager
  it('onSkillInstalled 应透传技能安装回调到 skillDropManager', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    settingsModalDelegations.onSkillInstalled.call(mock as UIManager, cb);
    expect(mock.skillDropManager.onSkillInstalled).toHaveBeenCalledWith(cb);
  });
});
