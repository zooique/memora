/**
 * 渲染进程初始化辅助函数
 *
 * 从 renderer.ts 提取，减少协调器文件体积，提高可测试性。
 *
 * 职责：
 * - 静默模式定时恢复管理
 * - Agent 初始化失败错误展示
 * - 首次使用欢迎消息
 */

import type { UIManager } from './ui.js';
import type { createSettingsController } from './settingsController.js';
import { reportError } from './errorHelpers.js';

/**
 * 创建静默模式恢复定时器工厂
 *
 * 通过闭包持有 timerRef 引用，使多次调用自动清理旧定时器。
 * 用于：
 * 1. 启动时从 sprite.json 恢复静默模式到期时间
 * 2. 主动提示 banner 中用户点击"静默 1 小时"
 *
 * @param uiManager UI 管理器实例
 * @param timerRef 定时器句柄引用（模块级 mutable state）
 * @returns scheduleSilentRecovery 函数
 */
export function createSilentRecoveryScheduler(
  uiManager: UIManager,
  timerRef: { current: number | null },
): (remainingMs: number) => void {
  return (remainingMs: number) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void window.electronAPI.updateConfig('silentMode', false).then(() => {
        void window.electronAPI.updateConfig('silentModeExpiresAt', null);
        uiManager.showToast('静默模式已到期自动恢复', 'info');
      }).catch((err: unknown) => {
        reportError('silentRecovery', err);
      });
    }, remainingMs);
  };
}

/**
 * 显示 Agent 初始化失败错误
 *
 * 在对话区显示错误详情 + 在设置面板显示可重试横幅 + 自动跳转到设置面板。
 *
 * @param uiManager UI 管理器实例
 * @param settingsController 设置控制器实例（用于重新加载配置）
 * @param error 错误描述信息
 */
export function showAgentInitError(
  uiManager: UIManager,
  settingsController: ReturnType<typeof createSettingsController>,
  error: string,
): void {
  uiManager.appendMessage({
    role: 'system',
    content: `⚠️ Agent 初始化失败\n\n错误信息：${error}\n\n可能的原因：\n• better-sqlite3 原生模块未正确编译（尝试运行 npm run rebuild）\n• 数据库文件损坏（可备份后删除 ~/.memora-sprite/data/memora.db 重试）\n• LLM 配置有误（请在设置面板检查并重新保存）\n\n请在设置面板重新保存 LLM 配置以触发重新初始化。`,
  });
  uiManager.showSettingsError(
    `Agent 初始化失败：${error}。请检查配置或点击重试。`,
    async () => {
      try {
        const llmData = await window.electronAPI.getLlmConfig();
        if (llmData.config) {
          await window.electronAPI.saveLlmConfig(llmData.config);
        }
      } catch (retryErr) {
        reportError('retryInit', retryErr);
      }
    },
  );
  uiManager.switchPanel('settings');
  void settingsController.loadConfig();
}

/**
 * 显示首次使用欢迎消息
 *
 * 配置缺失或状态查询异常时降级使用，引导用户完成初始配置。
 *
 * @param uiManager UI 管理器实例
 */
export function showWelcomeMessage(uiManager: UIManager): void {
  uiManager.appendMessage({
    role: 'system',
    content: '🎉 欢迎使用 Memora Sprite！\n\n首次使用需要配置 LLM 提供商和 API Key。\n已为您打开设置面板，请填写 LLM 配置后点击「测试连接」验证配置有效，再点击「保存」即可开始对话。\n\n推荐使用 DeepSeek（性价比高）或 OpenAI GPT-4o-mini。',
  });
}