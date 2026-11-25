/**
 * 对话区文字档位 — 三档枚举与归一化的唯一真源
 *
 * 宿主（配置读取 / 首帧 HTML 注入 / 热更广播）与 webview（常规卡回显）共用本模块，
 * 杜绝「同一份 auto/档位判定在两处各写一遍」的漂移（同 answerLanguage 的 mode 纪律）。
 *
 * 为什么存枚举而非 px：配置真源是档位名，px 映射只在 tokens.ts 一处完成。
 * 若把 12/13/14 写进配置，改字号阶梯就要迁移用户数据，且 CSS 与配置各持一份数值。
 *
 * 为什么归一函数在这里：未知值（旧配置 / 手改 settings.json / 跨版本残留）一律回退
 * `normal`，与现状逐字等价；三处调用面共用同一判定，改白名单只动这一处。
 */
export const CHAT_TEXT_SCALES = ['small', 'normal', 'large'] as const;

export type ChatTextScale = (typeof CHAT_TEXT_SCALES)[number];

/** 默认档 = 现状 13px，零视觉变化 */
export const DEFAULT_CHAT_TEXT_SCALE: ChatTextScale = 'normal';

/**
 * 归一化任意来源的原始值到合法档位。
 *
 * 白名单精确匹配；非字符串 / 未知值一律回退 `normal`（不信任配置面与消息面）。
 */
export function normalizeTextScale(raw: unknown): ChatTextScale {
  return typeof raw === 'string' && (CHAT_TEXT_SCALES as readonly string[]).includes(raw)
    ? (raw as ChatTextScale)
    : DEFAULT_CHAT_TEXT_SCALE;
}
