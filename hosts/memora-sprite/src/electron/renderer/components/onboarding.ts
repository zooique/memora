/**
 * 多步骤引导模块
 *
 * 职责：
 * - 检测是否需要显示引导（未配置 Provider 的新用户）
 * - 管理四步引导向导：欢迎 → API 配置 → 隐私统计选择 → 开始使用
 * - 通用表单：用户手填 provider/model/baseUrl/apiKey 四个字段（无内置预设）
 * - 测试连接：保存前可测试配置是否可用（错误消息经 classifyLlmError 映射）
 * - 持久化使用统计选择（通过 config-update-batch IPC）
 *
 * 设计原则：
 * - 独立于 UIManager，无 this 依赖，纯 DOM + IPC 操作
 * - 显示判定基于 Provider 配置记录存在性：无配置始终显示，有配置跳过
 * - 支持跳过 API 配置步骤（降级路径）
 * - 不内置 Provider 预设：模型更迭速度快，预设易滞后，改为用户自填所有字段
 */
import { reportError } from '../helpers/errorHelpers.js';
import { showFieldError, showFieldSuccess, clearFieldErrors } from '../helpers/formValidation.js';
// 跨进程 LLM 错误分类器（onboarding + minimalHandlers 共用）
import { classifyLlmError } from '../../../shared/llmErrorClassifier.js';
// 确认弹窗选项类型（与 UIManager.showConfirmDialog 共享）
import type { ConfirmDialogOptions } from '../types.js';
// 结构化错误类型（替代裸 throw new Error，统一走 SpriteError 体系）
import { SpriteError, ErrorCode } from '../../../sprite/errors.js';

// ─── OnboardingManager ──────────────────────────────────

/**
 * 多步骤引导管理器
 *
 * 独立管理四步引导向导的显示、步骤切换、API 配置保存和进度持久化。
 * UIManager 通过组合持有。
 */
export class OnboardingManager {
  /** 当前步骤（1-4） */
  private currentStep = 1;
  /** 是否已关闭（防止重复关闭） */
  private closed = false;
  /** 用户是否已跳过 API 配置 */
  private skippedApiKey = false;
  /** 用户是否已保存 API 配置（用于 step 4 完成消息区分"已保存未就绪"与"已就绪"） */
  private savedApiKey = false;
  /** Agent 就绪状态查询函数（由 UIManager 注入，用于 step 4 完成消息感知初始化进度） */
  private agentReadyProvider: (() => boolean) | null = null;
  /** 确认弹窗函数（由 UIManager 注入，用于跳过 API 配置时弹二次确认避免误触丢失输入） */
  private confirmDialog: ((options: ConfirmDialogOptions) => Promise<boolean>) | null = null;
  /** 当前关闭处理的 cleanup 函数（ESC/遮罩/完成三路径关闭后统一清理监听器，UX-0712-8） */
  private currentCleanup: (() => void) | null = null;
  /**
   * modal 内元素监听器记录（cleanup 时统一移除）
   *
   * 追踪 bindStepNavigation / bindApiKeySave / bindTestConnection / bindPrivacyChoice / bindDone
   * 中通过 addTrackedListener 注册的监听器。bindClose 中的 document 级监听器由 currentCleanup 单独处理
   * （因其关闭即清理的语义与 modal 内监听器不同）。
   */
  private listeners: Array<{
    target: EventTarget;
    type: string;
    listener: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }> = [];

  /**
   * 注入 Agent 就绪状态查询函数
   *
   * 由 UIManager 在构造后调用，使 OnboardingManager 能在 step 4 完成消息中
   * 感知 Agent 初始化进度（保存 API 后 reinitAgent 是异步 1-3s）。
   *
   * @param fn 返回当前 Agent 是否就绪的查询函数
   */
  setAgentReadyProvider(fn: () => boolean): void {
    this.agentReadyProvider = fn;
  }

