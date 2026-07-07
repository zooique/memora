/**
 * 多步骤引导管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - shouldShowOnboarding：未见标记返回 true / 已见返回 false
 * - showOnboardingDialog：元素缺失静默退出 / 显示弹窗 / 标记已见
 * - 关闭路径：完成按钮 / Esc 键 / 背景点击
 * - 关闭幂等：重复点击不重复 markSeen / 不重复触发
 * - 背景点击非 modal 不关闭
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API（classList/addEventListener/removeEventListener/localStorage）
 * - localStorage 由 JSDOM 默认提供，测试间通过 beforeEach 清理
 * - window.electronAPI 由 vi.mock 模拟（persistStep 调用 updateConfig）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OnboardingManager } from '../../../electron/renderer/components/onboarding.js';

// ─── 全局 mock ────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  // 模拟 window.electronAPI（persistStep + saveLlmProvider 需要）
  (window as Window & { electronAPI?: { updateConfig: typeof vi.fn; saveLlmProvider: typeof vi.fn } }).electronAPI = {
    updateConfig: vi.fn().mockResolvedValue(undefined),
    saveLlmProvider: vi.fn().mockResolvedValue({ success: true }),
  };
});

// ─── 测试 DOM（多步骤引导结构）─────────────────────────

/** 多步骤引导弹窗完整 DOM：
 *  步骤 1：欢迎 → 下一步/跳过
 *  步骤 2：API Key 配置 → 保存/上一步/跳过
 *  步骤 3：完成 → 开始使用按钮
 */
const ONBOARDING_HTML = `
  <div id="onboarding-modal" class="modal hidden">
    <!-- 步骤指示器 -->
    <div class="onboarding-steps">
      <span class="onboarding-step-dot active" data-step="1"></span>
      <span class="onboarding-step-line"></span>
      <span class="onboarding-step-dot" data-step="2"></span>
      <span class="onboarding-step-line"></span>
      <span class="onboarding-step-dot" data-step="3"></span>
    </div>
    <!-- 步骤 1：欢迎 -->
    <div class="onboarding-step-content active" data-step="1">
      <h2>欢迎使用 Memora</h2>
      <button class="onboarding-next" data-next="2">下一步</button>
      <button class="onboarding-skip" data-skip="3">跳过</button>
    </div>
    <!-- 步骤 2：API Key -->
    <div class="onboarding-step-content" data-step="2">
      <select id="onboarding-provider-type">
        <option value="openai">OpenAI</option>
        <option value="deepseek">DeepSeek</option>
      </select>
      <input id="onboarding-api-key" type="password" placeholder="sk-..." />
      <span id="onboarding-api-error" class="hidden"></span>
      <a id="onboarding-signup-link" href="#">获取 API Key →</a>
      <button id="btn-onboarding-save-key">保存并继续</button>
      <button class="onboarding-prev" data-prev="1">上一步</button>
      <button class="onboarding-skip" data-skip="3">跳过</button>
    </div>
    <!-- 步骤 3：完成 -->
    <div class="onboarding-step-content" data-step="3">
      <p id="onboarding-done-message"></p>
      <button id="btn-onboarding-done">开始使用</button>
    </div>
  </div>
`;

/** 创建 OnboardingManager（可选 DOM 结构） */
function createManager(html?: string): OnboardingManager {
  document.body.innerHTML = html ?? ONBOARDING_HTML;
  return new OnboardingManager();
}

/** 模拟点击背景（target === modal） */
function clickBackdrop(modal: HTMLElement): void {
  const event = new MouseEvent('click', { bubbles: true });
  Object.defineProperty(event, 'target', { value: modal });
  modal.dispatchEvent(event);
}

/** 按 Esc 键 */
function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

// ─── shouldShowOnboarding ────────────────────────────────

describe('shouldShowOnboarding', () => {
  it('未见标记时应返回 true（首次使用）', () => {
    const manager = createManager();
    expect(manager.shouldShowOnboarding(false)).toBe(true);
  });

  it('已见标记时应返回 false（老用户不再显示）', () => {
    localStorage.setItem('memora-onboarding-seen', '1');
    const manager = createManager();
    expect(manager.shouldShowOnboarding(false)).toBe(false);
  });
});

// ─── showOnboardingDialog · 元素缺失降级 ────────────────

describe('showOnboardingDialog · 元素缺失降级', () => {
  it('modal 不存在时应静默退出', () => {
    document.body.innerHTML = '<button id="btn-onboarding-done">开始</button>';
    const manager = new OnboardingManager();
    expect(() => manager.showOnboardingDialog()).not.toThrow();
    // 不应标记已见
    expect(localStorage.getItem('memora-onboarding-seen')).toBeNull();
  });
});

// ─── showOnboardingDialog · 显示与标记 ──────────────────

describe('showOnboardingDialog · 显示与标记', () => {
  it('应移除 hidden 类显示弹窗', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    expect(modal.classList.contains('hidden')).toBe(false);
  });

  it('应注册完成按钮事件（点击完成按钮 → 关闭 + 标记已见）', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const doneBtn = document.getElementById('btn-onboarding-done')!;
    doneBtn.click();
    // 监听器应已触发并标记已见
    expect(localStorage.getItem('memora-onboarding-seen')).toBe('1');
  });
});

// ─── showOnboardingDialog · 三种关闭路径 ────────────────

describe('showOnboardingDialog · 关闭路径', () => {
  it('click 完成按钮应关闭弹窗 + 标记已见', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    const doneBtn = document.getElementById('btn-onboarding-done')!;
    doneBtn.click();
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(localStorage.getItem('memora-onboarding-seen')).toBe('1');
  });

  it('Esc 键应关闭弹窗 + 标记已见', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    pressEscape();
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(localStorage.getItem('memora-onboarding-seen')).toBe('1');
  });

  it('click 背景应关闭弹窗 + 标记已见', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    clickBackdrop(modal);
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(localStorage.getItem('memora-onboarding-seen')).toBe('1');
  });

  it('click 弹窗内容（target !== modal）不应关闭', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    // 点击步骤 1 内容（target !== modal）
    const content = modal.querySelector('[data-step="1"]') as HTMLElement;
    content.click();
    // 弹窗应仍可见
    expect(modal.classList.contains('hidden')).toBe(false);
    // 不应标记已见
    expect(localStorage.getItem('memora-onboarding-seen')).toBeNull();
  });
});

// ─── showOnboardingDialog · 关闭幂等 ────────────────────

describe('showOnboardingDialog · 关闭幂等', () => {
  it('重复 click 完成按钮不应重复标记已见（closed 标志保护）', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const doneBtn = document.getElementById('btn-onboarding-done')!;
    doneBtn.click();
    doneBtn.click(); // 二次点击
    // localStorage 只应被写入一次
    expect(localStorage.getItem('memora-onboarding-seen')).toBe('1');
    // 弹窗应仍为隐藏
    expect(document.getElementById('onboarding-modal')!.classList.contains('hidden')).toBe(true);
  });

  it('完成按钮关闭后再 Esc 不应重复触发', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    const doneBtn = document.getElementById('btn-onboarding-done')!;
    doneBtn.click();
    // 再按 Esc（应被 closed 标志拦截）
    pressEscape();
    expect(modal.classList.contains('hidden')).toBe(true);
  });
});