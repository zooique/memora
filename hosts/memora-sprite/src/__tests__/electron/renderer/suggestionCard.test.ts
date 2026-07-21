/**
 * 建议卡片管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：预定义容器复用 / 动态创建 / 插入位置（proactive-banner 后 / messages 前 / body 兜底）
 * - showSuggestion：容器未初始化防护 / FIFO 限制（maxVisible=3）/ 滑入动画
 * - createCardElement：类型标签映射（rule/persona/skill/未知降级）/ 置信度百分比 /
 *   防 XSS（textContent）/ 关闭按钮 / 接受按钮 / 拒绝按钮
 * - 接受流程：成功移除 / 失败恢复按钮 / 异常恢复
 * - 拒绝流程：成功移除 / 异常恢复
 * - removeCard：淡出动画 + animationend 移除
 * - cleanup：EventTracker 清理 + clearElement 清空容器
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - requestAnimationFrame 同步化（showSuggestion 用 rAF 触发滑入动画）
 * - mock window.electronAPI.acceptSuggestion/rejectSuggestion（异步 IPC）
 * - JSDOM 提供真实 DOM API（classList/appendChild/querySelector/dispatchEvent）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SuggestionCardManager } from '../../../electron/renderer/components/suggestionCard.js';
import type { ConfigSuggestionPayload } from '../../../electron/preload.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建测试用建议 payload */
function createSuggestion(overrides?: Partial<ConfigSuggestionPayload>): ConfigSuggestionPayload {
  return {
    type: 'rule',
    name: 'TypeScript 偏好',
    content: '用户偏好函数式风格',
    confidence: 0.85,
    source: 'auto-config-refiner',
    ...overrides,
  };
}

/** 创建 SuggestionCardManager 实例（已 init） */
function createManager(opts?: { init?: boolean; dom?: 'full' | 'empty' | 'proactive-only' | 'messages-only' }): {
  manager: SuggestionCardManager;
  container: HTMLElement | null;
} {
  // 根据 dom 选项设置不同的 DOM 结构
  if (opts?.dom === 'empty') {
    document.body.innerHTML = '';
  } else if (opts?.dom === 'proactive-only') {
    document.body.innerHTML = '<div id="proactive-banner"></div>';
  } else if (opts?.dom === 'messages-only') {
    document.body.innerHTML = '<div id="messages"></div>';
  } else if (opts?.dom === 'full') {
    document.body.innerHTML = `
      <div id="proactive-banner"></div>
      <div id="messages"></div>
    `;
  }

  const manager = new SuggestionCardManager();
  if (opts?.init !== false) {
    manager.init();
  }
  const container = document.getElementById('suggestion-container');
  return { manager, container };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  // requestAnimationFrame 同步化：showSuggestion 用 rAF 触发滑入动画
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  // 初始化 window.electronAPI（acceptSuggestion/rejectSuggestion 默认成功，单测可覆盖）
  window.electronAPI = {
    acceptSuggestion: vi.fn().mockResolvedValue({ success: true }),
    rejectSuggestion: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as typeof window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── init ────────────────────────────────────────────────

describe('init · 容器获取与创建', () => {
  it('应复用 HTML 中预定义的容器', () => {
    // 预定义容器
    document.body.innerHTML = '<div id="suggestion-container" class="custom"></div>';
    const manager = new SuggestionCardManager();
    manager.init();
    // 应复用已存在的容器（保留 custom 类）
    const container = document.getElementById('suggestion-container')!;
    expect(container.className).toBe('custom');
  });

  it('容器不存在 + 有 proactive-banner 时应插入到 banner 之后', () => {
    createManager({ dom: 'full' });
    const banner = document.getElementById('proactive-banner')!;
    const container = document.getElementById('suggestion-container')!;
    // container 应紧跟在 banner 之后
    expect(banner.nextElementSibling).toBe(container);
  });

  it('容器不存在 + 无 proactive-banner + 有 messages 时应插入到 messages 之前', () => {
    createManager({ dom: 'messages-only' });
    const messages = document.getElementById('messages')!;
    const container = document.getElementById('suggestion-container')!;
    // container 应在 messages 之前
    expect(messages.previousElementSibling).toBe(container);
  });

  it('容器不存在 + 无 proactive-banner + 无 messages 时应追加到 body', () => {
    createManager({ dom: 'empty' });
    const container = document.getElementById('suggestion-container')!;
    expect(container.parentNode).toBe(document.body);
  });
});

// ─── showSuggestion ──────────────────────────────────────

describe('showSuggestion · 容器未初始化防护', () => {
  it('未调用 init 时应静默退出（不创建卡片）', () => {
    const { manager } = createManager({ init: false });
    expect(() => manager.showSuggestion(createSuggestion())).not.toThrow();
    // 不应创建任何卡片
    expect(document.querySelectorAll('.suggestion-card').length).toBe(0);
  });
});

describe('showSuggestion · FIFO 限制', () => {
  it('达到 maxVisible=3 时应移除最早的卡片', () => {
    const { manager } = createManager({ dom: 'empty' });
    // 添加 3 张卡片（达到上限）
    manager.showSuggestion(createSuggestion({ name: '卡片1' }));
    manager.showSuggestion(createSuggestion({ name: '卡片2' }));
    manager.showSuggestion(createSuggestion({ name: '卡片3' }));
    expect(document.querySelectorAll('.suggestion-card').length).toBe(3);

    // 添加第 4 张，应移除最早的（卡片1）
    manager.showSuggestion(createSuggestion({ name: '卡片4' }));
    const cards = document.querySelectorAll('.suggestion-card');
    expect(cards.length).toBe(3);
    // 第一张应为卡片2（卡片1 被移除）
    expect(cards[0].querySelector('.suggestion-card-name')!.textContent).toBe('卡片2');
  });

  it('未达到 maxVisible 时不应移除卡片', () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion({ name: '卡片1' }));
    manager.showSuggestion(createSuggestion({ name: '卡片2' }));
    expect(document.querySelectorAll('.suggestion-card').length).toBe(2);
  });

  it('应将新卡片追加到容器末尾', () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion({ name: '卡片1' }));
    manager.showSuggestion(createSuggestion({ name: '卡片2' }));
    const cards = document.querySelectorAll('.suggestion-card');
    // 卡片1 在前，卡片2 在后
    expect(cards[0].querySelector('.suggestion-card-name')!.textContent).toBe('卡片1');
    expect(cards[1].querySelector('.suggestion-card-name')!.textContent).toBe('卡片2');
  });
});

