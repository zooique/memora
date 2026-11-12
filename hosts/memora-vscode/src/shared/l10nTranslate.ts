/**
 * 零依赖翻译器契约 —— 「英文源键 + 实参 → 当前语言文案」
 *
 * ## 为什么需要它（而不是各处直接 `vscode.l10n.t`）
 * 零 vscode 依赖模块（`extension/host/imageIngest.ts` / `imagePick.ts` / `memoryStorage.ts`）
 * 的前提是**不 import `vscode`**——它们能在 vitest 里拿真实临时目录完整机测，靠的就是这条。
 * 这些模块产出的却是用户可见文案 ⇒ 只能由宿主入口**注入**翻译器（生产 = `vscode.l10n.t`）。
 *
 * 契约放 `shared/` ⇒ 宿主侧、零依赖模块侧与测试侧对「`t` 长什么样」只有一份定义，
 * 不会各自写一个形似的函数类型而漂移。
 *
 * ## 缺省实现为什么必须插值
 * 没有译文表时期望的行为是「英文源键 + 实参按 `{n}` 替换」（位置参数与 `{n}` 插值与
 * `vscode.l10n.t` 同形；本契约不支持命名参数）。
 * 若缺省只做恒等，测试与「未装语言包」两种情形看到的都是带占位符的半成品
 * （2026-11-10 实锤：`Image validation failed: {0}` 直接进了断言与回执）。
 */

/** 翻译器：第一参是英文源键，其余是插值实参（`{0}` `{1}` …） */
export type Translate = (key: string, ...args: string[]) => string;

/** 缺省翻译器：按 `{n}` 替换实参；缺参时**保留占位符**（比静默丢字更可诊断） */
export const identityTranslate: Translate = (key, ...args) =>
  key.replace(/\{(\d+)\}/g, (match, index) => args[Number(index)] ?? match);
