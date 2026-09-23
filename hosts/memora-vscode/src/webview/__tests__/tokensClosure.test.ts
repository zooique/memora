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
