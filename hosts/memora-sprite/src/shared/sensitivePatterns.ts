/**
 * 敏感内容检测模式与函数
 *
 * 从 electron/clipboardHandler.ts 下沉到 shared/，便于跨环境复用
 * （主进程 clipboardHandler / quickInputWindow / main.ts / 未来可能的渲染进程预检测）。
 *
 * 设计原则：
 *   - 纯数据 + 纯函数，无 Electron 依赖，可在任何环境使用
 *   - SENSITIVE_PATTERNS 为只读常量数组，运行时不可变
 *   - isSensitive 纯函数无副作用，可独立单元测试
 *
 * 命中任一模式即判定为敏感内容，调用方应静默忽略不提示分析（R22 安全风险）。
 */

/** 敏感内容类型（开放字符串，非枚举，遵循 ADR-004） */
export type SensitiveType = string;

/** 敏感内容检测结果 */
export interface SensitiveCheckResult {
  /** 是否敏感 */
  sensitive: boolean;
  /** 命中的敏感类型（如 'password'、'token'、'credit-card'、'private-key'） */
  type?: SensitiveType;
}

/**
 * 敏感内容检测模式（常量数组，便于扩展）
 *
 * 每个模式包含 type（类型标识）、pattern（正则）、label（人类可读描述）。
 * 命中任一模式即判定为敏感内容，静默忽略不提示分析。
 */
export const SENSITIVE_PATTERNS: ReadonlyArray<{ type: string; pattern: RegExp; label: string }> = [
  // API Token 前缀模式（Bearer / sk- / api_key= 等）
  {
    type: 'token',
    pattern: /^(Bearer\s|sk-|api_key=|apikey=|token=|authorization:\s)/i,
    label: 'API Token',
  },
  // 平台 Token 前缀模式（GitHub/GitLab/Slack/Stripe/Google 等平台专用 token）
  // 无 ^ 锚定：可能出现在配置行中（如 export GITHUB_TOKEN=ghp_xxx），
  // 也可能整段剪贴板仅含 token（此时 ^ 也匹配）
  {
    type: 'token',
    pattern: /(ghp_|github_pat_|glpat-|xox[bp]-|sk_live_|rk_live_|AIza)/i,
    label: '平台 Token',
  },
  // 信用卡模式（16 位连续数字，可能含空格或连字符）
  {
    type: 'credit-card',
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
    label: '信用卡号',
  },
  // 密码模式（8+ 位，含大小写字母+数字+特殊字符，无空格）
  // 注意：此模式可能误判，但宁可误判也不漏判（安全优先）
  {
    type: 'password',
    pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])[^\s]{8,}$/,
    label: '密码',
  },
  // 私钥模式（PEM 格式头部）
  {
    type: 'private-key',
    pattern: /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE\s+KEY-----/,
    label: '私钥',
  },
  // AWS Access Key 模式（20 位大写字母数字）
  {
    type: 'aws-key',
    pattern: /AKIA[0-9A-Z]{16}/,
    label: 'AWS Access Key',
  },
];

/**
 * 检测内容是否包含敏感信息（纯函数）
 *
 * 遍历 SENSITIVE_PATTERNS，命中任一模式即返回敏感结果。
 * 纯函数无副作用，可独立测试。
 *
 * @param content 待检测内容
 * @returns 敏感检测结果
 */
export function isSensitive(content: string): SensitiveCheckResult {
  for (const { type, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(content)) {
      return { sensitive: true, type };
    }
  }
  return { sensitive: false };
}
