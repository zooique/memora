/**
 * 上下文窗口管理器（从 AgentLoop 提取的独立职责）
 *
 * 职责：
 *   1. token 估算（estimateTokens）
 *   2. 消息截断（truncateMessages）—— 保留下方、裁中间、提取关键消息
 *   3. 关键消息提取（extractKeyMessages）—— 按重要性权重贪心选取
 *   4. 上下文摘要生成（generateContextSummary）—— LLM 生成"遗忘补偿"
 *   5. 摘要缓存管理（getOrCreateSummary）—— 缓存 TTL + 过期重生成
 *   6. 软上限判定（shouldInjectSoftLimitWrapup）—— 摘要层饱和注入收尾信号（自 AgentLoop 迁入）
 *   7. 压力预警（shouldInjectContextPressureHint）—— 容量到线但摘要健康的前一级提示
 *
 * 设计理由：AgentLoop 1151 行超阈值，上下文管理是独立职责，
 * 拆分后 AgentLoop 聚焦对话循环，ContextManager 聚焦上下文窗口管理。
 *
 * 自然生长原则：ContextManager 不持有 messages 引用（避免与 AgentLoop 状态耦合），
 * 所有方法接收 messages 作为参数，是无状态的纯计算 + 缓存。
 */

import type { LlmProvider, Message, ImageRef } from '@/llm/provider.js';
import type { ProviderRouter } from '@/llm/types.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { logger } from '@/logging/logger.js';
import { NOOP_TRACER, TRACE_SPANS, type ITracer } from '@/agent/tracer.js';
import { isAbortError } from '@/utils/errors.js';

/** 软上限摘要化判定标记：第一级替换产物文案前缀（compaction.ts ReplaceRoundsStrategy） */
export const SOFT_LIMIT_SUMMARY_MARKER_ROUND = 'Round summary · roundId:';
/** 软上限摘要化判定标记：第二级压缩产物文案前缀（loop.compressContext） */
export const SOFT_LIMIT_SUMMARY_MARKER_COMPRESS = 'Compressed context';

/**
 * 复用已存摘要产物的 token 上限比例（P2-4）。
 *
 * `roundSummaryLoader`（装配注入）拼装最多 5 条已存 round-summary，其长度**不受
 * `SUMMARY_MAX_TOKENS`（生成侧参数）约束**——截断产物此前可被其撑爆（产超窗请求，一次注定
 * 失败的调用）。复用路径按窗口比例封顶，超限即裁剪（保头部 + 省略标记）。
 */
const REUSED_SUMMARY_BUDGET_RATIO = 0.2;

/** ContextManager 构造选项（模块私有，0 外部 import） */
interface ContextManagerOptions {
  /** 上下文窗口 token 上限 */
  readonly maxContextTokens: number;
  /** LLM Provider（用于生成上下文摘要） */
  readonly provider: LlmProvider;
  /**
   * Provider 路由选择器（多模型路由基础，可选）
   *
   * 有配置时，摘要生成走 'summary' 路由，使用轻量模型。
   * 不配置时回退到主 Provider（完全向后兼容）。
   */
  readonly providerRouter?: ProviderRouter;
  /** 截断时生成占位消息的文案函数（来自 UIMessages.contextTruncated） */
  readonly contextTruncatedFn: (skipped: number, kept: number) => string;
  /**
   * 可观测性 Tracer（用于 generateContextSummary span 埋点）
   *
   * 未注入时降级为 NOOP_TRACER（静默丢弃所有 span，零开销）。
   */
  readonly tracer?: ITracer;
  /**
   * 截断事件回调（每次 truncateMessages 触发截断时调用）
   *
   * 未注入时静默忽略。宿主可通过此回调向用户通知上下文被截断。
   */
  readonly onContextTruncated?: (skippedCount: number, keptCount: number) => void;
  /**
   * 已存轮次摘要加载器（截断优先复用，可选）
   *
   * 截断生成上下文摘要前，先尝试取已持久化的 round-summary（零成本、保真），
   * 仅当没有已存摘要时才现调 LLM——让摘要生成退出截断关键路径。
   * 返回空字符串/undefined 表示无已存摘要，回退 LLM 生成。
   */
  readonly roundSummaryLoader?: () => string;
  /**
   * 最少保留的最近原始对话轮数（可选，默认 0）
   *
   * 截断时强制保留最近 N 轮完整原始对话（不被摘要替代），在此基础上再按 token 上限收集。
   * 宿主可据 provider 的 prompt caching（KV cache 复用）能力放宽此值——多塞原始对话几乎
   * 零成本且保真。0 表示不强制（保持纯 token 驱动截断）。
   */
  readonly minRecentRounds?: number;
}

