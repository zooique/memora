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
import { chatDelegations } from '../../../electron/renderer/helpers/uiDelegations/chatDelegations.js';
import { dashboardDelegations } from '../../../electron/renderer/helpers/uiDelegations/dashboardDelegations.js';
import { memoryDelegations } from '../../../electron/renderer/helpers/uiDelegations/memoryDelegations.js';
import { miscDelegations } from '../../../electron/renderer/helpers/uiDelegations/miscDelegations.js';
import { personaThemeDelegations } from '../../../electron/renderer/helpers/uiDelegations/personaThemeDelegations.js';
import { settingsModalDelegations } from '../../../electron/renderer/helpers/uiDelegations/settingsModalDelegations.js';
import type { UIManager } from '../../../electron/renderer/ui.js';

// ─── Mock 工厂 ─────────────────────────────────────────────

/**
 * 创建 mock UIManager 上下文
 *
 * 委托方法的 this 类型为 UIManager，实际只访问其持有的子模块实例。
 * 用 Proxy 动态返回 vi.fn() 容器，避免手写所有子模块。
 */
function createMockThis(): UIManager & Record<string, Record<string, ReturnType<typeof vi.fn>>> {
  const cache = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const proxy = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (!cache.has(prop)) {
          // 子模块本身是对象，其方法用 vi.fn 占位
          cache.set(prop, new Proxy(
            {},
            {
              get(_t, method: string) {
                if (!(_t as Record<string, ReturnType<typeof vi.fn>>)[method]) {
                  (_t as Record<string, ReturnType<typeof vi.fn>>)[method] = vi.fn();
                }
                return (_t as Record<string, ReturnType<typeof vi.fn>>)[method];
              },
            },
          ) as Record<string, ReturnType<typeof vi.fn>>);
        }
        return cache.get(prop);
      },
    },
  );
  return proxy as unknown as UIManager & Record<string, Record<string, ReturnType<typeof vi.fn>>>;
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
    expect(mock.chatPanel.startStreaming).toHaveBeenCalledWith('m1');
  });

  it('工具调用委托应透传完整参数', () => {
    const mock = createMockThis();
    chatDelegations.showToolStart.call(mock as UIManager, 'm1', 'tc1', 'search', '{"q":"x"}');
    chatDelegations.updateToolResult.call(mock as UIManager, 'm1', 'tc1', 'search', true, '找到 3 条');
    expect(mock.chatPanel.showToolStart).toHaveBeenCalledWith('m1', 'tc1', 'search', '{"q":"x"}');
    expect(mock.chatPanel.updateToolResult).toHaveBeenCalledWith('m1', 'tc1', 'search', true, '找到 3 条');
  });
});

// ─── 2. dashboardDelegations ─────────────────────────────

describe('dashboardDelegations', () => {
  it('renderDashboardStats 应透传 DashboardViewModel', () => {
    const mock = createMockThis();
    const data = { totalMemories: 10 } as never;
    dashboardDelegations.renderDashboardStats.call(mock as UIManager, data);
    expect(mock.dashboardPanel.renderDashboardStats).toHaveBeenCalledWith(data);
  });

  it('onPartnerMemoryClick 应多目标委托到 memoryPanel 和 perceptionPanel', () => {
    const mock = createMockThis();
    const cb = vi.fn();
    dashboardDelegations.onPartnerMemoryClick.call(mock as UIManager, cb);
    expect(mock.memoryPanel.onPartnerMemoryClick).toHaveBeenCalledWith(cb);
    expect(mock.perceptionPanel.onMemoryClick).toHaveBeenCalledWith(cb);
  });

  it('updateAffectDisplay 应多目标委托到 perceptionPanel 和 spriteStatusPopover', () => {
    const mock = createMockThis();
    const affect = { warmth: 0.8 } as never;
    dashboardDelegations.updateAffectDisplay.call(mock as UIManager, affect);
    expect(mock.perceptionPanel.updateAffectDisplay).toHaveBeenCalledWith(affect);
    expect(mock.spriteStatusPopover.updateAffect).toHaveBeenCalledWith(affect);
  });

  it('updateRapportDisplay 应多目标委托到 perceptionPanel 和 spriteStatusPopover', () => {
    const mock = createMockThis();
    const rapport = { level: 'high' } as never;
    dashboardDelegations.updateRapportDisplay.call(mock as UIManager, rapport);
    expect(mock.perceptionPanel.updateRapportDisplay).toHaveBeenCalledWith(rapport);
    expect(mock.spriteStatusPopover.updateRapport).toHaveBeenCalledWith(rapport);
  });

  it('updateContextDisplay 应多目标委托到 perceptionPanel 和 spriteStatusPopover', () => {
    const mock = createMockThis();
    const ctx = { focus: 'coding' } as never;
    dashboardDelegations.updateContextDisplay.call(mock as UIManager, ctx);
    expect(mock.perceptionPanel.updateContextDisplay).toHaveBeenCalledWith(ctx);
    expect(mock.spriteStatusPopover.updateContext).toHaveBeenCalledWith(ctx);
  });

  it('repaintCanvasOnThemeChange 应多目标委托到 dashboardPanel 和 memoryPanel', () => {
    const mock = createMockThis();
    dashboardDelegations.repaintCanvasOnThemeChange.call(mock as UIManager);
    expect(mock.dashboardPanel.repaintOnThemeChange).toHaveBeenCalled();
    expect(mock.memoryPanel.repaintOnThemeChange).toHaveBeenCalled();
  });

  it('renderSkills 应委托到 settingsPanelManager（而非 dashboardPanel）', () => {
    const mock = createMockThis();
    const skills = [{ name: 's1', keywords: ['k'], description: 'd', layer: 'L1' }];
    dashboardDelegations.renderSkills.call(mock as UIManager, skills);
    expect(mock.settingsPanelManager.renderSkills).toHaveBeenCalledWith(skills);
    // dashboardPanel.renderSkills 不应被调用（委托目标是 settingsPanelManager）
    expect(mock.dashboardPanel.renderSkills).not.toHaveBeenCalled();
  });

  it('showMemoryListError 应透传 listEl 元素', () => {
    const mock = createMockThis();
    const el = document.createElement('div');
    dashboardDelegations.showMemoryListError.call(mock as UIManager, el);
    expect(mock.dashboardPanel.showMemoryListError).toHaveBeenCalledWith(el);
  });

  it('pulseCounter 应透传 id', () => {
    const mock = createMockThis();
    dashboardDelegations.pulseCounter.call(mock as UIManager, 'counter-1');
    expect(mock.dashboardPanel.pulseCounter).toHaveBeenCalledWith('counter-1');
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

  it('handleSkillDrop 应 async 委托到 skillDropManager', async () => {
    const mock = createMockThis();
    mock.skillDropManager.handleSkillDrop.mockResolvedValue(undefined);
    const files = [new File(['content'], 'skill.zip')];
    await settingsModalDelegations.handleSkillDrop.call(mock as UIManager, files);
    expect(mock.skillDropManager.handleSkillDrop).toHaveBeenCalledWith(files);
  });

  it('resetSettingsFormDirty 应委托到 settingsPanelManager.resetFormDirty', () => {
    const mock = createMockThis();
    settingsModalDelegations.resetSettingsFormDirty.call(mock as UIManager);
    expect(mock.settingsPanelManager.resetFormDirty).toHaveBeenCalled();
  });
});
