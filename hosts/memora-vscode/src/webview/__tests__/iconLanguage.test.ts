// @vitest-environment jsdom
/**
 * 图标语言守卫（2026-09-19）——UI 渲染层禁止出现「字符图标」
 *
 * **背景**：项目图标语言唯一 = `webview/scripts/icons.ts` 的 Trae 柔和线条 SVG
 * （`stroke=currentColor` / `stroke-width=1.5` / 圆端 / 用 CSS 控尺寸）。字符图标
 * （emoji 与装饰符号）是**第二套语言**：彩色像素图、跨平台渲染不一、不跟随主题色。
 * 2026-09-19 收口时清理了 8 处（输入框技能触发器与 chip 的 ⚡、清空按钮 ✕、记忆卡按钮
 * ✕/✎、续接 chip ↻、step 锚点 📍、连接测试 ✅/❌、技能空态 📁），并剪除 toolNameMap 的
 * 24 键 emoji 表。本守卫防其回潮：**代码**中出现字符图标即红。
 *
 * **判据边界（有意为之，勿随意扩大）**：
 *   · 注释里的符号不管——不渲染进 DOM，且项目文风以 ⚠️ 作警示标记（如「⚠️ 勿回退」）；
 *   · 语义箭头 `→ ← ↔ ⇒` 不管——表意（「A → B」）而非图标；故 U+2190–21FF 整体放行，
 *     仅把循环箭头 `↺ ↻`（U+21BA/21BB，属图标性质）拦下；
 *   · CSS `content` 的单色几何字符（`▾ ▸ · ▋`）不管——它们跟随 `color`，不构成语言冲突，
 *     且 CSS content 无法承载 SVG；其中 `▾` 与 icons 的 `chevron-down` 语义重复已单独登记台账；
 *   · VS Code OutputChannel 的纯文本报告（`extension/commands/demo.ts` 的 `✓ ✖ ➤`）不管——
 *     文本通道无法渲染 SVG，且不在 webview 渲染面；
 *   · `×`（U+00D7）**不纳入禁止集**——同一字符在本项目兼作**语义乘号**（`工具×${n}`、
 *     `${label} ×${count}`、`×1000` 注释），字符本身无法区分「图标」与「乘号」。3 处图标用途
 *     （待发送条目删除 / 技能 chip 移除 / 团队弹窗关闭）已于 2026-09-19 人工改为 close SVG，
 *     此后靠人工审查覆盖——**已知判据盲区，明示不隐瞒**。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getIconSvg } from '../scripts/icons.js';

/** UI 渲染层根（webview 全量 + extension 侧生成 HTML 的 panels 均在 webview/ 下） */
const UI_ROOT = join(__dirname, '..');

/**
 * 禁止字符集：图形 emoji + 杂项装饰符号 + 图形符号补充 + 循环箭头 + 变体选择符。
 * 不含 U+2190–21FF 语义箭头，不含 U+2500 段几何字符（见文件头「判据边界」）。
 */
const FORBIDDEN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{21BA}\u{21BB}\u{FE0F}]/u;

/** 递归收集 UI 层源码（排除测试目录与测试文件本身） */
function collectUiSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      collectUiSources(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 剔除行尾注释（词法扫描：引号/模板串内的 `//` 不算注释起点，保护 URL 与正则字面量）
 *
 * 只做「从 `//` 起截断」这一件事——不做完整解析，故嵌套模板串的 `${}` 内出现 `//` 时
 * 可能提前截断（**只会漏检、不会误报**，方向安全）。
 */
function stripTrailingComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '`') inTemplate = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '`') inTemplate = true;
    else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** 扫描 UI 层源码，返回所有「代码中出现字符图标」的违规点 */
function findCharIcons(): { file: string; line: number; char: string }[] {
  const offenders: { file: string; line: number; char: string }[] = [];
  let scannedLines = 0;
  for (const file of collectUiSources(UI_ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((raw, idx) => {
      const trimmed = raw.trim();
      // 整行注释跳过（含 JSDoc / 块注释续行）
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const code = stripTrailingComment(raw);
      scannedLines++;
      const hit = code.match(FORBIDDEN);
      if (hit) {
        offenders.push({ file: file.slice(UI_ROOT.length + 1), line: idx + 1, char: hit[0] });
      }
    });
  }
  // 非空反向守卫：扫描面塌陷（路径错误 / 目录改名）立即红，防「空集假绿」
  expect(scannedLines, '扫描到的代码行数为 0——守卫的路径或提取逻辑已失效').toBeGreaterThan(500);
  return offenders;
}

describe('UI 图标语言 = icons.ts 的 SVG（字符图标守卫）', () => {
  it('代码中无字符图标（emoji / 装饰符号）——一律走 getIconSvg / data-icon', () => {
    const offenders = findCharIcons();
    const detail = offenders.map((o) => `${o.file}:${o.line} → "${o.char}"`).join('\n');
    expect(offenders, `以下位置在代码中使用了字符图标，应改用 icons.ts 的 SVG：\n${detail}`).toEqual([]);
  });

  it('图标单一真源在位：icons.ts 导出 getIconSvg 且被 UI 层消费', () => {
    const src = readFileSync(join(UI_ROOT, 'scripts', 'icons.ts'), 'utf8');
    expect(src, 'icons.ts 缺 getIconSvg 导出').toContain('export function getIconSvg');
    // 消费面至少覆盖 chatView 与 settingsView（2026-09-19 起 config/memory 亦接入）
    const consumers = collectUiSources(UI_ROOT).filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /from '[^']*icons\.js'/.test(s) && !f.endsWith('icons.ts');
    });
    expect(consumers.length, `引用 icons.js 的 UI 模块过少：${consumers.join(', ')}`).toBeGreaterThanOrEqual(3);
  });

  it('getIconSvg 产物可在 jsdom 下解析为 SVG 元素（所有 innerHTML 接入点的前提）', () => {
    // 接入面大量依赖 `el.innerHTML = getIconSvg(...)`——若 jsdom 不把字符串解析为 SVG
    // 元素，所有接入点会**静默变空**（tsc/守卫都不会报）。此断言锁死该前提。
    const host = document.createElement('span');
    host.innerHTML = getIconSvg('bolt', 11, 11);
    const svg = host.querySelector('svg');
    expect(svg, 'getIconSvg 产物无法解析为 <svg> —— 所有 innerHTML 接入点将静默变空').not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(svg!.getAttribute('stroke'), 'stroke 必须为 currentColor（跟随主题色的唯一途径）').toBe('currentColor');
    expect(svg!.getAttribute('width')).toBe('11');
  });
});
