/**
 * 工具结果卸载原语（大文本统一通道 · 入口关）
 *
 * 「带问题取件 → 一次一份 → 提炼 → 原文落盘 → 只积攒情报 + 留引用」
 * （大文本统一通道 §6.2）的**门前换鞋**动作：单条 tool 消息超阈时把原文写入磁盘，
 * 上下文只留「路径 + 预览 + 续读提示」。
 *
 * **单一原语 + 单一收口**：本函数是唯一的落盘实现；唯一调用点是 `AgentLoop.appendToolMessage`
 * （loop 唯一 tool 写点，一处覆盖五个调用点：工具结果 / `[ASK_ANSWER]` / `[ASK_ABORTED]` /
 * `[ASK_SUSPENDED]` / `[TOOL_ABORTED]`）。
 * 上下文中 tool 消息只可能由该写点产生，入口关覆盖后无需事后压缩扫描
 *（「读者先亡、写者后死」；实证见 §6.2 结论二）。
 *
 * **同步实现（有意为之，勿改异步）**：`AgentLoop.answerQuestion()` 是**同步公开 API**（宿主调用后
 * 立即 `continueAfterPause()`），异步落盘会沿 `appendToolMessage → answerQuestion` 传染成内核公开
 * API 破坏性变更。落盘是罕见路径（仅超阈时）、单次 ≤ 数百 KB，同步写阻塞可忽略；内核已有同步 fs
 * 生产先例（`security/pathGuard.ts: realpathSync`、`logging/logger.ts: mkdirSync`）。同步还使
 * **写失败可当场降级**（返回原文入上下文 + warn），不引入「悬空引用」这一新失败模式。
 *
 * **落盘内容 = 传入内容原样**（即 wrapped 后的那条消息全文）：不做 unwrap —— 剥离包裹需要一份与
 * `wrapToolResult` 模板对称的解析实现（模板一改即失配），而「路径指向的内容与原本将入上下文的内容
 * 完全一致」是更简单也更自洽的语义。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '@/logging/logger.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { estimateTokensText } from '@/agent/contextManager.js';

/** 预览字符数默认值（替换文本自身远小于单条上限，故不会二次触发落盘） */
const DEFAULT_PREVIEW_CHARS = 1_000;

/** 卸载结果：进入上下文的内容 + 是否真的落盘 + 产物路径 */
export interface ToolResultOffloadOutcome {
  /** 进入上下文的内容：落盘成功 = 「路径 + 预览 + 续读提示」；未超阈 / 写失败 = 原文 */
  content: string;
  /** 是否真的落盘（false = 未超阈，或写失败已降级） */
  offloaded: boolean;
  /** 产物绝对路径（仅 offloaded=true 时存在） */
  filePath?: string;
}

/** 卸载参数 */
export interface ToolResultOffloadOptions {
  /**
   * 落盘目录（**必传**）：由装配注入项目 `memoraDir` 下的 outputs 子目录。
   * 内核不派生落点 —— 信任根外的路径 `read_file` 读不回，等于假引用（OFFLOAD-1 教训）。
   */
  offloadDir: string;
  /**
   * 落盘阈值（token，**含包裹判据口径**）。
   * 默认 `LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS` —— 与 `read_file` 分段上限同键同源。
   */
  thresholdTokens?: number;
  /** 预览字符数（默认 1,000） */
  previewChars?: number;
  /**
   * 尾部预览字符数（默认 0 = 只留头部）。
   *
   * >0 时从**总预览预算内**划出尾部份额（头 = previewChars − 尾），**不扩大预算**——
   * 预算扩大会让替换文本逼近单条上限，破坏「替换后不二次落盘」的结构性保证。
   * 用途同 `SCRIPT_RESULT_TAIL_CHARS`：长输出的关键信息常在尾部（见缺口 D）。
   */
  tailPreviewChars?: number;
}

/**
 * 单条工具结果超阈 → 落盘 + 生成替换文本；否则原样返回。
 *
 * 判据 `estimateTokensText(content) > 阈值`（严格大于）：`read_file` 产出（含包裹）恒 ≤ 阈值，
 * 故**结构性不落盘**，回取产物不会再次落盘 → 无限嵌套不可能。
 *
 * @param content 即将进入上下文的 tool 消息内容（已 wrapped）
 * @param opts 落盘目录（必传）与可覆盖的阈值 / 预览长度
 * @returns 替换后内容 + 落盘事实（写失败时 `offloaded=false` 且内容原样）
 */
export function offloadLargeToolResult(
  content: string,
  opts: ToolResultOffloadOptions,
): ToolResultOffloadOutcome {
  const threshold = opts.thresholdTokens ?? LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS;
  const tokens = estimateTokensText(content);
  if (tokens <= threshold) {
    return { content, offloaded: false };
  }

  const previewChars = opts.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const fileName = `${Date.now()}_${randomBytes(4).toString('hex')}.txt`;
  const filePath = path.join(opts.offloadDir, fileName);

  try {
    mkdirSync(opts.offloadDir, { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    // 写失败 → 原样入上下文（不截断、不造假引用）；空间回收交由截断线兜底
    logger.warn({ err, filePath, tokens }, '工具结果卸载失败，已降级为原文入上下文（未产生引用）');
    return { content, offloaded: false };
  }

  // 头（+可选尾）份额均在 previewChars 预算内划分，不扩大总预览量
  const tailChars = Math.min(
    Math.max(opts.tailPreviewChars ?? 0, 0),
    Math.max(previewChars - 1, 0),
  );
  const headChars = previewChars - tailChars;
  const head = content.slice(0, headChars);
  const tail = tailChars > 0 ? content.slice(content.length - tailChars) : '';
  const omitted = Math.max(0, content.length - headChars - tailChars);
  const previewBlock =
    tailChars > 0
      ? `[预览（头 ${headChars} + 尾 ${tailChars} 字符）]\n${head}\n…[省略 ${omitted} 字符]…\n${tail}`
      : `[预览（前 ${previewChars} 字符）]\n${head}…`;

  return {
    content:
      `[工具结果已卸载至磁盘] 原文 ${content.length} 字符（≈${tokens} tokens）写入：${filePath}\n` +
      `${previewBlock}\n` +
      `[省略 ${omitted} 字符。需要完整内容请用 read_file 读取上述路径，大文件可配合 offset/limit 分段读取]`,
    offloaded: true,
    filePath,
  };
}
