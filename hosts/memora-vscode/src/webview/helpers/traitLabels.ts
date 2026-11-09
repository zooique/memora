/**
 * 性格特征名（角色域文案的唯一定义处）
 *
 * 存在理由：同一张「特征键 → 可见名」映射原有两个消费方各自持有副本——
 * 角色管理面板（`rolesView` 的性格特征条）与对话侧角色徽章（`chatView` 的标题
 * 悬浮说明）。两处各写一份，新增特征时必漏一侧，且**没有任何测试会红**。
 *
 * 值 = 英文源键（默认 bundle 空串 ⇒ 回退键本身），消费侧经 `traitLabel()` 过 l10n；
 * 中文名只存在于 `bundle.l10n.zh-cn.json`。
 *
 * @module traitLabels
 */

import * as l10n from '@vscode/l10n';

/** 特征键 → 英文源键（键面 = 内核 persona frontmatter 的 traits 键） */
// @nls-keys
export const TRAIT_LABELS: Record<string, string> = {
  precision: 'Precision',
  creativity: 'Creativity',
  rigor: 'Rigor',
  empathy: 'Empathy',
  speed: 'Speed',
  stability: 'Stability',
  assertiveness: 'Assertiveness',
  curiosity: 'Curiosity',
};

/**
 * 特征可见名
 *
 * 未知键**原样回退**（不吞事实）：内核新增特征而本表未跟上时，界面显示原始键，
 * 用户与开发者都能看见「这里少一条译文」，而不是被替换成「未知」这类静默值。
 *
 * @param key 特征键（如 `precision`）
 */
export function traitLabel(key: string): string {
  return l10n.t(TRAIT_LABELS[key] ?? key);
}