describe('showSuggestion · 滑入动画', () => {
  it('新卡片应先有 suggestion-card-enter 类，rAF 后移除', () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion());
    const card = document.querySelector('.suggestion-card') as HTMLElement;
    // rAF 已同步化执行，enter 类应已被移除
    expect(card.classList.contains('suggestion-card-enter')).toBe(false);
  });
});

// ─── createCardElement · DOM 结构 ────────────────────────

describe('createCardElement · 类型标签映射', () => {
  it('rule 类型应显示"规则建议"', () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion({ type: 'rule' }));
    expect(document.querySelector('.suggestion-card-type')!.textContent).toBe('规则建议');
  });

  it('persona 类型应显示"角色建议"', () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion({ type: 'persona' }));
    expect(document.querySelector('.suggestion-card-type')!.textContent).toBe('角色建议');
  });

  it('skill 类型应显示"技能建议"', () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion({ type: 'skill' }));
    expect(document.querySelector('.suggestion-card-type')!.textContent).toBe('技能建议');
  });

  it('未知类型应降级显示"建议"', () => {
    const { manager } = createManager({ dom: 'empty' });
    // 类型断言绕过 TS 检查以测试运行时降级
    manager.showSuggestion(createSuggestion({ type: 'unknown' as ConfigSuggestionPayload['type'] }));
    expect(document.querySelector('.suggestion-card-type')!.textContent).toBe('建议');
  });
});

describe('createCardElement · 置信度与内容', () => {
  it('应显示置信度百分比（四舍五入）', () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion({ confidence: 0.853 }));
    expect(document.querySelector('.suggestion-card-confidence')!.textContent).toBe('置信度 85%');
  });

  it('应显示建议名称（防 XSS）', () => {
    const { manager } = createManager({ dom: 'empty' });
    const malicious = '<img src=x onerror=alert(1)>';
    manager.showSuggestion(createSuggestion({ name: malicious }));
    // textContent 应为字面量（未作为 HTML 解析）
    const nameEl = document.querySelector('.suggestion-card-name')!;
    expect(nameEl.textContent).toBe(malicious);
    expect(nameEl.querySelector('img')).toBeNull();
  });

  it('应显示建议内容（防 XSS）', () => {
    const { manager } = createManager({ dom: 'empty' });
    const malicious = '<script>alert(1)</script>';
    manager.showSuggestion(createSuggestion({ content: malicious }));
    const contentEl = document.querySelector('.suggestion-card-content')!;
    expect(contentEl.textContent).toBe(malicious);
    expect(contentEl.querySelector('script')).toBeNull();
  });
});

describe('createCardElement · 按钮', () => {
  it('应创建接受和拒绝按钮', () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion());
    const acceptBtn = document.querySelector('.suggestion-card-btn.accept') as HTMLButtonElement;
    const rejectBtn = document.querySelector('.suggestion-card-btn.reject') as HTMLButtonElement;
    expect(acceptBtn).not.toBeNull();
    expect(acceptBtn.textContent).toBe('接受');
    expect(rejectBtn).not.toBeNull();
    expect(rejectBtn.textContent).toBe('拒绝');
  });

  it('不应创建关闭按钮（建议必须经接受/拒绝明确处置）', () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion());
    // X 关闭按钮不展示：避免用户随手关闭导致建议悬而未决
    expect(document.querySelector('.suggestion-card-close')).toBeNull();
  });
});

// ─── 接受流程 ────────────────────────────────────────────

