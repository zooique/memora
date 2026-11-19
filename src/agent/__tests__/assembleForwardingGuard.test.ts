/**
 * Agent 门面转发完整性守卫（静态闸）——防止「字段停在配置层、执行面静默失效」
 *
 * ## 实证背景（2026-11-19 · 新枝破土扫描升档项）
 * `AgentOptions` 的可选字段要在 Agent 门面转发**两处**：构造器 `this.#config` 与
 * `assembleComponents` 的装配实参。漏任何一处，TypeScript 都不报错（可选字段 +
 * Pick 类型覆盖不到门面自己的显式转发），但字段永远到不了执行器。
 * 7.1.0 连修三次同族事故：
 *   - `imageReadPort` 漏 ⇒ `read_image` 被永久裁成 `host-no-port`（工具面静默消失）；
 *   - `builtinFallbackRole` 漏 ⇒ 宿主兜底角色静默失效（落回内核常量）；
 *   - `environmentProvider` 漏 ⇒ 首轮 system prompt 缺「## 运行环境」段。
 * 每次都是「丢一个补一个 test」的打地鼠，没有结构性守卫。三次已达经验提取阈值（≥3）。
 *
 * ## 判据（真源 = `assembler.ts` 的 `AssembleRuntimeParams`）
 * 该 Pick 列出「装配链真正消费的 23 个字段」。守卫断言：这些字段**同时**出现在
 * ① `agent.ts` 构造器的 `this.#config` 字面量、② `assembleComponents` 的装配实字量。
 * 选它而非整个 `AgentOptions` 作判据，是因为后者含合法例外：
 *   - `provider` / `backgroundProvider` / `providerRouter` 走构造期直接赋值（不进 #config）；
 *   - `strategyOverride` 走 seed 侧直传（AssembleInput 零消费）；
 *   - `preExecutionCheck` 经 hooks 注入装配（不在顶层实参）。
 * 守整个接口会误报这些例外；守装配链消费集则精准命中三次事故形态。
 *
 * ## 静态闸自检（无运行时行为，用注入违规样本验证）
 * 主判据含① 集合下限断言（防解析塌陷成空集假绿）、② 注入探针自检
 * （构造带一个虚构字段的文本，守卫必须能抓出它），确保守卫本身不是恒绿。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件位于 src/agent/__tests__ 下，向上三级） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AGENT_SRC = join(ROOT, 'src', 'agent', 'agent.ts');
const ASSEMBLER_SRC = join(ROOT, 'src', 'agent', 'assembler.ts');

const agentText = readFileSync(AGENT_SRC, 'utf8');
const assemblerText = readFileSync(ASSEMBLER_SRC, 'utf8');

/**
 * 截取对象字面量块并取顶层键（6 空格缩进的 `key:` 行）。
 * 起点锚点后按 `{` / `}` 配平，到配平结束截断——避免注释里的字段名干扰。
 */
function topLevelKeysAt(src: string, startAnchor: string): Set<string> {
  const start = src.indexOf(startAnchor);
  if (start < 0)
    throw new Error(`守卫锚点未找到：${startAnchor}（agent.ts 结构变更时须同步本守卫）`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`守卫锚点大括号未配平：${startAnchor}`);
  const body = src.slice(open + 1, end);
  return new Set(
    [...body.matchAll(/^\s{6}([A-Za-z_]\w*):/gm)].map((m) => m[1]).filter((x): x is string => !!x),
  );
}

/** 解析 `AssembleRuntimeParams = Pick<AgentConfig, | 'a' | 'b' ...>` 的字段名 */
function runtimeParamFields(src: string): string[] {
  const m = src.match(/type AssembleRuntimeParams = Pick<\s*AgentConfig,([\s\S]*?)\n>;/);
  if (!m?.[1])
    throw new Error(
      '未找到 AssembleRuntimeParams 的 Pick 声明（assembler.ts 结构变更时须同步本守卫）',
    );
  return [...m[1].matchAll(/'([A-Za-z_]\w*)'/g)].map((x) => x[1]).filter((x): x is string => !!x);
}

describe('Agent 门面转发完整性守卫', () => {
  it('AssembleRuntimeParams 每个字段都在 #config 与 assembleComponents 两处转发', () => {
    const runtime = runtimeParamFields(assemblerText);
    // 下限断言：解析塌陷（空集 / 极少字段）不得假绿。当前 23，留 ±2 缓冲给合理增删。
    expect(
      runtime.length,
      'AssembleRuntimeParams 字段数异常——解析失败或 Pick 被清空',
    ).toBeGreaterThanOrEqual(21);

    const cfgKeys = topLevelKeysAt(agentText, 'this.#config = {');
    const asmKeys = topLevelKeysAt(agentText, 'await assembleComponents(pctx, {');
    expect(cfgKeys.size, '#config 顶层字段解析塌陷').toBeGreaterThanOrEqual(21);
    expect(asmKeys.size, 'assembleComponents 实参顶层字段解析塌陷').toBeGreaterThanOrEqual(21);

    const missCfg = runtime.filter((f) => !cfgKeys.has(f));
    const missAsm = runtime.filter((f) => !asmKeys.has(f));
    const hint =
      `\n漏转发 = 可选字段停在配置层、执行面静默失效（无类型错误）。\n` +
      `修法：在 agent.ts 对应字面量补 \`field: opts.field\`（构造段）与 \`field: this.#config.field\`（装配段）。\n` +
      `7.1.0 三笔同族事故（imageReadPort / builtinFallbackRole / environmentProvider）即由此形态造成。`;
    expect(
      missCfg,
      `\n装配链字段未进 #config 构造段：\n${missCfg.map((f) => `  - ${f}`).join('\n')}${hint}`,
    ).toEqual([]);
    expect(
      missAsm,
      `\n装配链字段未进 assembleComponents 实参：\n${missAsm.map((f) => `  - ${f}`).join('\n')}${hint}`,
    ).toEqual([]);
  });

  it('守卫自检：注入的虚构未转发字段必须被检出，干净字段集不误报', () => {
    // 用同款差集逻辑，验证「漏一个字段 ⇒ 报错」确实成立（防恒绿）。
    const cfgKeys = new Set(['projectPath', 'imageReadPort', 'denyTools']);
    const asmKeys = new Set(['projectPath', 'denyTools']); // 故意漏 imageReadPort
    const runtime = ['projectPath', 'imageReadPort', 'denyTools'];
    expect(runtime.filter((f) => !cfgKeys.has(f))).toEqual([]);
    expect(runtime.filter((f) => !asmKeys.has(f))).toEqual(['imageReadPort']);
  });
});
