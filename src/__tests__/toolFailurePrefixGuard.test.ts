/**
 * 工具失败前缀约定 · **双向对账守卫**（SCRIPT-1 / METRICS-PREFIX-1 后续加固 · 2026-10-06）
 *
 * ## 为什么要这个文件（不是已有契约段的重复）
 *
 * `managers/__tests__/toolCallHelpers.test.ts` 的「isToolFailure · 前缀约定契约」段是
 * **正向清单**：逐条钉死「已登记前缀 → 判定结果」。它测不出**新增一个未登记的失败族**——
 * 而那恰好是 SCRIPT-1 的原始形态（`formatExecutionResult` 悄悄长出 `[SCRIPT_ERROR]` 族，
 * 没人记得把它登记进判据 ⇒ 脚本族失败恒判成功，静默流漏一年）。
 *
 * **实证（2026-10-06）**：把 `toolExecutor` 两处返回改写成全新前缀 `[NETWORK_ERROR]`，
 * 该契约段 **62 passed 全绿**。它宣称「新增护栏文案未登记归属即转红」，实测不成立。
 *
 * 本文件补的就是缺的那一半：**反向对账**——扫生产代码真实产出的失败前缀，断言
 * 「未在契约段登记归属」的前缀集合为空。新语义漏登记 ⇒ 转红。
 *
 * 范式对齐 `src/agent/__tests__/confirmEntry.test.ts`（登记表键集 ↔ opaque 派生集
 * 双向相等）：单向清单锁不住"新增"，双向相等才锁得住。
 *
 * ## 扫描面（刻意收窄，勿随意扩大）
 *
 * 只扫**工具结果产出者**四个文件的字符串字面量首个方括号标签：
 *   · `toolExecutor.ts`         —— 内置工具返回值（唯一内置工具执行面）
 *   · `toolRunner.ts`           —— 执行层包装（READONLY_DENIED / PERMISSION_DENIED / ABORTED / IDEMPOTENT）
 *   · `skillScriptRunner.ts`    —— 三态格式化（`formatExecutionResult` 真理源）
 *   · `backgroundTasks.ts`      —— 后台任务回���通知
 *
 * **不扫** `loop.ts` / `guardRail.ts` / `assembler.ts`：它们产出的是 system prompt 注入
 * （`GUARD_RAIL_PROMPTS`）与计划错误串，**结构上不经 `isToolFailure`**
 * （`[READ_FAILED_LIMIT]` / `[WRITE_LOOP_STOP]` 等）。它们的前缀归属由契约段的
 * 「护栏提示族」段锁定——那里已明确标注层级差异。
 *
 * ## 判定分类（两桶，穷尽）
 *
 * · **失败族** —— 命中 `isToolFailure` 的前缀。其中 `[ERR…` 由**族级正则** `^\[ERR` 覆盖，
 *   无需逐条登记（新增 `[ERR:X]` 自动归族，这是**有意**的：内核结构化错误族是开放集）；
 *   三态族 `[SCRIPT|CODE|COMMAND]_(ERROR|TIMEOUT)` 由 `kind` 参数模板化生成，源码里
 *   扫不到字面量，改由契约段的正向用例锁死。
 * · **非失败族** —— 语义上「不是失败」的前缀：拦截 / 未执行 / 幂等 / 成功态。
 *   **这些必须逐条登记**（登记即断言），否则「新增一个语义上不是失败的标签」无从查证归属。
 *
 * ## 已知边界（诚实登记，勿默认为已覆盖）
 *
 * · **⚠️ 拼接型产出是真实盲区（不是理论风险，本机实测 98 处）**：本守卫扫**字符串字面量**，
 *   凡首字符不即标签的**动态拼接**（含插值的模板串）**一律扫不到**。实测规模（宽口径，
 *   见末条用例）：`toolExecutor.ts` **75** / `toolRunner.ts` **5** /
 *   `skillScriptRunner.ts` **14** / `backgroundTasks.ts` **4**。
 *   其中 `toolExecutor` 的拼接点**恰好包含本轮修的 `kill_command` 已终态分支**
 *   （`${body}` / `${commandLine}` / `${settledNote}`）——该分支的失败前缀来自
 *   `formatCommandResult`，**本守卫看不到它**，只因同一标签字面量出现在
 *   `skillScriptRunner.ts` 的模板串里才被间接覆盖 ⇒ **覆盖是巧合，不是保证**。
 *   ⇒ 末条「拼接盲区规模登记」用例把该规模**钉成数字**：拼接点增减会转红，
 *     强制每次改动时人工确认「新拼接是否引入了未受守卫的前缀」。
 *   **根治**：工具结果 status 字段化（`SCRIPT-2`）—— 判据不再读文本，盲区整族消失。
 * · **字符串感知简化**：逐行剔除 `//` 之后的部分，不跟踪跨行块注释与模板串状态。
 *   本扫描面内无 URL 形态标签，故不产生假阳性。
 * · **不覆盖宿主侧**：宿主不产生工具结果首标签（只读内核的 `ok` 字段），故无平行问题。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isToolFailure } from '@/agent/managers/toolCallHelpers.js';

/** 扫描根：`src/`（本文件在 `src/__tests__/`，故回退一级） */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 扫描面：工具结果产出者（扩展此列表前先确认新文件确实产出 tool 结果首标签） */
const PRODUCER_FILES = [
  'agent/toolExecutor.ts',
  'agent/toolRunner.ts',
  'skill/skillScriptRunner.ts',
  'agent/backgroundTasks.ts',
] as const;

