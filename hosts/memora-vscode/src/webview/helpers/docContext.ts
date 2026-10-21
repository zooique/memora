import type { ChatRef } from '../../shared/protocol.js';
import { formatRefRange, normalizeRefRange } from '../../shared/refKey.js';
// 信封块头的值真源 = shared/injectionSourceMeta（HOST-CTX-4 第 1 笔 SSOT 化）：曾与
// @ 下拉 label / chip 短名四处并列写字面量；此处保留导出名（剥离契约与测试的消费点），
// 值改从单点派生——改名不改值，既有调用方零改动。
import { MOUNTABLE_INJECTION_META } from '../../shared/injectionSourceMeta.js';

/**
 * 对话上下文信封 — 宿主注入的上下文块（技能块 / 文档块 / 引用块）的构造与剥离
 *
 * 说明：宿主在 handleSend 将「选中技能正文」与「当前打磨文档」作为上下文注入 chat
 * 输入，内核 appendUser 持久化的 user 消息因此带信封前缀。回放历史时应剥离全部注入
 * 块、只显示用户请求原文，与实时回显（`post({ type: 'user', text: input })` 发裸输入）
 * 保持对称。纯字符串操作、无依赖，可独立测试（从 chatPanel.ts 抽出为可测模块）。
 *
 * 信封结构（写入 buildInjectedContextEnvelope ↔ 剥离 stripInjectedContextPrefix）：
 *   `{块1}\n\n{块2}\n\n用户请求：{input}`；无任何块时**不加信封**，原样为 `{input}`。
 */

/** 文档上下文块开标签 */
export const DOC_CONTEXT_OPEN = '[当前打磨文档内容]';

/** 文档上下文块闭标签（剥离侧的锚点） */
export const DOC_CONTEXT_CLOSE = '[/当前打磨文档内容]';

/**
 * 引用上下文块开标签（右键「添加到对话」挂的文件/目录引用，仅路径、不注入内容）
 *
 * 与技能块/文档块同构进入信封：无块消息不含分隔符、回放侧以分隔符为界还原用户请求。
 * 剥离判据（stripInjectedContextPrefix）须识别本开标签，否则仅挂引用时回放会把
 * 引用块残留在用户消息里。
 */
export const REF_CONTEXT_OPEN = '[参考文件/目录]';

/** 引用上下文块闭标签 */
export const REF_CONTEXT_CLOSE = '[/参考文件/目录]';

/**
 * 诊断上下文块开标签（HOST-CTX-4 · `@problems` 有界注入）
 *
 * 值真源 = `shared/injectionSourceMeta.ts`（`MOUNTABLE_INJECTION_META.problems.envelope`），
 * 本常量是其在信封侧的派生名——保留导出名供剥离契约与测试消费，勿在此另写字面量。
 *
 * 与文档块同为「成对块」（有开有闭）⇒ 剥离侧（`stripInjectedContextPrefix`）以**闭标签**
 * 为锚点，避免块内正文（诊断消息 / 源码行可能含「用户请求：」字样）干扰分隔符搜索。
 * 判据与文档块同源，不另造一套。
 */
export const PROBLEMS_CONTEXT_OPEN = MOUNTABLE_INJECTION_META.problems.envelope.open;

/** 诊断上下文块闭标签（剥离侧锚点；值真源同开标签） */
export const PROBLEMS_CONTEXT_CLOSE = MOUNTABLE_INJECTION_META.problems.envelope.close;

/**
 * 构造诊断上下文块（`[工作区诊断]\n{body}\n[/工作区诊断]`）
 *
 * `body` 由 `problemsCollector.collectProblemsText` 在**发送时刻**产出（有界、含截断说明）。
 */
export function buildProblemsContextBlock(body: string): string {
  return `${PROBLEMS_CONTEXT_OPEN}\n${body}\n${PROBLEMS_CONTEXT_CLOSE}`;
}

/**
 * 单条引用的信封行（**引用模式**：只给指针 + 读取参数，不注入内容）
 *
 * 带行区间时把 `read_file` 的 offset/limit **算好摆出来**——模型不必自己算
 * `limit = end - start + 1`（算错即读偏）。这是引用模式能精确到行的关键：
 * 指针给准了，模型一次调用就能取到，无需把内容塞进上下文。
 *
 * 区间先经 `normalizeRefRange` 归一：非法区间（`start > end` / 非整数）降级为整文件行，
 * 绝不让 `limit` 算出 0 或负数——那种行喂给模型等于给一个「读不到东西」的指令且无报错。
 * 标签由 `formatRefRange` 单点产出（与 chip / 去重键同一格式，勿在此拼串）。
 *
 * @param missingPaths 发送前实测**已不存在**的文件引用路径集合（HOST-CTX-9 发送侧 stat，
 *   由 `collectMissingFileRefPaths` 产出）；命中即降级为裸指针 + 标记。缺省 = 不做失效标记。
 */
