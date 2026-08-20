/**
 * 工具执行器（ToolRunner）单测
 *
 * 覆盖单工具执行的生命周期：三重闸门（只读/审批/宿主 preCheck）的 denied/skip/execute、
 * 成功回传 onToolExecuted、异常转结构化错误串、signal 中断竞争（ABORTED）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRunner, type ToolCall, type ToolRunnerDeps } from '@/agent/toolRunner.js';
import { MemoraError } from '@/utils/errors.js';
import { NOOP_TRACER } from '@/agent/tracer.js';
import type { L2RuntimeStrategy } from '@/role-pack/types.js';
import { DEFAULT_L2_STRATEGY } from '@/role-pack/strategyResolver.js';

function tc(name = 'echo', args = '{}'): ToolCall {
  return { id: 't1', type: 'function', function: { name, arguments: args } };
}

/** 构造默认策略（默认 toolReadonly/toolApproval 关闭） */
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
    expect(deps.execute).toHaveBeenCalledWith('echo', '{}');
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

  it('审批闸：toolApproval=confirm 触发 onToolApproval', async () => {
    const onToolApproval = vi.fn();
    const deps = makeDeps({
      onToolApproval,
      getStrategy: () => strategy({ toolApproval: 'confirm' }),
    });
    const runner = new ToolRunner(deps);

    await runner.runOne(tc());

    expect(onToolApproval).toHaveBeenCalledWith({ toolName: 'echo', args: '{}' });
    // 审批不阻塞放行
    expect(deps.execute).toHaveBeenCalled();
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
    expect(onToolExecuted).toHaveBeenCalledWith('echo', expect.any(String), result, false);
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
