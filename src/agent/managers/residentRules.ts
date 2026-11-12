/**
 * 项目规则层 — 内核侧唯一判据与渲染（读盘判据 + 两道上限 + 段渲染）
 *
 * 定位：把「作品投影清单里 `resident === true` 的条目」的正文，渲染成系统提示词里的一段
 * 「项目规则」。本模块是这段规则的**单一真理源**——读盘判据、字符上限、段文案、
 * 未注入清单、降级状态行全部只在此实现，装配层与写路径（`setResident`）都调用它，
 * 禁止各写第二份（两份语义从落笔那刻起就会漂移，且没有测试会红）。
 *
 * 三条不可动的口径（设计锚：`hosts/memora-vscode/docs/resident-layer-design.md` §6.1 / §6.2）：
 * 1. **fail-closed**：工作区未信任（非严格 `true`）⇒ 整层不装配，且不读任何正文；
 * 2. **计量按渲染块**：单条按「标题行 + 正文」、合计按**整段渲染长度**（`String.length`），
 *    不按裸正文之和——两把尺子会在边界上得出两个结论；
 * 3. **失败即不注入**：读失败的条目本轮不进段（段内写明「本次未注入（读取失败，下轮重试）」），
 *    **不缓存、不沿用上次内容**——沿用会把「过期内容」伪装成「当前规则」，且要额外开销例外预算。
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import { logger } from '@/logging/logger.js';
import { isBlockedPath, resolveRealpath } from '@/security/pathGuard.js';
import { resolveSafePath } from '@/utils/scanner.js';
// 二进制嗅探唯一真理源（NUL 字节 + 严格 UTF-8 解码）：read_file 与本模块读盘共用同一判据
import { decodeTextBuffer } from '@/agent/textSanitize.js';
import type { WorkProjectionEntry } from './workProjection.js';

/**
 * 单条项目规则条目渲染块的上限（字符，UTF-16 码元）——**内核私有常量，不从包根导出**
 *
 * 政策线，不是实测结论（设计锚 §6.1）。2026-11-08 两次调整（用户拍板）：6000 → 10000 → 5000。
 */
export const MAX_RESIDENT_SINGLE_CHARS = 5000;

/**
 * 项目规则段合计（最终注入段渲染长度）的上限——同上，内核私有
 *
 * 🔴 **合计 = 单条 × 2**（5000 × 2 = 10000）：这是**可解释的预算关系**，不是巧合数字——
 * 最坏情况容得下「两篇各自顶格的规则」，第三篇起必然触发按序丢弃。
 * 改单条线时必须同笔改本条，否则「合计 = 单条 × 2」这条解释就变成假话。
 */
export const MAX_RESIDENT_TOTAL_CHARS = 10000;

/** 项目规则段标题行（§4.2 定稿文案） */
const SEGMENT_TITLE = '## 项目规则（本仓库具体约束；按清单顺序，靠前者优先）';

/**
 * Windows 盘符绝对路径形态（`C:\` / `C:/`）——补 `path.isAbsolute` 的平台缺口
 *
 * `path.isAbsolute` 是**平台相关**判据：POSIX 上 `C:/Windows/win.ini` 被判为相对路径，
 * 会被当成工作区内文件名，最终 reason 退化成 `blocked-path`；而 Windows 上同一输入给出
 * `outside-workspace`——reason 码是消费方可观测的公开字段，同一输入不得两平台两个答案。
 * 故显式补齐盘符形态（POSIX 的 `/` 开头仍由 `isAbsolute` 覆盖），两平台判定一致。
 */
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** 适用范围声明（§4.2 定稿文案；边界：不覆盖角色职责与工具边界） */
const SEGMENT_USAGE =
  '- 适用范围：仅「具体约束」冲突；不改变角色职责与工具边界（角色是只读审查员时，本段不会让它变成改码角色）。';

/** 优先级声明（§4.2 定稿文案；安全闸门永远优先） */
const SEGMENT_PRIORITY =
  '- 优先级：本段 > 角色包规则 > 技能清单等资料；但不得放宽任何代码闸门（权限 / deny / 工作区信任 / 只读态），冲突时以闸门为准。';