function refItemLine(ref: ChatRef, missingPaths?: ReadonlySet<string>): string {
  if (ref.kind === 'folder') {
    // 工具名必须是 list_dir：read_file 只读文件（内核 `read_file` 描述原文「读取项目内文件
    // 内容」），对目录给 read_file 等于给模型一条必然失败的指令。目录也不做整体注入——
    // 显式标注「按需读取」避免模型误以为全文已在上下文。
    // 目录不做失效检测（由模型经 list_dir 自行发现）。
    return `- 参考目录：${ref.path}（内容按需经 list_dir 读取）`;
  }
  // 失效引用（添加后文件已消失）：降级为**裸指针 + 标记**——把死指针变成模型可读事实。
  // 关键纪律「绝不给 read_file 一条必然失败的指令」⇒ 连行区间标签一并去掉（死文件上的
  // `#L5-L24` 与 offset/limit 同样是注定读空的精确指令）。标记仅行内追加文案，
  // 不新增标签/分隔符 ⇒ 剥离契约（stripInjectedContextPrefix 认 REF_CONTEXT_OPEN）零触碰。
  // 标记用**纯文本**而非 `⚠` 符号：本块会被剥离契约从 UI 隐藏、只喂模型，且
  // `iconLanguage` 守卫把 `⚠`(U+26A0) 列为 webview 代码内禁用的字符图标（代码内出现即红）。
  if (missingPaths?.has(ref.path)) {
    return `- 参考文件：${ref.path}（注意：添加后已不存在，请向用户确认）`;
  }
  const range = normalizeRefRange(ref.range);
  if (!range) return `- 参考文件：${ref.path}`;
  const limit = range.end - range.start + 1;
  return (
    `- 参考文件：${ref.path}${formatRefRange(range)}` +
    `（read_file 时 offset=${range.start} limit=${limit}；行号是添加时记下的**指针而非内容快照**，` +
    `若与读到的内容不符以实际内容为准）`
  );
}

/**
 * 构造引用上下文块（可选并入「当前打开文件」的指针行）
 *
 * @param refs 用户显式挂的引用（右键 / 后续 @ 提及）
 * @param currentFilePath 当前活动编辑器文件的**工作区相对路径**（干净态才传）
 * @param missingPaths 发送前实测已不存在的文件引用路径集合（HOST-CTX-9）；缺省 = 不标失效。
 *   注意 `.map` 的隐式第二参是下标，故须写成 `(r) => refItemLine(r, missingPaths)`，
 *   不可直接 `.map(refItemLine)`（后者会把下标当 missingPaths 传入）。
 *
 * 为什么当前文件只给指针、不注入正文：宿主上下文定案是「引用模式 Reference-Only」——
 * 所有上下文选择一律只挂指针。干净文件的磁盘内容就是真相，模型需要时 `read_file` 一次即可；
 * 仅当文件**有未保存修改**（磁盘不是真相）时才由调用方改走有界注入。
 * 已有同 path 引用时不重复追加（引用行本身已经告诉模型这个文件）。
 *
 * 空块返回空串（**不产出空信封**）——调用方据此判断「无任何上下文块」。
 */
export function buildRefContextBlock(
  refs: readonly ChatRef[],
  currentFilePath?: string,
  missingPaths?: ReadonlySet<string>,
): string {
  const items = refs.map((r) => refItemLine(r, missingPaths));
  if (currentFilePath && !refs.some((r) => r.path === currentFilePath)) {
    items.push(`- 当前打开文件：${currentFilePath}（内容未注入，按需经 read_file 读取）`);
  }
  if (items.length === 0) return '';
  return `${REF_CONTEXT_OPEN}\n${items.join('\n')}\n${REF_CONTEXT_CLOSE}`;
}

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
 *   1. 消息中确有宿主注入块 —— 含文档块 / 诊断块开标签，或含引用块开标签，或
 *      **以技能块开标签开头**（技能块恒为信封首块；普通消息即便含「用户请求：」
 *      字样也不满足此条）；
 *   2. 锚点之后存在信封分隔符。
 * 锚点：取**最后一个成对块（文档块 / 诊断块）闭标签之后**（块内正文可能自带
 * 「用户请求：」字样，必须排除在搜索区外）；技能块无闭标签、引用块旧例不进锚点计算，
 * 故纯技能 / 仅引用场景自 0 起搜索。
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
  if (
    openIdx < 0 &&
    !content.startsWith(SKILL_CONTEXT_OPEN) &&
    !content.includes(REF_CONTEXT_OPEN) &&
    !content.includes(PROBLEMS_CONTEXT_OPEN)
  )
    return content;

  // 锚点 = 最后一个**成对块**闭标签之后（文档块 / 诊断块）：块内正文若自带
  // `\n\n用户请求：`，不排除在搜索区外就会从块内截断 ⇒ 注入内容被当用户请求回显。
  // 有开无闭 = 畸形消息 ⇒ 该块不进锚点（保持既有「不误剥」语义）。
  // ⚠️ 新增成对块（未来的终端输出 / diff）**必须在此登记**：诊断块当前正文经采集器 clip
  // 压平（不含空行）⇒ 本条对它属纵深而非必需；未压平的块缺登记即锚点失效。
  let from = 0;
  const paired: readonly [string, string][] = [
    [DOC_CONTEXT_OPEN, DOC_CONTEXT_CLOSE],
    [PROBLEMS_CONTEXT_OPEN, PROBLEMS_CONTEXT_CLOSE],
  ];
  for (const [open, close] of paired) {
    const o = content.indexOf(open);
    if (o < 0) continue;
    const c = content.indexOf(close, o);
    if (c < 0) continue;
    from = Math.max(from, c + close.length);
  }

  // 判据 2：锚点之后无分隔符 → 无信封（如仅注入块、无用户请求），原样返回
  const idx = content.indexOf(USER_REQUEST_SEPARATOR, from);
  if (idx < 0) return content;
  return content.slice(idx + USER_REQUEST_SEPARATOR.length);
}
