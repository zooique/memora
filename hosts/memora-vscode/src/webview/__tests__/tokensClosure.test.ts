/**
 * 设计令牌闭合守卫 — tokens.ts「定义 ↔ 消费」双向闭合
 *
 * 背景：tokens.ts 是 webview 样式层令牌的单一真理源，
 * 但「定义」与「消费」两侧可能漂移，且两类漂移都不会被 tsc / eslint / 单测发现
 * （两侧都是 CSS 文本常量，类型系统看不见）：
 *
 *   ① 僵尸令牌：定义了却无人消费。随功能形态演进失去消费者后静默留存——
 *      实例：--brand-subtle / --status-info / --accent-subtle，以及「5 数据层分段着色」
 *      形态的 --occ-input/memory/output/rolepack（现为圆环充能形态，无消费者）；
 *   ② 幽灵令牌：样式引用了 tokens 未定义的令牌，只靠 `var(--x, 裸值)` 的 fallback 兜底
 *      → tokens 变更不跟随，令牌契约与视觉脱钩（实例：--accent-subtle 被 skillsStyles 引用）。
 *
 * 判据：
 *   - 可达集 = 从「真实消费点」出发，沿 tokens 定义链（`--a: var(--b)`）回溯能触达的令牌
 *     → 链式中转不算僵尸（如 --accent-soft 中转 --accent-bg-subtle 后无人用，才算僵尸）；
 *   - 僵尸 = 定义集 − 可达集；幽灵 = 消费集 − 定义集；
 *   - 白名单：--vscode-*（由 VS Code 主题注入，不属本仓定义域，两侧一律豁免）。
 *
 * 本文件同时是「反向守卫」的落点：两个非空断言防「提取逻辑失效 → 空集恒过」的假绿。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 本文件位于 src/webview/__tests__/ */
const HERE = dirname(fileURLToPath(import.meta.url));
const WEBVIEW_DIR = join(HERE, '..');
const SRC_DIR = join(HERE, '..', '..');
const TOKENS_PATH = join(WEBVIEW_DIR, 'styles', 'tokens.ts');

/** 主题注入域：VS Code 提供，不归本仓定义（双向豁免） */
const THEME_PREFIX = 'vscode-';