/**
 * 项目规则判据（唯一实现）：只有严格 `=== true` 才算项目规则（fail-closed）。
 *
 * 🔴 合法写法只有**布尔值** `true`：手改 JSON 写成字符串 `"resident": "true"` **视为未开启**
 * （该条按原作品投影处理；**不报错**，但会进完整失效集与日志，判据见 `isNonBooleanResident`）。
 * 这是**故意**的——宁可不开，也不猜用户意图：宽容解析会把「写错」变成「看起来能用」，
 * 比明确不开更坏。可读提示由作品投影树显示「配置有误」（设计稿 §8.2 / §10「已定边界」）。
 *
 * 为什么不信 `Boolean(...)`：清单文件用户可手改，`"false"` 是**非空字符串**
 * ⇒ 会被 truthy 判成项目规则，等于手改一个字符串就能绕过「非项目规则条目不进正文」的约定。
 *
 * @param entry 作品投影条目（只读 resident 字段）
 * @returns true = 该条正文进项目规则段；false = 原作品投影（只进索引块）
 */
export function isResidentEntry(entry: Pick<WorkProjectionEntry, 'resident'>): boolean {
  return entry.resident === true;
}

/**
 * 是否为「`resident` 字段存在但不是布尔」的清单误配（唯一实现）
 *
 * 判据：字段**缺失**（`undefined`）是合法「非规则」，不算误配；`null` / `"true"` / `"false"` /
 * 数字 / 对象一律算误配（JSON 手改笔误）。误配条目的效果与 `false` 相同（不进项目规则段），
 * 但必须**留痕**（进完整失效集 + 日志），否则用户永远不知道自己写了一行无效配置。
 *
 * @param entry 作品投影条目（只读 resident 字段）
 * @returns true = 该条 resident 值不是布尔（按未设为规则处理并记失效）
 */
export function isNonBooleanResident(entry: Pick<WorkProjectionEntry, 'resident'>): boolean {
  const raw: unknown = entry.resident;
  return raw !== undefined && raw !== true && raw !== false;
}

/**
 * 项目规则层是否启用（唯一实现）：只有 `workspaceTrusted === true` 才启用。
 *
 * `undefined`（宿主没传）/ `false` / 其他任何值一律按未信任处理——核内侧没有 `isTrusted` 态，
 * 装配期无法现读，只能由宿主传入事实快照；宁可不给项目规则正文，不静默扩权。
 *
 * @param workspaceTrusted 宿主传入的信任态快照
 * @returns true = 允许读盘并装配项目规则段
 */
export function isResidentLayerEnabled(workspaceTrusted: boolean | undefined): boolean {
  return workspaceTrusted === true;
}

/**
 * 单条读取失败原因（**内部细粒度**，供段内文案与内核日志；`setResident` 的公开返回面
 * 只按「不存在 / 读不到」折算成 `not-found` / `source-unreadable`，精确原因留在 message / 日志里）。
 */
export type ResidentSourceFailure =
  /** 路径在工作区外（绝对路径 / `..` 逃逸 / 符号链接指向外部） */
  | 'outside-workspace'
  /** 命中凭据 / 系统敏感路径黑名单（`.env` / `.npmrc` / `.ssh` 等） */
  | 'blocked-path'
  /** 非文本（含 NUL 字节或非 UTF-8 可解码） */
  | 'not-textual'
  /** 文件不存在（被删除 / 改名 / 移动） */
  | 'missing'
  /** 读盘失败（权限 / IO 抖动等，**可重试**——与前三类判据拒绝可区分） */
  | 'read-error';

/** 单条读取成功结果 */
export interface ResidentSourceReadOk {
  ok: true;
  /** 源文件正文（原样，不裁切） */
  text: string;
  /** 该条渲染块（`### 来源文件：<source>` + 正文）；单条上限按**本块**计量 */
  block: string;
}

/** 单条读取失败结果 */
export interface ResidentSourceReadFail {
  ok: false;
  /** 细粒度失败原因 */
  failure: ResidentSourceFailure;
  /** 人读文案（含精确原因，供日志 / 拒绝提示） */
  message: string;
}

/** 单条读取结果（判别联合） */
export type ResidentSourceReadResult = ResidentSourceReadOk | ResidentSourceReadFail;

/**
 * 渲染单条项目规则块（标题行 + 正文）
 *
 * @param source 清单里的相对路径（原样展示，模型据此回指）
 * @param text 源文件正文
 * @returns 该条渲染块
 */
function renderResidentBlock(source: string, text: string): string {
  return `### 来源文件：${source}\n${text}`;
}

