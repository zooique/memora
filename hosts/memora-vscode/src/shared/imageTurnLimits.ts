/**
 * 单轮图片聚合限额 —— IMG-8 三维判据单点（张数 / 总字节 / token）
 *
 * 为什么单独成文件（而不并进 `imageTokenBudget.ts`）：后者**值导入内核**（token 换算公式
 * 在内核 `imageTokens` 单点），只能由 node 侧引用；而本判据有两个消费侧——
 *   - webview 发送前预检（`imageCapture.checkTurnLimits`，IMG-8 拍板「发送前整轮判」：
 *     webview `sendMessage` 先清框再 post，宿主拒收即丢正文，故必须在清框前拦）；
 *   - 宿主兜底（`chatPanel.sendInput`，防竞态漏网；拒收走 `showWarningMessage` 可见提示）。
 * 两处**必须同判据**，且本文件必须能进浏览器包 ⇒ 零依赖纯判据（零 vscode、零内核）。
 *
 * token 的**换算**各走各的既有单点，本文件只比大小、不重写任何公式（第二份公式必漂移）：
 *   - webview：求和用宿主回执的 `tokens` 字段（宿主按内核 `imageTokens` 算好随
 *     `image_ingest_result` / `image_picked` 的 ok 回执回传，webview 禁重写公式）；
 *   - 宿主：直接调内核 `imageTokens(ref)` 逐张累计。
 *
 * 判据优先级：张数 → 总字节 → token，**首个越界即返回**（用户一次只修一件事）。
 * 比例常量 `IMAGE_TOKEN_WINDOW_RATIO` 的唯一真源在本文件——`imageTokenBudget.ts`
 * （内核侧兜底通道）也从此处引用，禁再写第二份 0.25。
 *
 * 零副作用：入参纯值对象、出参纯值对象，可完整机测 + 可变异验证。
 */

/** 单轮图片张数上限（IMG-8 拍板 2026-10-29：≤5 张） */
export const MAX_IMAGES_PER_TURN = 5;

/** 单轮图片总字节上限（IMG-8 拍板 2026-10-29：≤20 MiB） */
export const MAX_TURN_BYTES = 20 * 1024 * 1024;

/** 单轮图片 token 上限 = 模型上下文窗口的比例（方案 §6.7 第四维 / G3；唯一真源） */
export const IMAGE_TOKEN_WINDOW_RATIO = 0.25;

/** `checkImageTurnLimits` 入参（两消费侧各自凑齐：webview 从候选投影，宿主从 ref 累计） */
export interface ImageTurnLimitsInput {
  /** 本轮候选图张数 */
  count: number;
  /** 本轮候选图总字节数（真值 `ref.bytes` 合计；调用时序上全部候选已落盘换真） */
  totalBytes: number;
  /**
   * 本轮候选图 token 合计。
   * `undefined` = **token 维跳过**：任一候选缺 `tokens`（旧版本回执未带该字段）时，
   * 宁可跳过也不拿「部分求和」假算——低估 = 静默放行超限，恰是 IMG-8 病根本身。
   */
  totalTokens: number | undefined;
  /**
   * 当前有效上下文窗口（webview 取 `chat_providers.limitTokens` 投影；宿主经
   * `resolveContextWindow` 解析）。`0 / undefined` 只在本文件这一维按**不限**处理——宿主侧约定，
   * 不是内核口径：内核把 0 当真窗口（`??` 不兜 0）⇒ 每轮判输入过大，0 绝不能传给内核。
   * 正常也收不到 0：`providerStore` 读侧已把非法 `contextWindow` 归一成 `undefined`。
   */
  limitTokens: number | undefined;
}

/** `checkImageTurnLimits` 出参（超限时 message 必须带具体数字：已用 / 上限 / 超出） */
export interface ImageTurnLimitsResult {
  /** 是否放行 */
  ok: boolean;
  /** 面向用户的可读原因（可直接上活动条 / 通知；放行时为空串） */
  message: string;
  /**
   * 越界维度（放行时缺省）：宿主窗口提示按「维度 + 数字」渲染本地化文案
   * （`imageTurnGuard`），webview 预检仍用 `message`（webview 显示语言归切片 4）。
   * 结构化字段让宿主渲染**不透传内核/共享层中文散文**，判据公式仍单点在本文件。
   */
  dimension?: 'count' | 'bytes' | 'tokens';
  /** 已用量：count=张 / bytes=字节 / tokens=token */
  used?: number;
  /** 上限：count=张 / bytes=字节 / tokens=token */
  limit?: number;
  /** 超出量（同单位；恒正） */
  over?: number;
}

/** MiB 展示（一位小数，字节维度文案共用；宿主窗口提示同用本单点，禁第二份格式化） */
export function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function mib(bytes: number): string {
  return formatMiB(bytes);
}

/**
 * IMG-8 三维聚合限额：张数 ≤5 / 总字节 ≤20 MiB / token ≤25% 窗口。
 *
 * 为什么必须是「聚合」判据而内核只有逐张判：`validateImageCandidate` 六步全是单张校验，
 * 单图被 1568 上界钳住（4096² 的 147×147、UHD 4K 3840×2160 的 138×78，tile 数都远超上界，
 * 一律被 Math.min 压到 1568）⇒ 超限只能靠**累加**触发（5 张 4K = 5 × 1568 = 7840 token，
 * 对 8k 窗口已逼近上限）。
 *
 * @param input 三维用量 + 窗口（见各字段 JSDoc）
 * @returns 放行与否 + 超限文案（首个越界维度的具体数字）
 */
export function checkImageTurnLimits(input: ImageTurnLimitsInput): ImageTurnLimitsResult {
  if (input.count > MAX_IMAGES_PER_TURN) {
    return {
      ok: false,
      message: `本轮图片 ${input.count} 张，超过上限 ${MAX_IMAGES_PER_TURN} 张，请先移除部分图片再发送`,
      dimension: 'count',
      used: input.count,
      limit: MAX_IMAGES_PER_TURN,
      over: input.count - MAX_IMAGES_PER_TURN,
    };
  }
  if (input.totalBytes > MAX_TURN_BYTES) {
    const over = mib(input.totalBytes - MAX_TURN_BYTES);
    return {
      ok: false,
      message: `本轮图片合计 ${mib(input.totalBytes)} MiB，超过上限 20 MiB（超出 ${over} MiB），请减少图片或换更小的图`,
      dimension: 'bytes',
      used: input.totalBytes,
      limit: MAX_TURN_BYTES,
      over: input.totalBytes - MAX_TURN_BYTES,
    };
  }
  // 窗口缺省 / 0 ⇒ 仅本维不做限制（宿主侧约定；0 传给内核会被当零窗口）；合计未知 ⇒ 跳过不假算
  const window = input.limitTokens ?? 0;
  if (input.totalTokens !== undefined && window > 0) {
    const limit = Math.floor(window * IMAGE_TOKEN_WINDOW_RATIO);
    if (input.totalTokens > limit) {
      const over = input.totalTokens - limit;
      return {
        ok: false,
        message: `本轮图片约占 ${input.totalTokens} token，超过该模型上限 ${limit} token（25% 窗口，超出 ${over}），请减少图片或换更小的图`,
        dimension: 'tokens',
        used: input.totalTokens,
        limit,
        over,
      };
    }
  }
  return { ok: true, message: '' };
}