/** 递归列出 src 下的生产 .ts（跳过 __tests__，测试不构成真实消费点） */
function listProductionTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...listProductionTs(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 提取令牌定义名（覆盖「同一行多定义」：--sp-1: 4px; --sp-2: 6px;） */
function extractDefined(text: string): string[] {
  return [...text.matchAll(/--([a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]);
}

/** 提取令牌引用名（var(--x 与 var( --x 两种写法） */
function extractReferenced(text: string): string[] {
  return [...text.matchAll(/var\(\s*--([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

/** 解析 tokens.ts 的定义链：--a: <值含 var(--b)> → a → [b...] */
function buildDefinitionEdges(tokensText: string): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const line of tokensText.split('\n')) {
    const m = /--([a-zA-Z][\w-]*)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const targets = extractReferenced(m[2] ?? '').filter((t) => !t.startsWith(THEME_PREFIX));
    if (targets.length === 0) continue;
    edges.set(m[1], [...(edges.get(m[1]) ?? []), ...targets]);
  }
  return edges;
}

const tokensText = readFileSync(TOKENS_PATH, 'utf8');
const defined = new Set(extractDefined(tokensText));
const edges = buildDefinitionEdges(tokensText);

/** 真实消费点：除 tokens.ts 外的全部生产文件 */
const consumed = new Set<string>();
for (const file of listProductionTs(SRC_DIR)) {
  if (file === TOKENS_PATH) continue;
  for (const name of extractReferenced(readFileSync(file, 'utf8'))) {
    if (!name.startsWith(THEME_PREFIX)) consumed.add(name);
  }
}

/** 可达集：消费点 + 沿定义链回溯的全部中转令牌 */
const reachable = new Set(consumed);
const queue = [...consumed];
while (queue.length > 0) {
  const current = queue.pop() as string;
  for (const next of edges.get(current) ?? []) {
    if (reachable.has(next)) continue;
    reachable.add(next);
    queue.push(next);
  }
}

describe('设计令牌闭合守卫（tokens.ts ↔ 全样式层）', () => {
  it('提取口径有效（防提取失效导致的空集假绿）', () => {
    // 反向守卫：若提取正则或路径失效，下面两项立即变红，不会「因错误的原因通过」
    expect(defined.size).toBeGreaterThan(50);
    expect(consumed.size).toBeGreaterThan(50);
  });

  it('无僵尸令牌：tokens.ts 定义的每个令牌都可达（真实消费或定义链中转）', () => {
    const zombies = [...defined].filter((name) => !reachable.has(name)).sort();
    expect(zombies).toEqual([]);
  });

  it('无幽灵令牌：样式层引用的每个令牌都在 tokens.ts 有定义', () => {
    const ghosts = [...consumed].filter((name) => !defined.has(name)).sort();
    expect(ghosts).toEqual([]);
  });
});

/**
 * 值层面守卫 —— 补齐「令牌名闭合」之外的另一半
 *
 * 上一组守卫只比对**令牌名**（僵尸 / 幽灵），对**值**完全失明：样式文件里数百处
 * 裸 px 与裸颜色在测试全绿的情况下长期存在，直到人工盘点才暴露。本组补上这一半。
 *
 * 判据演进：初版为**冻结式软门**（`toBeLessThanOrEqual(基线)`，只挡新增、允许下降），
 * 理由是存量债务一次性归零会逼出造伤式整改；2026-10-12 清单降至 24（< 30 升档阈值）
 * ⇒ 按既定升档条件升级为**硬门** `toEqual(基线)`（A 类 4 + C 类 20，偏离即红）；
 * 同日晚些 A 类 4 处闭包为 tokens.ts 变体令牌（1:1 零视觉变化，枚举实证 24→20）
 * ⇒ 基线随债务降至 20，残余全为 C 类一次性维度。此后降基线必须带实测证据，
 * 禁「改数字造假绿」。
 *
 * Scope：仅扫 styles/ 目录（tokens.ts 定义处豁免）。webview JS 里的内联样式
 * （errorBoundary.ts 错误边界安全网）是**已登记例外**——安全网必须自包含，不依赖
 * 被守护系统的样式注入，裸值故意不入户；改动该文件前先读其处注释，勿顺手令牌化。
 *
 * 反向守卫：先断言扫描到的声明总数，防止提取正则失效导致「空集恒过」的假绿。
 */
const STYLES_DIR = join(WEBVIEW_DIR, 'styles');

/** 豁免属性：非布局间距类，tokens 头部注释明文允许内联
 * 2026-10-12 收紧白名单（升档注释 line 127「收紧白名单」授权）：定位偏移
 * top/bottom/left/right 是绝对定位元素的偏移量，非「间距刻度」取值，与已豁免的
 * transform/translate/vertical-align 同属定位类 ⇒ 一并豁免，不强制令牌化。 */
const EXEMPT_PROPS = new Set([
  'top',
  'bottom',
  'left',
  'right',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-width',
  'outline',
  'outline-width',
  'outline-offset',
  'box-shadow',
  'text-shadow',
  'transform',
  'translate',
  'vertical-align',
  'letter-spacing',
  'word-spacing',
  'stroke-width',
  'mask-image',
  '-webkit-mask-image',
]);

/**
 * 冻结基线：随消化进度**同步下调**，不是一次性定值。
 *   173 → 2026-10-11 初始值（排除豁免属性与 0 值后）
 *   127 → 收敛方形控件尺寸（新增 --sq-* 刻度，46 处）后
 *    79 → 收敛 padding/gap/margin 到间距刻度（新增 --sp-hair，48 处）后
 *    74 → 复核批次：5 处残留裸 border-radius（进度/特质条 2px ×3、开关轨道 22px ×2）全量消化后
 *    47 → 收敛内联图标与圆点尺寸（新增 --icon-* 六档 + --dot-lg 回归，14 处：9 内联图标 + 5 圆点）后（2026-10-12；实测 AXIS 弧净 diff 新增 icon 17 + dot 10）
 *    41 → 收紧白名单豁免定位偏移 top/bottom/left/right（与 transform/translate/vertical-align 同属定位类，非间距刻度；6 处：bottom 4 + left 2）后（2026-10-12）
 *    24 → 收敛大尺寸维度裸值（新增 --dim-* 六档中性刻度，17 处：280/320/160/60/40/360px，
 *         跨 width/height/max-width/max-height/min-width/min-height 复用）后（2026-10-12）。
 *         注：枚举脚本曾误报 19 处（把 calc(100vw - 48px) 里的 48px 当成独立消费者），
 *         经内容级 Grep 复核为 17 处 ⇒ 守护卫是 SSOT，脚本/文档计数须以其为准。
 *    20 → A 类 4 处 --dd-* 局部重定义闭包后（2026-10-12）：变体值升为 tokens.ts 具名
 *         变体令牌（--dd-trigger-max-w-narrow:120 / --dd-menu-min-w-wide:200）+
 *         model-picker 的 280 档复用 --dim-xl；.model-picker 的 --dd-trigger-max-w:200
 *         与 L3 定义重复，直接删。chatStyles 只留 var() 引用 ⇒ 1:1 零视觉变化。
 *         实证：闭包前后全量枚举 diff = 恰好这 4 处（24→20，残余与 C 类清单逐条一致）。
 *    22 → 自定义搜索引擎模块收口（2026-10-14）：.ce-* 新样式 10 处裸值中 8 处已令牌化
 *         （gap 6/8px→--sp-2/3、圆点 6px→--dot-md、标签位 32px→--sq-2xl、内距 10px→--sp-4、
 *         细边框拆 border-width 走边框宽度豁免），残余 2 处 C 类一次性维度逐条登记：
 *         settingsStyles .ce-summary `padding: 7px …`（摘要行上下内距，无 7px 档）、
 *         settingsStyles .ce-editor `border-top: 0.5px …`（border-top 不在边框宽度豁免属性内）。
 *         基线随实测同步（count-token-refs.mjs 机械真值），非放水：新增不登记即红。
 *    23 → 占用构成条（HOST-S3-2，2026-10-14）：chatStyles .context-segments `height: 4px`
 *         （分段比例条厚度，无对应刻度档——--dot-* 语义为圆点直径、--sq-* 下界 16px，均不适用）
 *         按 C 类一次性维度登记，与 .ce-summary 7px 同路径。
 *    26 → 会话大纲导航条（HOST-NAV-1，2026-10-20）：chatStyles .round-nav 段新增 3 处 C 类
 *         一次性维度逐条登记：条视觉厚 2px（.round-nav__bar::before height）+ 当前轮加粗 3px
 *         （.is-active::before height）+ 条端圆角 1px（border-radius；--radius-sm 2px 会把
 *         2px 高的条削成胶囊，失真）。可令牌化项已令牌化：触达高 12px→--sp-5、条宽 12px→--sp-5、
 *         浮层 160/320px→--dim-lg/--dim-2xl、条列横向 padding 2px→--sp-0、50vh/130%/0.12s 非 px 口径不入户。
 * 为何要跟着降：若基线停在初始值，消化出的 94+ 处会变成「可新增而不报错」的余额，
 * 等于给未来的裸值开了口子。门必须随债务一起往下走。
 * 现状（2026-10-20）：清单已至 26 ⇒ 硬门 toEqual(26)（见守卫断言）。
 * 残余 26 = C 类 26（一次性维度，显式硬门例外）；A 类 4 已于 2026-10-12 闭包（见上 20 行）。
 */
const FROZEN_VALUE_BASELINE = 26;

/** 剥离 var() 整体（含其 fallback），残留者才是真裸值 */
const stripVar = (v: string): string => v.replace(/var\(\s*--[\w-]+(\s*,[^)]*)?\)/g, '');

interface ValueViolation {
  file: string;
  prop: string;
  value: string;
}

/** 收集样式层的裸 px 违规（tokens.ts 是定义处，豁免） */
function collectValueViolations(): { violations: ValueViolation[]; scanned: number } {
  const violations: ValueViolation[] = [];
  let scanned = 0;
  for (const name of readdirSync(STYLES_DIR)) {
    if (!name.endsWith('.ts') || name === 'tokens.ts') continue;
    // 先剥离块注释：注释里的数值说明（如「参考值：56px」）不构成真实声明
    const text = readFileSync(join(STYLES_DIR, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]+);/g)) {
      scanned++;
      const prop = m[1]?.trim() ?? '';
      if (EXEMPT_PROPS.has(prop)) continue;
      const raw = stripVar(m[2] ?? '');
      for (const p of raw.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
        // 0 值无需令牌化（业界通行：零是结构性常量，不是刻度取值）
        if (p[1] === '0') continue;
        violations.push({ file: name, prop, value: `${p[1]}px` });
      }
    }
  }
  return { violations, scanned };
}

describe('设计令牌值守卫（裸值冻结 + 防新增）', () => {
  it('提取口径有效（防提取失效导致的空集假绿）', () => {
    const { scanned } = collectValueViolations();
    expect(scanned, '扫描到的 CSS 声明为 0——提取正则或路径已失效').toBeGreaterThan(500);
  });

  it('裸值债务硬门：必须等于 26（A 类 4 已闭包；残余 = C 类 26 一次性维度，偏离即红）', () => {
    const { violations } = collectValueViolations();
    if (violations.length > 0) {
      const byProp = new Map<string, number>();
      for (const v of violations) byProp.set(v.prop, (byProp.get(v.prop) ?? 0) + 1);
      const top = [...byProp].sort((a, b) => b[1] - a[1]).slice(0, 8);
      console.warn(
        `[值守卫] 存量 ${violations.length} 处（硬门 ${FROZEN_VALUE_BASELINE}）—` +
          ` 硬门已生效：必须等于 ${FROZEN_VALUE_BASELINE}，偏离（新增或误删）即红。\n` +
          `[值守卫] 属性分布 TOP：${top.map(([p, n]) => `${p}=${n}`).join(', ')}`,
      );
    }
    expect(violations.length).toEqual(FROZEN_VALUE_BASELINE);
  });
});

/**
 * fallback 一致性守卫 —— 堵住「第二套值」
 *
 * 病灶：样式文件普遍写成 `var(--x, Npx)`。当 N 与 tokens 里 --x 的定义不一致时，
 * 代码里就同时存在两套值：tokens 注入生效时用定义值，未注入时用 fallback 值。
 * 前者让 fallback 变成**骗人的死值**（读者以为间距是 2px，实际是 4px），
 * 后者会造成同一组件在不同面板的视觉不一致。
 *
 * 实测：本守卫上线前一次性查出 **88 处**漂移（如 `var(--sp-1, 2px)` 而定义是 4px、
 * `var(--radius-sm, 4px)` 而定义是 2px）——即旧报告 F5「靠人肉对齐」的真实代价。
 * 已全量修正，本条为防复发硬门：规则明确、无假阳性，故直接 fail 而非 warning。
 */
describe('设计令牌 fallback 一致性守卫（防第二套值）', () => {
  /** 从 tokens.ts 提取 px 单位的令牌定义（只管 px：颜色/复合值的定义形态不同，另行处理） */
  function collectPxDefinitions(): Map<string, string> {
    const defs = new Map<string, string>();
    for (const m of tokensText.matchAll(/--([\w-]+)\s*:\s*([\d.]+)px/g)) {
      if (!defs.has(m[1] ?? '')) defs.set(m[1] ?? '', `${m[2]}px`);
    }
    return defs;
  }

  it('样式层的 var(--x, Npx) 回退值必须与 tokens 定义一致', () => {
    const defs = collectPxDefinitions();
    const drift: string[] = [];
    let scanned = 0;
    for (const name of readdirSync(STYLES_DIR)) {
      if (!name.endsWith('.ts') || name === 'tokens.ts') continue;
      const text = readFileSync(join(STYLES_DIR, name), 'utf8');
      for (const m of text.matchAll(/var\(\s*--([\w-]+)\s*,\s*([\d.]+)px\s*\)/g)) {
        scanned++;
        const expected = defs.get(m[1] ?? '');
        if (expected === undefined || expected === `${m[2]}px`) continue;
        drift.push(`${name}: var(--${m[1]}, ${m[2]}px) 与定义 ${expected} 不一致`);
      }
    }
    // 反向守卫：扫不到任何带 px 回退的引用，说明提取口径已失效（空集恒过）
    expect(scanned, '未扫到任何 var(--x, Npx) 形式的引用——提取正则已失效').toBeGreaterThan(200);
    expect(
      drift,
      `以下回退值与 tokens 定义漂移（会形成第二套值，修法：把回退值改为定义值）：\n${drift.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * 颜色版 fallback 一致性守卫 —— 堵住「第三套值」
 *
 * 背景：上方 px 守卫只管 `var(--x, Npx)` 的数值回退。颜色回退 `var(--sp-x, <color>)`
 * 长期处于守卫盲区（见旧注释「颜色另行处理」）。实测（递归解析令牌定义最内层颜色后）
 * 曾存在 84 处漂移：强度随手写（如 `--surface-hover` 回退散落 .04/.08/.10/.2）、
 * 以及语义冲突（如 `--accent` 回退亮蓝 #4fc1ff vs 定义深蓝 #0e639c、--surface-code
 * 黑透明 vs 灰透明）。已全量对齐到令牌最内层颜色（耦合主路径下回退是死值，零视觉影响）。
 *
 * 判据形态与 px 守卫同构，但更强调「最内层颜色」：
 *   token 定义普遍是双层 `var(--vscode-y, INNER)`，样式回退只在该令牌整体缺失时生效，
 *   故回退应等于 INNER（令牌定义的第二跳），而非任意裸色——否则脱钩场景会出现
 *   「第三套值」与令牌定义不一致。
 * 反向守卫：扫不到足量颜色回退引用即说明提取口径失效（空集恒过）。
 */
function findVarsBalanced(str: string): { name: string; fb?: string }[] {
  const out: { name: string; fb?: string }[] = [];
  let i = 0;
  while (i < str.length) {
    if (str.startsWith('var(', i)) {
      const open = i + 3;
      let depth = 0;
      let j = open;
      for (; j < str.length; j++) {
        if (str[j] === '(') depth++;
        else if (str[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const inner = str.slice(open + 1, j);
      const comma = inner.indexOf(',');
      let name: string;
      let fb: string | undefined;
      if (comma === -1) {
        name = inner.trim();
        fb = undefined;
      } else {
        name = inner.slice(0, comma).trim();
        fb = inner.slice(comma + 1).trim();
      }
      if (name.startsWith('--')) name = name.slice(2);
      out.push({ name, fb });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

const colorDefs = new Map<string, string>();
for (const m of tokensText.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
  colorDefs.set(m[1], m[2].trim());
}

const colorInnermostMemo = new Map<string, string | undefined>();
function colorInnermost(name: string, stack = new Set<string>()): string | undefined {
  if (colorInnermostMemo.has(name)) return colorInnermostMemo.get(name);
  if (stack.has(name)) return undefined;
  stack.add(name);
  const raw = colorDefs.get(name);
  let result: string | undefined;
  if (!raw) {
    result = undefined;
  } else {
    const t = raw.trim();
    if (/^#([0-9a-fA-F]{3,8})\b$/.test(t) || (/^rgba?\(/.test(t) && t.endsWith(')'))) {
      result = t;
    } else {
      const vars = findVarsBalanced(raw);
      if (vars.length === 1) {
        const v = vars[0];
        if (v.name.startsWith('vscode-')) {
          result = v.fb;
        } else {
          const inner = colorInnermost(v.name, stack);
          result = inner !== undefined ? inner : v.fb;
        }
      } else {
        let fb: string | undefined;
        for (let k = vars.length - 1; k >= 0; k--) {
          if (vars[k].fb !== undefined) {
            fb = vars[k].fb;
            break;
          }
        }
        result = fb;
      }
    }
  }
  stack.delete(name);
  colorInnermostMemo.set(name, result);
  return result;
}

function normalizeColor(s: string): string {
  let r = s.trim().toLowerCase().replace(/\s+/g, '');
  if (r[0] === '#') {
    if (r.length === 4) r = '#' + r[1] + r[1] + r[2] + r[2] + r[3] + r[3];
    if (r.length === 5) r = '#' + r[1] + r[1] + r[2] + r[2] + r[3] + r[3];
    return r;
  }
  r = r.replace(/^rgba?\(/, 'rgba(');
  r = r.replace(/(^|[^\d.])\.(\d)/g, '$10.$2');
  return r;
}

describe('设计令牌颜色 fallback 一致性守卫（防第三套值）', () => {
  it('样式层的 var(--sp-x, <color>) 回退值须等于令牌最内层颜色', () => {
    const drift: string[] = [];
    let scanned = 0;
    for (const name of readdirSync(STYLES_DIR)) {
      if (!name.endsWith('.ts') || name === 'tokens.ts') continue;
      const text = readFileSync(join(STYLES_DIR, name), 'utf8');
      for (const m of text.matchAll(
        /var\(\s*--([\w-]+)\s*,\s*((?:#[0-9a-fA-F]{3,8}\b)|(?:rgba?\([^()]*(?:\([^()]*\))?[^()]*\)))\s*\)/g,
      )) {
        const tokenName = m[1];
        const fb = m[2];
        if (tokenName.startsWith('vscode-')) continue;
        scanned++;
        const target = colorInnermost(tokenName);
        if (target === undefined) continue; // 主题-only 令牌（定义无颜色回退），其 fallback 是唯一安全网，豁免
        if (normalizeColor(target) !== normalizeColor(fb)) {
          drift.push(`${name}: var(--${tokenName}, ${fb}) 与令牌最内层颜色 ${target} 不一致`);
        }
      }
    }
    // 反向守卫：扫不到足量颜色回退引用说明提取口径已失效
    expect(
      scanned,
      '未扫到任何 var(--sp-x, <color>) 形式的引用——提取正则或路径已失效',
    ).toBeGreaterThan(100);
    expect(
      drift,
      `以下颜色回退值与令牌最内层颜色漂移（脱钩场景会形成第三套值，修法：把回退值改为令牌最内层颜色）：\n${drift.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * 定义层守卫 —— tokens.ts 自己也要守「同变量同回退」
 *
 * 病灶：上列守卫都在比对「消费侧 ↔ 定义侧」，把 tokens.ts 当公理，于是**定义层自身的
 * 第二真理源**长期无人看管：同一个 --vscode-* 变量被多个令牌引用却配了不同 fallback
 * （2026-10-12 实测 8 组）。两类后果：
 *   ① 脱钩路径分裂：令牌未注入时，同族令牌渲染成互不一致的颜色（第三套值）；
 *   ② 更隐蔽的「主路径塌缩」：同变量 ⇒ 主路径恒同值，于是 --surface-inset（静态表面）
 *      与 --surface-hover / --surface-active（交互态）视觉无差别 ⇒ hover 与选中反馈在
 *      主路径失效。塌缩靠「对齐数值」治不好，只能换变量/换语义。
 *
 * 本次先合并**同义**令牌（--surface-normal→--surface-inset、--text-tertiary/--text-muted
 * →--text-secondary、--surface-tip→--surface-card、--surface-panel→--surface-sidebar、
 * --surface-inverse→--accent-foreground），8 组降到 5 组；真机验收后落地 LAYER-2 / WARN-1
 * ⇒ 3 组；最终批：border 三档（--border / --border-subtle 全部消费是容器描边，收进
 * --line-* 值令牌族后退役）+ 跨色系两组回退对齐（同引同值统一中性灰）⇒ **归零**。
 *
 * ⚠️ 基线必须随消化同步下调：停在旧值等于给未来新增开口子。基线 0 ⇒ 本门等效硬门
 * （任何新映射必须与同变量既有映射回退一致，或引新变量）。
 *
 * 反向守卫：断言扫到的定义层映射总量，防提取正则失效导致「空集恒过」的假绿。
 */
const DEFINITION_FROZEN_BASELINE = 0;

/** 回退可能是嵌套 var 降级链（--a: var(--vscode-x, var(--vscode-y, fb))）——取最内层兜底色比对，
 * 否则嵌套写法会被误判为与平面写法「不一致」（字符串级比较的假阳性）。 */
function fbInnermost(fb: string): string {
  const m = /^var\(\s*--[\w-]+\s*,\s*([\s\S]+)\)$/.exec(fb.trim());
  return m ? fbInnermost(m[1] ?? '') : fb.trim();
}

describe('设计令牌定义层守卫（同 --vscode-* 变量须同回退）', () => {
  interface DefEntry {
    token: string;
    fb: string;
  }

  /** 收集定义层映射：--token: var(--vscode-x, fb) —— 按变量聚组 */
  function collectDefinitionGroups(): Map<string, DefEntry[]> {
    const groups = new Map<string, DefEntry[]>();
    // 先剥块注释：注释里的示例定义（如折叠说明）不构成真实声明
    const text = tokensText.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      const token = m[1] ?? '';
      const head = findVarsBalanced(m[2] ?? '')[0];
      // 只认「首跳即主题变量」的映射；--a: var(--b, ...) 的链式令牌归值守卫管
      if (!head || !head.name.startsWith('vscode-') || head.fb === undefined) continue;
      const list = groups.get(head.name) ?? [];
      list.push({ token, fb: normalizeColor(fbInnermost(head.fb)) });
      groups.set(head.name, list);
    }
    return groups;
  }

  it('提取口径有效（防提取失效导致的空集假绿）', () => {
    let scanned = 0;
    for (const list of collectDefinitionGroups().values()) scanned += list.length;
    expect(scanned, '未扫到定义层的 --vscode-* 映射——提取正则已失效').toBeGreaterThan(40);
  });

  it('同变量不同回退的组数不得高于基线（新增即红，下降不受限）', () => {
    const inconsistent: string[] = [];
    for (const [vsc, list] of collectDefinitionGroups()) {
      if (new Set(list.map((e) => e.fb)).size <= 1) continue;
      inconsistent.push(`--${vsc}: ${list.map((e) => `--${e.token}=${e.fb}`).join(' | ')}`);
    }
    if (inconsistent.length > 0) {
      console.warn(
        `[定义层守卫] 同变量不同回退 ${inconsistent.length} 组（基线 ${DEFINITION_FROZEN_BASELINE}）—` +
          ` 债务冻结中，新增即红、下降不受限。\n${inconsistent.join('\n')}`,
      );
    }
    expect(inconsistent.length).toBeLessThanOrEqual(DEFINITION_FROZEN_BASELINE);
  });
});

/**
 * 各令牌族「消费引用数」反向守卫（根治批量统计失真 · 2026-10-12）
 *
 * 背景：AXIS-1 维度计数反复人肉失真——同一批数据在 CHANGELOG / 台账被手数成
 * 24→17、27→14、61→69 等多套互相矛盾的数字，连「订正」都在失真
 * （原稿 icon/dot 27 本正确，上一轮误改为 14）。根因：计数无机械化校验，
 * 全靠 grep 行数手加。本守卫把「各家族消费引用次数」钉死为单一机械真理，
 * CHANGELOG / 台账直接引此数，禁止手数。
 *
 * 口径：与 tokensClosure 既有逻辑一致——只数「消费点」（`styles/` 下除 tokens.ts 定义层外的
 * `var(--family` 出现次数，非行数；一行多引用计入多次）。数字经 scripts/count-token-refs.mjs 实锤，
 * 并经 AXIS 弧净 diff 交叉验证（迁移数 = 弧内新增）。
 *
 * 反向守卫双保险：① `count > 0` 防「提取失效→空集恒过」假绿（本项目已踩过）；
 * ② `count === expected` 精确钉死，任何提取回退 / 手数漂移当场红。
 */
describe('各令牌族消费引用数反向守卫（根治批量统计失真）', () => {
  const STYLES_DIR = join(WEBVIEW_DIR, 'styles');

  // 单一机械真理：当前消费引用次数（occurrence，非行数）。
  // 改 CHANGELOG / 台账前先跑仓库根 scripts/count-token-refs.mjs（路径以仓库根为基准）
  // 取此数，禁止手数。
  // dim- 于 2026-10-12 补登记（UI-TOKEN-RAW-3 复核发现）：--dim-* 六档随 B 类收口落地时
  // 漏钉 ⇒ 令牌互换类视觉变化（如 --dim-lg→--dim-xl）曾全门失明；新族必须同批登记。
  // 17→18：A 类闭包时 .model-picker 菜单 max-w 改引 var(--dim-xl)（复用刻度不造并列值）
  // ⇒ 新增 1 处 dim 消费者，本表随机械真值同步（该闭包提交的实测 diff）。
  // 18→19：活动时间线限高（.status-dock__timeline max-height: var(--dim-lg)，兑现
  // tokens.ts「活动详情面板高」注释）⇒ 新增 1 处 dim 消费者，同上随实测同步。
  // lh- 46→47：HOST-S3-1 记忆命中行 .memory-hits__item 行高 var(--lh-normal) 新增 1 处；
  // 47→48：HOST-S3-3 反馈按钮 .memory-hits__remove 行高 var(--lh-flat) 新增 1 处
  //（line- 69→70：.memory-hits__source 描边 var(--line-solid)），实数经
  // scripts/count-token-refs.mjs 实锤同步（2026-10-14）。
  // dim- 19→20：HOST-S3-2 占用构成条宽度 var(--dim-md)（.context-segments，复用「进度条
  // 最小宽」同用途域刻度）新增 1 处消费者，同上随实测同步（2026-10-14）。
  // dim- 20→19：占用构成条（HOST-S3-2）由状态行常驻移入圆环 hover 卡片底部
  // （.context-segments 宽度 var(--dim-md) → 卡片内 100%，同源信号不双渲染）⇒ 减少 1 处
  // dim 消费者，随 count-token-refs.mjs 机械实测同步（2026-10-18）。
  // line- 70→71：会话归档模式区（memoryStyles .archive-mode）分区描边 var(--line-solid)
  //（与 .governance 同构：顶部分隔线），实数经 scripts/count-token-refs.mjs 实锤同步
  // （2026-10-16 setArchiveMode 接线）。
  // line- 71→72：web_search 裁决证据块（.round-block__search-evidence）顶部分隔线
  // var(--line-solid)（与 .round-block__tool-summary 同层但加分隔），实数经
  // scripts/count-token-refs.mjs 实锤同步（2026-10-17 web_search_result 证据接入宿主重放）。
  // line- 74→75：本轮注入回执行（.context-ring__injection）卡片底部分隔线
  // border-top: var(--line-solid)（chatStyles）新增 1 处——CTX-4 真机反馈后徽记由状态行
  // 迁入圆环 hover 卡片（旧 .injection-badge 无 line 消费，净 +1），实数经
  // scripts/count-token-refs.mjs 实锤同步（2026-10-21）。
  // line- 75→76：活动指标空态指引（.activity-metrics-empty）顶部分隔线
  // border-top: var(--line-solid)（chatStyles）新增 1 处——showMetrics 默认关时解释
  // 「为什么空」，实数经 scripts/count-token-refs.mjs 实锤同步（2026-10-22）。
  // line- 76→78：MCP 选项卡样式（mcpStyles.ts）新增 2 处——页头 border-bottom + 工具行
  // border-top 分隔线（MCP 页首版零样式，2026-10-24 补 mcpStyles 时机械实测同步）。
  // lh- 49→50：MCP 页级说明段落（mcpStyles 的 #mcp-root .security-desc）改用
  // var(--lh-relaxed)——snug(1.5) 在 11px 中文长段落偏挤，真机截图反馈后机械实测同步
  // （2026-10-24，实数经 scripts/count-token-refs.mjs）。
  // lh- 50→51：MCP 隐藏条目解释行（mcpStyles 的 #mcp-root .mcp-omitted）同样用
  // var(--lh-relaxed)——它是最长的一句（配置条数 + 原因 + 指路输出面板），与页级说明同族；
  // 实数经 scripts/count-token-refs.mjs 机械实测同步（2026-10-24）。
  // z- 15（净不变，内部两移）：UI-TOAST-1 浮层化（chatStyles 的 .activity-bar.is-toast
  // z-index: var(--z-bar) +1）与 config 平行 toast 形态删除（configStyles 的
  // #config-root #toast z-index: var(--z-bar) -1）相抵；settingsStyles 的 .settings-toast
  // 由 z-overlay 改 z-bar 属同族内替换不计数。实数经 count-token-refs.mjs 实锤（2026-10-24）。
  // line- 78→79：UI-TOAST-1 活动条浮层形态（chatStyles 的 .activity-bar.is-toast
  // border: var(--line-solid)）新增 1 处，实数经 count-token-refs.mjs 实锤（2026-10-24）。
  const EXPECTED = {
    'z-': 16, // HOST-NAV-1：大纲条 var(--z-float)（chatStyles）+1（2026-10-20）；
    //          UI-TOAST-1：浮层 +1 / config 旧形态 -1 相抵（2026-10-24，净不变）；
    //          IMG-2：悬停预览浮层 .image-chip-tip 叠层 +1（2026-10-28，
    //          实数经 scripts/count-token-refs.mjs 实锤同步）
    'lh-': 51, // MEM-EVENT-2：工具行内命中徽章 line-height: var(--lh-flat)（chatStyles）+1；
    //             MCP 页级说明段落改 var(--lh-relaxed) +1（2026-10-24）
    //             MCP 隐藏条目解释行 var(--lh-relaxed) +1（2026-10-24）
    // 18：回到原值。中途曾 +2（🔒 未钉态 / ✕ 弱化态各用 opacity: var(--op-6)），后经真机
    // 实测废掉该做法——**弱化只用降色、不用降透明度**（半透明图标观感像没渲染好/被禁用），
    // 二态改由「形状 + 颜色」两个明确通道承载；实数经 scripts/count-token-refs.mjs 实锤。
    // 19：IMG-2 Q3 上传按钮置灰态 .image-attach-btn.is-vision-off opacity: var(--op-3)
    // +1（2026-10-28）——置灰 = 禁用态语义（op-3 的既有语义位），非「弱化装饰」。
    'op-': 19,
    'icon-': 17,
    'dot-': 22,
    'line-': 83, // MEM-EVENT-2：工具行内命中块 border-top: var(--line-solid)（chatStyles）+1；
    //             HOST-NAV-1：大纲条浮层 border: var(--line-input)（chatStyles）再 +1（2026-10-20）；
    //             CTX-4 真机反馈：本轮注入回执行 .context-ring__injection 分隔线 +1（2026-10-21）；
    //             指标空态指引 .activity-metrics-empty 分隔线 +1（2026-10-22）；
    //             MCP 选项卡 mcpStyles（页头 border-bottom + 工具行 border-top）+2（2026-10-24）；
    //             UI-TOAST-1：活动条浮层 .activity-bar.is-toast 描边 +1（2026-10-24）；
    //             MCP-S1：远程标记 .mcp-server-tag 描边 +1（2026-10-25）；
    //             IMG-2：悬停预览浮层 .image-chip-tip 描边（var(--line-input)）+1（2026-10-28）；
    //             IMG-2 Q3：上传按钮 .image-attach-btn 描边 + hover 描边（var(--line-solid)）+2
    //             （2026-10-28，实数经 scripts/count-token-refs.mjs 实锤同步）
    'sq-': 49, // IMG-2 Q3：上传按钮 .image-attach-btn 尺寸 var(--sq-xl)/var(--sq-lg) +2
    //           （2026-10-28，实数经 scripts/count-token-refs.mjs 实锤同步）
    'dim-': 25, // HOST-NAV-1：大纲条浮层 min-width/max-width 改引 var(--dim-lg)/var(--dim-2xl) +2（2026-10-20）；
    //             UI-CONFIRM-FIT-1：审批卡 max-height 引 var(--dim-2xl)（替代裸值 420px）+1（2026-10-22）；
    //             IMG-2：悬停预览 3 处（浮层 max-width + 预览图 max-width/max-height，均复用
    //             var(--dim-2xl) 的「提示卡最大宽高」既有语义）+3（2026-10-28，
    //             实数经 scripts/count-token-refs.mjs 实锤同步）
  } as const;

  for (const family of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
    const expected = EXPECTED[family];
    it(`var(--${family} 消费引用须精确等于 ${expected}（禁止手数，CHANGELOG 引此数）`, () => {
      const re = new RegExp(`var\\(--${family}`, 'g');
      let count = 0;
      for (const name of readdirSync(STYLES_DIR)) {
        if (!name.endsWith('.ts') || name === 'tokens.ts') continue;
        const text = readFileSync(join(STYLES_DIR, name), 'utf8');
        const m = text.match(re);
        if (m) count += m.length;
      }
      // 反向守卫：确保真扫到引用（防提取正则失效→空集恒过假绿）
      expect(count, `未扫到任何 var(--${family} 引用——提取口径已失效`).toBeGreaterThan(0);
      // 精确钉死：任何提取回退 / 计数漂移当场红
      expect(count, `var(--${family} 消费引用数漂移（CHANGELOG 须与此一致，禁止手数）`).toBe(
        expected,
      );
    });
  }
});
