/**
 * 多步骤引导管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - shouldShowOnboarding：无 Provider 返回 true / 有 Provider 返回 false（基于配置记录判定）
 * - showOnboardingDialog：元素缺失静默退出 / 显示弹窗
 * - 关闭路径：完成按钮 / Esc 键 / 背景点击 / 非背景点击不关闭
 * - 关闭幂等：重复点击不重复触发清理
 * - 通用表单校验：必填字段为空时标记错误
 * - 测试连接按钮：成功/失败路径
 * - 保存流程：成功前进步骤 / 失败显示错误
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API（classList/addEventListener/removeEventListener）
 * - window.electronAPI 由 vi.mock 模拟（saveLlmProvider/testLlmConfig/updateConfigBatch）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OnboardingManager } from '../../../electron/renderer/components/onboarding.js';
import { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';

// ─── 全局 mock ────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  // 模拟 window.electronAPI（saveLlmProvider + testLlmConfig + updateConfigBatch 需要）
  (window as Window & { electronAPI?: { saveLlmProvider: typeof vi.fn; testLlmConfig: typeof vi.fn; updateConfigBatch: typeof vi.fn } }).electronAPI = {
    saveLlmProvider: vi.fn().mockResolvedValue({ success: true }),
    testLlmConfig: vi.fn().mockResolvedValue({ success: true, error: null }),
    // AUDIT-5-4：bindDone 完成时持久化使用统计选择（fire-and-forget）
    updateConfigBatch: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── 测试 DOM（多步骤引导结构 - 通用表单版）─────────────

/** 多步骤引导弹窗完整 DOM：
 *  步骤 1：欢迎 → 下一步/跳过
 *  步骤 2：API 配置（通用表单）→ 测试连接/保存/上一步/跳过
 *  步骤 3：隐私统计选择 → 下一步/上一步
 *  步骤 4：完成 → 开始使用按钮
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
      <span class="onboarding-step-line"></span>
      <span class="onboarding-step-dot" data-step="4"></span>
    </div>
    <!-- 步骤 1：欢迎 -->
    <div class="onboarding-step-content active" data-step="1">
      <h2>欢迎使用 Memora</h2>
      <button class="onboarding-next" data-next="2">下一步</button>
      <button class="onboarding-skip" data-skip="4">跳过</button>
    </div>
    <!-- 步骤 2：API 配置（通用表单） -->
    <div class="onboarding-step-content" data-step="2">
      <input id="onboarding-provider" type="text" placeholder="如 deepseek" />
      <p id="onboarding-provider-error" class="onboarding-error hidden" role="alert"></p>
      <input id="onboarding-model" type="text" placeholder="如 deepseek-chat" />
      <p id="onboarding-model-error" class="onboarding-error hidden" role="alert"></p>
      <input id="onboarding-base-url" type="text" placeholder="https://api.deepseek.com/v1" />
      <p id="onboarding-base-url-error" class="onboarding-error hidden" role="alert"></p>
      <input id="onboarding-api-key" type="password" placeholder="sk-..." />
      <p id="onboarding-api-key-error" class="onboarding-error hidden" role="alert"></p>
      <button id="btn-onboarding-test" type="button">测试连接</button>
      <button id="btn-onboarding-save-key">保存并继续</button>
      <button class="onboarding-prev" data-prev="1">上一步</button>
      <button class="onboarding-skip" data-skip="4">跳过</button>
    </div>
    <!-- 步骤 3：隐私统计选择 -->
    <div class="onboarding-step-content" data-step="3">
      <label>
        <input type="checkbox" id="onboarding-usage-stats" />
        允许采集匿名使用统计
      </label>
      <button class="onboarding-next" data-next="4">下一步</button>
      <button class="onboarding-prev" data-prev="2">上一步</button>
    </div>
    <!-- 步骤 4：完成 -->
    <div class="onboarding-step-content" data-step="4">
      <p id="onboarding-done-message"></p>
      <button id="btn-onboarding-done">开始使用</button>
    </div>
  </div>
`;

/** 创建 OnboardingManager（可选 DOM 结构） */
function createManager(html?: string): OnboardingManager {
  document.body.innerHTML = html ?? ONBOARDING_HTML;
  return new OnboardingManager(new EventTracker());
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
  it('无 Provider 配置时应返回 true（首次使用 / 跳过后未配置）', () => {
    const manager = createManager();
    expect(manager.shouldShowOnboarding(false)).toBe(true);
  });

  it('已有 Provider 配置时应返回 false（已配置用户）', () => {
    const manager = createManager();
    expect(manager.shouldShowOnboarding(true)).toBe(false);
  });

  it('C2 修复：跳过引导后无 Provider，下次仍应显示（不依赖 localStorage 标记）', () => {
    // 行为：不写 localStorage，仅基于 Provider 列表判定
    localStorage.setItem('memora-onboarding-seen', '1'); // 模拟旧标记残留（应被忽略）
    const manager = createManager();
    expect(manager.shouldShowOnboarding(false)).toBe(true);
  });
});

// ─── showOnboardingDialog · 元素缺失降级 ────────────────

