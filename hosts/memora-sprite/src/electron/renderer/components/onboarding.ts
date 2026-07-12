/**
 * 多步骤引导模块
 *
 * 职责：
 * - 检测是否需要显示引导（未配置 Provider 的新用户）
 * - 管理四步引导向导：欢迎 → API Key 配置 → 隐私统计选择 → 开始使用
 * - 为每个预设 Provider 提供注册链接
 * - 保存 API Key 配置（通过 updateConfig IPC）
 * - 持久化使用统计选择（通过 config-update-batch IPC）
 *
 * 设计原则：
 * - 独立于 UIManager，无 this 依赖，纯 DOM + localStorage + IPC 操作
 * - 已配置 Provider 的用户跳过引导（检查 provider 列表）
 * - 支持跳过 API Key 步骤（降级路径)
 */
import { reportError } from '../helpers/errorHelpers.js';
import { showFieldError, clearFieldErrors } from '../helpers/formValidation.js';

// ─── Provider 注册链接映射 ──────────────────────────────

/** 常用 Provider 的注册/获取 API Key 页面链接 */
const PROVIDER_SIGNUP_URLS: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  anthropic: 'https://console.anthropic.com/keys',
  dashscope: 'https://dashscope.console.aliyun.com/apiKey',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  moonshot: 'https://platform.moonshot.cn/console/api-keys',
  siliconflow: 'https://cloud.siliconflow.cn/account/ak',
};

/** Provider 默认模型映射（自动填充，减少用户配置负担） */
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o',
  deepseek: 'deepseek-chat',
  anthropic: 'claude-sonnet-4-20250514',
  dashscope: 'qwen-plus',
  zhipu: 'glm-4',
  moonshot: 'moonshot-v1-8k',
  siliconflow: 'deepseek-ai/DeepSeek-V3',
};

/** Provider 默认 Base URL 映射 */
const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  moonshot: 'https://api.moonshot.cn/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
};

// ─── localStorage 键 ────────────────────────────────────

/** 标记引导是否已完成（老用户跳过） */
const ONBOARDING_SEEN_KEY = 'memora-onboarding-seen';

// ─── OnboardingManager ──────────────────────────────────

/**
 * 多步骤引导管理器
 *
 * 独立管理四步引导向导的显示、步骤切换、API Key 保存和进度持久化。
 * UIManager 通过组合持有。
 */
export class OnboardingManager {
  /** 当前步骤（1-4） */
  private currentStep = 1;
  /** 是否已关闭（防止重复关闭） */
  private closed = false;
  /** 用户是否已跳过 API Key 配置 */
  private skippedApiKey = false;

  /**
   * 检查是否需要显示引导
   *
   * 检查逻辑：
   * 1. localStorage 标记已见过 → 跳过
   * 2. 已有 Provider 配置 → 跳过（已配置用户）
   *
   * @param hasProviders 是否已有 Provider 配置
   */
  shouldShowOnboarding(hasProviders: boolean): boolean {
    // 已标记过引导 → 不再显示
    if (localStorage.getItem(ONBOARDING_SEEN_KEY) === '1') return false;
    // 已有 Provider 配置 → 跳过引导
    if (hasProviders) return false;
    return true;
  }

  /**
   * 显示多步骤引导向导
   *
   * 绑定步骤导航、API Key 保存、完成收尾等事件。
   */
  showOnboardingDialog(): void {
    const modal = document.getElementById('onboarding-modal');
    if (!modal) return;

    this.closed = false;
    this.currentStep = 1;
    this.skippedApiKey = false;

    // 绑定关闭处理
    this.bindClose(modal);
    // 绑定步骤导航
    this.bindStepNavigation(modal);
    // 绑定 API Key 保存
    this.bindApiKeySave(modal);
    // 绑定隐私统计选择（AUDIT-5-4）
    this.bindPrivacyChoice(modal);
    // 绑定完成按钮
    this.bindDone(modal);
    // 绑定 Provider 选择变化（更新注册链接）
    this.bindProviderSelect(modal);
    // 初始化注册链接
    this.updateSignupLink(modal);

    // 显示第一步
    this.showStep(modal, 1);

    // 显示弹窗
    modal.classList.remove('hidden');
  }

  // ─── 关闭处理 ──────────────────────────────────────

  /**
   * 标记引导已完成并关闭弹窗
   */
  private markSeen(): void {
    localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
  }

  /**
   * 关闭弹窗
   */
  private closeModal(modal: HTMLElement): void {
    if (this.closed) return;
    this.closed = true;
    this.markSeen();
    modal.classList.add('hidden');
  }