/**
 * 判断字符是否为 CJK 字符（中文适配）
 *
 * CJK 字符在 LLM tokenizer 中 token 密度更高（约 1-2 token/字符），
 * 需要与英文/数字/符号分开估算。
 *
 * 覆盖范围：
 *   - U+3400-U+4DBF：CJK 统一表意文字扩展A
 *   - U+4E00-U+9FFF：CJK 统一表意文字（常用中文）
 *   - U+3040-U+30FF：日文平假名 + 片假名
 *   - U+AC00-U+D7AF：韩文音节
 *
 * @param code 字符的 Unicode code point
 * @returns 是否为 CJK 字符
 */
function isCjkChar(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展A
    (code >= 0x3040 && code <= 0x30ff) || // 日文平假名 + 片假名
    (code >= 0xac00 && code <= 0xd7af) // 韩文音节
  );
}

/**
 * 统计字符串中 CJK 与非 CJK 字符数（中文适配）
 *
 * 用 for...of 遍历字符串以正确处理代理对（emoji 等），
 * codePointAt(0) 获取首个 code point。
 *
 * @param str 待统计的字符串
 * @returns { cjkChars, otherChars } CJK 字符数与非 CJK 字符数
 */
function countCjkAndOther(str: string): { cjkChars: number; otherChars: number } {
  let cjkChars = 0;
  let otherChars = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isCjkChar(code)) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }
  return { cjkChars, otherChars };
}

/** 可估算 token 的最小消息形状（宿主历史会话重算无需构造完整内核 Message） */
export interface EstimableMessage {
  readonly content: string;
  readonly toolCalls?: unknown;
  /** 图片附件（可选，多模态输入）；按尺寸折算等价 CJK 字符数，复用同一套 ceil 公式（方案 §5.9） */
  readonly attachments?: readonly ImageRef[];
}

/**
 * 单图 token 上界（方案 §5.9）：按 Claude 官方 patch 公式 `⌈w/28⌉×⌈h/28⌉` 推算后 clamp。
 *
 * ⚠️ **不存在「按后端调这个常量」的配置项**——当前实现里 1568 是写死的默认值，宿主也没有
 * 与之对应的设置键。早前的注释写过「为 OpenAI high 时应上调配置」，那句话是**文档债**
 * （描述了一个并不存在的配置面）。真相是：
 *   - 1568 = Claude 标准档单图上界，覆盖 Claude 与常规 OpenAI（low/medium detail）；
 *   - OpenAI high detail 单图可达 ≈2125 ⇒ 走 high 时本估算**会低估**（约 26%）；
 *   - 低估的后果是装配期预算偏松 → 有超窗风险的窗口被当成安全放行。
 *
 * 因此「宁可高估不低估」这句方向性承诺**并未在 high 场景成立**。把上界抬到 2125 可以覆盖
 * high，代价是对 Claude / 常规档系统性高估约 36%，同样有害（预算偏紧、过早截断）。
 * 取舍结论：**暂维持 1568**（常见场景精确），high-detail 的低估作为**已知缺口**在此登记，
 * 待 vision 单元可视化特性上线（IMG-2）拿到真实 usage 后再按实际占用收口。
 * 收口方式必须是「换成从响应用 usage 校正」或直接提高本常量——**禁止**先加一个假配置项。
 */
export const IMAGE_TOKEN_UPPER_BOUND = 1568;

/**
 * 单图 token 数（按尺寸，零状态纯函数）。上界封顶防止超大图爆窗估算。
 *
 * 入参刻意只要 `Pick<ImageRef,'width'|'height'>` 而非整个 `ImageRef`：本函数的事实依赖只有
 * 像素尺寸，把签名放宽到子集 ⇒ 宿主在**只持有尺寸**的阶段（采集限额 G3，尚未拼完整 ref）
 * 也能直接复用同一公式，不必伪造其余字段；将来 `ImageRef` 加必填成员也不会级联到这里。
 */
