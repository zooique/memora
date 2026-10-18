/**
 * 文档-代码一致性守卫（GUARD-METHOD-1 · 面 A + 面 C）。
 *
 * 立此守卫的血训（2026-10-18 实测）：四批删 API（PUB-API-PRUNE-2/3 + PR-SWITCH-1/2）之后，
 * 靠人工 grep 扫「叙述载体」，**同一轮内三种文档形态各漏一次**——
 *   ① 表格相对路径：`module-inventory.md` 仍列已删的 `memory/projectRegistry.ts`；
 *   ② 接口代码块：`api-reference` §5.3 的 `ISessionStore` 只有 3 个方法且有幻影 `appendMessage`；
 *   ③ 字段散文：§2.6 `projectName` 仍写「从注册表读取」。
 * 结论：人工扫描只能覆盖一种形态，必须按形态各立一面机器夹。
 *
 * **两面分工**：
 * - 面 A（本文件 `模块清单存在性`）：模块清单里承诺的 `.ts` 必须存在于磁盘。抓「删了模块没删清单」。
 * - 面 C（本文件 `手册公开成员引用`）：手册里 `agent.X` 必须在公开成员面基线内。抓「删了成员没删手册」。
 *
 * **面 A 的形态覆盖（2026-10-18 二次加固）**：
 * 首版只匹配「表格**第一列**是 `x/y.ts`」的行 ⇒ 同一份清单里三种形态全部逃逸，实测漏检 3 处
 * （`utils/recallDefaults.ts` 的：第 2 列打磨推荐表、散文「无测试的 N 个文件」、计数行）。
 * 根因不是正则写错，是**自检只数「匹配到几条」，不数「有几条没被匹配」**——覆盖率 ≠ 完备性。
 * 现改为：
 *   ① 匹配范围 = 文档**任意位置**的反引号 `.ts` 路径（表格 / 散文 / 列表 / 块引用一律扫）；
 *   ② 唯一豁免 = **历史语境块**（`>` 开头且含「补记 / 历史留痕 / 深度剪枝 / 已删除 / 已随 / 已出列 / 退役」）——
 *      那些行按定义就是「记一个已不存在的文件」，不是承诺；
 *   ③ 自检改为**反向**：先统计全文 `.ts` 路径总数，再断言「被检查数 = 总数 − 豁免数」，任何
 *      一条既没被检查也没被豁免，用例直接红（`uncovered`）——这才是「守卫是否失明」的判据。
 *   ④ 解析能力扩展：支持 `src/` / `hosts/` 全路径前缀；`__tests__/x.test.ts` 按 basename 全仓查找
 *      （测试文件散落在各模块目录下，无法靠前缀推断）。
 *
 * **已知边界（诚实登记，勿默认为已覆盖）**：
 * - 面 B（接口代码块成员集 vs 源码 interface）**已落**，见 `docInterfaceGuard.test.ts`。
 * - 两个面都只夹「存在性 / 引用 / 成员集」，不夹「语义是否说谎」——`bootstrapMemories` 写着
 *   「启动时加载」实则恒为空数组，这种**散文级语义漂移**机器判不了，仍靠人工审查。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INVENTORY = join(ROOT, 'docs', 'architecture', 'module-inventory.md');
const API_REFERENCE = join(ROOT, 'docs', 'memora-api-reference.md');
const GUARD_FILE = join(ROOT, 'src', '__tests__', 'publicMemberSurfaceGuard.test.ts');

/** 模块清单里的路径可能是相对 src/、相对 src/agent/、或相对宿主 src/——逐个试 */
const MODULE_PREFIXES = ['', 'src', join('src', 'agent'), join('hosts', 'memora-vscode', 'src')];

/**
 * 历史语境判据：`>` 开头的块引用行，且明说这是「已删除 / 已退役 / 补记」。
 * 这些行按定义会提到不存在的文件，属**留痕**而非**承诺**。
 * 收紧方向：宁可漏放（把承诺当留痕而放过）也不误伤——但漏放必须能被下面的 uncovered 自检看见。
 */
const LEGACY_CONTEXT = /(补记|历史留痕|深度剪枝|已删除|已随|已出列|整链退役|不再计入)/;

function isLegacyProse(line: string): boolean {
  const t = line.trim();
  return t.startsWith('>') && LEGACY_CONTEXT.test(t);
}

/** 递归找同名文件（__tests__ 类路径无法靠前缀推断） */
const basenameCache = new Map<string, boolean>();
function existsByBasename(rel: string): boolean {
  const base = basename(rel);
  const cached = basenameCache.get(base);
  if (cached !== undefined) return cached;
  const stack = [join(ROOT, 'src'), join(ROOT, 'hosts', 'memora-vscode', 'src')];
  let found = false;
  while (stack.length > 0 && !found) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (['node_modules', 'dist', 'coverage'].includes(e.name)) continue;
        stack.push(join(dir, e.name));
      } else if (e.name === base) {
        found = true;
        break;
      }
    }
  }
  basenameCache.set(base, found);
  return found;
}

function moduleExists(rel: string): boolean {
  if (rel.includes('__tests__/')) return existsByBasename(rel);
  return MODULE_PREFIXES.some((p) => existsSync(join(ROOT, p, rel)));
}