describe('showOnboardingDialog · 元素缺失降级', () => {
  it('modal 不存在时应静默退出', () => {
    document.body.innerHTML = '<button id="btn-onboarding-done">开始</button>';
    const manager = new OnboardingManager(new EventTracker());
    expect(() => manager.showOnboardingDialog()).not.toThrow();
  });
});

// ─── showOnboardingDialog · 显示 ──────────────────────────

describe('showOnboardingDialog · 显示', () => {
  it('应移除 hidden 类显示弹窗', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    expect(modal.classList.contains('hidden')).toBe(false);
  });

  it('应注册完成按钮事件（点击完成按钮 → 关闭弹窗）', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const doneBtn = document.getElementById('btn-onboarding-done')!;
    doneBtn.click();
    // 弹窗应已隐藏
    expect(document.getElementById('onboarding-modal')!.classList.contains('hidden')).toBe(true);
  });
});

// ─── showOnboardingDialog · 三种关闭路径 ────────────────

describe('showOnboardingDialog · 关闭路径', () => {
  it('click 完成按钮应关闭弹窗', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    const doneBtn = document.getElementById('btn-onboarding-done')!;
    doneBtn.click();
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  it('Esc 键应关闭弹窗', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    pressEscape();
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  it('click 背景应关闭弹窗', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const modal = document.getElementById('onboarding-modal')!;
    clickBackdrop(modal);
    expect(modal.classList.contains('hidden')).toBe(true);
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
  });
});

// ─── showOnboardingDialog · 关闭幂等 ────────────────────

describe('showOnboardingDialog · 关闭幂等', () => {
  it('重复 click 完成按钮不应重复触发清理（closed 标志保护）', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const doneBtn = document.getElementById('btn-onboarding-done')!;
    doneBtn.click();
    doneBtn.click(); // 二次点击
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

// ─── 步骤 2：通用表单校验 + 保存流程 ────────────────────

describe('步骤 2：通用表单校验', () => {
  it('保存时必填字段为空应标记错误且不调用 saveLlmProvider', async () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    // 切换到步骤 2
    const nextBtn = document.querySelector('.onboarding-next[data-next="2"]') as HTMLButtonElement;
    nextBtn.click();

    // 所有字段为空，点击保存
    const saveBtn = document.getElementById('btn-onboarding-save-key') as HTMLButtonElement;
    saveBtn.click();
    // 等待微任务（async click handler）
    await Promise.resolve();

    const electronAPI = (window as Window & { electronAPI: { saveLlmProvider: ReturnType<typeof vi.fn> } }).electronAPI;
    expect(electronAPI.saveLlmProvider).not.toHaveBeenCalled();
    // 至少 provider 字段应被标记错误
    const providerError = document.getElementById('onboarding-provider-error')!;
    expect(providerError.classList.contains('hidden')).toBe(false);
  });

  it('保存时填写完整应调用 saveLlmProvider 并前进到步骤 3', async () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    // 切换到步骤 2
    const nextBtn = document.querySelector('.onboarding-next[data-next="2"]') as HTMLButtonElement;
    nextBtn.click();

    // 填写所有必填字段
    (document.getElementById('onboarding-provider') as HTMLInputElement).value = 'deepseek';
    (document.getElementById('onboarding-model') as HTMLInputElement).value = 'deepseek-chat';
    (document.getElementById('onboarding-base-url') as HTMLInputElement).value = 'https://api.deepseek.com/v1';
    (document.getElementById('onboarding-api-key') as HTMLInputElement).value = 'sk-test';

    const saveBtn = document.getElementById('btn-onboarding-save-key') as HTMLButtonElement;
    saveBtn.click();
    // 等待 async handler 完成
    await Promise.resolve();
    await Promise.resolve();

    const electronAPI = (window as Window & { electronAPI: { saveLlmProvider: ReturnType<typeof vi.fn> } }).electronAPI;
    expect(electronAPI.saveLlmProvider).toHaveBeenCalledWith('default', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      temperature: 0.7,
    });

    // 应前进到步骤 3（步骤 2 content 失活，步骤 3 content 激活）
    const step2 = document.querySelector('[data-step="2"]') as HTMLElement;
    const step3 = document.querySelector('[data-step="3"]') as HTMLElement;
    expect(step2.classList.contains('active')).toBe(false);
    expect(step3.classList.contains('active')).toBe(true);
  });

  it('保存失败应显示错误且不前进步骤', async () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    // mock saveLlmProvider 返回失败
    const electronAPI = (window as Window & { electronAPI: { saveLlmProvider: ReturnType<typeof vi.fn> } }).electronAPI;
    electronAPI.saveLlmProvider.mockResolvedValueOnce({ success: false, error: 'API Key 无效' });

    // 切换到步骤 2 并填写
    const nextBtn = document.querySelector('.onboarding-next[data-next="2"]') as HTMLButtonElement;
    nextBtn.click();
    (document.getElementById('onboarding-provider') as HTMLInputElement).value = 'deepseek';
    (document.getElementById('onboarding-model') as HTMLInputElement).value = 'deepseek-chat';
    (document.getElementById('onboarding-base-url') as HTMLInputElement).value = 'https://api.deepseek.com/v1';
    (document.getElementById('onboarding-api-key') as HTMLInputElement).value = 'sk-wrong';

    const saveBtn = document.getElementById('btn-onboarding-save-key') as HTMLButtonElement;
    saveBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    // 应显示错误在 apiKey 错误区
    const apiKeyError = document.getElementById('onboarding-api-key-error')!;
    expect(apiKeyError.classList.contains('hidden')).toBe(false);
    // 步骤 2 应仍为激活（未前进）
    const step2 = document.querySelector('[data-step="2"]') as HTMLElement;
    expect(step2.classList.contains('active')).toBe(true);
  });
});

