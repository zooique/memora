/**
 * 图片 token 入口限额（G3 第四维：单轮图片 token 合计 ≤ 模型窗口 25%）
 *
 * **为什么单独成文件（而不是并进 `imageValidation.ts`）**：
 * 本文件**值导入内核**（`imageTokens` 换算走内核单点，不得在此重写公式），
 * 而 `imageValidation.ts` 处在 webview 采集链上——webview 运行时打包用的是
 * `platform: 'browser'` 的 esbuild，**只要链上任何一环值导入内核 barrel，
 * 就会把整个 Node 内核（`node:fs` / `node:path` …）拖进浏览器包**，当场 32 个
 * 解析错误、插件打包失败（2026-10-28 真实事故）。
 *
 * 因此按**消费侧**切开：
 *   - `imageValidation.ts` = 零内核依赖的纯校验（嗅探 / 尺寸 / base64 往返 / 命名）
 *     ⇒ 可被 webview 采集链安全引用；
 *   - 本文件 = 唯一需要内核算式的部分 ⇒ **只能由 node 侧（extension / 测试）引用**。
 * ⚠️ 若将来自 webview 侧需要当场提示超限，**不得**把本文件 import 回采集链，
 * 而是走「宿主算好回传结果」或「内核下沉纯叶子模块 + 子路径导出」——见守卫
 * `esbuild.config.mjs` 里 browser 构建的 onResolve 报错。
 *
 * 零副作用：入参纯值对象、出参纯值对象，可完整机测 + 可变异验证。
 */
import { imageTokens } from '@zooique/memora';
import type { ImageSize } from './imageValidation.js';

/** 单轮图片 token 上限 = 模型上下文窗口的比例（方案 §6.7 第四维 / G3） */
export const IMAGE_TOKEN_WINDOW_RATIO = 0.25;

/** `checkImageTokenBudget` 入参 */
export interface ImageTokenBudgetInput {
  /** 已通过校验的候选图（含宽高） */
  sizes: ReadonlyArray<ImageSize>;
  /** 该模型配置的上下文窗口 token 数（0 / undefined = 不限，与内核预算口径一致） */
  contextWindow: number | undefined;
}

/** `checkImageTokenBudget` 出参（超限时 message 必须带具体数字，用户据此决定减几张） */
export interface ImageTokenBudgetResult {
  /** 是否放行 */
  ok: boolean;
  /** 全部候选图换算后的合计 token */
  totalTokens: number;
  /** 该模型的图片 token 上限（不限时为 Infinity） */
  limit: number;
  /** 面向用户的可读原因（可直接进 UI；放行时为空串） */
  message: string;
}

/**
 * G3 入口限额第四维：单轮图片 token 合计 ≤ 模型 `contextWindow` 的 25%。
 *
 * 为什么必须补这一维（方案 §6.7 / G3）：张数 / 单图字节 / 总字节三个维度都**看不见** token ——
 * 一张 4K 图 ≈2125 token，5 张 ≈10.6k，而 `contextWindow` 可低到 8k ⇒ 这是唯一
 * 「真机上真会爆」的一条。换算必须走**内核单点** `imageTokens`，不得在此重写公式。
 *
 * `contextWindow` 为 0 / undefined（= 不限，与内核 tokenBudget 口径一致）时不做限制。
 *
 * @param input 候选图尺寸列表 + 该模型的上下文窗口
 * @returns 放行与否 + 合计 token + 上限 + 超限文案
 */
export function checkImageTokenBudget(input: ImageTokenBudgetInput): ImageTokenBudgetResult {
  // 逐张换算（复用内核单点公式，含 1568 上界封顶）
  const tokens = input.sizes.map((s) => imageTokens(s));
  // 合计占用：判据必须是**合计**而非单张峰值（单图被上界钳住 ⇒ 只能靠累加触发）
  const totalTokens = tokens.reduce((a, b) => a + b, 0);
  // 窗口缺省 / 0 ⇒ 不限（与内核 tokenBudget 口径一致）
  const window = input.contextWindow ?? 0;
  if (window <= 0) {
    return { ok: true, totalTokens, limit: Number.POSITIVE_INFINITY, message: '' };
  }
  // 窗口 × 比例取整 = 该模型的图片 token 上限
  const limit = Math.floor(window * IMAGE_TOKEN_WINDOW_RATIO);
  return totalTokens > limit
    ? {
        ok: false,
        totalTokens,
        limit,
        message: `本轮图片约占 ${totalTokens} token，超过该模型上限 ${limit} token（${Math.round(
          IMAGE_TOKEN_WINDOW_RATIO * 100,
        )}% 窗口），请减少图片数量或换用更小的图`,
      }
    : { ok: true, totalTokens, limit, message: '' };
}
