/**
 * VscodeTracer.getRecentTraces 单元测试（B9 可观测补齐）
 *
 * 覆盖：
 *   - 已结束 span 被采集，按新→旧返回，limit 截断
 *   - 已知 TRACE_SPANS 名称映射为中文展现标签
 *   - 工具 span 附带工具名（工具·<名>）
 *   - 未知名 span 回退原始名称
 */
import { describe, it, expect } from 'vitest';
import { TRACE_SPANS } from '@zooique/memora';
import { VscodeTracer } from '../tracer.js';

describe('VscodeTracer.getRecentTraces', () => {
  it('按新→旧返回已结束 span，并映射为中文标签', () => {
    const tracer = new VscodeTracer();
    tracer.startSpan(TRACE_SPANS.RECALL).end();
    tracer.startSpan(TRACE_SPANS.LLM_CALL, { inputTokens: 100 }).end();
    tracer.startSpan(TRACE_SPANS.RESPONSE).end();

    const traces = tracer.getRecentTraces();
    // 新→旧：最先结束的 recall 在末尾
    expect(traces).toHaveLength(3);
    expect(traces[0].label).toBe('响应生成');
    expect(traces[1].label).toBe('LLM 调用');
    expect(traces[2].label).toBe('记忆召回');
  });

  it('工具 span 附带工具名（工具·<名>）', () => {
    const tracer = new VscodeTracer();
    tracer.startSpan(TRACE_SPANS.TOOL_EXEC, { tool: 'read_file' }).end();

    const [first] = tracer.getRecentTraces();
    expect(first?.label).toBe('工具·read_file');
  });

  it('limit 截断最近 N 条', () => {
    const tracer = new VscodeTracer();
    for (let i = 0; i < 5; i++) tracer.startSpan(TRACE_SPANS.LLM_CALL).end();

    const traces = tracer.getRecentTraces(2);
    expect(traces).toHaveLength(2);
    // 保留最近的 2 条（新→旧）
    expect(traces[0].label).toBe('LLM 调用');
    expect(traces[1].label).toBe('LLM 调用');
  });

  it('未知名 span 回退原始名称', () => {
    const tracer = new VscodeTracer();
    tracer.startSpan('custom.span-name').end();

    const [first] = tracer.getRecentTraces();
    expect(first?.label).toBe('custom.span-name');
  });

  it('未结束 span 不进入 trace（仅在 end() 后采集）', () => {
    const tracer = new VscodeTracer();
    // 未 end 的 span 不被记录
    tracer.startSpan(TRACE_SPANS.LLM_CALL);
    expect(tracer.getRecentTraces()).toHaveLength(0);
    // end 后被记录
    const span = tracer.startSpan(TRACE_SPANS.REPORT);
    span.end();
    expect(tracer.getRecentTraces()).toHaveLength(1);
  });
});