/**
 * 非失败族登记表（前缀 → 语义归属）。
 *
 * ⚠️ **本表是「语义归属」的 SSOT**：每个在生产代码里产出、但语义上**不是失败**的前缀
 * 都必须在此登记。`TOOL_DECLINE` 之类的 `[ERR…]` 前缀不在此列——它们由 `^\[ERR` 族级
 * 正则自动归为失败，无需登记（开放集）。
 *
 * 新增条目时**必须写清语义归属**，不得只写「非失败」——「为什么不是失败」才是这条
 * 登记的全部价值（例：主动挡下的 ≠ 工具跑挂了）。
 */
const NON_FAILURE_PREFIXES: Readonly<Record<string, string>> = {
  '[KILLED]': '主动终止（非退出码失败 · 强杀无退出码，贴失败码即谎报）',
  '[TASK_ALREADY_SETTLED]': '已终态回传（控制流事实；结局事实由结果体承载，见 kill_command 分支）',
  '[BACKGROUND_STARTED]': '后台启动成功（命令转后台，不在本轮判成败）',
  '[SKIP:TOOL:IDEMPOTENT]': '幂等跳过（主动挡下，未执行）',
};

/**
 * 扫出生产代码真实产出的工具结果首标签 → 出现位置（供报错定位）。
 *
 * 判据：`return` / 赋值等语句里，字符串字面量（单引号 / 模板串）**紧跟**方括号标签。
 * 只认「首字符即标签」——正文中提及（如 stdout 内容里出现 `[ERR:TOOL:X]`）不算产出。
 */