export function imageTokens(ref: Pick<ImageRef, 'width' | 'height'>): number {
  const wTiles = Math.max(1, Math.ceil(ref.width / 28));
  const hTiles = Math.max(1, Math.ceil(ref.height / 28));
  return Math.min(wTiles * hTiles, IMAGE_TOKEN_UPPER_BOUND);
}

/**
 * 估算消息序列 token 数（CJK 感知，零状态纯函数）。
 *
 * 单一真理源：先累计全部字符、最后一次向上取整——与逐条取整再求和**不等价**
 * （后者系统性高估）。运行时（`ContextManager.estimateTokens` / contextPreparer
 * 各层计量）与宿主历史会话占用重算共用本函数，两端口径不漂移。
 * 图片附件按尺寸折算等价 CJK 字符数，**复用同一套 ceil 公式**（不引入第二套 token 数学）。
 *
 * @param messages 待估算的消息序列（content 计入，toolCalls 序列化后计入，attachments 按尺寸计入）
 * @returns token 数（按 CJK/其他字符分轨估算后向上取整 + 图片折算）
 */
export function estimateTokensMessages(messages: readonly EstimableMessage[]): number {
  let cjkChars = 0;
  let otherChars = 0;
  for (const m of messages) {
    const contentCounts = countCjkAndOther(m.content);
    cjkChars += contentCounts.cjkChars;
    otherChars += contentCounts.otherChars;
    if (m.toolCalls) {
      const toolCallsCounts = countCjkAndOther(JSON.stringify(m.toolCalls));
      cjkChars += toolCallsCounts.cjkChars;
      otherChars += toolCallsCounts.otherChars;
    }
    if (m.attachments?.length) {
      let imgTokens = 0;
      for (const a of m.attachments) imgTokens += imageTokens(a);
      // 折回等价 CJK 字符数，复用同一套 ceil 公式（不引入第二套 token 数学）
      cjkChars += imgTokens * LOOP_CONSTANTS.CJK_CHARS_PER_TOKEN;
    }
  }
  return Math.ceil(
    cjkChars / LOOP_CONSTANTS.CJK_CHARS_PER_TOKEN + otherChars / LOOP_CONSTANTS.CHARS_PER_TOKEN,
  );
}

/**
 * 估算单段文本 token 数（CJK 感知，零状态纯函数）。
 *
 * 供「单段文本」场景使用（如宿主对一条记忆正文的独立计量）。
 * 计量**消息序列**须用 `estimateTokensMessages`：本函数逐条调用再求和会放大
 * 取整误差，与本函数同口径但结果不等价。
 *
 * @param text 待估算文本
 * @returns token 数（按 CJK/其他字符分轨估算后向上取整）
 */
export function estimateTokensText(text: string): number {
  const { cjkChars, otherChars } = countCjkAndOther(text);
  return Math.ceil(
    cjkChars / LOOP_CONSTANTS.CJK_CHARS_PER_TOKEN + otherChars / LOOP_CONSTANTS.CHARS_PER_TOKEN,
  );
}

/**
 * 上下文窗口管理器
 *
 * 管理 token 估算、消息截断、摘要生成与缓存。
 * 从 AgentLoop 提取，保持无状态设计（不持有 messages 引用）。
 */
export class ContextManager {
  // 组合 root 统一注入为字段，类内不承担 Provider 选址逻辑。
  // 非 readonly：模型热切换（Agent.setContextWindow）后经 setMaxContextTokens 更新，
  // 截断阈值 / 软上限 / 召回注入警戒线随新窗口同步重算。
  private maxContextTokens: number;
  private readonly provider: LlmProvider;
  private readonly providerRouter: ProviderRouter | undefined;
  private readonly contextTruncatedFn: (skipped: number, kept: number) => string;
  private readonly tracer: ITracer;

  private contextSummary: string | null = null;
  private contextSummaryMsgCount: number = 0;
  private _truncationCount: number = 0;
  private readonly onContextTruncated: ((skipped: number, kept: number) => void) | undefined;
  private readonly roundSummaryLoader: (() => string) | undefined;
  private readonly minRecentRounds: number;

