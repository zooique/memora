/**
 * 流式错误 category → 用户可见文案（webview 重放路映射；**单一真理源**）
 *
 * 消费面（2026-11-09 起）：webview 侧 `processFlowModel`（中断轮平铺停止行，含失败原因）。
 * 宿主实时路（chatPanel 窗口提示）已改走 `host/windowNotices.ts` 的 `flowError`
 * （`vscode.l10n` 本地化渲染）——webview 无法调 `vscode.l10n`，故两份映射并存是切片 4
 * 前的过渡形态（category 联合类型锁两侧不漂移，统一收口归切片 4，见台账 HOST-I18N-2）。
 *
 * 未收录的 category（如 'unknown'）**回退原始 message** —— 与收口前 `chatPanel` 的既有行为逐字等价
 * （不改既有错误展示：保留技术细节供排查，不做二次加工）。
 *
 * **本地化形态（B9-E-4 起）**：本文件只被 webview 消费 ⇒ 用 `@vscode/l10n` 的 `l10n.t`。
 * 文案**必须在调用时取**，不能建模块级「category → 译文」常量表：模块加载早于语言包就绪，
 * 顶层求值会把默认语言写死；且键面守卫 ⑨⑫ 认的是静态 `t('键')` 字面量。
 */
import * as l10n from '@vscode/l10n';
import type { LlmErrorCategory } from '@zooique/memora';

/**
 * 取错误展示文案。
 *
 * @param category 内核判定的结构化分类（缺省 = 普通错误 / 旧数据）
 * @param rawMessage 内核原始 message（回退用）
 * @returns 友好文案；无对应映射时返回 rawMessage
 */
export function friendlyErrorMessage(
  category: LlmErrorCategory | undefined,
  rawMessage: string,
): string {
  switch (category) {
    case 'connection':
      return l10n.t(
        'The conversation connection was interrupted and part of the answer was kept; check your network and try again',
      );
    case 'timeout':
      return l10n.t('The conversation timed out; please try again later');
    default:
      return rawMessage;
  }
}