  /**
   * 注入确认弹窗函数
   *
   * 由 UIManager 在构造后调用，使 OnboardingManager 能在步骤 2 跳过且用户已填写字段时
   * 弹出二次确认对话框，避免误触跳过导致已输入内容丢失。
   *
   * @param fn UIManager.showConfirmDialog 的引用
   */
  setConfirmDialog(fn: (options: ConfirmDialogOptions) => Promise<boolean>): void {
    this.confirmDialog = fn;
  }

  // ─── 资源清理 ──────────────────────────────────────

  /**
   * 注册监听器并记录到 listeners 数组
   *
   * 替代裸 addEventListener，确保 manager 销毁或弹窗关闭时所有监听器被统一移除。
   * 与 EventTracker 设计思路一致（OnboardingManager 独立于 UIManager，未注入 EventTracker，
   * 故自建轻量追踪机制）。
   *
   * 泛型 E 默认为 Event，调用方传 `(e: KeyboardEvent) => void` 时自动推断为 KeyboardEvent，
   * 避免 strict 模式下函数参数逆变报错。
   */
  private addTrackedListener<E extends Event = Event>(
    target: EventTarget,
    type: string,
    listener: (e: E) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener as EventListener, options);
    this.listeners.push({
      target,
      type,
      listener: listener as EventListener,
      options,
    });
  }

  /**
   * 清空所有已追踪的 modal 内监听器
   *
   * 在 closeModal 中调用（关闭即清理，防止重复 showOnboardingDialog 时监听器累积）。
   * bindClose 中的 document 级监听器由 currentCleanup 单独处理（保留原有 UX-0712-8 修复逻辑）。
   */
  private clearTrackedListeners(): void {
    for (const record of this.listeners) {
      record.target.removeEventListener(record.type, record.listener, record.options);
    }
    this.listeners = [];
  }

  /**
   * 销毁 OnboardingManager，清理所有监听器与注入引用
   *
   * 由 UIManager 在卸载引导模块时调用。与 closeModal 的区别：
   * - closeModal：仅清理监听器，保留注入引用（modal 可能再次打开）
   * - cleanup：清理监听器 + 重置注入引用 + 标记已关闭（manager 不再使用）
   */
  cleanup(): void {
    this.clearTrackedListeners();
    this.currentCleanup?.();
    this.currentCleanup = null;
    this.agentReadyProvider = null;
    this.confirmDialog = null;
    this.closed = true;
  }

  /**
   * 检查是否需要显示引导
   *
   * 判定逻辑：
   * - 仅基于 Provider 配置记录存在性决定
   * - 无 Provider 配置 → 显示引导（即便用户上次跳过，下次启动仍会显示）
   * - 有 Provider 配置 → 跳过引导
   *
   * 理由：Provider 列表是主进程的真理源，状态真理源唯一。
   * localStorage 标记易与实际状态不一致（如用户跳过引导后未配置、或配置后又被删除），
   * 导致引导该显示时不显示、不该显示时又弹出。
   *
   * @param hasProviders 是否已有 Provider 配置
   */
  shouldShowOnboarding(hasProviders: boolean): boolean {
    // 已有 Provider 配置 → 跳过引导
    if (hasProviders) return false;
    return true;
  }

  /**
   * 显示多步骤引导向导
   *
   * 绑定步骤导航、API 配置保存、测试连接、完成收尾等事件。
   */
  showOnboardingDialog(): void {
    const modal = document.getElementById('onboarding-modal');
    if (!modal) return;

    this.closed = false;
    this.currentStep = 1;
    this.skippedApiKey = false;
    // 重置保存标志（每次打开引导时清空，避免上次状态残留）
    this.savedApiKey = false;

    // 绑定关闭处理
    this.bindClose(modal);
    // 绑定步骤导航
    this.bindStepNavigation(modal);
    // 绑定 API 配置保存
    this.bindApiKeySave(modal);
    // 绑定测试连接按钮
    this.bindTestConnection(modal);
    // 绑定隐私统计选择
    this.bindPrivacyChoice(modal);
    // 绑定完成按钮
    this.bindDone(modal);

    // 显示第一步
    this.showStep(modal, 1);

    // 显示弹窗
    modal.classList.remove('hidden');
  }

  // ─── 关闭处理 ──────────────────────────────────────

  /**
   * 关闭弹窗
   *
   * 三条关闭路径（ESC/遮罩/完成按钮）统一在此清理监听器，避免 ESC 重复触发（UX-0712-8）。
   *
   * 引导显示由 Provider 配置记录决定，而非"是否见过引导"。用户跳过引导后未配置
   * Provider 时，下次启动仍会显示。
   */
  private closeModal(modal: HTMLElement): void {
    if (this.closed) return;
    this.closed = true;
    modal.classList.add('hidden');
    // 清理 modal 内监听器（btn click / input keydown / checkbox change 等）
    this.clearTrackedListeners();
    // 清理 document 级监听器（keydown + click），防止 listener 累积泄漏
    this.currentCleanup?.();
    this.currentCleanup = null;
  }

  /**
   * 绑定关闭事件（Esc 键 + 点击遮罩）
   *
   * 步骤 2 已填字段时弹二次确认，避免用户误触 ESC/遮罩丢失已输入的 API 配置。
   * 完成按钮路径不走此逻辑（用户已主动完成，无需二次确认）。
   */
  private bindClose(modal: HTMLElement): void {
    // Esc 键关闭（步骤 2 已填字段时弹二次确认）
    const onKey = async (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (this.currentStep === 2 && this.hasFilledApiFields(modal)) {
        const confirmed = await this.confirmDialog?.({
          title: '关闭引导',
          message: '你已填写部分字段，关闭后这些信息将不会保存。确认关闭吗？',
          confirmText: '关闭',
          cancelText: '继续配置',
        }) ?? true;
        if (!confirmed) return;
      }
      this.closeModal(modal);
    };
    document.addEventListener('keydown', onKey, { once: false });

    // 点击遮罩关闭（步骤 2 已填字段时弹二次确认）
    const onBackdrop = async (e: MouseEvent) => {
      if (e.target !== modal) return;
      if (this.currentStep === 2 && this.hasFilledApiFields(modal)) {
        const confirmed = await this.confirmDialog?.({
          title: '关闭引导',
          message: '你已填写部分字段，关闭后这些信息将不会保存。确认关闭吗？',
          confirmText: '关闭',
          cancelText: '继续配置',
        }) ?? true;
        if (!confirmed) return;
      }
      this.closeModal(modal);
    };
    modal.addEventListener('click', onBackdrop);

    // 清理：closeModal 统一调用，确保 ESC/遮罩/完成三路径都触发清理（UX-0712-8）
    this.currentCleanup = () => {
      document.removeEventListener('keydown', onKey);
      modal.removeEventListener('click', onBackdrop);
    };
  }

  // ─── 步骤导航 ──────────────────────────────────────

  /**
   * 绑定步骤导航按钮事件
   */
  private bindStepNavigation(modal: HTMLElement): void {
    // 下一步按钮
    modal.querySelectorAll('.onboarding-next').forEach((btn) => {
      this.addTrackedListener(btn, 'click', () => {
        const next = parseInt(btn.getAttribute('data-next') || '2', 10);
        this.showStep(modal, next);
      });
    });

    // 上一步按钮
    modal.querySelectorAll('.onboarding-prev').forEach((btn) => {
      this.addTrackedListener(btn, 'click', () => {
        const prev = parseInt(btn.getAttribute('data-prev') || '1', 10);
        this.showStep(modal, prev);
      });
    });

    // 跳过按钮（步骤 2 已填字段时弹二次确认，避免误触丢失输入）
    modal.querySelectorAll('.onboarding-skip').forEach((btn) => {
      this.addTrackedListener(btn, 'click', async () => {
        const skipTo = parseInt(btn.getAttribute('data-skip') || '4', 10);
        // 仅在步骤 2 跳过且用户已填写任一字段时弹确认
        if (this.currentStep === 2 && this.hasFilledApiFields(modal)) {
          const confirmed = await this.confirmDialog?.({
            title: '跳过 API 配置',
            message: '你已填写部分字段，跳过后这些信息将不会保存。确认跳过吗？',
            confirmText: '跳过',
            cancelText: '继续配置',
          }) ?? true;
          if (!confirmed) return;
        }
        if (skipTo === 4 && this.currentStep === 2) {
          this.skippedApiKey = true;
        }
        this.showStep(modal, skipTo);
      });
    });
  }

  /**
   * 检测步骤 2 表单是否已填写任一字段
   *
   * 用于跳过按钮的确认弹窗触发判定，避免用户误触跳过丢失已输入内容。
   * 仅检查非空字符串，不校验字段合法性。
   */
  private hasFilledApiFields(modal: HTMLElement): boolean {
    const { provider, model, baseUrl, apiKey } = this.readApiForm(modal);
    return provider !== '' || model !== '' || baseUrl !== '' || apiKey !== '';
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
      // aria-current="step" 仅标记当前步骤，辅助屏幕阅读器定位进度
      if (elStep === step) {
        (el as HTMLElement).setAttribute('aria-current', 'step');
      } else {
        (el as HTMLElement).removeAttribute('aria-current');
      }
    });

    // 更新步骤指示器连线
    modal.querySelectorAll('.onboarding-step-line').forEach((el, index) => {
      el.classList.toggle('done', index + 1 < step);
    });

    // 步骤 4：根据 Agent 状态动态显示完成消息
    // reinitAgent 是异步的（1-3s），用户到达 step 4 时 Agent 可能仍未就绪
    if (step === 4) {
      const msgEl = modal.querySelector('#onboarding-done-message');
      if (msgEl) {
        const isReady = this.agentReadyProvider?.() ?? false;
        if (this.skippedApiKey) {
          // 跳过 API 配置：引导用户稍后在设置面板配置
          msgEl.textContent = '你可以稍后在设置面板中配置 AI 服务。现在开始对话吧。';
        } else if (this.savedApiKey && isReady) {
          // 已保存且 Agent 已就绪：用户可立即开始对话
          msgEl.textContent = 'AI 服务已配置，开始你的第一段对话吧。';
        } else if (this.savedApiKey) {
          // 已保存但 Agent 仍在初始化中：让用户知道需要稍候
          msgEl.textContent = 'AI 服务已保存，正在初始化中，请稍候片刻再开始对话。';
        } else {
          // 未保存也未跳过（从步骤 1 直接跳过等边界场景）：引导用户稍后配置
          msgEl.textContent = '你可以稍后在设置面板中配置 AI 服务。现在开始对话吧。';
        }
      }
    }
  }

  // ─── API 配置表单读取 + 校验 ──────────────────────

  /**
   * Onboarding 表单字段 id 列表（用于 clearFieldErrors 批量清空）
   */
  private static readonly FORM_FIELD_IDS = [
    'onboarding-provider',
    'onboarding-model',
    'onboarding-base-url',
    'onboarding-api-key',
  ] as const;

  /**
   * 从表单读取 API 配置
   *
   * @param modal 引导弹窗根元素
   * @returns 表单数据（未校验，可能含空字符串）
   */
  private readApiForm(modal: HTMLElement): {
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
  } {
    // 引导弹窗模板静态元素，modal 已确认存在，用 ! 断言正视契约
    const provider = (modal.querySelector('#onboarding-provider') as HTMLInputElement).value.trim();
    const model = (modal.querySelector('#onboarding-model') as HTMLInputElement).value.trim();
    const baseUrl = (modal.querySelector('#onboarding-base-url') as HTMLInputElement).value.trim();
    const apiKey = (modal.querySelector('#onboarding-api-key') as HTMLInputElement).value.trim();
    return { provider, model, baseUrl, apiKey };
  }

  /**
   * 校验 API 配置表单：必填字段非空
   *
   * 校验规则：provider / model / apiKey 必填，baseUrl 可空（部分 Provider 允许）
   *
   * @param data 表单数据
   * @returns true 通过校验 / false 校验失败（已标记错误字段）
   */
  private validateApiForm(data: { provider: string; model: string; baseUrl: string; apiKey: string }): boolean {
    // 清空上次的错误状态
    clearFieldErrors([...OnboardingManager.FORM_FIELD_IDS]);

    // 逐字段校验：必填字段为空时标记错误
    let firstErrorField: HTMLElement | null = null;
    if (!data.provider) {
      firstErrorField = showFieldError('onboarding-provider', '请填写提供商');
    }
    if (!data.model) {
      firstErrorField ??= showFieldError('onboarding-model', '请填写模型');
    }
    if (!data.apiKey) {
      firstErrorField ??= showFieldError('onboarding-api-key', '请填写 API Key');
    }
    if (firstErrorField) {
      firstErrorField.focus();
      return false;
    }
    return true;
  }

  // ─── 测试连接 ──────────────────────────────────────

  /**
   * 绑定测试连接按钮事件
   *
   * 复用 LLM_CONFIG_TEST IPC 通道，错误消息经 classifyLlmError 映射为中文友好提示。
   * 测试期间禁用按钮防止重复点击。
   */
  private bindTestConnection(modal: HTMLElement): void {
    const testBtn = modal.querySelector('#btn-onboarding-test');
    if (!(testBtn instanceof HTMLButtonElement)) {
      reportError('Onboarding btn-onboarding-test 元素缺失', new Error('HTMLButtonElement 校验失败'));
      return;
    }

    this.addTrackedListener(testBtn, 'click', async () => {
      const data = this.readApiForm(modal);
      // 测试连接前先校验必填字段（与保存一致）
      if (!this.validateApiForm(data)) return;

      // 禁用按钮 + 显示测试中状态
      const originalText = testBtn.textContent;
      testBtn.disabled = true;
      testBtn.textContent = '测试中...';

      try {
        const result = await window.electronAPI.testLlmConfig({
          provider: data.provider,
          model: data.model,
          baseUrl: data.baseUrl,
          apiKey: data.apiKey,
        });

        if (result.success) {
          // 成功提示：使用 showFieldSuccess 切换为绿色视觉，避免复用红色错误容器
          showFieldSuccess('onboarding-api-key', '✓ 连接成功');
        } else {
          // 失败：错误消息已是 classifyLlmError 映射后的友好提示
          showFieldError('onboarding-api-key', result.error ?? '连接失败');
        }
      } catch (err) {
        // 异常兜底：未知错误也过分类器（可能匹配到通用网络错误）
        const rawMsg = err instanceof Error ? err.message : '未知错误';
        showFieldError('onboarding-api-key', classifyLlmError(rawMsg));
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = originalText;
      }
    });
  }

  // ─── API 配置保存 ──────────────────────────────────

  /**
   * 绑定 API 配置保存按钮事件
   *
   * 保存成功后：标记 savedApiKey、给用户视觉反馈（按钮文字临时改为"已保存 ✓"）、
   * 前进到步骤 3。reinitAgent 是异步的，Agent 就绪状态由 step 4 完成消息感知。
   * 首次添加 Provider 时 alias 固定为 'default'，用户可在设置面板中后续添加更多。
   */
  private bindApiKeySave(modal: HTMLElement): void {
    const saveBtn = modal.querySelector('#btn-onboarding-save-key');
    if (!(saveBtn instanceof HTMLButtonElement)) {
      reportError('Onboarding btn-onboarding-save-key 元素缺失', new Error('HTMLButtonElement 校验失败'));
      return;
    }

    this.addTrackedListener(saveBtn, 'click', async () => {
      const data = this.readApiForm(modal);
      // 清空上次的错误状态
      clearFieldErrors([...OnboardingManager.FORM_FIELD_IDS]);

      // 校验必填字段
      if (!this.validateApiForm(data)) return;

      // 禁用按钮，显示加载状态
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';

      try {
        // 首次配置：alias 固定为 'default'，作为用户的首个 Provider
        // saveLlmProvider 首次添加会自动设为 active，触发 reinitAgent
        const result = await window.electronAPI.saveLlmProvider('default', {
          provider: data.provider,
          model: data.model,
          baseUrl: data.baseUrl,
          apiKey: data.apiKey,
          temperature: 0.7,
        });

        if (!result.success) {
          // 使用 SpriteError 体系（携带 STORAGE_ERROR 错误码，便于 errorHandler 分类）
          throw new SpriteError(ErrorCode.STORAGE_ERROR, result.error || '保存失败');
        }

        this.skippedApiKey = false;
        // 标记已保存，供 step 4 完成消息区分"已保存未就绪"与"已就绪"
        this.savedApiKey = true;
        // 恢复按钮文字（保存成功视觉反馈由 step 4 完成消息承载，无需在 step 2 延迟）
        saveBtn.textContent = '保存并继续';
        // 前进到步骤 3（reinitAgent 在后台并行初始化，Agent 就绪状态由 step 4 完成消息感知）
        this.showStep(modal, 3);
      } catch (err) {
        // 保存失败：错误消息已是 classifyLlmError 映射后的友好提示
        // 但 saveLlmProvider 返回的 error 可能是 reinit 失败的原始消息，再过一次分类器
        const rawMsg = err instanceof Error ? err.message : '未知错误';
        showFieldError('onboarding-api-key', classifyLlmError(rawMsg));
        saveBtn.disabled = false;
        saveBtn.textContent = '保存并继续';
      }
    });

    // Enter 键提交（在 apiKey 输入框内按 Enter 触发保存）
    const apiKeyInput = modal.querySelector('#onboarding-api-key');
    if (apiKeyInput instanceof HTMLInputElement) {
      this.addTrackedListener(apiKeyInput, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') saveBtn.click();
      });
    }
  }

  // ─── 隐私统计选择 ──────────────────────

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
    this.addTrackedListener(checkbox, 'change', () => {
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
   * 完成时读取隐私统计选择并通过 config-update-batch IPC 持久化。
   */
  private bindDone(modal: HTMLElement): void {
    const doneBtn = modal.querySelector('#btn-onboarding-done');
    if (!(doneBtn instanceof HTMLButtonElement)) {
      reportError('Onboarding btn-onboarding-done 元素缺失', new Error('HTMLButtonElement 校验失败'));
      return;
    }

    this.addTrackedListener(doneBtn, 'click', () => {
      // 持久化使用统计选择（fire-and-forget，不阻塞关闭）
      const usageStatsEnabled = this.getUsageStatsChoice();
      // 跳过路径（未配置 API）：config-update-batch handler 未注册（在 setupAgentReady 中才注册），
      // 跳过 IPC 调用避免 "No handler registered" 错误日志。
      // 已配置路径：reinitAgent 触发 setupAgentReady 注册 handler，
      // 即使 Agent 尚未就绪，handler 已注册，IPC 调用可正常执行。
      if (!this.skippedApiKey) {
        window.electronAPI.updateConfigBatch({ usageStatsEnabled }).catch(() => {
          // 持久化失败不阻塞引导完成，用户可在设置面板中再次切换
        });
      }
      this.closeModal(modal);
    });
  }
}
