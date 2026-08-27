/**
 * tracer.ts 单元测试 — Agent 可观测性接口
 *
 * 覆盖范围：
 *   - NoopSpan 三个方法（setAttribute/end/recordException）静默不抛错
 *   - NoopTracer.startSpan 返回共享的 NOOP_SPAN 单例
 *   - NOOP_TRACER 单例身份稳定
 *   - TRACE_SPANS 5 个预定义 Span 名称常量
 *   - 自定义 ITracer 注入后按接口契约工作
 *   - AgentMetrics 类型契约（纯类型，仅做编译时校验）
 */
import { describe, expect, it, vi } from 'vitest';
import { NOOP_TRACER, TRACE_SPANS, type ISpan, type ITracer } from '@/agent/tracer.js';

// ─── NoopSpan 行为（通过 NOOP_TRACER 间接验证 NoopSpan） ────────

describe('NoopSpan（通过 NOOP_TRACER 间接验证）', () => {
  it('setAttribute 不抛错且不返回值', () => {
    const span = NOOP_TRACER.startSpan('test');
    // 三个不同类型的属性值，验证类型签名兼容
    expect(() => span.setAttribute('string-key', 'value')).not.toThrow();
    expect(() => span.setAttribute('number-key', 42)).not.toThrow();
    expect(() => span.setAttribute('boolean-key', true)).not.toThrow();
  });

  it('end 不抛错且不返回值', () => {
    const span = NOOP_TRACER.startSpan('test');
    expect(() => span.end()).not.toThrow();
    // 重复 end 也应安全（NoopSpan 无状态）
    expect(() => span.end()).not.toThrow();
  });

  it('recordException 不抛错且不返回值', () => {
    const span = NOOP_TRACER.startSpan('test');
    const err = new Error('测试异常');
    expect(() => span.recordException(err)).not.toThrow();
    // recordException 不应中断 span，可继续 setAttribute / end
    expect(() => span.setAttribute('after-error', true)).not.toThrow();
    expect(() => span.end()).not.toThrow();
  });
});

// ─── NoopTracer 行为 ────────────────────────────────────────

describe('NoopTracer', () => {
  it('startSpan 返回 ISpan 实例（满足接口契约）', () => {
    const span = NOOP_TRACER.startSpan('any-name');
    // 接口契约：返回的对象必须实现 ISpan 的三个方法
    expect(span).toBeDefined();
    expect(typeof span.setAttribute).toBe('function');
    expect(typeof span.end).toBe('function');
    expect(typeof span.recordException).toBe('function');
  });

  it('startSpan 无 attributes 参数时不抛错', () => {
    expect(() => NOOP_TRACER.startSpan('no-attrs')).not.toThrow();
  });

  it('startSpan 带 attributes 参数时不抛错', () => {
    const attrs = { model: 'gpt-4o', temperature: 0.3, stream: true };
    expect(() => NOOP_TRACER.startSpan('with-attrs', attrs)).not.toThrow();
  });

  it('startSpan 多次调用返回同一个 NoopSpan 单例（避免分配开销）', () => {
    // 设计意图：共享 NOOP_SPAN 单例，零分配
    const span1 = NOOP_TRACER.startSpan('first');
    const span2 = NOOP_TRACER.startSpan('second');
    const span3 = NOOP_TRACER.startSpan('third', { k: 'v' });
    expect(span1).toBe(span2);
    expect(span2).toBe(span3);
  });
});

// ─── NOOP_TRACER 单例身份 ──────────────────────────────────

describe('NOOP_TRACER 单例', () => {
  it('NOOP_TRACER 实现 ITracer 接口', () => {
    expect(NOOP_TRACER).toBeDefined();
    expect(typeof NOOP_TRACER.startSpan).toBe('function');
  });

  it('NOOP_TRACER 引用稳定（多次 import 返回同一实例）', () => {
    // 模块级单例：import 多次应返回同一引用
    // 通过对比 startSpan 返回的 span 间接验证（NoopTracer 始终返回同一 NoopSpan）
    const spanA = NOOP_TRACER.startSpan('a');
    const spanB = NOOP_TRACER.startSpan('b');
    expect(spanA).toBe(spanB);
  });
});

// ─── TRACE_SPANS 预定义 Span 名称 ─────────────────────────