  constructor(opts: ContextManagerOptions) {
    this.maxContextTokens = opts.maxContextTokens;
    this.provider = opts.provider;
    this.providerRouter = opts.providerRouter;
    this.contextTruncatedFn = opts.contextTruncatedFn;
    this.onContextTruncated = opts.onContextTruncated;
    this.roundSummaryLoader = opts.roundSummaryLoader;
    this.minRecentRounds = Math.max(0, Math.floor(opts.minRecentRounds ?? 0));
    this.tracer = opts.tracer ?? NOOP_TRACER;
  }

  /**
   * 运行时更新上下文窗口上限（token）
   *
   * 截断判定 / 软上限 / 召回注入警戒线均内读本字段，更新即刻生效。
   *
   * @param tokens 新窗口 token 数
   */
  setMaxContextTokens(tokens: number): void {
    this.maxContextTokens = tokens;
  }

  get truncationCount(): number {
    return this._truncationCount;
  }

  /**
   * 估算消息 token 数。
   *
   * CJK（中/日/韩）与其它字符密度不同需分开估算：
   * 统一按 3 字符/token 会严重低估中文（实际约 1.5 字符/token）。
   * toolCalls 序列化字符同样计入。
   */
  estimateTokens(messages: readonly Message[]): number {
    return estimateTokensMessages(messages);
  }

  /** token 超阈值且消息数 > 3（避免单条消息触发截断）时才需要截断 */
  shouldTruncate(messages: readonly Message[]): boolean {
    return this.estimateTokens(messages) > this.maxContextTokens && messages.length > 3;
  }

  /**
   * 软上限判定：上下文逼近容量上限（≥ 缓冲阈值）且摘要层 token 占比过高时，注入收尾信号让 LLM 收敛。
   * 从 AgentLoop._shouldInjectSoftLimitWrapup 迁入（与 estimateTokens/maxContextTokens 同属上下文预算层）。
   *
   * 精确检测摘要层 token 占用（替代原"存在标记即触发"的近似判断）：
   *   - 过滤出标记为摘要的消息（Round summary / Compressed context）
   *   - 计算摘要层 token 占用
   *   - 当摘要层 token ≥ maxContextTokens × SUMMARY_LAYER_TOKEN_RATIO 时判定为"摘要层达容量上限"
   *
   * @param messages 当前工作记忆（读型判定，不修改）
   * @returns 是否应注入软上限收尾信号
   */
  shouldInjectSoftLimitWrapup(messages: readonly Message[]): boolean {
    // 容量阈值：上下文逼近 maxContextTokens 警戒线（≥ CONTEXT_TOKENS_BUFFER_RATIO）
    const currentTokens = this.estimateTokens(messages);
    if (currentTokens < this.maxContextTokens * LOOP_CONSTANTS.CONTEXT_TOKENS_BUFFER_RATIO) {
      return false;
    }

    // 精确检测：计算摘要层 token 占用（仅统计标记为摘要的消息）
    const summaryMessages = messages.filter(
      (m) =>
        m.content.includes(SOFT_LIMIT_SUMMARY_MARKER_ROUND) ||
        m.content.includes(SOFT_LIMIT_SUMMARY_MARKER_COMPRESS),
    );

    if (summaryMessages.length === 0) {
      return false;
    }

    // 摘要层 token 占容量阈值比例（≥ SUMMARY_LAYER_TOKEN_RATIO = 30%）
    const summaryTokens = this.estimateTokens(summaryMessages);
    return summaryTokens >= this.maxContextTokens * LOOP_CONSTANTS.SUMMARY_LAYER_TOKEN_RATIO;
  }

  /**
   * 上下文压力预警判定：容量表达警戒线（≥ CONTEXT_TOKENS_BUFFER_RATIO）但
   * 摘要层未饱和（低于 SUMMARY_LAYER_TOKEN_RATIO）时 → 可注入温和提示（压缩/收敛引导）。
   *
   * 与 shouldInjectSoftLimitWrapup 互补——同一容量闸的两级：
   *   摘要层饱和       → shouldInjectSoftLimitWrapup（收尾信号）
   *   容量到线但摘要健康 → shouldInjectContextPressureHint（软上限的前一级预警）
   *
   * @param messages 当前工作记忆（读型判定，不修改）
   * @returns 是否应注入上下文空间预警提示
   */
  shouldInjectContextPressureHint(messages: readonly Message[]): boolean {
    // 容量阈值：上下文逼警戒线（≥ CONTEXT_TOKENS_BUFFER_RATIO）
    const currentTokens = this.estimateTokens(messages);
    if (currentTokens < this.maxContextTokens * LOOP_CONSTANTS.CONTEXT_TOKENS_BUFFER_RATIO) {
      return false;
    }
    // 摘要层已达饱和 → 归软上限收尾路径，不重复预警（避免与收尾信号叠加）
    if (this.shouldInjectSoftLimitWrapup(messages)) {
      return false;
    }
    return true;
  }

