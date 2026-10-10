/**
 * 后台任务脱管入口 · 调用点唯一性守卫（loop.ts 契约显化首批 · 从注释断言搬进机器）
 *
 * 契约真源 = `AgentLoop.finalizeBackgroundTasksOnTurnEnd` 头注释（ADR-036 定案锚）：
 * 「done / interrupted / error / 达到最大迭代 四条收场路径统一经此，调用点唯一
 * （`_runWithSlo` 的 finally）」。
 *
 * 为什么这条值得机器锁：脱管语义 =「turn 收场时把存活后台任务移出跟踪，不杀进程、
 * 不丢未消费的 command-result」。若未来有人从收场路径之外（如 pause 分支、step 边界）
 * 调用本方法，**挂起中的 turn 会把后台任务错误脱管**——「挂起不算终态」的定案被静默
 * 破坏，且行为测试不必然红（行为用例只覆盖已存在的路径，不防「新增第二个调用点」）。
 *
 * 判据（只锁静态可判定的事实）：
 * 1. `finalizeBackgroundTasksOnTurnEnd(` 在 loop.ts 非注释代码中出现恰好 2 次
 *    = 1 定义 + 1 调用（`_runWithSlo` finally）；
 * 2. `detachAll()` 在 loop.ts 非注释代码中恰好 1 次调用——注册表的脱管原语
 *    不允许被 finalize 之外的路径旁路直调。
 *
 * 判据边界（诚实声明）：本守卫只锁「唯一性」；「唯一调用点必须位于 finally 收场
 * 路径」属行为语义，由 loop.test.ts 后台任务族的行为用例覆盖，本守卫不伪装锁语义。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 被扫文件：本测试在 `src/agent/__tests__/`，loop.ts 在上两级 */
const LOOP_TS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'loop.ts');

/** 行级剥注释：trim 后以行注释符、块注释起符、星号、块注释止符开头的行剔除
 *  （⚠️ 本注释不得写出那四个记号的字面量——注释正文含块注释止符会提前终止 JSDoc，
 *  把后续代码吞进模板字符串，实测 58 行起连环 parse error，本仓「注释写词法记号」活案例） */
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');
}

describe('后台任务脱管入口 · 调用点唯一性守卫（finalizeDetachGuard）', () => {
  const code = stripCommentLines(readFileSync(LOOP_TS, 'utf8'));

  it('finalizeBackgroundTasksOnTurnEnd：定义恰 1 + 调用恰 1（唯一调用点 = _runWithSlo finally）', () => {
    const defs = code.match(/private finalizeBackgroundTasksOnTurnEnd\(/g) ?? [];
    const calls = code.match(/this\.finalizeBackgroundTasksOnTurnEnd\(\)/g) ?? [];
    expect(defs, '定义必须恰 1 处：重复定义 = 脱管语义分叉').toHaveLength(1);
    expect(
      calls,
      '调用必须恰 1 处：新增第二调用点 = 破坏「四条收场路径统一经此」的 ADR-036 定案' +
        '（挂起分支误调会把暂停中的 turn 的后台任务错误脱管）。若确需扩调用点，' +
        '先回 `docs/方案-后台任务跨轮存活-20261004.md` §三 重新定案，再同步改本守卫与头注释。',
    ).toHaveLength(1);
  });

  it('detachAll()：注册表脱管原语在 loop.ts 内仅 finalize 方法体消费（禁旁路直调）', () => {
    const calls = code.match(/\.detachAll\(\)/g) ?? [];
    expect(
      calls,
      'detachAll 是注册表脱管原语，唯一合法消费面 = finalizeBackgroundTasksOnTurnEnd 方法体；' +
        '旁路直调 = 绕过「收场报告上屏」链路（脱管报告文本无人产出，UI 静默丢事件）。',
    ).toHaveLength(1);
  });
});
