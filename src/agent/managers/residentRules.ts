/**
 * 项目常驻规则层 — 内核侧唯一判据与渲染（读盘判据 + 两道上限 + 段渲染）
 *
 * 定位：把「作品投影清单里 `resident === true` 的条目」的正文，渲染成系统提示词里的一段
 * 「项目常驻规则」。本模块是这段规则的**单一真理源**——读盘判据、字符上限、段文案、
 * 失效汇总、降级状态行全部只在此实现，装配层与写路径（`setResident`）都调用它，
 * 禁止各写第二份（两份语义从落笔那刻起就会漂移，且没有测试会红）。
 *
 * 三条不可动的口径（设计锚：`hosts/memora-vscode/docs/resident-layer-design.md` §6.1 / §6.2）：
 * 1. **fail-closed**：工作区未信任（非严格 `true`）⇒ 整层不装配，且不读任何正文；
 * 2. **计量按渲染块**：单条按「标题行 + 正文」、合计按**整段渲染长度**（`String.length`），
 *    不按裸正文之和——两把尺子会在边界上得出两个结论；
 * 3. **失败标注行不计入预算（有意例外）**：理由见 `README_RESIDENT_ANNOTATION` 注释（自噬链）。
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import { logger } from '@/logging/logger.js';
import { isBlockedPath, resolveRealpath } from '@/security/pathGuard.js';
import { resolveSafePath } from '@/utils/scanner.js';
import type { WorkProjectionEntry } from './workProjection.js';

/** 单条常驻正文渲染块的上限（字符，UTF-16 码元）——**内核私有常量，不从包根导出** */
export const MAX_RESIDENT_SINGLE_CHARS = 6000;

/** 常驻段合计（最终注入段渲染长度）的上限——同上，内核私有 */
export const MAX_RESIDENT_TOTAL_CHARS = 15000;

/** 常驻段标题行（§4.2 定稿文案） */
const SEGMENT_TITLE = '## 项目常驻规则（本仓库具体约束；按清单顺序，靠前者优先）';

/** 适用范围声明（§4.2 定稿文案；边界：不覆盖角色职责与工具边界） */
const SEGMENT_USAGE =
  '- 适用范围：仅「具体约束」冲突；不改变角色职责与工具边界（角色是只读审查员时，本段不会让它变成改码角色）。';

/** 优先级声明（§4.2 定稿文案；安全闸门永远优先） */
const SEGMENT_PRIORITY =
  '- 优先级：本段 > 角色包规则 > 技能清单等资料；但不得放宽任何代码闸门（权限 / deny / 工作区信任 / 只读态），冲突时以闸门为准。';

/**
 * 读失败沿用缓存时的段首标注（给**模型**看，不是给用户看）。
 *
 * 🔴 **有意例外（不得「修正」）：本行不计入 15000 预算。**
 * 自噬链：若计入——上次渲染贴着 15000 ⇒ 本次读失败追加标注 ⇒ 越限 ⇒ 整段降级 ⇒
 * 常驻规则被抹掉，恰好反噬「已有缓存必须沿用」这条自身。因此「段长度超过 15000 且带本行」
 * 是设计预期，不是越限；把它算进预算的「修复」会让降级路径静默抹掉规则。
 * 边界：例外**只**覆盖本行；标题、优先级、失效汇总行照常计入（§6.1）。
 */
const READ_FAILURE_ANNOTATION = '（本次读取失败，沿用上次内容）';

/**
 * 常驻判据（唯一实现）：只有严格 `=== true` 才算常驻（fail-closed）。
 *
 * 🔴 合法写法只有**布尔值** `true`：手改 JSON 写成字符串 `"resident": "true"` **视为未开启**
 * （不报错、不进失效汇总、该条按原作品投影处理）。这是**故意**的——宁可不开，也不猜用户意图：
 * 宽容解析会把「写错」变成「看起来能用」，比明确不开更坏。可读提示归界面批次（§10 已登记）。
 *
 * 为什么不信 `Boolean(...)`：清单文件用户可手改，`"false"` 是**非空字符串**
 * ⇒ 会被 truthy 判成常驻，等于手改一个字符串就能绕过「非常驻不进正文」的约定。
 *
 * @param entry 作品投影条目（只读 resident 字段）
 * @returns true = 该条正文进常驻段；false = 原作品投影（只进索引块）
 */
export function isResidentEntry(entry: Pick<WorkProjectionEntry, 'resident'>): boolean {
  return entry.resident === true;
}