/**
 * 读取单个项目规则源文件（读盘判据的**唯一实现**，装配期与 `setResident` 共用）
 *
 * 判据顺序（每一步失败都**不读正文**，避免把不该给模型的内容先读进内存）：
 * ① 绝对路径 / `..` 逃逸 ⇒ 拒绝；② realpath 复核（防符号链接指向工作区外）；
 * ③ 凭据 / 系统敏感路径黑名单；④ 读盘（区分「不存在」与「读取失败」）；
 * ⑤ 二进制嗅探（NUL 字节）+ fatal UTF-8 解码复核。
 *
 * @param projectDir 主根绝对路径（清单 `source` 一律相对它）
 * @param source 清单里的相对路径
 * @returns 成功（正文 + 渲染块）或失败（细粒度原因 + 人读文案）
 */
export async function readResidentSource(
  projectDir: string,
  source: string,
): Promise<ResidentSourceReadResult> {
  // ① 字符串层越界：绝对路径直接判外（resolveSafePath 虽也能挡，但先判可给出更准的文案）
  //    判定必须**跨平台一致**：POSIX 的 path.isAbsolute 不认 Windows 盘符形态（见 WINDOWS_DRIVE_ABSOLUTE）
  if (isAbsolute(source) || WINDOWS_DRIVE_ABSOLUTE.test(source)) {
    return {
      ok: false,
      failure: 'outside-workspace',
      message: `源文件不在工作区内（清单里是绝对路径）：${source}`,
    };
  }
  const fullPath = resolveSafePath(projectDir, source);
  if (fullPath === null) {
    return {
      ok: false,
      failure: 'outside-workspace',
      message: `源文件不在工作区内（含 ../ 逃逸或路径异常）：${source}`,
    };
  }

  // ② realpath 复核：字符串路径在项目内、但符号链接指向项目外 ⇒ 仍算逃逸
  const realRoot = resolveRealpath(projectDir);
  const realFull = resolveRealpath(fullPath);
  if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) {
    return {
      ok: false,
      failure: 'outside-workspace',
      message: `源文件不在工作区内（符号链接指向工作区外）：${source}`,
    };
  }

  // ③ 凭据 / 系统敏感路径（复用 pathGuard 单一实现，禁复制正则表）
  if (isBlockedPath(fullPath)) {
    return {
      ok: false,
      failure: 'blocked-path',
      message: `源文件属于凭据 / 系统敏感文件，不允许作为项目规则：${source}`,
    };
  }

  // ④ 读盘：区分「不存在」（不可重试）与「读取失败」（可重试）
  let buf: Buffer;
  try {
    buf = await readFile(fullPath);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        failure: 'missing',
        message: `源文件不存在（可能已被删除 / 改名 / 移动）：${source}`,
      };
    }
    return {
      ok: false,
      failure: 'read-error',
      message: `源文件读取失败（可重试；${code ?? '未知错误'}）：${source}`,
    };
  }

  // ⑤ 二进制嗅探：判据唯一真理源在 textSanitize.decodeTextBuffer（NUL 字节 / 严格 UTF-8 解码），
  // 本模块只负责把原因码翻译成项目规则语境的人读文案（不做截断 / 替换式解码）
  const decoded = decodeTextBuffer(buf);
  if (decoded.kind === 'binary') {
    // 原因码 → 项目规则语境的措辞（无 BOM 含 NUL / UTF-8 非法 / UTF-16 损坏）
    const reasonText =
      decoded.reason === 'nul-byte'
        ? '含 NUL 字节'
        : decoded.reason === 'invalid-utf16'
          ? 'UTF-16 编码损坏'
          : '非 UTF-8 编码';
    return {
      ok: false,
      failure: 'not-textual',
      message: `源文件不是文本文件（${reasonText}），不能作为项目规则：${source}`,
    };
  }

  return { ok: true, text: decoded.text, block: renderResidentBlock(source, decoded.text) };
}

/**
 * 项目规则段内一条失效记录（**完整失效集**：供日志、宿主报告与 `setResident` 拒绝文案）
 *
 * 🔴 与「段首未注入清单」（`ResidentNotInjected`）不是同一层：本集合是**全量失效**，
 * 段首只投影其中 `read-failed` / `too-long` 两类（见 `toNotInjected`）。新增原因码时
 * 必须显式决定「是不是模型可见」——默认**不进段首**（模型改不了清单文件，写进去只会污染上下文）。
 */
