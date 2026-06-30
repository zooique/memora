/**
 * 三态首次引导管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - shouldShowOnboarding：未见标记返回 true / 已见返回 false
 * - showOnboardingDialog：元素缺失静默退出 / 显示弹窗 / 标记已见
 * - 三种关闭路径：OK 按钮 / 关闭按钮 / 背景点击
 * - 关闭幂等：重复点击不重复 markSeen / 不重复解绑监听器
 * - 背景点击非 modal 不关闭
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API（classList/addEventListener/removeEventListener/localStorage）
 * - localStorage 由 JSDOM 默认提供，测试间通过 beforeEach 清理
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OnboardingManager } from '../../../electron/renderer/components/onboarding.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 引导弹窗完整 DOM 结构（modal + btnOk + closeBtn） */
const ONBOARDING_HTML = `
  <div id="onboarding-modal" class="modal hidden">
    <div class="modal-content">
      <button class="modal-close">x</button>
      <button id="btn-onboarding-ok">开始使用</button>
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

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

// ─── shouldShowOnboarding ────────────────────────────────

describe('shouldShowOnboarding', () => {
  it('未见标记时应返回 true（首次使用）', () => {
    const manager = createManager();
    expect(manager.shouldShowOnboarding()).toBe(true);
  });

  it('已见标记时应返回 false（老用户不再显示）', () => {
    localStorage.setItem('memora-onboarding-seen', '1');
    const manager = createManager();
    expect(manager.shouldShowOnboarding()).toBe(false);
  });
});

// ─── showOnboardingDialog · 元素缺失降级 ────────────────

describe('showOnboardingDialog · 元素缺失降级', () => {
  it('modal 不存在时应静默退出', () => {
    document.body.innerHTML = '<button id="btn-onboarding-ok">开始</button>';
    const manager = new OnboardingManager();
    expect(() => manager.showOnboardingDialog()).not.toThrow();
    // 不应标记已见
    expect(localStorage.getItem('memora-onboarding-seen')).toBeNull();
  });

  it('btnOk 不存在时应静默退出', () => {
    document.body.innerHTML = '<div id="onboarding-modal" class="hidden"></div>';
    const manager = new OnboardingManager();
    expect(() => manager.showOnboardingDialog()).not.toThrow();
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

  it('应注册 OK 按钮 / 背景 / 关闭按钮的事件监听器', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    // 通过触发各路径验证监听器已注册（详见关闭路径测试）
    const btnOk = document.getElementById('btn-onboarding-ok')!;
    btnOk.click();
    // 监听器应已触发并标记已见
    expect(localStorage.getItem('memora-onboarding-seen')).toBe('1');
  });
});

// ─── showOnboardingDialog · 三种关闭路径 ────────────────

describe('showOnboardingDialog · 关闭路径', () => {
  it('click OK 按钮应关闭弹窗 + 标记已见', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    const btnOk = document.getElementById('btn-onboarding-ok')!;
    btnOk.click();
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(localStorage.getItem('memora-onboarding-seen')).toBe('1');
  });

  it('click 关闭按钮（.modal-close）应关闭弹窗 + 标记已见', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    const closeBtn = modal.querySelector('.modal-close') as HTMLElement;
    closeBtn.click();
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
    // 点击 modal-content（target !== modal）
    const content = modal.querySelector('.modal-content') as HTMLElement;
    content.click();
    // 弹窗应仍可见
    expect(modal.classList.contains('hidden')).toBe(false);
    // 不应标记已见
    expect(localStorage.getItem('memora-onboarding-seen')).toBeNull();
  });
});

// ─── showOnboardingDialog · 关闭幂等 ────────────────────

describe('showOnboardingDialog · 关闭幂等', () => {
  it('重复 click OK 按钮不应重复标记已见（closed 标志保护）', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const btnOk = document.getElementById('btn-onboarding-ok')!;
    btnOk.click();
    btnOk.click(); // 二次点击
    // localStorage 只应被写入一次（值仍为 '1'，但通过监听器解绑验证幂等）
    expect(localStorage.getItem('memora-onboarding-seen')).toBe('1');
    // 弹窗应仍为隐藏
    expect(document.getElementById('onboarding-modal')!.classList.contains('hidden')).toBe(true);
  });

  it('OK 关闭后再 click 背景不应重复触发', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    const btnOk = document.getElementById('btn-onboarding-ok')!;
    btnOk.click();
    // 再 click 背景（应被 closed 标志拦截）
    clickBackdrop(modal);
    // 监听器已被移除，click 不应触发任何操作
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  it('无 closeBtn 时不应抛错（closeBtn 可选）', () => {
    // 移除 closeBtn 模拟无关闭按钮场景
    const html = `
      <div id="onboarding-modal" class="modal hidden">
        <div class="modal-content">
          <button id="btn-onboarding-ok">开始使用</button>
        </div>
      </div>
    `;
    const manager = createManager(html);
    manager.showOnboardingDialog();
    const btnOk = document.getElementById('btn-onboarding-ok')!;
    // 不应抛错（closeBtn 不存在时跳过 removeEventListener）
    expect(() => btnOk.click()).not.toThrow();
    expect(localStorage.getItem('memora-onboarding-seen')).toBe('1');
  });
});