/**
 * 常驻层是否启用（唯一实现）：只有 `workspaceTrusted === true` 才启用。
 *
 * `undefined`（宿主没传）/ `false` / 其他任何值一律按未信任处理——核内侧没有 `isTrusted` 态，
 * 装配期无法现读，只能由宿主传入事实快照；宁可不给常驻正文，不静默扩权。
 *
 * @param workspaceTrusted 宿主传入的信任态快照
 * @returns true = 允许读盘并装配常驻段
 */
export function isResidentLayerEnabled(workspaceTrusted: boolean | undefined): boolean {
  return workspaceTrusted === true;
}

/**
 * 单条读取失败原因（**内部细粒度**，供段首汇总与内核日志；`setResident` 的公开返回面
 * 只把「判据拒绝」类归并成粗码 `source-rejected`，精确原因留在 message / 日志里）。
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
 * 渲染单条常驻块（标题行 + 正文）
 *
 * @param source 清单里的相对路径（原样展示，模型据此回指）
 * @param text 源文件正文
 * @returns 该条渲染块
 */
function renderResidentBlock(source: string, text: string): string {
  return `### 来源文件：${source}\n${text}`;
}

/**
 * 读取单个常驻源文件（读盘判据的**唯一实现**，装配期与 `setResident` 共用）
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
  if (isAbsolute(source)) {
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
      message: `源文件属于凭据 / 系统敏感文件，不允许作为项目常驻规则：${source}`,
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

  // ⑤ 二进制嗅探：NUL 字节 ⇒ 非文本；fatal UTF-8 解码失败 ⇒ 非文本（不做截断 / 替换式解码）
  if (buf.includes(0)) {
    return {
      ok: false,
      failure: 'not-textual',
      message: `源文件不是文本文件（含 NUL 字节），不能作为项目常驻规则：${source}`,
    };
  }
  let text: string;
  try {
    // fatal: true ⇒ 非法序列直接抛错，不静默用替换字符吞掉（吞掉等于把乱码当规则发给模型）
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return {
      ok: false,
      failure: 'not-textual',
      message: `源文件不是文本文件（非 UTF-8 编码），不能作为项目常驻规则：${source}`,
    };
  }

  return { ok: true, text, block: renderResidentBlock(source, text) };
}

/** 常驻段内一条失效记录（供段首汇总、日志与 `setResident` 拒绝文案） */
export interface ResidentSegmentEntryFailure {
  /** 失效条目的清单相对路径 */
  source: string;
  /** 失效原因（读盘判据失败，或单条超限） */
  reason: ResidentSourceFailure | 'too-long';
  /** 人读文案（含实际计量与差额） */
  message: string;
}

/** 常驻段的一次求值结果 */
export interface ResidentSegmentEvaluation {
  /**
   * 渲染后的整段文本（**不含**「沿用上次内容」标注——那是读失败分支的追加行，有意例外）。
   * 无任何常驻条目且无失效条目时为空串（不注入空段）。
   */
  segment: string;
  /** 实际注入的条目渲染块（按清单顺序） */
  blocks: string[];
  /** 失效条目（段首汇总行与日志的唯一数据源） */
  failures: ResidentSegmentEntryFailure[];
}

/**
 * 渲染常驻段（纯函数）
 *
 * 段内顺序（§4.2 定稿）：标题 → 适用范围 → 优先级 → 失效汇总行（仅当有失效条目）→ 空行 → 各条渲染块。
 * 求值顺序的「先定失效集合、再渲染」在这里落地：失效汇总行的内容在渲染前已确定，
 * 不会因「丢条 → 汇总变长 → 再丢条」形成循环依赖（§6.1）。
 *
 * @param blocks 已通过读盘判据与单条上限的条目渲染块
 * @param invalidPaths 失效条目的路径（只进段首汇总，不注入正文）
 * @returns 整段文本；无内容时为空串
 */
export function renderResidentSegment(
  blocks: readonly string[],
  invalidPaths: readonly string[],
): string {
  // 既无正文又无失效 ⇒ 本轮不存在常驻规则，不注入空段（避免模型读到只有标题的空壳）
  if (blocks.length === 0 && invalidPaths.length === 0) return '';

  const parts: string[] = [SEGMENT_TITLE, SEGMENT_USAGE, SEGMENT_PRIORITY];

  // 失效汇总行：放段首（模型先知道「有几条没注入」，再读注入的正文）
  if (invalidPaths.length > 0) {
    parts.push(`（以下 ${invalidPaths.length} 条未能注入：${invalidPaths.join('、')}）`);
  }

  // 正文块之间空一行，保证 `###` 标题在渲染上独立成块
  if (blocks.length > 0) {
    parts.push('');
    parts.push(blocks.join('\n\n'));
  }

  return parts.join('\n');
}