export interface ResidentSegmentEntryFailure {
  /** 失效条目的清单相对路径 */
  source: string;
  /**
   * 失效原因：
   * - `ResidentSourceFailure`：读盘判据失败（可重试或需修正文件路径 / 权限）；
   * - `'too-long'`：单条渲染块超上限（需拆分文件）；
   * - `'total-exceeded'`：合计超限被按清单顺序丢弃（本条本身没问题，只是预算不够）；
   * - `'resident-not-boolean'`：清单里该条 `resident` 值不是布尔（手改笔误，已按「未设为规则」处理）。
   */
  reason: ResidentSourceFailure | 'too-long' | 'total-exceeded' | 'resident-not-boolean';
  /** 人读文案（含实际计量与差额 / 实际写入值） */
  message: string;
}

/**
 * 段首「未注入清单」的入参（按原因分两类，段内文案不同）
 *
 * 为什么要分类而不是只给路径：读失败会**下轮重试**、单条超限要**拆分文件**——
 * 两类处置方向相反，合并成一句「未能注入」会让模型（和排障的人）用错动作。
 */
export interface ResidentNotInjected {
  /** 条目路径（清单里的相对路径，模型据此回指） */
  source: string;
  /** 未注入原因：`read-failed` = 读盘判据失败（可重试）；`too-long` = 单条超上限（需拆分） */
  reason: 'read-failed' | 'too-long';
}

/**
 * 把完整失效记录投影成「模型可见的未注入清单」（唯一映射点）
 *
 * 只接受两类：`too-long`（需拆分文件）、读盘判据失败（`read-failed` 家族，可重试 / 可改路径）。
 * 其余一律返回 null（不投影）：非布尔误配是**用户改清单**的动作，模型重试永远解决不了；
 * 合计丢弃另有 `dropped` 清单行，不走这里。
 *
 * @param failure 完整失效记录
 * @returns 段首条目，或 null（模型不可见）
 */
function toNotInjected(failure: ResidentSegmentEntryFailure): ResidentNotInjected | null {
  switch (failure.reason) {
    case 'too-long':
      return { source: failure.source, reason: 'too-long' };
    case 'outside-workspace':
    case 'blocked-path':
    case 'not-textual':
    case 'missing':
    case 'read-error':
      return { source: failure.source, reason: 'read-failed' };
    // 非布尔误配 / 合计丢弃：模型不可见（前者是用户动作，后者由 dropped 行承载）
    case 'resident-not-boolean':
    case 'total-exceeded':
      return null;
    default:
      // 未来新增原因码的默认落点：**不投影**（宁可少说，不可让模型对无能为力的事反复解释）
      return null;
  }
}

/** 项目规则段的一次求值结果 */
export interface ResidentSegmentEvaluation {
  /** 渲染后的整段文本；无任何条目且无未注入/丢弃条目时为空串（不注入空段） */
  segment: string;
  /** 实际注入的条目渲染块（按清单顺序） */
  blocks: string[];
  /**
   * 完整失效集（日志与宿主报告的唯一数据源）
   *
   * 与段首的关系：段首只投影 `read-failed` / `too-long` 两类（处置动作对模型可理解）；
   * 其余原因（如 `resident-not-boolean`）**只留在本条与日志**——模型改不了清单文件，
   * 把它写进 prompt 只会让模型对一条自己无能为力的配置笔误反复解释。
   */
  failures: ResidentSegmentEntryFailure[];
  /**
   * 因合计超限被按序丢弃的条目（按**清单顺序**，`reason` 恒为 `total-exceeded`）
   *
   * 与 `failures` 分开的理由：失效 = 「这条本身有问题」（读盘 / 单条超限），丢弃 = 「这条没问题、
   * 只是预算不够」。两者混一列会让「修文件就能救」与「必须先精简别人」共用同一条汇总文案。
   */
  dropped: ResidentSegmentEntryFailure[];
}

/**
 * 本轮项目规则求值快照（**只读报告**，宿主 UI 消费；不参与注入、不参与写路径判定）
 *
 * 定位：把「这一轮到底注入了什么、哪些条目没生效」从 Manager 内部人读日志提升为可读面，
 * 供宿主展示失效徽标。判据仍在 `refresh()` 单点生产，宿主**不得**据此本地复算或改写清单。
 *
 * 生命周期：每次 `refresh()` 全量覆盖（不跨轮沿用）；`null` = 尚未求值过
 * （未初始化 / 还没跑过任何 turn / 工作区未受信任整层不装配）。
 */