/**
 * Agent 公开面允许出现、但不在 EXPECTED 里的名字。
 * `on` / `off` / `once` 来自 `TypedEventEmitter` 继承（手册 §2.7 明写「Agent 继承
 * TypedEventEmitter<AgentEventMap>」），属合法公开面但不在成员守卫的类自身声明里。
 */
const INHERITED_MEMBERS = new Set(['on', 'off', 'once']);

/** 逐行标记：历史留痕块（`> 历史留痕…` 起的连续 blockquote）内的引用不算承诺 */
function legacyLines(text: string): boolean[] {
  const lines = text.split(/\r?\n/);
  const flags: boolean[] = [];
  let inLegacy = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^>\s*\*{0,2}历史留痕/.test(t)) {
      inLegacy = true;
      flags.push(true);
      continue;
    }
    if (inLegacy && /^>/.test(t)) {
      flags.push(true);
      continue;
    }
    inLegacy = false;
    flags.push(false);
  }
  return flags;
}

/** 从 publicMemberSurfaceGuard 的 EXPECTED 里读 Agent 成员（单一真源，不另抄一份） */
function agentMembers(): Set<string> {
  const text = readFileSync(GUARD_FILE, 'utf8');
  const body = text.slice(text.indexOf('const EXPECTED'));
  const block = body.slice(body.indexOf('Agent: {'), body.indexOf('UIMessages: {'));
  const names = [...block.matchAll(/^ {6}'([^']+)',/gm)]
    .map((m) => m[1])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.replace(/^(get|set) /, ''));
  return new Set(names);
}

describe('文档-代码一致性守卫（GUARD-METHOD-1 · 面 A + 面 C）', () => {
  it('面 A · 模块清单承诺的 .ts 必须存在（任意形态全覆盖）', () => {
    const lines = readFileSync(INVENTORY, 'utf8').split(/\r?\n/);
    const allRefs: { rel: string; line: number; legacy: boolean; firstCol: boolean }[] = [];
    lines.forEach((line, i) => {
      const firstCol = /^\|\s*`(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.ts`/.test(line);
      for (const m of line.matchAll(/`((?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.ts)`/g)) {
        const rel = m[1];
        if (!rel) continue;
        allRefs.push({ rel, line: i + 1, legacy: isLegacyProse(line), firstCol });
      }
    });
    const checked = allRefs.filter((r) => !r.legacy);
    const missing = checked
      .filter((r) => !moduleExists(r.rel))
      .map((r) => `第 ${r.line} 行：${r.rel}`);

    // ① 解析失明守卫：全文路径引用量骤降 ⇒ 正则或文档形态变了
    expect(allRefs.length, '清单 .ts 路径引用异常偏少——解析可能失明').toBeGreaterThan(80);
    // ② 豁免面守卫：历史留痕行不得吞噬正文（豁免过半即视为判据过宽）
    expect(
      allRefs.length - checked.length,
      `历史语境豁免了 ${allRefs.length - checked.length}/${allRefs.length} 条引用——` +
        `豁免判据（LEGACY_CONTEXT）过宽，正在把承诺当留痕放过。`,
    ).toBeLessThan(allRefs.length / 2);
    // ③ 形态覆盖实证：必须存在「非表格首列」被检查的路径，否则说明又退回只扫首列
    expect(
      checked.some((r) => !r.firstCol),
      '全部被检查路径都在表格首列——面 A 可能已退回「只扫首列」的旧实现（见文件头血训）。',
    ).toBe(true);
    // ④ 存在性
    expect(
      missing,
      `\n模块清单 ${missing.length} 条承诺无对应文件：\n${missing.map((s) => `  - ${s}`).join('\n')}\n` +
        `若模块确已删除：删清单行 + 在该行位置留「已删除」补记（须以「>」开头并含「补记/已删除」等词，\n` +
        `否则本守卫会继续把它当承诺）；若只是挪了位置：同步更新清单路径。`,
    ).toEqual([]);
  });

  it('面 C · 手册里的 agent.X 必须在 Agent 公开成员基线内（抓「删了成员没删手册」）', () => {
    const text = readFileSync(API_REFERENCE, 'utf8');
    const flags = legacyLines(text);
    const lines = text.split(/\r?\n/);
    const members = agentMembers();
    const refs = new Map<string, number[]>();
    lines.forEach((line, i) => {
      if (flags[i] === true) return; // 历史留痕块：明写「5.0.0 前曾有」，不算承诺
      for (const m of line.matchAll(/agent\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
        const name = m[1];
        if (!name || INHERITED_MEMBERS.has(name)) continue;
        if (!members.has(name)) {
          if (!refs.has(name)) refs.set(name, []);
          refs.get(name)!.push(i + 1);
        }
      }
    });
    // 失明自检：手册里 agent.X 引用总量应稳定（骤降 = 正则失效）
    expect(members.size, 'Agent 成员基线读取失败——守卫可能失明').toBeGreaterThan(50);
    const report = [...refs.entries()].map(([n, ls]) => `  - agent.${n}（第 ${ls.join('、')} 行）`);
    expect(
      report,
      `\n手册 ${report.length} 处引用不在 Agent 公开成员面内：\n${report.join('\n')}\n` +
        `处理三选一：① 成员已删 → 删手册行并补「历史留痕」；② 成员应存在 → 加回代码 + 更新守卫基线；\n` +
        `③ 属继承成员 → 加进本文件 INHERITED_MEMBERS（须写明来源类）。禁止让手册承诺不存在的入口。`,
    ).toEqual([]);
  });
});
