/**
 * TOOL-ABORT-KILL-1 执行面「中断后不残留」机判（真进程 spawn，不 mock）
 *
 * 覆盖五个执行面各自的机判，**逐个独立**（不合并成一个「全部通过」）：
 *   1. run_command（前台同步命令）—— 内核 runShellCommand spawn
 *   2. run_project_script —— 内核 runSkillScript spawn
 *   3. run_skill_script —— 注入回调 → 内核 runSkillScript spawn
 *   4. run_code —— 宿主 ICodeExecutionProvider（本文件只判 signal 透传 + 中断文案；
 *      真实子进程「不残留」机判在宿主 codeExecutor.test.ts，因执行器实现属宿主包）
 *   5. 自定义工具 —— 进程内 handler，只能协作式感知 signal（判 signal 确实传到）
 *
 * 判据（子进程面）：abort 后 ≤2s 返回，且被中断的脚本不会在之后写出标记文件
 * （= 进程树真的死了，不是「结果被丢弃、进程继续跑」）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolExecutor } from '@/agent/toolExecutor.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { runSkillScript } from '@/skill/skillScriptRunner.js';
import type { ICodeExecutionProvider } from '@/code-exec/types.js';

/** 标记文件在中断后是否出现（true = 进程残留，判据失败） */
const MARKER_DELAY_MS = 3_000;
/** 中断时点（脚本启动后） */
const ABORT_AFTER_MS = 1_000;
/** 断言返回耗时上限（判据：子进程面 ≤2s） */
const RETURN_BUDGET_MS = 2_000;
/** 等待「若进程还活着就会写标记」的观察窗（脚本 3s 写，等到 4.5s 足够） */
const OBSERVE_UNTIL_MS = 4_500;

/** 生成一个「延迟写标记文件」的探针脚本：进程存活则写，死亡则不写 */
function writeSleeperScript(dir: string, name: string, markerPath: string): string {
  const scriptPath = join(dir, name);
  writeFileSync(
    scriptPath,
    `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'alive'); }, ${MARKER_DELAY_MS});\n`,
    'utf-8',
  );
  return scriptPath;
}

/** 定时 abort 的控制器（返回 controller + 已安排的中断计时器） */
function makeTimedAbort(): { controller: AbortController; timer: NodeJS.Timeout } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ABORT_AFTER_MS);
  return { controller, timer };
}

/** 等到「脚本本该写标记」之后再检查（不残留 = 文件不存在） */
async function assertNoResidue(markerPath: string, startedAt: number): Promise<void> {
  const remain = Math.max(0, OBSERVE_UNTIL_MS - (performance.now() - startedAt));
  await new Promise((resolve) => setTimeout(resolve, remain));
  expect(
    existsSync(markerPath),
    `中断后进程仍在运行：标记文件 ${markerPath} 被写出（子进程未随中断终止）`,
  ).toBe(false);
}

