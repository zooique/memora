/**
 * capabilityChips — 能力面三态 → 角色卡 chip 行的渲染（`rolesView` 的薄视图外置件）
 *
 * 为什么独立成文件：能力 chip 的 DOM 构造 + 三态分支属纯渲染细节，外置让 `rolesView`
 * 回归「装配 + 交互」。
 * 注（2026-11-13 复核）：原文称「`rolesView.ts` 贴 eslint `max-lines` 上限（只降不升）」，
 * 实测 `rolesView.ts` 927 行、已低于通用上限 1000，且无专属闸——该指认已不成立，故删。
 *
 * 边界：本文件只做 DOM 构造与分支，**不判定三态**——判定唯一出口仍是
 * `capabilityState.ts` 的 `deriveCapabilityState`；文案唯一真源仍是 `capabilityLabels.ts`
 * 的 `CAPABILITY_STATE_TEXT`（与输入区能力徽章共用一份，禁止在此另写文案）。
 */
import * as l10n from '@vscode/l10n';
import type { CapabilityStateDto } from '../../shared/protocol.js';
import { CAPABILITY_STATE_TEXT } from './capabilityLabels.js';

/** 单枚 chip 的构造参数（两类 chip 只差修饰类，故共用同一循环） */
interface ChipSpec {
  /** 主文案 */
  text: string;
  /** 悬停说明 */
  title: string;
  /** 是否为「三态标记」（加 `cap-chip--state` 修饰类，与能力名 chip 视觉区分） */
  stateChip: boolean;
}

/**
 * 在 `parent` 末尾追加一行能力 chip。
 *
 * - `list` ⇒ 每个能力名一枚 chip（文本 = `label`（英文源键，当前未过 l10n），title = 原始能力名）
 * - `all` / `residentOnly` ⇒ 一枚**状态 chip**：两态文案不同。两态若共用同一文案，
 *   用户会把「未声明（全部工具）」与「显式空（仅基础工具）」读成同一件事。
 *
 * @param doc webview 文档对象（DOM 构造唯一入口；本模块不读全局 `document`）
 * @param parent 挂载容器
 * @param state host 已判定的三态
 */
export function appendCapabilityChips(
  doc: Document,
  parent: HTMLElement,
  state: CapabilityStateDto,
): void {
  /** 待渲染的 chip 规格：`list` 展开为多条（`label` 是英文源键，本渲染点当前未过 `t()`），其余两态各一条（本表值是源键，此处过 l10n） */
  const specs: ChipSpec[] =
    state.kind === 'list'
      ? state.capabilities.map((c) => ({ text: c.label, title: c.capability, stateChip: false }))
      : [
          {
            text: l10n.t(CAPABILITY_STATE_TEXT[state.kind].label),
            title: l10n.t(CAPABILITY_STATE_TEXT[state.kind].title),
            stateChip: true,
          },
        ];

  /** chip 行容器（紧凑单行） */
  const box = doc.createElement('div');
  box.className = 'cap-chips';
  for (const spec of specs) {
    const chip = doc.createElement('span');
    chip.className = spec.stateChip ? 'cap-chip cap-chip--state' : 'cap-chip';
    chip.textContent = spec.text;
    chip.title = spec.title;
    box.appendChild(chip);
  }
  parent.appendChild(box);
}