export interface ResidentSegmentReport {
  /** 本轮渲染段（与 `contextBlock()` 同一份；空串 = 本轮不注入项目规则段） */
  segment: string;
  /**
   * 完整失效集（见 `ResidentSegmentEntryFailure` 的层级说明）
   *
   * 含 `resident-not-boolean` 这类**不进段首**的失效——宿主徽标要显示它，模型看不到它。
   */
  failures: ResidentSegmentEntryFailure[];
  /** 因合计超限被按序丢弃的条目（按清单顺序） */
  dropped: ResidentSegmentEntryFailure[];
  /** 本轮清单是否读到了（false ⇒ 清单缺失/格式错误/读取异常，本轮整段为空） */
  listReadable: boolean;
}

/**
 * 渲染项目规则段（纯函数）
 *
 * 段内顺序（§4.2 定稿）：标题 → 适用范围 → 优先级 → 读失败未注入行（仅当有）→
 * 单条超限未注入行（仅当有）→ 丢弃清单行（仅当有）→ 空行 → 各条渲染块。
 * 求值顺序的「先定未注入集合、再渲染」在这里落地：未注入行的内容在渲染前已确定，
 * 不会因「丢条 → 汇总变长 → 再丢条」形成循环依赖（§6.1）；丢弃清单行**计入**合计预算，
 * 其收敛性由 `evaluateResidentSegment` 的单调性论证保证（每丢一条就少一个正文块）。
 *
 * @param blocks 已通过读盘判据、单条上限与合计预算的条目渲染块
 * @param notInjected 未注入条目及其原因（只进段首清单，不注入正文）
 * @param droppedPaths 因合计超限被丢弃的条目路径（按清单顺序；只进段首清单，不注入正文）
 * @returns 整段文本；无内容时为空串
 */
export function renderResidentSegment(
  blocks: readonly string[],
  notInjected: readonly ResidentNotInjected[] = [],
  droppedPaths: readonly string[] = [],
): string {
  // 既无正文又无未注入/丢弃 ⇒ 本轮不存在项目规则，不注入空段（避免模型读到只有标题的空壳）
  if (blocks.length === 0 && notInjected.length === 0 && droppedPaths.length === 0) return '';

  const parts: string[] = [SEGMENT_TITLE, SEGMENT_USAGE, SEGMENT_PRIORITY];

  // 读失败行：明确「本轮未注入 + 下轮重试」，避免模型把它当永久失效
  const readFailedPaths = notInjected
    .filter((n) => n.reason === 'read-failed')
    .map((n) => n.source);
  if (readFailedPaths.length > 0) {
    parts.push(
      `（以下 ${readFailedPaths.length} 条本次未注入（读取失败，下轮重试）：${readFailedPaths.join('、')}）`,
    );
  }

  // 单条超限行：处置方向指向文件本身（拆分），不许说成「下轮会好」
  const tooLongPaths = notInjected.filter((n) => n.reason === 'too-long').map((n) => n.source);
  if (tooLongPaths.length > 0) {
    parts.push(
      `（以下 ${tooLongPaths.length} 条本次未注入（单文件超上限，需拆分）：${tooLongPaths.join('、')}）`,
    );
  }

  // 丢弃清单行：与上面两类分开写，模型才分得清「这条自己有问题」还是「这条没问题、只是预算不够」
  if (droppedPaths.length > 0) {
    parts.push(
      `（以下 ${droppedPaths.length} 条因合计超限未注入：${droppedPaths.join('、')}；` +
        '已按清单顺序丢弃靠后条目，靠前者优先）',
    );
  }

  // 正文块之间空一行，保证 `###` 标题在渲染上独立成块
  if (blocks.length > 0) {
    parts.push('');
    parts.push(blocks.join('\n\n'));
  }

  return parts.join('\n');
}

/**
 * 极端兜底：**全部条目已被丢弃**、段内只剩标题/优先级/清单行仍超合计上限时的状态行
 *
 * 正常不会发生（合计 10000 远大于段首固定行 + 路径清单）。保留它只为兜住「路径清单本身撑爆段首」，
 * 使任何输入都返回可注入的文本，而不是让一段超长文本漏进 prompt。
 *
 * @param totalLength 全部丢弃后段首固定行的实际渲染长度（用于报文给出实测计量与差额）
 * @returns 单行状态文本
 */
export function renderDegradedSegment(totalLength: number): string {
  return (
    `（项目规则未注入：本段合计 ${totalLength} 字符，` +
    `超过合计 ${MAX_RESIDENT_TOTAL_CHARS} 上限 ${totalLength - MAX_RESIDENT_TOTAL_CHARS} 字符；` +
    '本轮项目规则未生效，请精简规则文件或缩短正文）'
  );
}

