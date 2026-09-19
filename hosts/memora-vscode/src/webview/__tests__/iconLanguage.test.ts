// @vitest-environment jsdom
/**
 * 图标语言守卫（2026-09-19）——UI 渲染层禁止出现「字符图标」
 *
 * **背景**：项目图标语言唯一 = `webview/scripts/icons.ts` 的 Trae 柔和线条 SVG
 * （`stroke=currentColor` / `stroke-width=1.5` / 圆端 / 用 CSS 控尺寸）。字符图标
 * （emoji 与装饰符号）是**第二套语言**：彩色像素图、跨平台渲染不一、不跟随主题色。
 * 2026-09-19 收口时清理了 8 处（输入框技能触发器与 chip 的 ⚡、清空按钮 ✕、记忆卡按钮
 * ✕/✎、续接 chip ↻、step 锚点 📍、连接测试 ✅/❌、技能空态 📁），并剪除 toolNameMap 的
 * 24 键 emoji 表。同日 HOST-S8 追加收口 3 处（plan-bar 折叠指示 ▸/▾ → `applyIcon`、
 * dropdown 默认触发器 ⋯ → `getIconSvg('ellipsis')` **内联**自足 SVG；另补齐缺失的
 * `chevron-right`、删零消费的 `chevron-up`），并将下述三个**逃逸**字符点名纳入禁止集。
 * 本守卫防其回潮：**代码**中出现字符图标即红。
 *
 * **判据边界（有意为之，勿随意扩大）**：
 *   · 注释里的符号不管——不渲染进 DOM，且项目文风以 ⚠️ 作警示标记（如「⚠️ 勿回退」）；
 *   · 语义箭头 `→ ← ↔ ⇒` 不管——表意（「A → B」）而非图标；故 U+2190–21FF 整体放行，
 *     仅把循环箭头 `↺ ↻`（U+21BA/21BB，属图标性质）拦下；
 *   · CSS `content` 的几何字符——**两类语义不同，勿混为一谈**：
 *     (a) `▾`(U+25BE) / `▸`(U+25B8)：**已点名纳入 FORBIDDEN**，但仅 `styles/` 层的
 *         `content` 行受**窄豁免**放行（伪元素**无法持有 DOM 节点** → 字形不可能换成
 *         <svg>）。豁免面由下方守卫以**结构性约束**锁死（须在 `styles/`、值须 ≤1 字符）。
 *         现存于 dropdown capsule caret / roles details summary 两处（描述性快照，**非
 *         处数断言**——处数随 UI 需求漂移、无 SSOT，写死即每改一次过期一次），经 HOST-S8
 *         裁决保留：把指示器搬进 HTML 需改 dropdown/roles 组件契约，收益不抵成本；
 *     (b) `·`(U+00B7) / `▋`(U+258B)：**完全未纳入 FORBIDDEN**，任何层均放行（排版分隔 /
 *         流式光标，代码侧 30+ 处在用，纳入即大面积误报）；
 *   · **逃逸已点名收口（HOST-S10 部分闭环，2026-09-19）**：禁止集是**黑名单**式，无法
 *     枚举「图标性字符」全集。实证：`▸`(U+25B8) / `▾`(U+25BE) / `⋯`(U+22EF) 三者
 *     **均不在**原区间内（落在 `2600–27BF` 之外）——即 `chatView.ts` 原先的 `'▾':'▸'`
 *     折叠指示器**从未被本守卫拦过**，其收口靠人工发现而非守卫。现已逐个点名纳入
 *     FORBIDDEN（全库重扫：命中 0→2，且 2 处全在 CSS content → 被上条豁免）；
 *     但 `·`(U+00B7) / `▋`(U+258B) **不纳入**——代码侧 30+ 处在用（排版分隔、单位、
 *     流式光标），纳入即大面积误报。残余盲区仍存（黑名单永远漏），CSS 侧判据的稳健
 *     方向是反转为**白名单**（`content` 非空仅允许 `''`/`'·'`/`'▋'`）——本次先以结构性
 *     约束控住豁免面，未动白名单化（改判据须带观测与退出条件）；
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
 * 禁止字符集：图形 emoji + 杂项装饰符号 + 图形符号补充 + 循环箭头 + 变体选择符，
 * 并**逐个点名**三个曾逃逸出区间的图标性字符：`▸`(U+25B8) / `▾`(U+25BE) / `⋯`(U+22EF)。
 * 不含 U+2190–21FF 语义箭头；`·`(U+00B7) / `▋`(U+258B) 属排版分隔与流式光标且代码侧
 * 30+ 处在用，**不纳入**（见文件头「判据边界」）。
 */
