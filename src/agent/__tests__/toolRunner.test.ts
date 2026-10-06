/**
 * 工具执行器（ToolRunner）单测
 *
 * 覆盖单工具执行的生命周期：三重闸门（只读/审批/宿主 preCheck）的 denied/skip/execute、
 * 成功回传 onToolExecuted、异常转结构化错误串、signal 中断竞争（ABORTED）。
 * B4 起 runOne 返回 ToolOutcome（结构化事实）；denied/skip 直接构造 blocked outcome。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ToolRunner, type ToolCall, type ToolRunnerDeps } from '@/agent/toolRunner.js';
import {
  BUILTIN_TOOLS,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  RUN_CODE_TOOL,
} from '@/agent/builtinTools.js';
import { MemoraError } from '@/utils/errors.js';
import { NOOP_TRACER } from '@/agent/tracer.js';
import type { L2RuntimeStrategy } from '@/role-pack/types.js';
import { DEFAULT_L2_STRATEGY } from '@/role-pack/strategyResolver.js';
// 原生 outcome 类型（执行器回调载荷契约）
import type { ToolOutcome } from '@/agent/managers/toolCallHelpers.js';

function tc(name = 'echo', args = '{}'): ToolCall {
  return { id: 't1', type: 'function', function: { name, arguments: args } };
}

/** 构造默认策略（默认 toolReadonly 关闭） */
function strategy(overrides: Partial<L2RuntimeStrategy> = {}): L2RuntimeStrategy {
  return { ...DEFAULT_L2_STRATEGY, ...overrides } as L2RuntimeStrategy;
}

/** 装配依赖（execute 默认返回 OK） */
function makeDeps(overrides: Partial<ToolRunnerDeps> = {}): ToolRunnerDeps {
  return {
    execute: vi.fn(async () => 'OK'),
    getStrategy: () => strategy(),
    tracer: NOOP_TRACER,
    ...overrides,
  } as ToolRunnerDeps;
}

