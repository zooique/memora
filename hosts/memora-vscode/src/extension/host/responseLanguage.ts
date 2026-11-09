/**
 * 回答语言指令 — 宿主显示语言 → 注入 system prompt 的一行指令（HOST-I18N-LLM-1）
 *
 * 语言真源**唯一** = `vscode.env.language`（VS Code 显示语言）。本模块不是第二套语言
 * 选择器：它只把 VS Code 已经选定的 locale 翻译成一句给模型看的指令，是既有真源的
 * 一个消费者。ADR-042 决策 1 禁止自建语言开关 / 自建字典 / `memora.language` 配置，
 * 故此处不新增配置项、不缓存语言态、不提供切换入口。
 *
 * 选择规则：**用户读得懂哪种语言就给哪种，没有该语言才统一英文兜底**（需求原话：
 * 「有对应语言就同步，没有就统一英文，英文定义为兜底语言」）。故 `zh-cn` / `zh-tw`
 * 各有独立条目、各写各自的措辞——**不是**把 `zh-tw` 当成 `zh-cn` 的回落：ADR-042
 * 禁止假设语言包自动回落，UI 文案查找仍按 locale 精确匹配 `package.nls.<locale>.json`。
 * 尚未支持的语言（`ja` / `fr`…）与取不到 locale ⇒ 英文。
 *
 * 未来加日语：在 `DIRECTIVE_BY_LOCALE` 加一条 `'ja'` 即可，内核与 manifest 零改动。
 * 若要 UI 文案也显示日语，那是**另一件事**——按 ADR-042 切片 2-4 加
 * `bundle.l10n.ja.json` / `package.nls.ja.json`，与本模块互不夹带。
 *
 * ⚠️ 边界：AI 回答语言与 UI 文案本地化是两件独立的事（方案 §7）。本模块只管前者
 * （模型可见、属功能）；后者由 VS Code 原生 l10n 承担（外观）。两者共用同一个语言
 * 真源，但机制分开。
 */

/**
 * VS Code locale → 回答语言指令行。**新增语言只改这一张表**。
 *
 * 键 = `vscode.env.language` 归一化后的值（小写、去首尾空格）；值 = 完整一行文本
 * （含列表前缀），由内核 `buildEnvironmentContextBlock` 零解释转发。
 */
const DIRECTIVE_BY_LOCALE = {
  'zh-cn': '- 回答语言：请使用简体中文回答用户的问题。',
  // zh-tw 是 VS Code 自带的第二个中文语言包 ⇒ 用户界面已是繁体中文，回答必须也是中文。
  // 与 UI 文件查找的区别：回答语言只是一句自然语言指令，不需要独立翻译文件，故按
  // 「用户读得懂哪种中文」判定，不必等 `package.nls.zh-tw.json` 存在。
  'zh-tw': '- 回答语言：請使用繁體中文回答使用者的問題。',
} as const;

/** 兜底语言 = 英文（ADR-042 决策 2：默认语言文件必须是英文） */
export const FALLBACK_RESPONSE_DIRECTIVE = '- 回答语言：Please respond in English.';

/**
 * 取本会话注入给模型的回答语言指令行。
 *
 * @param envLanguage `vscode.env.language`（如 `zh-cn` / `en` / `ja`）；
 *                    取不到时按「无对应语言」处理 ⇒ 英文兜底
 */
export function buildResponseLanguageDirective(envLanguage: string | undefined): string {
  const locale = (envLanguage ?? '').trim().toLowerCase();
  // Object.hasOwn 而非直接索引：避免原型链上的键（constructor / __proto__）被误判成
  // 「已支持语言」而把非字符串值塞进 prompt。边界前置，不靠上游输入可信。
  return Object.hasOwn(DIRECTIVE_BY_LOCALE, locale)
    ? DIRECTIVE_BY_LOCALE[locale as keyof typeof DIRECTIVE_BY_LOCALE]
    : FALLBACK_RESPONSE_DIRECTIVE;
}