describe('TOOL-ABORT-KILL-1：五个执行面的中断不残留机判', () => {
  let tmpProject: string;
  let security: SecurityGuard;
  let index: InMemoryStorage;
  let executor: ToolExecutor;

  beforeAll(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-abort-kill-'));
    security = new SecurityGuard(tmpProject, tmpProject, [], false, 'owner');
    index = new InMemoryStorage();
    executor = new ToolExecutor(tmpProject, security, index);
  });

  afterAll(() => {
    index.close?.();
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('面 1/5 run_command：中断后 ≤2s 返回且子进程不残留', { timeout: 20_000 }, async () => {
    const marker = join(tmpProject, 'cmd-marker.txt');
    const sleeper = writeSleeperScript(tmpProject, 'cmd-sleeper.js', marker);
    const { controller, timer } = makeTimedAbort();
    const startedAt = performance.now();
    const result = await executor.execute(
      'run_command',
      JSON.stringify({ command: `node ${sleeper}` }),
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    clearTimeout(timer);
    const elapsed = performance.now() - startedAt;
    expect(result).toContain('COMMAND_ABORTED');
    // 返回时点 ≤ 中断时点 + 2s
    expect(elapsed).toBeLessThanOrEqual(ABORT_AFTER_MS + RETURN_BUDGET_MS);
    await assertNoResidue(marker, startedAt);
  });

  it('面 2/5 run_project_script：中断后 ≤2s 返回且子进程不残留', { timeout: 20_000 }, async () => {
    const marker = join(tmpProject, 'project-marker.txt');
    writeSleeperScript(tmpProject, 'project-sleeper.js', marker);
    const { controller, timer } = makeTimedAbort();
    const startedAt = performance.now();
    const result = await executor.execute(
      'run_project_script',
      JSON.stringify({ script_path: 'project-sleeper.js' }),
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    clearTimeout(timer);
    const elapsed = performance.now() - startedAt;
    expect(result).toContain('SCRIPT_ABORTED');
    expect(elapsed).toBeLessThanOrEqual(ABORT_AFTER_MS + RETURN_BUDGET_MS);
    await assertNoResidue(marker, startedAt);
  });

  it('面 3/5 run_skill_script：中断后 ≤2s 返回且子进程不残留', { timeout: 20_000 }, async () => {
    const marker = join(tmpProject, 'skill-marker.txt');
    const sleeper = writeSleeperScript(tmpProject, 'skill-sleeper.js', marker);
    // 注入装配层同款回调：第 4 参 signal 必须被透传给内核 runSkillScript
    executor.runSkillScript = async (_skillName, _scriptPath, args, signal) =>
      runSkillScript(sleeper, 'node', args, 60_000, tmpProject, undefined, signal);
    const { controller, timer } = makeTimedAbort();
    const startedAt = performance.now();
    const result = await executor.execute(
      'run_skill_script',
      JSON.stringify({ skill_name: 'probe', script_path: 'sleeper.js' }),
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    clearTimeout(timer);
    const elapsed = performance.now() - startedAt;
    expect(result).toContain('SCRIPT_ABORTED');
    expect(elapsed).toBeLessThanOrEqual(ABORT_AFTER_MS + RETURN_BUDGET_MS);
    await assertNoResidue(marker, startedAt);
  });

  it('面 4/5 run_code：signal 确实透传到 ICodeExecutionProvider（真实杀树机判在宿主）', async () => {
    /** 记录 provider 收到的 signal（判「透传」而非「丢参」） */
    const seenSignals: Array<AbortSignal | undefined> = [];
    const provider: ICodeExecutionProvider = {
      supportedLanguages: ['js'],
      async execute(_code, _language, options) {
        seenSignals.push(options?.signal);
        // 执行器侧中断尚未发生：模拟宿主在 signal abort 后返回的终止结果
        if (options?.signal?.aborted) {
          return { stdout: '', stderr: '', exitCode: -1, timedOut: false, aborted: true };
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: true };
      },
    };
    // provider 属构造注入（无 setter）：单独构造一个带 provider 的执行器
    const providerExecutor = new ToolExecutor(
      tmpProject,
      security,
      index,
      undefined,
      undefined,
      undefined,
      provider,
    );
    const { controller, timer } = makeTimedAbort();
    // 先构造已中止信号（provider 分支走中断返回，验证内核格式化不把中断报成普通失败/成功）
    controller.abort();
    clearTimeout(timer);
    const result = await providerExecutor.execute(
      'run_code',
      JSON.stringify({ code: 'console.log(1)', language: 'js' }),
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    expect(seenSignals.length).toBe(1);
    expect(seenSignals[0]).toBe(controller.signal);
    expect(result).toContain('CODE_ABORTED');
  });

  it('面 5/5 自定义工具（进程内）：signal 确实传到 handler 的 ctx', async () => {
    /** handler 观测到的 ctx.signal（判「进程内面只能协作式感知」） */
    let observed: AbortSignal | undefined;
    executor.registerTool(
      {
        name: 'abort_probe_tool',
        description: '中断透传探针（进程内执行面）',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      async (_args, ctx) => {
        observed = ctx.signal;
        return ctx.signal?.aborted ? 'probe-aborted' : 'probe-running';
      },
    );
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute(
      'abort_probe_tool',
      '{}',
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    expect(observed).toBe(controller.signal);
    expect(result).toBe('probe-aborted');
  });
});