describe('ToolRunner 单工具执行', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('execute 路径：执行成功并触发 onToolExecuted(ok=true)', async () => {
    const onToolExecuted = vi.fn();
    const deps = makeDeps({ onToolExecuted });
    const runner = new ToolRunner(deps);

    const result = await runner.runOne(tc());

    expect(result.status).toBe('ok');
    expect(result.text).toBe('OK');
    // raceToolWithSignal 始终把原生 outcome 回调作为第 3 参传入（未切族忽略即可）
    expect(deps.execute).toHaveBeenCalledWith('echo', '{}', expect.any(Function));
    expect(onToolExecuted).toHaveBeenCalledWith('echo', '{}', 'OK', true);
  });

  it('只读闸：toolReadonly=readonly 且工具非只读 → denied，不入 execute', async () => {
    const validTools = [{ name: 'write_file', readonly: false }] as Array<{
      name: string;
      readonly: boolean;
    }>;
    const deps = makeDeps({
      builtinTools: validTools as never,
      getStrategy: () => strategy({ toolReadonly: 'readonly' }),
    });
    const runner = new ToolRunner(deps);

    const result = await runner.runOne(tc('write_file', '{payload}'));

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('readonly_denied');
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('只读闸（生产全量内置定义）：readonly 放行 web_search/web_fetch/read_file，阻止 run_code/write_file', async () => {
    // 修复 4-1/4-2 后的生产注入形态：assembler 传 toolExec.builtinDefinitions（全量内置含条件工具）
    const builtinTools = [...BUILTIN_TOOLS, WEB_SEARCH_TOOL, WEB_FETCH_TOOL, RUN_CODE_TOOL];
    const execute = vi.fn(async () => 'OK');
    const deps = makeDeps({
      execute,
      builtinTools,
      getStrategy: () => strategy({ toolReadonly: 'readonly' }),
    });
    const runner = new ToolRunner(deps);

    // 只读工具（含条件工具 web_search / web_fetch）放行执行
    await runner.runOne(tc('web_search', '{"query":"x"}'));
    await runner.runOne(tc('web_fetch', '{"url":"https://a"}'));
    await runner.runOne(tc('read_file', '{"path":"a"}'));
    expect(execute).toHaveBeenCalledTimes(3);

    // 写/执行工具（write_file / run_code）被只读闸拒绝
    const deniedWrite = await runner.runOne(tc('write_file', '{"path":"a","content":"x"}'));
    expect(deniedWrite.blockedReason).toBe('readonly_denied');
    const deniedCode = await runner.runOne(tc('run_code', '{"language":"python","code":"x"}'));
    expect(deniedCode.blockedReason).toBe('readonly_denied');
    // 拒绝路径不入 execute（execute 仅被上 3 个只读工具调用）
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('宿主 preCheck 拒绝 → denied', async () => {
    const preExecutionCheck = vi.fn(() => ({ denied: true, reason: '不安全' }));
    const deps = makeDeps({ preExecutionCheck: preExecutionCheck as never });
    const runner = new ToolRunner(deps);

    const result = await runner.runOne(tc());

    expect(result.blockedReason).toBe('permission_denied');
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('宿主 preCheck skip → 幂等跳过，回传 previousResult', async () => {
    const preExecutionCheck = vi.fn(() => ({ skip: true, previousResult: '已执行过' }));
    const deps = makeDeps({ preExecutionCheck: preExecutionCheck as never });
    const runner = new ToolRunner(deps);

    const result = await runner.runOne(tc());

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('idempotent_skip');
    expect(result.text).toBe('已执行过');
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('工具抛 MemoraError → 结构化错误串并 onToolExecuted(ok=false)', async () => {
    const onToolExecuted = vi.fn();
    const boom = new MemoraError({
      title: '写文件失败',
      detail: '磁盘只读',
      suggestions: ['检查权限'],
      category: 'tool',
    });
    const deps = makeDeps({
      execute: vi.fn(async () => {
        throw boom;
      }),
      onToolExecuted,
    });
    const runner = new ToolRunner(deps);

    const result = await runner.runOne(tc());

    expect(result.status).toBe('failed');
    expect(result.text.startsWith('[ERR:TOOL:')).toBe(true);
    // 建议送达：suggestions 从「人读」下沉进「LLM 上下文」，可执行确切的下一步指令
    expect(result.text).toContain('建议：检查权限');
    expect(result.text).toContain('磁盘只读'); // detail 仍保留
    expect(onToolExecuted).toHaveBeenCalledWith('echo', expect.any(String), result.text, false);
  });

  it('工具抛 MemoraError 且无 suggestions → 失败串不加「建议：」后缀（零噪音）', async () => {
    const boom = new MemoraError({
      title: '未知工具',
      detail: undefined,
      suggestions: [],
      category: 'tool',
    });
    const deps = makeDeps({
      execute: vi.fn(async () => {
        throw boom;
      }),
    });
    const runner = new ToolRunner(deps);

    const result = await runner.runOne(tc());

    expect(result.status).toBe('failed');
    expect(result.text).toBe('[ERR:TOOL:UNKNOWN] 错误：未知工具');
    expect(result.text).not.toContain('建议：');
  });

  it('signal 提前 abort → 返回 ABORTED，不触发 execute', async () => {
    const execute = vi.fn(async () => 'never');
    const runner = new ToolRunner(makeDeps({ execute }));
    const ac = new AbortController();
    ac.abort();

    const result = await runner.runOne(tc(), ac.signal);

    expect(result.status).toBe('failed');
    expect(result.text).toContain('[ERR:TOOL:ABORTED]');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('SCRIPT-2 B4：runOne 返回 ToolOutcome（结构化事实，文本降为渲染面）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('执行器 emit 原生 outcome → 原样返回（status 权威，不被文本判据覆盖）', async () => {
    // 执行器在返回字符串的同点 emit：文本是成功形、status 是 blocked —— 原生为唯一权威
    const execute = vi.fn(async (_n: string, _a: string, emit?: (o: ToolOutcome) => void) => {
      emit?.({ status: 'blocked', text: 'OK', blockedReason: 'permission_denied' });
      return 'OK';
    });
    const runner = new ToolRunner(makeDeps({ execute }));

    const result = await runner.runOne(tc());

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('permission_denied');
    expect(result.text).toBe('OK');
  });

  it('执行器未 emit → 兜底 ok（B5 后无文本判据：失败必须显式 emit，裸文本=正常完成）', async () => {
    // 未 emit + 裸文本：兜底 okOutcome（原 isToolFailure 判据桥已物理删除，
    // 失败事实若不 emit 会被吞 ⇒ 由残留守卫测试锁「生产代码零裸失败前缀 return」）
    const okRunner = new ToolRunner(makeDeps({ execute: vi.fn(async () => 'OK') }));
    expect((await okRunner.runOne(tc())).status).toBe('ok');

    // 即使文本长得像失败前缀，只要执行器没 emit 就不判失败——判据唯一来源 = emit
    const errishRunner = new ToolRunner(
      makeDeps({ execute: vi.fn(async () => '[ERR:X] 坏了') }),
    );
    expect((await errishRunner.runOne(tc())).status).toBe('ok');
  });

  it('denied/skip 出口直接构造 blocked：readonly_denied / permission_denied / idempotent_skip', async () => {
    // ① 只读闸拒绝 → readonly_denied
    const readonlyTools = [{ name: 'write_file', readonly: false }] as never;
    const r1 = await new ToolRunner(
      makeDeps({
        builtinTools: readonlyTools,
        getStrategy: () => strategy({ toolReadonly: 'readonly' }),
      }),
    ).runOne(tc('write_file'));
    expect(r1.status).toBe('blocked');
    expect(r1.blockedReason).toBe('readonly_denied');

    // ② 宿主 preCheck 拒绝 → permission_denied
    const r2 = await new ToolRunner(
      makeDeps({ preExecutionCheck: vi.fn(() => ({ denied: true })) as never }),
    ).runOne(tc());
    expect(r2.blockedReason).toBe('permission_denied');

    // ③ outbox 幂等跳过 → idempotent_skip
    const r3 = await new ToolRunner(
      makeDeps({ preExecutionCheck: vi.fn(() => ({ skip: true })) as never }),
    ).runOne(tc());
    expect(r3.blockedReason).toBe('idempotent_skip');
  });
});

describe('SCRIPT-2 B5-e：裸失败前缀 return 残留守卫（判据桥消亡后的永久锁）', () => {
  // 判据桥（isToolFailure）已物理删除：runOne 兜底 = ok，失败事实的唯一出口 = 执行器显式 emit。
  // 若有人新增「裸 return 失败前缀文本」，失败会被兜底吞成成功（静默假阴性，无测试会红）——
  // 本守卫把方案收尾时的手工 grep 证明固化为永久测试：生产代码零裸失败前缀 return。
  // 覆盖面 = 三个工具执行/装配文件；软降级前缀（[KILLED] / [TASK_ALREADY_SETTLED] /
  // [BACKGROUND_STARTED] / [SEARCH_LIMIT_REACHED] 等）语义非失败，不在守卫范围。
  const PROD_FILES = [
    'src/agent/toolExecutor.ts',
    'src/agent/toolRunner.ts',
    'src/agent/assembler.ts',
  ];

  // 失败前缀两族（与已删除的 TOOL_FAILURE_PATTERNS 同源）：
  // ① `[ERR…` 结构化错误族 ② 执行三态族（SCRIPT/CODE/COMMAND × ERROR/TIMEOUT）
  const BARE_FAIL_RETURN =
    /return\s*(?:\(\s*)?['"`]\[(?:ERR|(?:SCRIPT|CODE|COMMAND)_(?:ERROR|TIMEOUT))]/;

  it.each(PROD_FILES)('%s 零裸失败前缀 return（失败必须显式 emit）', (rel) => {
    const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
    const hits = src
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter((l) => BARE_FAIL_RETURN.test(l.line));
    expect(hits).toEqual([]);
  });

  it('abort 出口已结构化（toolRunner 内 ABORTED 文本经 emitOutcome 产出，非裸 return）', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/agent/toolRunner.ts'), 'utf8');
    // abort 两点都必须 emit failedOutcome（中断 = 失败事实，防兜底误判 ok）
    const emitCount = (src.match(/emitOutcome\(failedOutcome\(abortedText\)\)/g) ?? []).length;
    expect(emitCount).toBe(2);
  });
});
