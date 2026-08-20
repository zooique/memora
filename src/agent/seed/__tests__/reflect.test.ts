/**
 * 回答后（Reflect）独立单元测试
 *
 * 覆盖 SeedReflect.run（round-summary 摘要生成，记忆即摘要单轨）：
 *   - summary=on：委托 roundSummaryGenerator.generate + registerPendingArchive（span 生命周期）
 *   - summary=off：跳过摘要生成
 *   - generate 抛错仅记日志、不外泄（Promise 不 reject）
 *   - 提炼视角 summaryFocus 透传
 */

import { describe, it, expect } from 'vitest';
import { SeedReflect } from '@/agent/seed/reflect.js';
import {
  createHarness,
  buildParts,
  makeStrategy,
  useStrategy,
} from './harness.js';

describe('SeedReflect 回答后', () => {
  it('summary=on：委托 generate + registerPendingArchive，span 开启与结束', async () => {
    const { mocks, deps } = createHarness();

    await new SeedReflect(deps).run('用户输入', '助手回复');

    // roundId 取 loop 当前轮，sessionName 取 history 当前会话
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '用户输入',
      '助手回复',
      'round-1',
      '2026-08-20-main',
      undefined, // 无 summaryFocus → undefined
    );
    expect(mocks.history.registerPendingArchive).toHaveBeenCalledTimes(1);
    expect(mocks.tracer.startSpan).toHaveBeenCalledTimes(1);
    expect(mocks.span.end).toHaveBeenCalledTimes(1);
  });

  it('summary=off：跳过摘要生成（一次性对话不沉淀）', async () => {
    const { mocks, deps } = createHarness();
    useStrategy(mocks, makeStrategy({ summary: 'off' }));

    await new SeedReflect(deps).run('输入', '回复');

    expect(mocks.roundSummaryGenerator.generate).not.toHaveBeenCalled();
    expect(mocks.history.registerPendingArchive).not.toHaveBeenCalled();
  });

  it('提炼视角透传：rolePack prepare.summaryFocus → 注入 generate', async () => {
    const { mocks, deps } = createHarness();
    useStrategy(mocks, makeStrategy({ summaryFocus: '保留代码/表格细节' }));

    await new SeedReflect(deps).run('输入', '回复');

    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '输入',
      '回复',
      'round-1',
      '2026-08-20-main',
      '保留代码/表格细节',
    );
  });

  it('generate 抛错：仅记日志不外泄，Promise 正常 resolve（不 reject）', async () => {
    const { mocks, deps } = createHarness();
    mocks.roundSummaryGenerator.generate.mockRejectedValueOnce(new Error('LLM 失败'));

    // 内部 catch 兜底 error → await 不应抛
    await expect(new SeedReflect(deps).run('输入', '回复')).resolves.toBeUndefined();
  });

  it('无 roundSummaryGenerator：静默跳过摘要（不抛）', async () => {
    const { mocks } = createHarness();
    // 覆写 getParts：roundSummaryGenerator = null（对应未初始化/关闭边界）
    const deps = createHarness({
      getParts: () => ({ ...buildParts(mocks), roundSummaryGenerator: null }),
    }).deps;
    await expect(new SeedReflect(deps).run('输入', '回复')).resolves.toBeUndefined();
  });

  it('runReported：以汇报文本为单源（输入侧空）生成摘要，span 归因 REPORT', async () => {
    const { mocks, deps } = createHarness();

    await new SeedReflect(deps).runReported('【汇报】任务已完成，结论 X');

    // 汇报单源：输入侧 ''，输出侧为汇报文本
    expect(mocks.roundSummaryGenerator.generate).toHaveBeenCalledWith(
      '',
      '【汇报】任务已完成，结论 X',
      'round-1',
      '2026-08-20-main',
      undefined,
    );
    expect(mocks.history.registerPendingArchive).toHaveBeenCalledTimes(1);
    // span 归因 round.report（非普通 a.postProcess）
    expect(mocks.tracer.startSpan).toHaveBeenCalledWith(
      'round.report',
      expect.any(Object),
    );
  });
});