const FORBIDDEN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{21BA}\u{21BB}\u{FE0F}\u25B8\u25BE\u22EF]/u;

/**
 * CSS `content` 值豁免（HOST-S8 裁决保留的 2 处）：伪元素**无法持有 DOM 节点**，
 * 故其字形不可能换成 <svg>。豁免面由下方守卫以**结构性约束**锁死（须在 styles/、值须单字符），
 * 不锁数字——数字无 SSOT，每改即过期。
 */
const CSS_CONTENT_ROW = /content:\s*['"][^'"]*['"]/;

/** 样式层目录前缀（路径已正斜杠归一后比较） */
const STYLE_LAYER = 'styles/';

/** 相对 UI_ROOT 的路径，统一正斜杠——Windows 下 join 产出反斜杠，直接 startsWith 会恒 false */
const relPath = (f: string): string => f.slice(UI_ROOT.length + 1).split('\\').join('/');

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
    const rel = relPath(file);
    // 豁免只在样式层生效：JS 对象属性也叫 content（`post({ content: '' })`），
    // 若全局豁免，那种行里的字符图标会被静默放过
    const styleLayer = rel.startsWith(STYLE_LAYER);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((raw, idx) => {
      const trimmed = raw.trim();
      // 整行注释跳过（含 JSDoc / 块注释续行）
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const code = stripTrailingComment(raw);
      scannedLines++;
      // CSS content 值豁免——伪元素无法持有 DOM 节点（详见 CSS_CONTENT_ROW 注释）
      if (styleLayer && CSS_CONTENT_ROW.test(code)) return;
      const hit = code.match(FORBIDDEN);
      if (hit) {
        offenders.push({ file: rel, line: idx + 1, char: hit[0] });
      }
    });
  }
  // 非空反向守卫：扫描面塌陷（路径错误 / 目录改名）立即红，防「空集假绿」。
  // 此为**单调安全下限**（源码行数只增不减，实际量级远高于此），与上文「不锁处数」不冲突：
  // 处数断言会随 UI 需求漂移（每改即过期），行数下限只会随代码增长而更宽松、不会假红。
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

  it('CSS content 豁免面结构受控（防漏检面膨胀 / 防豁免逻辑失效）', () => {
    const exemptRows: { path: string; value: string }[] = [];
    for (const file of collectUiSources(UI_ROOT)) {
      const rel = relPath(file);
      // 豁免面只在样式层统计：JS 对象属性也叫 content（`post({ content: '' })`），不是 CSS
      if (!rel.startsWith(STYLE_LAYER)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((raw) => {
        const trimmed = raw.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        const m = stripTrailingComment(raw).match(CSS_CONTENT_ROW);
        if (m) exemptRows.push({ path: rel, value: m[0] });
      });
    }
    // 非空反向守卫：豁免正则失效时立即红——否则被豁免的字形会被静默放行
    expect(exemptRows.length, 'CSS content 豁免行为 0——正则或提取逻辑已失效').toBeGreaterThan(0);
    // 结构性约束：content 值至多 1 个字符——防有人塞长串/SVG 借豁免绕过
    expect(
      exemptRows
        .filter((r) => Array.from(r.value.replace(/^content:\s*['"]|['"]$/g, '')).length > 1)
        .map((r) => `${r.path} → ${r.value}`),
      'content 值必须至多单字符（防借豁免塞入 SVG/长串）',
    ).toEqual([]);
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
