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
 * 判据设计为**冻结式软门**而非「归零硬门」，理由（勿回改成硬门）：
 *   ① 存量债务 173 处是多年累积，一次性归零会逼出「为过门而乱改样式」的造伤式整改；
 *   ② 硬门一旦变红就必然被放宽，放宽过的门等于没有门；
 *   ③ 冻结式只挡**新增**，同时允许并鼓励下降 —— 每消化一处，基线自然下移。
 * 升档条件：当清单规模降到人工可核实的量级（例如 < 30），再改为硬门并随之收紧白名单。
 *
 * 反向守卫：先断言扫描到的声明总数，防止提取正则失效导致「空集恒过」的假绿。
 */
const STYLES_DIR = join(WEBVIEW_DIR, 'styles');

/** 豁免属性：非布局间距类，tokens 头部注释明文允许内联 */
const EXEMPT_PROPS = new Set([
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-width',
  'outline', 'outline-width', 'outline-offset',
  'box-shadow', 'text-shadow', 'transform', 'translate',
  'vertical-align', 'letter-spacing', 'word-spacing', 'stroke-width',
  'mask-image', '-webkit-mask-image',
]);

/**
 * 冻结基线：随消化进度**同步下调**，不是一次性定值。
 *   173 → 2026-10-11 初始值（排除豁免属性与 0 值后）
 *   127 → 收敛方形控件尺寸（新增 --sq-* 刻度，46 处）后
 *    79 → 收敛 padding/gap/margin 到间距刻度（新增 --sp-hair，48 处）后
 * 为何要跟着降：若基线停在初始值，消化出的 94 处会变成「可新增而不报错」的余额，
 * 等于给未来的裸值开了口子。门必须随债务一起往下走。
 * 升硬门条件：清单降到人工可核实的量级（例如 < 30）时，一并改为硬门并收紧白名单。
 */
const FROZEN_VALUE_BASELINE = 79;

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

  it('裸值债务冻结：不得高于基线（新增即红，下降不受限）', () => {
    const { violations } = collectValueViolations();
    if (violations.length > 0) {
      const byProp = new Map<string, number>();
      for (const v of violations) byProp.set(v.prop, (byProp.get(v.prop) ?? 0) + 1);
      const top = [...byProp].sort((a, b) => b[1] - a[1]).slice(0, 8);
      console.warn(
        `[值守卫] 存量为 ${violations.length} 处（基线 ${FROZEN_VALUE_BASELINE}）—` +
          ` 债务冻结中，新增即红、下降不受限。\n` +
          `[值守卫] 属性分布 TOP：${top.map(([p, n]) => `${p}=${n}`).join(', ')}`,
      );
    }
    expect(violations.length).toBeLessThanOrEqual(FROZEN_VALUE_BASELINE);
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
