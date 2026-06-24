/**
 * 三态首次引导模块
 *
 * 职责：
 * - 检测是否需要显示首次引导
 * - 显示三态窗口模型介绍弹窗（完整/浮动/托盘 + 快捷键）
 * - 用户点击"开始使用"或关闭弹窗后标记为已见过
 *
 * 设计原则：
 * - 使用 localStorage 标记，老用户不再显示，避免重复打扰
 * - 独立于 UIManager，无 this 依赖，纯 DOM + localStorage 操作
 */

/** localStorage 键名：标记是否已显示过三态引导 */
const ONBOARDING_SEEN_KEY = 'memora-onboarding-seen';

/**
 * 三态首次引导管理器
 *
 * 独立管理引导弹窗的显示和标记逻辑，UIManager 通过组合持有。
 */
export class OnboardingManager {
  /**
   * 检查是否需要显示三态首次引导
   *
   * 使用 localStorage 标记，首次使用（未标记）时返回 true。
   * 老用户（已标记）不再显示，避免重复打扰。
   */
  shouldShowOnboarding(): boolean {
    return localStorage.getItem(ONBOARDING_SEEN_KEY) !== '1';
  }

  /**
   * 显示三态首次引导弹窗
   *
   * 介绍三态窗口模型（完整/浮动/托盘）+ 快捷键。
   * 用户点击"开始使用"或关闭弹窗后标记为已见过。
   */
  showOnboardingDialog(): void {
    const modal = document.getElementById('onboarding-modal');
    const btnOk = document.getElementById('btn-onboarding-ok');
    if (!modal || !btnOk) return;

    // 标记已见过引导（无论用户点击确定还是关闭）
    const markSeen = () => {
      localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
    };

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      markSeen();
      modal.classList.add('hidden');
      btnOk.removeEventListener('click', onOk);
      modal.removeEventListener('click', onBackdrop);
      const closeBtn = modal.querySelector('.modal-close');
      if (closeBtn) closeBtn.removeEventListener('click', onClose);
    };

    const onOk = () => close();
    const onClose = () => close();
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === modal) close();
    };

    btnOk.addEventListener('click', onOk);
    modal.addEventListener('click', onBackdrop);
    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) closeBtn.addEventListener('click', onClose);

    // 显示弹窗
    modal.classList.remove('hidden');
  }
}
