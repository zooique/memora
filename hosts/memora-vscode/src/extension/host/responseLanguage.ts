/**
 * 回答语言指令 — 把「界面语言 + 用户自定义」收敛成注入 system prompt 的一行指令
 *
 * 语言判定唯一在本函数（不散落），两级优先级：
 *   ① 用户在 `memora.answerLanguage` 显式填了语言 ⇒ **硬指定**，不让位；
 *   ② 未填（空 / `auto`）⇒ 按 VS Code 显示语言（`vscode.env.language`）**软默认**，
 *      并显式让位给用户当轮使用的语言。
 *
 * 为什么软默认还要带让位条款：**只靠模型自己猜用户语言不可靠**。本项目的 system prompt
 * （角色包 / 技能清单 / 项目规则 / 工具描述 / UI 消息）整体是中文，纯中文上下文会把
 * 「没表态」的输入（`ok`、贴一段英文报错、只给一个路径）拉回中文回答。故软默认 =
 * 「有锚点」+「允许让位」两件事同时写进指令；反过来只写「请用 X 回答」会把用户主动
 * 改用英文的提问也拽回 X——这正是「强制设定感」的来源。
 *
 * 与 UI 文案本地化的边界：本模块只管**模型可见的回答语言**（行为）；UI 文案走 VS Code
 * 原生 l10n（外观）。两者共用 `vscode.env.language` 一个真源，机制互不夹带。
 * ADR-042 决策 1 禁止的 `memora.language` 是 **UI 语言开关**；`memora.answerLanguage`
 * 不改任何界面文案，边界注记见该 ADR。
 *
 * 新增支持语言：在 `DIRECTIVE_BY_LOCALE` 加一条即可（内核与 manifest 零改动）。
 */

/** 设置值里被当作「跟随显示语言」的哨兵（大小写不敏感） */
const AUTO = 'auto';

/**
 * 界面语言 → 软默认指令行。**新增语言只改这一张表**。
 *
 * 键 = 归一化（小写、去首尾空格）后的 `vscode.env.language`；值是完整一行（含列表前缀），
 * 且**必须带让位条款**（理由见文件头）。
 */
const DIRECTIVE_BY_LOCALE = {
  'zh-cn': '- 回答语言：默认使用简体中文；若用户本轮使用其他语言提问，则跟随用户的语言。',
  'zh-tw': '- 回答语言：預設使用繁體中文；若使用者本輪使用其他語言提問，則跟隨使用者的語言。',
} as const;

/** 兜底语言 = 英文（ADR-042 决策 2：默认语言文件必须是英文） */
export const FALLBACK_RESPONSE_DIRECTIVE =
  '- 回答语言：Respond in English by default; if the user writes in another language, follow the user.';

/** 回答语言的两个输入：装配期静态的显示语言 + 每轮现读的用户覆盖 */
export interface AnswerLanguageInput {
  /** VS Code 显示语言（`vscode.env.language`）；取不到按「无对应语言」处理 */
  display?: string;
  /** 用户自定义（`memora.answerLanguage`）读取器：**每次调用现读** ⇒ 改设置下一轮即生效 */
  readOverride?: () => string;
}

/**
 * 清洗用户填写的语言名：所有空白（含换行）折叠成单个空格并去首尾。
 *
 * 为什么必须折叠换行：该值原样进 system prompt，换行可伪造出新的段落标题
 * （`\n## …`），属结构注入面——设置 schema 只能提示，手改 settings.json 仍会被读到。
 * `auto`（大小写不敏感）= 明确的「跟随显示语言」意图，不是语言名。
 */
function normalizeOverride(raw: string | undefined): string {
  if (!raw) return '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned.toLowerCase() === AUTO ? '' : cleaned;
}

/**
 * 取本会话注入给模型的回答语言指令行（完整一行，含列表前缀）。
 *
 * @param input 显示语言 + 用户覆盖读取器；全缺省 ⇒ 英文软默认
 */
export function buildResponseLanguageDirective(input: AnswerLanguageInput = {}): string {
  const custom = normalizeOverride(input.readOverride?.());
  // 硬指定：用户明确填了语言就不让位，否则「我就要日语」会被一条英文提问带走
  if (custom) return `- 回答语言（用户指定，优先于界面语言）：${custom}`;
  const locale = (input.display ?? '').trim().toLowerCase();
  // Object.hasOwn 而非直接索引：避免原型链上的键（constructor / __proto__）被误判成
  // 「已支持语言」而把非字符串值塞进 prompt。边界前置，不靠上游输入可信。
  return Object.hasOwn(DIRECTIVE_BY_LOCALE, locale)
    ? DIRECTIVE_BY_LOCALE[locale as keyof typeof DIRECTIVE_BY_LOCALE]
    : FALLBACK_RESPONSE_DIRECTIVE;
}