/**
 * 合计超限时的整段降级文案（唯一一条状态行，不含任何条目正文）
 *
 * 为什么整段降级而不是截前半段：截断会让模型把「被截的残段」当完整规则执行；
 * 明确「本轮未生效」比一份伪造的完整感更安全（§6.1）。
 *
 * @param totalLength 未降级时的整段渲染长度（用于报文给出实际计量与差额）
 * @returns 单行状态文本
 */
export function renderDegradedSegment(totalLength: number): string {
  return (
    `（项目常驻规则未注入：本段合计 ${totalLength} 字符，` +
    `超过合计 ${MAX_RESIDENT_TOTAL_CHARS} 上限 ${totalLength - MAX_RESIDENT_TOTAL_CHARS} 字符；` +
    '本轮常驻规则未生效，请精简常驻文件或缩短正文）'
  );
}

/**
 * 给已缓存的段插入「本次读取失败，沿用上次内容」标注（段首标题行的**下一行**）
 *
 * 只给模型看，不改缓存本体（缓存始终存无标注版本，避免同一轮反复刷新把标注越叠越多）。
 *
 * @param segment 已缓存的整段文本（无标注）
 * @returns 带标注的整段文本
 */
export function annotateReadFailure(segment: string): string {
  const firstBreak = segment.indexOf('\n');
  // 极端兜底：缓存段没有换行（理论上不会，标题行恒在）⇒ 标注追加在末尾，仍可见
  if (firstBreak < 0) return `${segment}\n${READ_FAILURE_ANNOTATION}`;
  return (
    segment.slice(0, firstBreak + 1) +
    READ_FAILURE_ANNOTATION +
    '\n' +
    segment.slice(firstBreak + 1)
  );
}

/**
 * 求值一整段常驻规则（读盘 + 单条上限 + 渲染；**不含**合计判定）
 *
 * 装配期与写路径共用本函数：装配期拿到段文本后判合计；`setResident` 用同一函数算出
 * 「加上候选条之后的合计长度」，从而保证两处用的是**同一把尺子**。
 *
 * @param projectDir 主根绝对路径
 * @param residentSources 常驻条目的清单相对路径（按清单数组顺序）
 * @returns 渲染结果 + 逐条失效记录
 */
export async function evaluateResidentSegment(
  projectDir: string,
  residentSources: readonly string[],
): Promise<ResidentSegmentEvaluation> {
  // 实际注入的条目渲染块
  const blocks: string[] = [];
  // 失效条目（路径 + 精确原因 + 人读文案）
  const failures: ResidentSegmentEntryFailure[] = [];

  for (const source of residentSources) {
    const read = await readResidentSource(projectDir, source);
    if (!read.ok) {
      failures.push({ source, reason: read.failure, message: read.message });
      // 失效必须留痕（静默跳过 = 假阴性）；日志记精确原因，返回值只给粗码
      logger.warn({ source, failure: read.failure }, `项目常驻规则条目失效：${read.message}`);
      continue;
    }

    // 单条上限：按**该条渲染块**（标题行 + 正文）计量，与合计口径一致
    const blockLength = read.block.length;
    if (blockLength > MAX_RESIDENT_SINGLE_CHARS) {
      const exceed = blockLength - MAX_RESIDENT_SINGLE_CHARS;
      const message = `该文件含标题行共 ${blockLength} 字符，超过单条 ${MAX_RESIDENT_SINGLE_CHARS} 上限 ${exceed} 字符`;
      failures.push({ source, reason: 'too-long', message });
      logger.warn(
        { source, blockLength, limit: MAX_RESIDENT_SINGLE_CHARS, exceed },
        `项目常驻规则单条超限，本轮剔除该条：${message}`,
      );
      continue;
    }

    blocks.push(read.block);
  }

  return {
    segment: renderResidentSegment(
      blocks,
      failures.map((f) => f.source),
    ),
    blocks,
    failures,
  };
}