/**
 * 求值一整段项目规则（读盘 + 单条上限 + **合计预算按序丢弃** + 渲染）
 *
 * 装配期与写路径共用本函数：装配期直接用返回段；`setResident` 用同一函数算
 * 「加上候选条之后会被丢弃哪些条目」，从而保证两处用的是**同一把尺子**。
 *
 * 🔴 **丢弃顺序的定义（可预测、可解释，不许随机）**：
 * 顺序真源 = **清单数组顺序**（段首标题已明写「按清单顺序，靠前者优先」）。合计超限时
 * **从清单末尾逐条丢弃**：丢一条 → 重算段长度 → 仍超则继续丢，直到装得下。
 * 不引入 `priority` 字段：那会与标题行已声明的「清单顺序」形成第二套排序真源，
 * 且需要用户手填数字，冲突时无法解释「到底听谁的」。
 *
 * 收敛性（不用「丢条 → 汇总变长 → 再丢条」的循环依赖）：每丢一条，正文少一个块
 * （块 ≥ 路径 + `### 来源文件：` 标题），段首只多一个路径 + 一个分隔符；故总长单调下降，
 * 循环上界 = 条目数。丢光后仍超限才退到状态行（`renderDegradedSegment`）。
 *
 * 读失败的条目**本轮直接不进段**（不缓存、不沿用上次内容）：下一次 refresh 会重新读盘，
 * 故段内文案是「下轮重试」而不是永久失效。
 *
 * @param projectDir 主根绝对路径
 * @param residentSources 项目规则条目的清单相对路径（按清单数组顺序）
 * @returns 渲染结果 + 逐条失效记录 + 按序丢弃清单
 */
export async function evaluateResidentSegment(
  projectDir: string,
  residentSources: readonly string[],
): Promise<ResidentSegmentEvaluation> {
  // 候选条目（保留路径以便丢弃时按清单顺序回报；`blocks` 只是它的投影）
  const kept: { source: string; block: string }[] = [];
  // 失效条目（路径 + 精确原因 + 人读文案）
  const failures: ResidentSegmentEntryFailure[] = [];

  for (const source of residentSources) {
    const read = await readResidentSource(projectDir, source);
    if (!read.ok) {
      failures.push({ source, reason: read.failure, message: read.message });
      // 失效必须留痕（静默跳过 = 假阴性）；日志记精确原因，返回值只给粗码
      logger.warn({ source, failure: read.failure }, `项目规则条目失效：${read.message}`);
      continue;
    }

    // 单条上限：按**该条渲染块**（标题行 + 正文）计量，与合计口径一致
    const blockLength = read.block.length;
    if (blockLength > MAX_RESIDENT_SINGLE_CHARS) {
      const exceed = blockLength - MAX_RESIDENT_SINGLE_CHARS;
      // 「单文件超上限」的处置必须指向文件本身，不许让合计去迁就单篇（§8.1）
      const message =
        `该文件含标题行共 ${blockLength} 字符，超过单条 ${MAX_RESIDENT_SINGLE_CHARS} 上限 ${exceed} 字符` +
        '；单文件超上限，请拆分该文件';
      failures.push({ source, reason: 'too-long', message });
      logger.warn(
        { source, blockLength, limit: MAX_RESIDENT_SINGLE_CHARS, exceed },
        `项目规则单条超限，本轮剔除该条：${message}`,
      );
      continue;
    }

    kept.push({ source, block: read.block });
  }

  // 段首未注入清单：只投影「改文件能救」的两类（读失败可重试 / 单条超限需拆分），
  // 其余失效（非布尔误配、合计丢弃）不进模型可见面——映射显式列举，禁止再写成三目折叠
  // （折叠会把未来新增的原因码静默当 read-failed，给模型一句永远无法被满足的「下轮重试」）。
  const notInjected: ResidentNotInjected[] = failures
    .map(toNotInjected)
    .filter((n): n is ResidentNotInjected => n !== null);
  // 因合计超限被丢弃的条目（按清单顺序，供段首汇总与日志/写路径回执）
  const dropped: ResidentSegmentEntryFailure[] = [];

  /** 按当前保留集渲染（丢弃清单行一并计入预算） */
  const render = (): string =>
    renderResidentSegment(
      kept.map((k) => k.block),
      notInjected,
      dropped.map((d) => d.source),
    );

  let segment = render();
  // 丢弃前的真实溢出量（排障用）：丢弃后段长恒 ≤ 上限，只看最终长度看不出「溢出多少」
  const overflowBeforeDrop = segment.length - MAX_RESIDENT_TOTAL_CHARS;
  // 从清单末尾逐条丢弃：靠后者让位给靠前者（顺序真源 = 清单数组顺序）
  while (segment.length > MAX_RESIDENT_TOTAL_CHARS && kept.length > 0) {
    const evicted = kept.pop()!;
    dropped.unshift({
      source: evicted.source,
      reason: 'total-exceeded',
      message:
        `项目规则段合计超过 ${MAX_RESIDENT_TOTAL_CHARS} 上限，本条按清单顺序靠后被丢弃` +
        '（本轮未注入；请精简靠前的规则文件或缩短其正文）',
    });
    logger.warn(
      { source: evicted.source, limit: MAX_RESIDENT_TOTAL_CHARS, overflow: overflowBeforeDrop },
      `项目规则合计超限：按清单顺序丢弃靠后条目 ${evicted.source}`,
    );
    segment = render();
  }

  // 极端兜底：丢光全部条目后段首仍超限（只可能由路径清单本身撑爆）⇒ 退到状态行
  if (segment.length > MAX_RESIDENT_TOTAL_CHARS) {
    segment = renderDegradedSegment(segment.length);
  }

  return {
    segment,
    blocks: kept.map((k) => k.block),
    failures,
    dropped,
  };
}

