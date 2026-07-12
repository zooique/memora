/**
 * 记忆关系图谱颜色解析（从 relationGraph.ts 提取）
 *
 * 职责：
 *   集中管理图谱渲染所需的 CSS 变量解析与颜色映射，降低 relationGraph.ts 体量。涵盖：
 *   - source/edge 类型 → CSS 变量名映射
 *   - CSS 变量运行时解析（含深浅色双 fallback）
 *   - 十六进制颜色转 rgba、YIQ 亮度对比色计算
 *
 * 提取原因：
 *   relationGraph.ts 超标（1360 行，超 1200 触发线）。
 *   颜色解析相关常量与方法（SOURCE_COLOR_VARS/EDGE_COLOR_VARS/resolveCssVar/
 *   getNodeColor/getEdgeColor/hexToRgba/getContrastColor）形成独立子系统，
 *   仅依赖 document 与入参，适合提取为纯函数模块。
 *
 * 设计：
 *   - 纯函数 + 常量导出，无需依赖注入（resolveCssVar 只依赖 document）
 *   - getNodeColor 签名从 (node: GraphNode) 改为 (source: string)，解耦类型依赖
 *   - 深浅色双 fallback 通过运行时检测 data-theme 属性动态选择
 *
 * 先例：
 *   参照 memoryGraphPanel.ts 的提取模式（ADR-017 枝叶层 2 次提取原则首次实践）
 */

// ─── 颜色映射常量（source → CSS 变量名，运行时从主题解析实际色值） ──

/** source 类型 → 对应的 CSS 变量名（在 base.css 中定义，支持双主题） */
export const SOURCE_COLOR_VARS: Record<string, string> = {
  profile: '--green',
  insight: '--accent',
  guardrail: '--pink',
  skill: '--yellow',
  rule: '--mauve',
  persona: '--teal',
  session: '--peach',
};

/** 边类型 → 对应的 CSS 变量名 */
export const EDGE_COLOR_VARS: Record<string, string> = {
  contradicts: '--red',
  supports: '--green',
  follows: '--accent',
  refines: '--yellow',
  caused: '--mauve',
  related: '--muted',
};

/** 连线模式预览线使用的 CSS 变量名 */
export const CONNECTION_LINE_VAR = '--yellow';

// ─── CSS 变量 fallback ───────────────────────────────────

/**
 * Canvas CSS 变量 fallback 常量表
 *
 * Canvas 2D 不支持 CSS var() 语法，需通过 getComputedStyle 运行时解析。
 * 当变量解析失败时使用此处的 fallback 值兜底。
 *
 * 深色主题 fallback 通过运行时检测 data-theme 属性动态选择，
 * 确保 fallback 值与当前主题视觉一致。
 */

/** 检测当前是否为深色主题 */
export function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

/** 深浅色双 fallback 常量表（与 base.css 变量值保持同步） */
export const CSS_VAR_FALLBACKS = {
  '--accent': () => '#0066ff',
  '--muted': () => '#7a7a82',
  '--text': () => (isDarkTheme() ? '#cdd6f4' : '#1d1d1f'),
  '--white': () => '#ffffff',
  '--yellow': () => (isDarkTheme() ? '#f9e2af' : '#ff9f0a'),
  '--text-3': () => (isDarkTheme() ? '#a1a1a6' : '#7a7a82'),
  '--surface0': () => (isDarkTheme() ? '#1e1e2e' : '#ececee'),
} as const;

// ─── 颜色解析函数 ────────────────────────────────────────

/**
 * 从 CSS 变量解析当前主题色值
 *
 * Canvas 2D 无法直接使用 CSS var()，需在绘制时动态读取。
 * fallback 值从 CSS_VAR_FALLBACKS 常量表获取，支持深浅色双主题。
 *
 * @param varName CSS 变量名（如 '--accent'）
 * @param fallback 显式 fallback 值（可选，优先于常量表）
 */
export function resolveCssVar(varName: string, fallback?: string): string {
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(varName).trim();
  if (resolved) return resolved;
  // 优先使用显式传入的 fallback，其次查常量表
  return fallback ?? CSS_VAR_FALLBACKS[varName as keyof typeof CSS_VAR_FALLBACKS]?.() ?? '#7a7a82';
}

/**
 * 根据 source 获取节点颜色（从 CSS 变量解析，支持双主题自动切换）
 *
 * @param source 记忆来源类型（如 'insight'、'profile'）
 */
export function getNodeColor(source: string): string {
  const varName = SOURCE_COLOR_VARS[source];
  if (varName) {
    return resolveCssVar(varName);
  }
  return resolveCssVar('--muted');
}

/**
 * 根据边类型获取边颜色（从 CSS 变量解析，支持双主题自动切换）
 *
 * @param edgeType 边类型（如 'supports'、'contradicts'）
 */
export function getEdgeColor(edgeType: string): string {
  const varName = EDGE_COLOR_VARS[edgeType];
  if (varName) {
    return resolveCssVar(varName);
  }
  return resolveCssVar('--muted');
}

/**
 * 将十六进制颜色转换为 rgba 字符串（用于光晕/渐变等需要透明度的场景）
 *
 * @param hex 十六进制颜色（6 位，带或不带 #）
 * @param alpha 透明度 0-1
 */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 根据背景色计算高对比度文字颜色（黑/白）
 *
 * 使用 YIQ 颜色空间判断亮度，同时考虑当前主题背景。
 * 亮色背景（YIQ ≥ 128）用深色文字（--text），暗色背景用浅色文字（--white）。
 *
 * @param hexColor 背景色十六进制值
 */
export function getContrastColor(hexColor: string): string {
  const hex = hexColor.replace('#', '');
  if (hex.length !== 6) return '#ffffff';
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  // YIQ 亮度公式
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  // 亮色背景用深色文字，暗色背景用浅色文字（文字颜色跟随主题 --text）
  return yiq >= 128
    ? resolveCssVar('--text')
    : resolveCssVar('--white');
}