/** 常驻规则管理器的构造参数（依赖由装配层注入，本模块不新开第二份清单读取实现） */
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
 * 常驻规则管理器：每轮刷新缓存，同步供给装配链
 *
 * 为什么分两个方法：`refresh()` 是**异步**（读清单 + 逐个读正文），只能由 turn 入口 await；
 * `contextBlock()` 是**同步**（刷新链 `refreshRolePackPrefixForRound` 全程同步，不能做 IO）。
 * 因此顺序必须是「入口先 await refresh()，随后同步刷新链读 contextBlock()」——否则规则晚一轮生效
 * （§4.1 每轮刷新口径）。
 *
 * 三道 fail-safe 分支（§6.2）：
 * - 未信任 ⇒ 清空缓存 + 空段（与读盘成败无关）；
 * - 已信任 + 读失败 + 有缓存 ⇒ **沿用缓存** + 段首标注（IO 抖动不得静默抹掉项目约束）；
 * - 已信任 + 读失败 + 无缓存 ⇒ 空段 + 日志。
 * 读盘异常**一律不向上抛**：不得中断 `prepare` / `resume`。
 */
export class ResidentRulesManager {
  /** 主根绝对路径（读盘判据的基目录） */
  private readonly projectDir: string;
  /** 常驻层是否启用（构造时按信任态唯一判据定死；信任态在一次装配内不变） */
  private readonly enabled: boolean;
  /** 清单读取依赖（装配层注入） */
  private readonly listEntries: () => Promise<readonly WorkProjectionEntry[]>;
  /** 清单错形态依赖（装配层注入） */
  private readonly isListMalformed: () => boolean;
  /** 上次成功求值的段文本（**无标注**版本；只在成功刷新时覆盖） */
  private lastSegment = '';
  /** 本次是否处于「读失败沿用缓存」态（contextBlock 据此决定是否加标注） */
  private staleNotice = false;

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
   * 重读清单与全部常驻正文，重建缓存（只能由 turn 入口 await，不得在同步刷新链里调用）
   *
   * 读失败不抛错：按三道 fail-safe 分支降级——这是「一次 IO 抖动不得让 turn 失败」的落点。
   *
   * @returns 无（结果只写本实例缓存，由 `contextBlock()` 同步读取）
   */
  async refresh(): Promise<void> {
    // 分支 1：未信任 ⇒ 清空缓存 + 空段（fail-closed 的硬面，与读盘成败无关）
    if (!this.enabled) {
      this.lastSegment = '';
      this.staleNotice = false;
      logger.debug('项目常驻规则：工作区未受信任，整层不装配');
      return;
    }

    // 清单级读取：把「格式错误」与「读取异常」同归为读失败（两者都意味着拿不到最新声明）
    let residentSources: string[];
    try {
      const entries = await this.listEntries();
      if (this.isListMalformed()) throw new Error('作品投影清单文件格式异常');
      // 常驻判据唯一实现；顺序真源 = 清单数组顺序（不另排序）
      residentSources = entries.filter(isResidentEntry).map((e) => e.source);
    } catch (err) {
      if (this.lastSegment.length > 0) {
        // 分支 2：已信任 + 读失败 + 有缓存 ⇒ 沿用缓存 + 段首标注（标注不入预算，见常量注释）
        this.staleNotice = true;
        logger.warn({ err }, '项目常驻规则读取失败：沿用上次内容（标注已加入段首，不中断本轮）');
      } else {
        // 分支 3：已信任 + 读失败 + 无缓存 ⇒ 空段 + 日志
        this.lastSegment = '';
        this.staleNotice = false;
        logger.warn({ err }, '项目常驻规则读取失败：无可沿用缓存，本轮空段');
      }
      return;
    }

    const evaluation = await evaluateResidentSegment(this.projectDir, residentSources);

    // 合计闸：只判「最终注入段」的渲染长度（标题 + 优先级 + 各条块 + 失效汇总行）
    if (evaluation.segment.length > MAX_RESIDENT_TOTAL_CHARS) {
      this.lastSegment = renderDegradedSegment(evaluation.segment.length);
      logger.warn(
        {
          totalLength: evaluation.segment.length,
          limit: MAX_RESIDENT_TOTAL_CHARS,
          exceed: evaluation.segment.length - MAX_RESIDENT_TOTAL_CHARS,
          count: residentSources.length,
        },
        '项目常驻规则合计超限：本轮整段降级为状态行（不截断、不注入残段）',
      );
    } else {
      this.lastSegment = evaluation.segment;
    }
    this.staleNotice = false;
  }

  /**
   * 同步读取当前缓存段（供同步刷新链使用）
   *
   * @returns 待注入的段文本（可能带读失败标注；未信任或无条目时为空串）
   */
  contextBlock(): string {
    if (!this.staleNotice || this.lastSegment.length === 0) return this.lastSegment;
    return annotateReadFailure(this.lastSegment);
  }
}