  /**
   * 绑定关闭事件（Esc 键 + 点击遮罩）
   */
  private bindClose(modal: HTMLElement): void {
    // Esc 键关闭
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.closeModal(modal);
    };
    document.addEventListener('keydown', onKey, { once: false });

    // 点击遮罩关闭
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === modal) this.closeModal(modal);
    };
    modal.addEventListener('click', onBackdrop);

    // 清理：关闭时移除事件监听
    const cleanup = () => {
      document.removeEventListener('keydown', onKey);
      modal.removeEventListener('click', onBackdrop);
    };
    // 利用 MutationObserver 或直接在 closeModal 后清理
    // 使用 once 的 animationend 或直接在关闭时清理
    const doneBtn = modal.querySelector('#btn-onboarding-done');
    if (doneBtn) {
      doneBtn.addEventListener('click', cleanup, { once: true });
    }
  }

  // ─── 步骤导航 ──────────────────────────────────────

  /**
   * 绑定步骤导航按钮事件
   */
  private bindStepNavigation(modal: HTMLElement): void {
    // 下一步按钮
    modal.querySelectorAll('.onboarding-next').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = parseInt(btn.getAttribute('data-next') || '2', 10);
        this.showStep(modal, next);
      });
    });

    // 上一步按钮
    modal.querySelectorAll('.onboarding-prev').forEach((btn) => {
      btn.addEventListener('click', () => {
        const prev = parseInt(btn.getAttribute('data-prev') || '1', 10);
        this.showStep(modal, prev);
      });
    });

    // 跳过按钮
    modal.querySelectorAll('.onboarding-skip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const skipTo = parseInt(btn.getAttribute('data-skip') || '4', 10);
        if (skipTo === 4 && this.currentStep === 2) {
          this.skippedApiKey = true;
        }
        this.showStep(modal, skipTo);
      });
    });
  }

  /**
   * 切换到指定步骤
   */
  private showStep(modal: HTMLElement, step: number): void {
    this.currentStep = step;

    // 更新步骤内容显隐
    modal.querySelectorAll('.onboarding-step-content').forEach((el) => {
      const elStep = parseInt((el as HTMLElement).dataset.step || '0', 10);
      el.classList.toggle('active', elStep === step);
    });

    // 更新步骤指示器圆点
    modal.querySelectorAll('.onboarding-step-dot').forEach((el) => {
      const elStep = parseInt((el as HTMLElement).dataset.step || '0', 10);
      el.classList.toggle('active', elStep === step);
      el.classList.toggle('done', elStep < step);
    });

    // 更新步骤指示器连线
    modal.querySelectorAll('.onboarding-step-line').forEach((el, index) => {
      el.classList.toggle('done', index + 1 < step);
    });

    // 步骤 4：更新完成消息
    if (step === 4) {
      const msgEl = modal.querySelector('#onboarding-done-message');
      if (msgEl) {
        msgEl.textContent = this.skippedApiKey
          ? '你可以稍后在设置面板中配置 AI 服务。现在开始对话吧。'
          : 'AI 服务已配置，开始你的第一段对话吧。';
      }
    }
  }

  // ─── API Key 保存 ──────────────────────────────────

  /**
   * 绑定 API Key 保存按钮事件
   */
  private bindApiKeySave(modal: HTMLElement): void {
    const saveBtn = modal.querySelector('#btn-onboarding-save-key');
    if (!(saveBtn instanceof HTMLButtonElement)) {
      reportError('Onboarding btn-onboarding-save-key 元素缺失', new Error('HTMLButtonElement 校验失败'));
      return;
    }

    saveBtn.addEventListener('click', async () => {
      // 引导弹窗模板静态元素，modal 已确认存在，用 ! 断言正视契约
      const providerSelect = modal.querySelector('#onboarding-provider-type')! as HTMLSelectElement;
      const apiKeyInput = modal.querySelector('#onboarding-api-key')! as HTMLInputElement;

      const providerType = providerSelect.value;
      const apiKey = apiKeyInput.value.trim();

      // 清空上次的错误状态（aria-invalid + 错误文本）
      clearFieldErrors(['onboarding-api-key']);

      // 校验：空值通过公共 showFieldError 标记 aria-invalid + 显示错误文本
      if (!apiKey) {
        showFieldError('onboarding-api-key', '请输入 API Key');
        return;
      }

      // 禁用按钮，显示加载状态
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';

      try {
        // 自动填充默认值和模型
        const alias = providerType === 'custom' ? 'custom' : providerType;
        const model = PROVIDER_DEFAULT_MODELS[providerType] || '';
        const baseUrl = PROVIDER_BASE_URLS[providerType] || '';

        // 通过 IPC 保存 Provider（使用 saveLlmProvider API）
        const result = await window.electronAPI.saveLlmProvider(alias, {
          provider: providerType,
          model,
          baseUrl,
          apiKey,
          temperature: 0.7,
        });

        if (!result.success) {
          throw new Error(result.error || '保存失败');
        }

        this.skippedApiKey = false;
        // 前进到步骤 3
        this.showStep(modal, 3);
      } catch (err) {
        // 保存失败通过公共 showFieldError 显示错误（含 aria-invalid 语义）
        showFieldError('onboarding-api-key', `保存失败：${err instanceof Error ? err.message : '未知错误'}`);
        saveBtn.disabled = false;
        saveBtn.textContent = '保存并继续';
      }
    });

    // Enter 键提交（复用上面已校验的 apiKeyInput，这里用 ! 断言）
    const apiKeyInputEnter = modal.querySelector('#onboarding-api-key')! as HTMLInputElement;
    apiKeyInputEnter.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') saveBtn.click();
    });
  }

  // ─── Provider 选择 ─────────────────────────────────

  /**
   * 绑定 Provider 下拉选择变化事件
   *
   * 切换 Provider 时更新注册链接和输入框提示。
   */
  private bindProviderSelect(modal: HTMLElement): void {
    const select = modal.querySelector('#onboarding-provider-type');
    if (!(select instanceof HTMLSelectElement)) {
      reportError('Onboarding onboarding-provider-type 元素缺失', new Error('HTMLSelectElement 校验失败'));
      return;
    }

    select.addEventListener('change', () => {
      this.updateSignupLink(modal);
    });
  }

  /**
   * 更新注册链接的 href 和文本
   */
  private updateSignupLink(modal: HTMLElement): void {
    // 引导弹窗模板静态元素，modal 已确认存在，用 ! 断言正视契约
    const select = modal.querySelector('#onboarding-provider-type')! as HTMLSelectElement;
    const link = modal.querySelector('#onboarding-signup-link')! as HTMLAnchorElement;

    const providerType = select.value;
    const url = PROVIDER_SIGNUP_URLS[providerType];

    if (url) {
      link.href = url;
      link.textContent = '获取 API Key →';
      link.classList.remove('hidden');
    } else {
      link.classList.add('hidden');
    }
  }

  // ─── 隐私统计选择（AUDIT-5-4） ──────────────────────

  /**
   * 绑定隐私统计选择（步骤 3）
   *
   * 用户在步骤 3 选择是否开启使用统计。
   * 选择结果通过 getUsageStatsChoice() 在完成时读取并持久化。
   */
  private bindPrivacyChoice(modal: HTMLElement): void {
    const checkbox = modal.querySelector('#onboarding-usage-stats');
    if (!(checkbox instanceof HTMLInputElement)) {
      reportError('Onboarding onboarding-usage-stats 元素缺失', new Error('HTMLInputElement 校验失败'));
      return;
    }
    // change 事件即时反馈（具体值在完成时读取）
    checkbox.addEventListener('change', () => {
      // 静默更新，具体值在 bindDone 完成时读取
    });
  }

  /** 获取隐私统计选择结果（完成时调用） */
  getUsageStatsChoice(): boolean {
    const checkbox = document.querySelector('#onboarding-usage-stats');
    if (checkbox instanceof HTMLInputElement) {
      return checkbox.checked;
    }
    return false;
  }

  // ─── 完成 ──────────────────────────────────────────

  /**
   * 绑定完成按钮事件
   *
   * 完成时读取隐私统计选择并通过 config-update-batch IPC 持久化（AUDIT-5-4）。
   */
  private bindDone(modal: HTMLElement): void {
    const doneBtn = modal.querySelector('#btn-onboarding-done');
    if (!(doneBtn instanceof HTMLButtonElement)) {
      reportError('Onboarding btn-onboarding-done 元素缺失', new Error('HTMLButtonElement 校验失败'));
      return;
    }

    doneBtn.addEventListener('click', () => {
      // AUDIT-5-4：持久化使用统计选择（fire-and-forget，不阻塞关闭）
      const usageStatsEnabled = this.getUsageStatsChoice();
      window.electronAPI.updateConfigBatch({ usageStatsEnabled }).catch(() => {
        // 持久化失败不阻塞引导完成，用户可在设置面板中再次切换
      });
      this.closeModal(modal);
    });
  }
}