describe('接受流程', () => {
  it('click 接受按钮成功应移除卡片', async () => {
    const { manager } = createManager({ dom: 'empty' });
    const suggestion = createSuggestion();
    manager.showSuggestion(suggestion);
    // mock acceptSuggestion 成功
    window.electronAPI.acceptSuggestion = vi.fn().mockResolvedValue({ success: true });
    const acceptBtn = document.querySelector('.suggestion-card-btn.accept') as HTMLButtonElement;
    acceptBtn.click();
    // 等待异步完成
    await Promise.resolve();
    await Promise.resolve();
    // 应调用 acceptSuggestion
    expect(window.electronAPI.acceptSuggestion).toHaveBeenCalledWith(suggestion);
    // 卡片应触发淡出
    const card = document.querySelector('.suggestion-card') as HTMLElement;
    expect(card.classList.contains('suggestion-card-leave')).toBe(true);
  });

  it('click 接受按钮失败应恢复按钮状态', async () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion());
    // mock acceptSuggestion 失败
    window.electronAPI.acceptSuggestion = vi.fn().mockResolvedValue({
      success: false,
      error: '配置写入失败',
    });
    const acceptBtn = document.querySelector('.suggestion-card-btn.accept') as HTMLButtonElement;
    const rejectBtn = document.querySelector('.suggestion-card-btn.reject') as HTMLButtonElement;
    acceptBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    // 按钮应恢复可用
    expect(acceptBtn.disabled).toBe(false);
    expect(rejectBtn.disabled).toBe(false);
    expect(acceptBtn.textContent).toBe('接受');
    // 卡片不应被移除
    expect(document.querySelectorAll('.suggestion-card').length).toBe(1);
  });

  it('click 接受按钮异常应恢复按钮状态', async () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion());
    // mock acceptSuggestion 抛异常
    window.electronAPI.acceptSuggestion = vi.fn().mockRejectedValue(new Error('网络错误'));
    const acceptBtn = document.querySelector('.suggestion-card-btn.accept') as HTMLButtonElement;
    acceptBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(acceptBtn.disabled).toBe(false);
    expect(acceptBtn.textContent).toBe('接受');
  });

  it('接受失败应通过注入的 showToast 给用户可见反馈', async () => {
    // 注入 showToast spy，验证操作失败时弹 toast 提示
    const showToast = vi.fn();
    document.body.innerHTML = '';
    const manager = new SuggestionCardManager();
    manager.init(showToast);
    manager.showSuggestion(createSuggestion());
    window.electronAPI.acceptSuggestion = vi.fn().mockResolvedValue({
      success: false,
      error: '配置写入失败',
    });
    const acceptBtn = document.querySelector('.suggestion-card-btn.accept') as HTMLButtonElement;
    acceptBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(showToast).toHaveBeenCalledWith('接受建议失败，请稍后重试', 'error');
  });
});

// ─── 拒绝流程 ────────────────────────────────────────────

describe('拒绝流程', () => {
  it('click 拒绝按钮成功应移除卡片', async () => {
    const { manager } = createManager({ dom: 'empty' });
    const suggestion = createSuggestion();
    manager.showSuggestion(suggestion);
    window.electronAPI.rejectSuggestion = vi.fn().mockResolvedValue({ success: true });
    const rejectBtn = document.querySelector('.suggestion-card-btn.reject') as HTMLButtonElement;
    rejectBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.electronAPI.rejectSuggestion).toHaveBeenCalledWith(suggestion);
    const card = document.querySelector('.suggestion-card') as HTMLElement;
    expect(card.classList.contains('suggestion-card-leave')).toBe(true);
  });

  it('click 拒绝按钮异常应恢复按钮状态', async () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion());
    window.electronAPI.rejectSuggestion = vi.fn().mockRejectedValue(new Error('IPC 失败'));
    const rejectBtn = document.querySelector('.suggestion-card-btn.reject') as HTMLButtonElement;
    const acceptBtn = document.querySelector('.suggestion-card-btn.accept') as HTMLButtonElement;
    rejectBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(rejectBtn.disabled).toBe(false);
    expect(acceptBtn.disabled).toBe(false);
    expect(document.querySelectorAll('.suggestion-card').length).toBe(1);
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup', () => {
  it('应清空容器内所有卡片', () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion({ name: '卡片1' }));
    manager.showSuggestion(createSuggestion({ name: '卡片2' }));
    manager.showSuggestion(createSuggestion({ name: '卡片3' }));
    expect(document.querySelectorAll('.suggestion-card').length).toBe(3);
    manager.cleanup();
    expect(document.querySelectorAll('.suggestion-card').length).toBe(0);
  });

  it('cleanup 后事件监听器应被移除（按钮 click 不再生效）', async () => {
    const { manager } = createManager({ dom: 'empty' });
    manager.showSuggestion(createSuggestion());
    // cleanup 前获取按钮引用（cleanup 会清空容器）
    const acceptBtn = document.querySelector('.suggestion-card-btn.accept') as HTMLButtonElement;
    manager.cleanup();
    // cleanup 后 click 接受按钮不应触发 IPC（监听器已移除）
    acceptBtn.click();
    await Promise.resolve();
    expect(window.electronAPI.acceptSuggestion).not.toHaveBeenCalled();
  });
});
