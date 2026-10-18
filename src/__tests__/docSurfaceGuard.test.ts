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
 * **已知边界（诚实登记，勿默认为已覆盖）**：
 * - 面 B（接口代码块成员集 vs 源码 interface）**未实现**——需解析 markdown 代码块 + 容忍注释/
 *   可选标记，成本高。触发条件：接口再发生一次签名漂移（台账 GUARD-METHOD-1）。
 * - 本守卫只夹「存在性 / 引用」，不夹「语义是否说谎」——`bootstrapMemories` 写着「启动时加载」
 *   实则恒为空数组，这种**散文级语义漂移**机器判不了，仍靠人工审查。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INVENTORY = join(ROOT, 'docs', 'architecture', 'module-inventory.md');
const API_REFERENCE = join(ROOT, 'docs', 'memora-api-reference.md');
const GUARD_FILE = join(ROOT, 'src', '__tests__', 'publicMemberSurfaceGuard.test.ts');

/** 模块清单里的路径可能是相对 src/、相对 src/agent/、或相对宿主 src/——逐个试 */
const MODULE_PREFIXES = ['src', join('src', 'agent'), join('hosts', 'memora-vscode', 'src')];

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
  it('面 A · 模块清单承诺的 .ts 必须存在（抓「删了模块没删清单」）', () => {
    const lines = readFileSync(INVENTORY, 'utf8').split(/\r?\n/);
    const declared: string[] = [];
    const missing: string[] = [];
    lines.forEach((line, i) => {
      const m = line.match(/^\|\s*`((?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.ts)`/);
      if (!m) return;
      const rel = m[1];
      if (!rel) return;
      declared.push(rel);
      if (!MODULE_PREFIXES.some((p) => existsSync(join(ROOT, p, rel)))) {
        missing.push(`第 ${i + 1} 行：${rel}`);
      }
    });
    // 防守卫失明假绿：清单条目数骤降说明正则没匹配上（而非清单真的变干净）
    expect(
      declared.length,
      '模块清单条目数异常偏少——正则或表格形态变了，守卫可能失明',
    ).toBeGreaterThan(80);
    expect(
      missing,
      `\n模块清单 ${missing.length} 条承诺无对应文件：\n${missing.map((s) => `  - ${s}`).join('\n')}\n` +
        `若模块确已删除：删清单行 + 在本节留「已删除」补记（决策史可溯）；\n` +
        `若只是挪了位置：同步更新清单路径。禁止让清单继续承诺不存在的模块。`,
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