function scanProducedPrefixes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const rel of PRODUCER_FILES) {
    const lines = readFileSync(join(SRC_ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, idx) => {
      // 字符串感知简化：剔除行注释（本扫描面无 URL 形态标签，不产生假阳性）
      const code = line.replace(/\/\/.*$/, '');
      const re = /[`'](\[[A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)*\])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const tag = m[1]!;
        const hits = found.get(tag) ?? [];
        hits.push(`${rel}:${idx + 1}`);
        found.set(tag, hits);
      }
    });
  }
  return found;
}

describe('工具失败前缀 · 双向对账守卫', () => {
  const produced = scanProducedPrefixes();

  it('扫描面非空（守卫自身有效：扫描器没坏，否则反向对账恒真通过）', () => {
    // 防「扫不出任何东西 ⇒ 未登记集合恒空 ⇒ 守卫假绿」：扫描器哑火是最危险的失效模式。
    expect(produced.size).toBeGreaterThan(0);
    expect(produced.size).toBeGreaterThanOrEqual(PRODUCER_FILES.length);
  });

  it('生产产出的每个非失败族前缀都已在登记表里（漏登记即红 · SCRIPT-1 复发锁）', () => {
    // 反向对账的核心：产出 ∖ 登记 = ∅。
    // 实证过这条能抓什么：新增 `[NETWORK_ERROR]` 而不登记 ⇒ 本条转红
    //（原契约段对同一变异 62 passed 全绿）。
    const unregistered = [...produced.keys()]
      .filter((tag) => !isToolFailure(tag) && !(tag in NON_FAILURE_PREFIXES))
      .sort();
    expect(
      unregistered,
      `以下前缀在生产代码中产出、判据判为非失败、但未在 NON_FAILURE_PREFIXES 登记语义归属：\n` +
        unregistered.map((t) => `  ${t}  ←  ${produced.get(t)!.join(', ')}`).join('\n') +
        `\n修法：① 若语义上确实是失败 → 把它加入 TOOL_FAILURE_PATTERNS 的族正则` +
        `\n     ② 若语义上确实不是失败 → 在 NON_FAILURE_PREFIXES 登记并写清归属理由`,
    ).toEqual([]);
  });

  it('登记表的每个前缀都真实在生产中产出（防登记条目腐化成僵尸契约）', () => {
    // 正向对账：登记 ≠ 产出 ⇒ 条目已失效（标签被删/改名），留着是误导。
    const zombie = Object.keys(NON_FAILURE_PREFIXES)
      .filter((tag) => !produced.has(tag))
      .sort();
    expect(
      zombie,
      `以下前缀已登记但生产代码不再产出（标签被删或改名？）——请同步删除登记：\n  ${zombie.join('\n  ')}`,
    ).toEqual([]);
  });

  it('登记表的前缀判据真值与登记语义一致（登记说非失败，判据不得判失败）', () => {
    // 防「登记为豁免但判据实际判失败」——那等于豁免清单失效且无人知晓。
    const wrong = Object.keys(NON_FAILURE_PREFIXES)
      .filter((tag) => isToolFailure(tag))
      .sort();
    expect(
      wrong,
      `以下前缀已登记为非失败，但 isToolFailure 判为失败：\n  ${wrong.join('\n  ')}`,
    ).toEqual([]);
  });

  it('★ 拼接盲区规模登记（把「已知边界」钉成数字，防边界声明被当 boilerplate 忽略）', () => {
    // 本守卫扫「字符串字面量首个方括号标签」，看不到**动态拼接**出来的首字符。
    //
    // ⚠️⚠️ 口径踩坑**四次**才定稿（这段血泪史本身就是教训，勿再简化）：
    //   ① 收窄到「反引号紧跟 return」→ 24，漏了对象字面量里的写法；
    //   ② 放到「return / result: / =>」→ 39，与探针脚本数字对不上（同口径两处定义）；
    //   ③ 改无边界 alternation → 31，**看似定稿**；
    //   ④ 变异时才发现：把 `const header = \`…\`` 改成字面量，**断言根本不响**
    //      ⇒ ③ 漏掉了「中间变量赋值」这一类（既非 return 也非 result:）。
    // **教训链（三条，同源）**：
    //   · **量出来的数若没被变异验证过，就是猜的**；
    //   · **收窄口径让数字"看起来可控"是自欺** —— 边界该宽就宽，宽数字才有行动价值；
    //   · **同一口径只能有一处定义**（探针与测试各写一份正则，对不上才暴露问题）。
    //
    // 定稿口径 = **全部含插值的模板串行**（不做任何上下文收窄）：
    // 「这个文件里有多少行可能在运行时拼出首字符」就是盲区的真实规模。
    const DYNAMIC_TEMPLATE = /`[^`]*\$\{/;
    const perFile: Record<string, number> = {};
    let total = 0;
    for (const rel of PRODUCER_FILES) {
      const lines = readFileSync(join(SRC_ROOT, rel), 'utf8').split('\n');
      const n = lines.filter((l) => DYNAMIC_TEMPLATE.test(l)).length;
      perFile[rel] = n;
      total += n;
    }
    expect(perFile).toEqual({
      'agent/toolExecutor.ts': 75,
      'agent/toolRunner.ts': 5,
      'skill/skillScriptRunner.ts': 14,
      'agent/backgroundTasks.ts': 4,
    });
    // 提醒文本随断言一起报出，避免「只看到红不知道该做什么」
    expect(
      total,
      `含插值模板串行数应恒为 98（实际 ${total}：${JSON.stringify(perFile)}）。` +
        `\n这些行都可能在运行时拼出首字符 ⇒ 本守卫对其失明。` +
        `\n必须做：① 新增/改动拼接点 → 人工确认其首标签是否已被 NON_FAILURE_PREFIXES 或 TOOL_FAILURE_PATTERNS 覆盖；` +
        `\n     ② 数量变化 → 复核是否删改产出者文件（守卫扫描面会同步失明）。` +
        `\n根治出路：SCRIPT-2 工具结果 status 字段化 —— 判据不再读文本，盲区整族消失。`,
    ).toBe(98);
  });
});
