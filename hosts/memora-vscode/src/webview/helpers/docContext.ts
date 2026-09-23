/**
 * 对话上下文信封 — 宿主注入的上下文块（技能块 / 文档块）的构造与剥离
 *
 * 说明：宿主在 handleSend 将「选中技能正文」与「当前打磨文档」作为上下文注入 chat
 * 输入，内核 appendUser 持久化的 user 消息因此带信封前缀。回放历史时应剥离全部注入
 * 块、只显示用户请求原文，与实时回显（`post({ type: 'user', text: input })` 发裸输入）
 * 保持对称。纯字符串操作、无依赖，可独立测试（阶段 A 对抗评估 P2-1：从 chatPanel.ts
 * 抽出为可测模块，固化 P1-6 修复）。
 *
 * 信封结构（写入 buildInjectedContextEnvelope ↔ 剥离 stripInjectedContextPrefix）：
 *   `{块1}\n\n{块2}\n\n用户请求：{input}`；无任何块时**不加信封**，原样为 `{input}`。
 */

/** 文档上下文块开标签 */
export const DOC_CONTEXT_OPEN = '[当前打磨文档内容]';

/** 文档上下文块闭标签（剥离侧的锚点） */
export const DOC_CONTEXT_CLOSE = '[/当前打磨文档内容]';

/**
 * 技能上下文块开标签
 *
 * ⚠️ 跨侧镜像（非本文件可单方修改）：内核 SSOT = `src/skill/skillManager.ts`
 * `buildSystemPrompt`（`【当前技能】{name}\n{content}`）；宿主侧另有镜像点
 * `extension/host/skillAggregation.ts` `skillPromptFor`。webview 经 esbuild 打成
 * browser/iife 包、无法 import host 侧模块（后者依赖 vscode），故此处只能镜像。
 * 内核变更该前缀时须同步本常量（否则纯技能消息的剥离判据失效）。
 */
export const SKILL_CONTEXT_OPEN = '【当前技能】';

/**
 * 上下文信封分隔符
 *
 * 仅当存在上下文块时由 buildInjectedContextEnvelope 注入，是「宿主注入前缀」与
 * 「用户原始输入」之间唯一的分界标记；无块消息不含此串。
 */
export const USER_REQUEST_SEPARATOR = '\n\n用户请求：';

/** 构造文档上下文块（`[当前打磨文档内容]\n{doc}\n[/当前打磨文档内容]`） */
export function buildDocContextBlock(doc: string): string {
  return `${DOC_CONTEXT_OPEN}\n${doc}\n${DOC_CONTEXT_CLOSE}`;
}

/**
 * 构造带上下文信封的 user 消息 —— stripInjectedContextPrefix 的写入侧对偶
 *
 * 无任何块时返回 `input` 原文（**不注入分隔符**），保证「无上下文 = 无信封」，
 * 剥离侧因此可以安全地以分隔符为界。
 *
 * @param blocks 上下文块（如 [技能块, 文档块]），空串/undefined 被忽略
 * @param input 用户原始输入
 * @returns 注入信封后的 chatInput（无块时即 input 原文）
 */
export function buildInjectedContextEnvelope(
  blocks: readonly (string | undefined)[],
  input: string,
): string {
  const joined = blocks.filter((b): b is string => Boolean(b)).join('\n\n');
  return joined ? `${joined}${USER_REQUEST_SEPARATOR}${input}` : input;
}

/**
 * 剥离 user 消息中宿主注入的上下文前缀，还原用户请求原文（仅用于 UI 回显）
 *
 * 判据（缺一不剥）：
 *   1. 消息中确有宿主注入块 —— 含文档块开标签，或**以技能块开标签开头**
 *      （技能块恒为信封首块；普通消息即便含「用户请求：」字样也不满足此条）；
 *   2. 锚点之后存在信封分隔符。
 * 锚点：含文档块时取**开标签之后的首个闭标签**（文档正文可能自带「用户请求：」字样，
 * 必须排除在搜索区外）；技能块无闭标签，故纯技能场景自 0 起搜索。
 * 用户 input 内含「用户请求：」必然出现在注入分隔符之后，不会被误剥。
 *
 * 已知局限（非破坏性）：技能正文为载体自由撰写，若正文自身含「用户请求：」，
 * 纯技能消息会在正文处截断。实测 role-packs + bundled skills 全量 45 文件 0 命中该
 * 字样；文档块场景不受此限（有闭标签锚点）。畸形消息（有开无闭 / 无分隔符）原样返回。
 *
 * @param content 内核持久化的 user 消息原文
 * @returns 剥离前缀后的用户请求文本
 */
export function stripInjectedContextPrefix(content: string): string {
  const openIdx = content.indexOf(DOC_CONTEXT_OPEN);
  // 判据 1：无宿主注入块 → 普通消息（resume 补写 / 无上下文），原样返回
  if (openIdx < 0 && !content.startsWith(SKILL_CONTEXT_OPEN)) return content;

  let from = 0;
  if (openIdx >= 0) {
    const closeIdx = content.indexOf(DOC_CONTEXT_CLOSE, openIdx);
    if (closeIdx < 0) return content; // 有开无闭 → 畸形消息，不误剥
    from = closeIdx + DOC_CONTEXT_CLOSE.length;
  }

  // 判据 2：锚点之后无分隔符 → 无信封（如仅注入块、无用户请求），原样返回
  const idx = content.indexOf(USER_REQUEST_SEPARATOR, from);
  if (idx < 0) return content;
  return content.slice(idx + USER_REQUEST_SEPARATOR.length);
}