/** 项目规则管理器的构造参数（依赖由装配层注入，本模块不新开第二份清单读取实现） */
export interface ResidentRulesManagerParams {
  /** 主根绝对路径（清单 source 一律相对它） */
  projectDir: string;
  /** 宿主传入的信任态快照（判据唯一实现 = `isResidentLayerEnabled`） */
  workspaceTrusted: boolean | undefined;
  /** 读取作品投影清单（装配层注入 `workProjection.refresh`，与索引块共用同一份缓存） */
  listEntries: () => Promise<readonly WorkProjectionEntry[]>;
  /** 清单是否处于「文件存在但格式错误」态（同一实例的 `isFileMalformed`） */
  isListMalformed: () => boolean;
}

/**
 * 项目规则管理器：每轮刷新，同步供给装配链
 *
 * 为什么分两个方法：`refresh()` 是**异步**（读清单 + 逐个读正文），只能由 turn 入口 await；
 * `contextBlock()` 是**同步**（刷新链 `refreshRolePackPrefixForRound` 全程同步，不能做 IO）。
 * 因此顺序必须是「入口先 await refresh()，随后同步刷新链读 contextBlock()」——否则规则晚一轮生效
 * （§4.1 每轮刷新口径）。
 *
 * 两道 fail-safe 分支（§6.2）：
 * - 未信任 ⇒ 空段（与读盘成败无关）；
 * - 已信任 + 清单读失败 ⇒ 空段 + 日志（**不缓存、不沿用上次内容**：过期规则会冒充当前规则）。
 * 条目级读失败不在此列：它只影响该条（本轮不进段，段内写明「读取失败，下轮重试」）。
 * 读盘异常**一律不向上抛**：不得中断 `prepare` / `resume`。
 *
 * 合计超限**不是** fail-safe 分支：它按清单顺序逐条丢弃靠后条目并继续注入其余（§6.1）。
 */
export class ResidentRulesManager {
  /** 主根绝对路径（读盘判据的基目录） */
  private readonly projectDir: string;
  /** 项目规则层是否启用（构造时按信任态唯一判据定死；信任态在一次装配内不变） */
  private readonly enabled: boolean;
  /** 清单读取依赖（装配层注入） */
  private readonly listEntries: () => Promise<readonly WorkProjectionEntry[]>;
  /** 清单错形态依赖（装配层注入） */
  private readonly isListMalformed: () => boolean;
  /** 本轮求值得到的段文本（**不跨轮沿用**：每次 refresh 全量覆盖，失败即清空） */
  private segment = '';
  /**
   * 本轮求值快照（宿主只读报告；`null` = 尚未求值过或整层未启用）
   *
   * 与 `segment` 同步在同一处写入，避免两个字段漂移；宿主通过 `Agent.residentSegmentReport` 消费。
   */
  private reportSnapshot: ResidentSegmentReport | null = null;

  /** 本轮求值快照（只读；`null` = 尚未求值 / 整层未启用） */
  get report(): ResidentSegmentReport | null {
    return this.reportSnapshot;
  }

