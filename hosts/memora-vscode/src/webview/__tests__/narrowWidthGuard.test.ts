/**
 * 窄宽度兜底守卫（IMG-12）—— 「浮层宽度上限不随视口收缩」这一类伤的机器判据
 *
 * 背景：Webview 侧栏宽度**完全由用户拖动决定**，扩展 API 侧没有任何读/写/约束通道
 * （`WebviewView` / `WebviewOptions` / `WebviewPanelOptions` 均无宽度成员，见
 *  `@types/vscode` 类型定义）。因此「给内容一个最小宽度」在平台层不可能实现，
 *  唯一可行的方向是**内容自己带兜底**：宽度上限必须能随视口收缩。
 *
 * 该类伤在同一个仓库已复发三次，且每次都是靠人肉 grep 事后发现：
 *   ① 正文缩略图 `.msg-attachment`（IMG-7，固定 280 上限）；
 *   ② 输入区浮层 `.image-chip-tip`（IMG-11，固定 320 上限）；
 *   ③ 本轮一次性扫出四处同族未修面（`.round-nav__list` / `.context-ring__tip` /
 *      `.session-history .treedd__menu` 的 min 压 max / `.treedd__menu` 只有下限没有上限）。
 * 三次的共同根因不是「某处写错」，而是**没有任何机器判据能发现第四处**。
 *
 * 判据：宽度类硬约束声明（`min-width` / `max-width`）若其固定尺寸达到面板级
 * （≥ `--dim-lg` = 160px），必须带兜底关键词（`min()` / `max()` / `clamp()` / `%` / `vw` / `vh`）；
 * 否则必须进 `EXEMPT` 豁免表并写明「为什么它的布局上下文使它不会溢出」。
 *
 * 为什么不区分浮层：宽度声明与定位声明可以分离——父级 `position: absolute` 而子级定宽
 * （`.round-nav__list` 之于 `.round-nav__panel`），或跨文件覆写（`.treedd__menu` 由
 * `chatStyles` 覆写 `dropdown` 的基础样式）。按「同块内出现 position」筛选会同时漏报这两类。
 *
 * 为什么只判 `min-width` / `max-width` 而不判 `width`：`width` 是期望宽度，块级元素的
 * `width: auto` 会被父级限制、`width: 90%` 本身是相对值；能突破父级约束的是 min/max。
 *
 * 反向守卫：先断言扫描到的声明总数（防提取正则失效导致空集恒过）；再断言豁免表无僵尸
 * （元素改名后残留的豁免键会掩盖真实回归——与仓库「僵尸容器拒入库」同一纪律）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 本文件位于 src/webview/__tests__/ */
const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES_DIR = join(HERE, '..', 'styles');
const TOKENS_PATH = join(STYLES_DIR, 'tokens.ts');

/** 面板级尺寸阈值：--dim-lg = 160px。低于此的固定宽在平台 sash 下限以上永远装得下 */
const PANEL_SCALE_PX = 160;

