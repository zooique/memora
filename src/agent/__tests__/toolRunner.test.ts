/**
 * 工具执行器（ToolRunner）单测
 *
 * 覆盖单工具执行的生命周期：三重闸门（只读/审批/宿主 preCheck）的 denied/skip/execute、
 * 成功回传 onToolExecuted、异常转结构化错误串、signal 中断竞争（ABORTED）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

    expect(result).toBe('OK');
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

    expect(result.startsWith('[ERR:TOOL:READONLY_DENIED]')).toBe(true);
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
    expect(deniedWrite.startsWith('[ERR:TOOL:READONLY_DENIED]')).toBe(true);
    const deniedCode = await runner.runOne(tc('run_code', '{"language":"python","code":"x"}'));
    expect(deniedCode.startsWith('[ERR:TOOL:READONLY_DENIED]')).toBe(true);
    // 拒绝路径不入 execute（execute 仅被上 3 个只读工具调用）
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('宿主 preCheck 拒绝 → denied', async () => {
    const preExecutionCheck = vi.fn(() => ({ denied: true, reason: '不安全' }));
    const deps = makeDeps({ preExecutionCheck: preExecutionCheck as never });
    const runner = new ToolRunner(deps);

    const result = await runner.runOne(tc());

    expect(result.startsWith('[ERR:TOOL:PERMISSION_DENIED]')).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('宿主 preCheck skip → 幂等跳过，回传 previousResult', async () => {
    const preExecutionCheck = vi.fn(() => ({ skip: true, previousResult: '已执行过' }));
    const deps = makeDeps({ preExecutionCheck: preExecutionCheck as never });
    const runner = new ToolRunner(deps);

    const result = await runner.runOne(tc());

    expect(result).toBe('已执行过');
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

    expect(result.startsWith('[ERR:TOOL:')).toBe(true);
    // 建议送达：suggestions 从「人读」下沉进「LLM 上下文」，可执行确切的下一步指令
    expect(result).toContain('建议：检查权限');
    expect(result).toContain('磁盘只读'); // detail 仍保留
    expect(onToolExecuted).toHaveBeenCalledWith('echo', expect.any(String), result, false);
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

    expect(result).toBe('[ERR:TOOL:UNKNOWN] 错误：未知工具');
    expect(result).not.toContain('建议：');
  });

  it('signal 提前 abort → 返回 ABORTED，不触发 execute', async () => {
    const execute = vi.fn(async () => 'never');
    const runner = new ToolRunner(makeDeps({ execute }));
    const ac = new AbortController();
    ac.abort();

    const result = await runner.runOne(tc(), ac.signal);

    expect(result).toContain('[ERR:TOOL:ABORTED]');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('SCRIPT-2 原生 outcome 通道（B1）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('执行器 emit 原生 outcome → onToolSettled 原样上报（status 权威，不被文本判据覆盖）', async () => {
    const onToolSettled = vi.fn();
    // 执行器在返回字符串的同点 emit：文本是成功形、status 是 blocked —— 原生为唯一权威
    const execute = vi.fn(async (_n: string, _a: string, emit?: (o: ToolOutcome) => void) => {
      emit?.({ status: 'blocked', text: 'OK', blockedReason: 'permission_denied' });
      return 'OK';
    });
    const deps = makeDeps({ execute, onToolSettled });
    const runner = new ToolRunner(deps);

    const result = await runner.runOne(tc());

    expect(result).toBe('OK');
    expect(onToolSettled).toHaveBeenCalledTimes(1);
    expect(onToolSettled).toHaveBeenCalledWith(
      't1',
      'echo',
      expect.objectContaining({ status: 'blocked', blockedReason: 'permission_denied' }),
    );
  });

  it('执行器未 emit → 文本判据同源回落（未切族零变更）', async () => {
    const onToolSettled = vi.fn();
    // 失败串 + 无 emit：isToolFailure 回落 failed（同一次判定，不引入第二判据）
    const deps = makeDeps({
      execute: vi.fn(async () => '[ERR:X] 坏了'),
      onToolSettled,
    });
    const runner = new ToolRunner(deps);

    await runner.runOne(tc());

    expect(onToolSettled).toHaveBeenCalledWith(
      't1',
      'echo',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('denied/skip 出口带原因：readonly_denied / permission_denied / idempotent_skip', async () => {
    // ① 只读闸拒绝 → readonly_denied
    const readonlyTools = [{ name: 'write_file', readonly: false }] as never;
    let deps = makeDeps({
      builtinTools: readonlyTools,
      getStrategy: () => strategy({ toolReadonly: 'readonly' }),
      onToolSettled: vi.fn(),
    });
    await new ToolRunner(deps).runOne(tc('write_file'));
    expect(deps.onToolSettled).toHaveBeenCalledWith(
      't1',
      'write_file',
      expect.objectContaining({ status: 'blocked', blockedReason: 'readonly_denied' }),
    );

    // ② 宿主 preCheck 拒绝 → permission_denied
    deps = makeDeps({
      preExecutionCheck: vi.fn(() => ({ denied: true })) as never,
      onToolSettled: vi.fn(),
    });
    await new ToolRunner(deps).runOne(tc());
    expect(deps.onToolSettled).toHaveBeenCalledWith(
      't1',
      'echo',
      expect.objectContaining({ blockedReason: 'permission_denied' }),
    );

    // ③ outbox 幂等跳过 → idempotent_skip
    deps = makeDeps({
      preExecutionCheck: vi.fn(() => ({ skip: true })) as never,
      onToolSettled: vi.fn(),
    });
    await new ToolRunner(deps).runOne(tc());
    expect(deps.onToolSettled).toHaveBeenCalledWith(
      't1',
      'echo',
      expect.objectContaining({ blockedReason: 'idempotent_skip' }),
    );
  });
});