  /**
   * @param params 构造参数（见 `ResidentRulesManagerParams`）
   */
  constructor(params: ResidentRulesManagerParams) {
    this.projectDir = params.projectDir;
    this.enabled = isResidentLayerEnabled(params.workspaceTrusted);
    this.listEntries = params.listEntries;
    this.isListMalformed = params.isListMalformed;
  }

  /**
   * 重读清单与全部规则正文，重建本轮段（只能由 turn 入口 await，不得在同步刷新链里调用）
   *
   * 读失败不抛错：按两道 fail-safe 分支降级——这是「一次 IO 抖动不得让 turn 失败」的落点。
   *
   * @returns 无（结果只写本实例字段，由 `contextBlock()` 同步读取）
   */
  async refresh(): Promise<void> {
    // 分支 1：未信任 ⇒ 空段（fail-closed 的硬面，与读盘成败无关）
    if (!this.enabled) {
      this.segment = '';
      // 整层未启用不是「本轮求值结果」，快照归 null（宿主据此区分「没求值」与「求值了但零条目」）
      this.reportSnapshot = null;
      logger.debug('项目规则：工作区未受信任，整层不装配');
      return;
    }

    // 清单级读取：把「格式错误」与「读取异常」同归为读失败（两者都意味着拿不到最新声明）
    let residentSources: string[];
    let misconfigured: ResidentSegmentEntryFailure[];
    try {
      const entries = await this.listEntries();
      if (this.isListMalformed()) throw new Error('作品投影清单文件格式异常');
      // 非布尔误配（唯一判据 isNonBooleanResident）：**先于过滤器采集**——过滤器会把它们与
      // 「未设规则」一起剔除，事后就再也分不出「漏写 true」和「故意不设」了。
      misconfigured = entries.filter(isNonBooleanResident).map((e) => {
        // 实际写入值的字面形态（供用户定位手改笔误；JSON.stringify 对 null/字符串/对象都安全）
        const raw = JSON.stringify(e.resident) ?? String(e.resident);
        return {
          source: e.source,
          reason: 'resident-not-boolean' as const,
          message:
            `该条 resident 字段值为 ${raw}（非布尔），已按「未设为项目规则」处理` +
            '；请在 work-projections.json 中改为 true / false 或删除该字段',
        };
      });
      // 项目规则判据唯一实现；顺序真源 = 清单数组顺序（不另排序）
      residentSources = entries.filter(isResidentEntry).map((e) => e.source);
    } catch (err) {
      // 分支 2：已信任 + 清单读失败 ⇒ 空段 + 说明（不沿用上次内容：拿不到声明就不猜它是什么）
      this.segment = '';
      this.reportSnapshot = { segment: '', failures: [], dropped: [], listReadable: false };
      logger.warn({ err }, '项目规则：清单读取失败，本轮不注入任何规则（下轮重试）');
      return;
    }

    // 误配留痕：曾静默忽略 ⇒ 用户手改的 "true" 永远没人告诉他没生效（假阴性）
    for (const f of misconfigured) {
      logger.warn({ source: f.source }, `项目规则清单条目误配：${f.message}`);
    }

    const evaluation = await evaluateResidentSegment(this.projectDir, residentSources);

    // 合计超限已在内核求值里**按清单顺序逐条丢弃**（§6.1）：这里不再整段降级，
    // 只负责把「丢了哪几篇」汇总回给宿主日志（段首同时有一行给模型看的丢弃清单）
    if (evaluation.dropped.length > 0) {
      logger.warn(
        {
          dropped: evaluation.dropped.map((d) => d.source),
          limit: MAX_RESIDENT_TOTAL_CHARS,
          totalLength: evaluation.segment.length,
          residentCount: residentSources.length,
        },
        '项目规则合计超限：已按清单顺序丢弃靠后条目（丢弃清单已写入段首，靠前者优先）',
      );
    }

    this.segment = evaluation.segment;
    // 快照 = 完整失效集（误配在前 + 求值失效在后）；段首仍只投影求值失效里的两类
    this.reportSnapshot = {
      segment: evaluation.segment,
      failures: [...misconfigured, ...evaluation.failures],
      dropped: evaluation.dropped,
      listReadable: true,
    };
  }

  /**
   * 同步读取本轮段（供同步刷新链使用）
   *
   * @returns 待注入的段文本（未信任 / 清单读失败 / 无条目时为空串）
   */
  contextBlock(): string {
    return this.segment;
  }
}