/** 兜底形态：任选其一即视为随视口/容器自适应 */
const HAS_FALLBACK = /(min\(|max\(|clamp\(|%|vw|vh)/;

interface WidthDecl {
  file: string;
  selector: string;
  prop: string;
  value: string;
  /** 该声明可能达到的最大固定像素值（裸 px / var fallback / 令牌查表三者取最大） */
  px: number;
}

/**
 * 豁免表：键 = `文件 :: 选择器 :: 属性 = 值`，值 = 为什么它的布局上下文不会溢出。
 *
 * 键里带完整值 ⇒ **改值也会红**（改宽度等于重新判定风险，必须重新走一遍理由）。
 * 键里带选择器 ⇒ 元素改名后本表变僵尸，由「豁免无僵尸」用例当场揪出。
 */
const EXEMPT: Record<string, string> = {
  'chatStyles.ts :: .empty-state :: max-width = var(--dim-2xl)':
    '块级元素 + margin:auto：width:auto 本就会填满父级，max-width 只封顶不撑宽；文本可换行',
  'chatStyles.ts :: .capability-badge :: max-width = var(--dim-lg)':
    'inline-flex 正常流：flex-shrink 默认可收缩，且内容为单行徽章文本会 ellipsis',
  'chatStyles.ts :: .skill-chip :: max-width = 220px':
    'flex:0 0 auto 确实不收缩，但所在 .skill-chip-row 自带 overflow-x 滚动容器，溢出被行裁住、不产生面板级横向滚动条',
  'configStyles.ts :: #config-root .modal :: max-width = var(--dim-3xl)':
    '同块已声明 width:90%：百分比先行决定宽度，max-width 仅在宽容器里封顶；配置弹窗不驻留侧栏',
  'dropdown.ts :: .treedd--capsule .treedd__trigger :: max-width = var(--dd-trigger-max-w, 200px)':
    'inline-flex 正常流触发器：内部 span.dd-trigger-name 负责 ellipsis，且父级 flex 可压缩',
  'settingsStyles.ts :: .security-select :: max-width = var(--dim-xl)':
    '原生 select（inline 语义、宽度随内容）+ 设置面板是编辑器标签页单例，不驻留侧栏',
};

/** 令牌 → 像素值（覆盖同一行多定义：`--sp-1: 4px; --sp-2: 6px;`） */
function buildTokenPxMap(): Map<string, number> {
  const map = new Map<string, number>();
  const text = readFileSync(TOKENS_PATH, 'utf8');
  for (const m of text.matchAll(/--([a-zA-Z][\w-]*)\s*:\s*(\d+(?:\.\d+)?)px/g)) {
    map.set(m[1] as string, Number(m[2]));
  }
  return map;
}

/** 提取声明可能达到的最大固定像素值 */
function maxFixedPx(value: string, tokenPx: Map<string, number>): number {
  let max = 0;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)px/g)) max = Math.max(max, Number(m[1]));
  for (const m of value.matchAll(/var\(\s*--([\w-]+)\s*\)/g)) {
    const v = tokenPx.get(m[1] as string);
    if (v !== undefined) max = Math.max(max, v);
  }
  return max;
}

/** 扫描全部样式文件（tokens.ts 是定义处，不构成布局声明） */
function collectWidthDecls(): WidthDecl[] {
  const tokenPx = buildTokenPxMap();
  const out: WidthDecl[] = [];
  for (const name of readdirSync(STYLES_DIR)) {
    if (!name.endsWith('.ts') || name === 'tokens.ts') continue;
    // 先剥离块注释：注释里的数值说明与示例不构成真实声明
    const text = readFileSync(join(STYLES_DIR, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // 只取最内层规则块（`@media` 包裹的内层规则同样能命中，外层因含 `{` 不满足 `[^{}]*` 被跳过）
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ').split('\n').pop()?.trim() ?? '';
      const body = m[2] ?? '';
      for (const d of body.matchAll(/(min-width|max-width)\s*:\s*([^;{}]+)/g)) {
        const value = (d[2] ?? '').trim();
        out.push({
          file: name,
          selector,
          prop: d[1] as string,
          value,
          px: maxFixedPx(value, tokenPx),
        });
      }
    }
  }
  return out;
}

const decls = collectWidthDecls();
const keyOf = (d: WidthDecl): string => `${d.file} :: ${d.selector} :: ${d.prop} = ${d.value}`;

describe('窄宽度兜底守卫（IMG-12）', () => {
  it('提取口径有效（防提取失效导致的空集假绿）', () => {
    // 反向守卫：正则或路径一旦失效，这里先红，不会「因错误的原因通过」
    expect(decls.length).toBeGreaterThan(40);
    expect(decls.some((d) => d.prop === 'max-width')).toBe(true);
    expect(decls.some((d) => d.prop === 'min-width')).toBe(true);
  });

  it('面板级尺寸的宽度硬约束必须带视口/相对兜底，或登记豁免', () => {
    const unguarded = decls
      .filter((d) => !HAS_FALLBACK.test(d.value) && d.px >= PANEL_SCALE_PX)
      .filter((d) => !(keyOf(d) in EXEMPT))
      .map((d) => `${keyOf(d)}  [px=${d.px}]`)
      .sort();
    expect(unguarded).toEqual([]);
  });

  it('豁免表无僵尸：登记的键必须仍对应真实的宽度声明', () => {
    const live = new Set(decls.map(keyOf));
    const zombies = Object.keys(EXEMPT)
      .filter((k) => !live.has(k))
      .sort();
    expect(zombies).toEqual([]);
  });

  it('兜底表无空理由：每条豁免都必须写明为什么不会溢出', () => {
    const empty = Object.entries(EXEMPT)
      .filter(([, why]) => why.trim().length < 10)
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });
});