describe('TRACE_SPANS 预定义 Span 名称常量', () => {
  it('包含 9 个 AgentLoop 关键节点 Span 名称', () => {
    expect(Object.keys(TRACE_SPANS)).toHaveLength(9);
  });

  it('RECALL = "recall.recall"（记忆召回阶段）', () => {
    expect(TRACE_SPANS.RECALL).toBe('recall.recall');
  });

  it('LLM_CALL = "llm.call"（LLM API 调用）', () => {
    expect(TRACE_SPANS.LLM_CALL).toBe('llm.call');
  });

  it('TOOL_EXEC = "tool.execute"（工具执行）', () => {
    expect(TRACE_SPANS.TOOL_EXEC).toBe('tool.execute');
  });

  it('RESPONSE = "response.generate"（最终响应生成）', () => {
    expect(TRACE_SPANS.RESPONSE).toBe('response.generate');
  });

  it('CONTEXT_SUMMARY = "context.summary"（上下文摘要生成）', () => {
    expect(TRACE_SPANS.CONTEXT_SUMMARY).toBe('context.summary');
  });

  it('POST_PROCESS = "archive.postProcess"（对话后归档处理）', () => {
    expect(TRACE_SPANS.POST_PROCESS).toBe('archive.postProcess');
  });

  it('RECALL_ACTUAL = "recall.actual"（实际记忆召回函数）', () => {
    expect(TRACE_SPANS.RECALL_ACTUAL).toBe('recall.actual');
  });

  it('所有 Span 名称采用 dot.notation 命名约定', () => {
    // 命名约定：service.operation 形式，便于宿主按前缀过滤
    // 支持多段点号（如 archive.postProcess）
    for (const name of Object.values(TRACE_SPANS)) {
      expect(name).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
    }
  });
});

// ─── 自定义 ITracer 注入（宿主接入路径） ───────────────────

describe('自定义 ITracer 注入', () => {
  it('注入自定义 Tracer 后 startSpan 按接口契约工作', () => {
    // 模拟宿主注入的 Tracer（如 OpenTelemetry 适配器）
    const customSpan: ISpan = {
      setAttribute: vi.fn(),
      end: vi.fn(),
      recordException: vi.fn(),
    };
    const customTracer: ITracer = {
      startSpan: vi.fn().mockReturnValue(customSpan),
    };

    // 调用方使用 tracer（模拟 AgentLoop 的使用方式）
    const span = customTracer.startSpan('llm.call', { model: 'gpt-4o' });
    span.setAttribute('input.tokens', 100);
    span.setAttribute('output.tokens', 50);
    span.end();

    expect(customTracer.startSpan).toHaveBeenCalledWith('llm.call', { model: 'gpt-4o' });
    expect(customSpan.setAttribute).toHaveBeenCalledTimes(2);
    expect(customSpan.end).toHaveBeenCalledTimes(1);
    expect(customSpan.recordException).not.toHaveBeenCalled();
  });

  it('注入自定义 Tracer 后 recordException 用于标记错误状态', () => {
    const customSpan: ISpan = {
      setAttribute: vi.fn(),
      end: vi.fn(),
      recordException: vi.fn(),
    };
    const customTracer: ITracer = {
      startSpan: vi.fn().mockReturnValue(customSpan),
    };

    const span = customTracer.startSpan('tool.execute', { tool: 'read_file' });
    const err = new Error('文件不存在');
    span.recordException(err);
    span.end();

    expect(customSpan.recordException).toHaveBeenCalledWith(err);
    expect(customSpan.end).toHaveBeenCalledTimes(1);
  });

  it('自定义 Tracer 与 NOOP_TRACER 行为隔离（不共享 span）', () => {
    // 自定义 Tracer 不应返回 NOOP_TRACER 的 NoopSpan 单例
    const customSpan: ISpan = {
      setAttribute: vi.fn(),
      end: vi.fn(),
      recordException: vi.fn(),
    };
    const customTracer: ITracer = {
      startSpan: vi.fn().mockReturnValue(customSpan),
    };

    const customResult = customTracer.startSpan('test');
    const noopResult = NOOP_TRACER.startSpan('test');

    expect(customResult).not.toBe(noopResult);
    expect(customResult).toBe(customSpan);
  });
});

// ─── ISpan / ITracer 接口契约（编译时校验） ────────────────

describe('ISpan / ITracer 接口契约', () => {
  it('ISpan 接口实现对象满足类型签名', () => {
    // 编译时校验：实现 ISpan 的对象必须包含三个方法
    const span: ISpan = {
      setAttribute: (_key: string, _value: string | number | boolean) => {},
      end: () => {},
      recordException: (_error: Error) => {},
    };
    expect(span).toBeDefined();
    expect(typeof span.setAttribute).toBe('function');
    expect(typeof span.end).toBe('function');
    expect(typeof span.recordException).toBe('function');
  });

  it('ITracer 接口实现对象满足类型签名', () => {
    // 编译时校验：实现 ITracer 的对象必须包含 startSpan 方法
    const tracer: ITracer = {
      startSpan: (_name: string, _attributes?: Record<string, string | number | boolean>) => ({
        setAttribute: () => {},
        end: () => {},
        recordException: () => {},
      }),
    };
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe('function');
    // 调用一次验证运行时行为
    const span = tracer.startSpan('compile-check');
    expect(span).toBeDefined();
  });
});