  /**
   * 截断消息数组以适配上下文窗口。
   *
   * 策略：保留下方（最近）、裁中间、头部折叠成占位消息。
   * - messages[0]（system prompt）始终保留；
   * - 从被裁剪段按重要性（user > tool > assistant）提取关键消息；
   * - 若 system prompt 本身已超窗口则不截断（配置问题，交由 LLM API 报错）。
   */
  truncateMessages(messages: readonly Message[], summary?: string): readonly Message[] {
    const estimated = this.estimateTokens(messages);
    if (estimated <= this.maxContextTokens || messages.length <= 3) {
      return messages;
    }

    const systemMsg = messages[0];
    if (!systemMsg || systemMsg.role !== 'system') {
      return messages;
    }

    const systemTokens = this.estimateTokens([systemMsg]);
    if (systemTokens >= this.maxContextTokens) {
      logger.warn(
        { systemTokens, maxContextTokens: this.maxContextTokens },
        'system prompt 已超过上下文窗口上限，请缩减 bootstrapMemories 或 toolDefinitions',
      );
      return messages;
    }

    // 留 10% 缓冲给 LLM 响应
    const availableTokens =
      Math.floor(this.maxContextTokens * LOOP_CONSTANTS.CONTEXT_TOKENS_BUFFER_RATIO) - systemTokens;

    // 从尾部向前收集最近消息（tail 区）；cutIndex 记录裁剪起始
    const tail: Message[] = [];
    let tailTokens = 0;
    let cutIndex = messages.length;
    // 强制保留最近 minRecentRounds 轮原始对话，不被摘要替代（0=不强制）
    let forcedTailCount = 0;
    if (this.minRecentRounds > 0) {
      let userSeen = 0;
      for (let i = messages.length - 1; i >= 1; i--) {
        const msg = messages[i];
        if (!msg) break;
        if (msg.role === 'user') userSeen++;
        if (userSeen > this.minRecentRounds) break;
        forcedTailCount++;
      }
    }
    for (let i = messages.length - 1; i >= 1; i--) {
      const msg = messages[i];
      if (!msg) break;
      const msgTokens = this.estimateTokens([msg]);
      // 强制保留区不计入 token 上限；超出该区才按 token 截断
      const inForced = tail.length < forcedTailCount;
      if (!inForced && tailTokens + msgTokens > availableTokens) {
        cutIndex = i + 1;
        break;
      }
      tail.unshift(msg);
      tailTokens += msgTokens;
      cutIndex = i;
    }

    // 去掉 system prompt（-1）；裁剪数为 0 说明全部保留
    const skipped = cutIndex - 1;
    if (skipped <= 0) {
      return messages;
    }

    this._truncationCount++;
    this.onContextTruncated?.(skipped, tail.length);

    // 从被裁剪段按重要性提取关键消息（保留信息量最高的用户输入）
    const cutMessages = messages.slice(1, cutIndex);
    const keyMessages = this.extractKeyMessages(cutMessages, availableTokens - tailTokens);

    // 占位消息：告知 LLM 有历史被裁剪
    const placeholder: Message = {
      role: 'system',
      content: this.contextTruncatedFn(skipped, tail.length),
    };

    const summaryMsg: Message | undefined = summary
      ? { role: 'system', content: summary }
      : undefined;
    const truncated: Message[] = [systemMsg];
    if (summaryMsg) {
      truncated.push(summaryMsg);
    }
    truncated.push(...keyMessages);
    truncated.push(placeholder);
    truncated.push(...tail);

    const newEstimated = this.estimateTokens(truncated);

    // ── 超窗观测守卫（P2-4） ─────────────────────────────────────
    // system + tail 受 availableTokens（= floor(max × 0.9) − system）约束，但 summary（来自
    // roundSummaryLoader）、keyMessages、placeholder **均不计入 availableTokens** ⇒ 组装产物可能
    // 超 maxContextTokens（超窗 = 一次注定失败的 LLM 调用）。
    // **此处只观测、不改造结构**——结构契约 = system→summary→keyMessages→placeholder→tail，
    // 由用例锁定（改造即破约 = 造伤）；真正的止血落在源头：复用摘要产物封顶（见
    // getOrCreateSummary → capSummary，按窗口比例裁剪 roundSummaryLoader 产物）。
    if (newEstimated > this.maxContextTokens) {
      logger.warn(
        {
          newTokens: newEstimated,
          maxContextTokens: this.maxContextTokens,
          summaryTokens: summaryMsg ? this.estimateTokens([summaryMsg]) : 0,
        },
        '截断产物超窗（summary/占位符未计入 availableTokens）：检查摘要长度或收紧 CONTEXT_TOKENS_BUFFER_RATIO',
      );
    }

    logger.info(
      {
        originalCount: messages.length,
        truncatedCount: truncated.length,
        skipped,
        keyExtracted: keyMessages.length,
        originalTokens: estimated,
        newTokens: newEstimated,
      },
      '上下文窗口截断完成',
    );

    return truncated;
  }

