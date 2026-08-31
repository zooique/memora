/**
 * token 数量的人类可读格式化 — webview 共享纯函数
 *
 * 主题单一真理源：webview 侧所有「token 数量可读展示/换算」统一收敛于此，
 * 避免各页面各自内联缩写逻辑（configView 卡片详情与表单反馈、chatView 上下文
 * 圆环明细 occTip、预算可视化行 fmtCompactTokens）。
 *
 * 换算规约（唯一真理源）：K = ×1000 供配置表单输入与展示共用；
 * M = ×1,000,000 仅展示缩写用（表单已收紧为单一 K 单位输入）。
 * 注意：K 恒取千进制——1024K=1,024,000（非二进制 1MiB），与模型文档标注一致。
 */

/** 千（×1000）：K 简写与解析共用的唯一倍数定义 */
export const TOKENS_PER_K = 1000;
/** 百万（×1,000,000）：M 简写展示的唯一倍数定义（表单已收紧为单一 K，M 仅用于展示缩写） */
export const TOKENS_PER_M = 1_000_000;

/**
 * 格式化 token 数量（精确展示：整 M / 整 K 缩写，其余千分位）
 *
 * 规则：
 *   - ≥1,000,000 且能被 1,000,000 整除 → 缩写 M（如 1000000 → 1M）；
 *   - ≥1000 且能被 1000 整除 → 缩写 K（如 128000 → 128K），扫读友好；
 *   - 其余 → 千分位分隔（如 65536 → 65,536），防大数字歧义；
 *   - 非正/非法输入 → "0"（占用条未产生数据时的兜底展示）。
 * 单位（token）由调用方拼接，"K"/"M" 后不重复带单位。
 *
 * @param n token 数
 * @returns 人类可读数字串（不含单位）
 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= TOKENS_PER_M && n % TOKENS_PER_M === 0) return `${n / TOKENS_PER_M}M`;
  if (n >= TOKENS_PER_K && n % TOKENS_PER_K === 0) return `${n / TOKENS_PER_K}K`;
  return n.toLocaleString('en-US');
}

/**
 * 格式化 token 数量（紧凑近似：≥1000 四舍五入为 k 缩写）
 *
 * 与 fmtTokens 的「精确展示」为两种展示策略：本函数用于指标摘要等空间受限的
 * 紧凑行（如预算分配「可用 97k」），牺牲精度换行宽；缺省 <1000 原样返回。
 *
 * @param n token 数
 * @returns 紧凑数字串（不含单位，k 小写与既有预算行展示一致）
 */
export function fmtCompactTokens(n: number): string {
  return n >= TOKENS_PER_K ? `${Math.round(n / TOKENS_PER_K)}k` : String(n);
}