// ─── 步骤 2：测试连接按钮 ────────────────────────────────

describe('步骤 2：测试连接按钮', () => {
  it('测试成功应显示成功提示', async () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    // 切换到步骤 2
    const nextBtn = document.querySelector('.onboarding-next[data-next="2"]') as HTMLButtonElement;
    nextBtn.click();

    // 填写完整字段
    (document.getElementById('onboarding-provider') as HTMLInputElement).value = 'deepseek';
    (document.getElementById('onboarding-model') as HTMLInputElement).value = 'deepseek-chat';
    (document.getElementById('onboarding-base-url') as HTMLInputElement).value = 'https://api.deepseek.com/v1';
    (document.getElementById('onboarding-api-key') as HTMLInputElement).value = 'sk-test';

    const testBtn = document.getElementById('btn-onboarding-test') as HTMLButtonElement;
    testBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    const electronAPI = (window as Window & { electronAPI: { testLlmConfig: ReturnType<typeof vi.fn> } }).electronAPI;
    expect(electronAPI.testLlmConfig).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
    });

    // 应显示成功提示
    const apiKeyError = document.getElementById('onboarding-api-key-error')!;
    expect(apiKeyError.classList.contains('hidden')).toBe(false);
    expect(apiKeyError.textContent).toContain('连接成功');
  });

  it('测试失败应显示错误提示（错误消息经 classifyLlmError 映射）', async () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    const electronAPI = (window as Window & { electronAPI: { testLlmConfig: ReturnType<typeof vi.fn> } }).electronAPI;
    // 模拟 401 错误（应被 classifyLlmError 映射为"API Key 无效"）
    electronAPI.testLlmConfig.mockResolvedValueOnce({ success: false, error: 'API Key 无效，请检查是否复制完整（注意前后不要有空格）' });

    // 切换到步骤 2 并填写
    const nextBtn = document.querySelector('.onboarding-next[data-next="2"]') as HTMLButtonElement;
    nextBtn.click();
    (document.getElementById('onboarding-provider') as HTMLInputElement).value = 'deepseek';
    (document.getElementById('onboarding-model') as HTMLInputElement).value = 'deepseek-chat';
    (document.getElementById('onboarding-base-url') as HTMLInputElement).value = 'https://api.deepseek.com/v1';
    (document.getElementById('onboarding-api-key') as HTMLInputElement).value = 'sk-wrong';

    const testBtn = document.getElementById('btn-onboarding-test') as HTMLButtonElement;
    testBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    const apiKeyError = document.getElementById('onboarding-api-key-error')!;
    expect(apiKeyError.classList.contains('hidden')).toBe(false);
    expect(apiKeyError.textContent).toContain('API Key 无效');
  });

  it('必填字段为空时点击测试应先校验且不调用 testLlmConfig', async () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    // 切换到步骤 2
    const nextBtn = document.querySelector('.onboarding-next[data-next="2"]') as HTMLButtonElement;
    nextBtn.click();

    // 所有字段为空，点击测试
    const testBtn = document.getElementById('btn-onboarding-test') as HTMLButtonElement;
    testBtn.click();
    await Promise.resolve();

    const electronAPI = (window as Window & { electronAPI: { testLlmConfig: ReturnType<typeof vi.fn> } }).electronAPI;
    expect(electronAPI.testLlmConfig).not.toHaveBeenCalled();
  });
});

// ─── 跳过路径 ────────────────────────────────────────────

describe('跳过路径', () => {
  it('步骤 2 点击跳过应设置 skippedApiKey=true 并跳到步骤 4', () => {
    const manager = createManager();
    manager.showOnboardingDialog();
    // 切换到步骤 2
    const nextBtn = document.querySelector('.onboarding-next[data-next="2"]') as HTMLButtonElement;
    nextBtn.click();
    // 点击跳过
    const skipBtn = document.querySelector('.onboarding-skip[data-skip="4"]') as HTMLButtonElement;
    skipBtn.click();

    // 应跳到步骤 4
    const step4 = document.querySelector('[data-step="4"]') as HTMLElement;
    expect(step4.classList.contains('active')).toBe(true);
    // 完成消息应是"稍后配置"版本
    const doneMsg = document.getElementById('onboarding-done-message')!;
    expect(doneMsg.textContent).toContain('稍后');
  });
});