  /**
   * 从被裁剪段按重要性贪心选取关键消息，保留信息量最高的用户输入。
   * 权重：user=3 > tool=2 > assistant=1，同级按内容长度；最后恢复原始顺序。
   */
  private extractKeyMessages(cutMessages: readonly Message[], availableTokens: number): Message[] {
    if (availableTokens <= 0 || cutMessages.length === 0) return [];

    const weighted = cutMessages.map((msg, index) => ({
      msg,
      index, // 原始顺序索引（最终恢复用）
      weight: this.messageImportance(msg),
      tokens: this.estimateTokens([msg]),
    }));

    weighted.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return b.msg.content.length - a.msg.content.length;
    });

    // 贪心选取直到 token 用完
    const selected: typeof weighted = [];
    let usedTokens = 0;
    for (const item of weighted) {
      if (usedTokens + item.tokens > availableTokens) break;
      selected.push(item);
      usedTokens += item.tokens;
    }

    // 恢复原始顺序，保持时间线一致
    selected.sort((a, b) => a.index - b.index);
    return selected.map((item) => item.msg);
  }

  /** 消息重要性权重：user>tool>assistant */
  private messageImportance(msg: Message): number {
    if (msg.role === 'user') return 3;
    if (msg.role === 'tool') return 2;
    return 1;
  }

  /**
   * 作废摘要缓存
   *
   * 缓存过期靠 `messages.length - contextSummaryMsgCount > TTL` 这个**单向**数值判断，
   * 只覆盖「消息增长」。当消息集合被整体替换（`AgentLoop.restoreHistory` 恢复检查点）
   * 且新历史更短时，差值为负 → 陈旧摘要永不过期，会把上一段会话的摘要注入新上下文。
   *
   * 修法不是把条件改成 `Math.abs`：truncateMessages 的正常裁剪同样让消息变少，
   * 而那时摘要恰恰更该保留（它描述的就是被裁掉的历史）。真理源是「消息集合是否被替换」
   * 这一事实，故由替换方显式作废，而非从长度差反推。
   */
  resetSummary(): void {
    this.contextSummary = null;
    this.contextSummaryMsgCount = 0;
  }

  /**
   * 获取或创建上下文摘要（带缓存）。
   *
   * 缓存 TTL：消息数增长超 SUMMARY_CACHE_TTL_MSGS 即过期重生成。
   * signal 使摘要 LLM 可被中断，避免其卡住时挂起调用方。
   */
  async getOrCreateSummary(messages: readonly Message[], signal?: AbortSignal): Promise<string> {
    const summaryExpired =
      this.contextSummary !== null &&
      messages.length - this.contextSummaryMsgCount > LOOP_CONSTANTS.SUMMARY_CACHE_TTL_MSGS;

    if (this.contextSummary && !summaryExpired) {
      return this.contextSummary;
    }

    const summary = await this.generateContextSummary(messages, signal);
    this.contextSummary = summary;
    this.contextSummaryMsgCount = messages.length;
    return summary;
  }

  /**
   * 复用摘要产物按窗口比例封顶（P2-4）。
   *
   * 超出 `maxContextTokens × REUSED_SUMMARY_BUDGET_RATIO` 的 token 预算即按**最保守**字符密度
   * （CJK 1.5 字符/token）裁剪，附省略标记。目的：roundSummaryLoader 产物不受 SUMMARY_MAX_TOKENS
   * 约束，原样复用可把截断产物撑爆超窗——封顶把它约束回窗口内可容纳的量级。
   */
  private capSummary(summary: string): string {
    const budgetTokens = Math.floor(this.maxContextTokens * REUSED_SUMMARY_BUDGET_RATIO);
    if (budgetTokens <= 0) return '';
    if (estimateTokensText(summary) <= budgetTokens) return summary;
    const charBudget = Math.floor(budgetTokens * LOOP_CONSTANTS.CJK_CHARS_PER_TOKEN);
    return `${summary.slice(0, charBudget)}…`;
  }

  /**
   * 生成上下文摘要：把被裁剪段压缩成"遗忘补偿"注入 system prompt。
   *
   * 策略：
   * - 优先复用已存的 round-summary（每轮后台生成的零成本产物），仅无已存摘要才调 LLM；
   * - 走 providerRouter 的 'summary' 路由（轻量模型），未配置则回退主 provider；
   * - abort 或失败一律降级为空串返回，不影响主流程。
   */
  private async generateContextSummary(
    messages: readonly Message[],
    signal?: AbortSignal,
  ): Promise<string> {
    const summarySpan = this.tracer.startSpan(TRACE_SPANS.CONTEXT_SUMMARY, {
      messageCount: messages.length,
      summarizingMessages: Math.min(messages.length - 1, LOOP_CONSTANTS.SUMMARY_MSG_COUNT),
    });

    try {
      if (signal?.aborted) {
        summarySpan.setAttribute('aborted', true);
        return '';
      }

      if (this.roundSummaryLoader) {
        const existing = this.roundSummaryLoader();
        if (existing) {
          summarySpan.setAttribute('source', 'round-summary');
          logger.debug('上下文截断复用已存 round-summary，跳过 LLM 摘要生成');
          // P2-4：复用产物按窗口比例封顶（其长度不受 SUMMARY_MAX_TOKENS 约束）
          return this.capSummary(existing);
        }
      }

      const messagesToSummarize = messages.slice(1);
      const recentMessages = messagesToSummarize
        .filter(
          (m) => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string'),
        )
        .slice(-LOOP_CONSTANTS.SUMMARY_MSG_COUNT)
        .map(
          (m) =>
            `${m.role}: ${typeof m.content === 'string' ? m.content.substring(0, LOOP_CONSTANTS.SUMMARY_CONTENT_SLICE) : '[tool]'}`,
        )
        .join('\n');

      if (!recentMessages) {
        summarySpan.setAttribute('skipped', true);
        return '';
      }

      const summaryProvider = this.providerRouter ? this.providerRouter('summary') : this.provider;

      const stream = summaryProvider.chat(
        [
          {
            role: 'system',
            content:
              'Summarize the following conversation excerpt in 1-2 sentences. Focus on key facts, decisions, and user preferences. Be concise.',
          },
          { role: 'user', content: recentMessages },
        ],
        {
          maxTokens: LOOP_CONSTANTS.SUMMARY_MAX_TOKENS,
          temperature: 0,
          signal,
        },
      );
      let summary = '';
      for await (const chunk of stream) {
        if (signal?.aborted) {
          summarySpan.setAttribute('aborted', true);
          break;
        }
        if (chunk.content) summary += chunk.content;
      }
      if (signal?.aborted) {
        return '';
      }
      summarySpan.setAttribute('summaryLength', summary.length);
      logger.info({ summaryLength: summary.length }, '上下文摘要已生成');
      return `[Context summary of earlier conversation]\n${summary}`;
    } catch (err) {
      // AbortError 是用户主动取消，降级为无摘要而非错误
      if (isAbortError(err)) {
        summarySpan.setAttribute('aborted', true);
        logger.debug('上下文摘要生成被中断，降级为无摘要');
        return '';
      }
      summarySpan.recordException(err instanceof Error ? err : new Error(String(err)));
      logger.warn({ err }, '上下文摘要生成失败，降级为无摘要');
      return '';
    } finally {
      summarySpan.end();
    }
  }
}
