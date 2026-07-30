/**
 * 单元测试：AbortSignal 合并工具
 *
 * 覆盖 mergeAbortSignals，重点验证：
 *   - 返回 signal + clearTimer + dispose 三件套
 *   - 超时触发 abort（DOMException + TimeoutError）
 *   - optsSignal 已 aborted 时立即传播
 *   - optsSignal 运行中 abort 传播到内部 signal
 *   - clearTimer 清超时但不移除 optsSignal 监听
 *   - dispose 完整清理（清超时 + 移除监听，防止泄漏）
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { mergeAbortSignals } from '@/llm/abortSignal.js';

describe('llm/abortSignal · mergeAbortSignals', () => {
  afterEach(() => {
    // 恢复真实定时器，避免跨用例污染
    vi.useRealTimers();
  });

  it('应返回 signal / clearTimer / dispose 三件套', () => {
    const result = mergeAbortSignals(undefined, 1000, 'LLM 请求超时');
    expect(result.signal).toBeInstanceOf(AbortSignal);
    expect(typeof result.clearTimer).toBe('function');
    expect(typeof result.dispose).toBe('function');
    // 默认未触发 abort
    expect(result.signal.aborted).toBe(false);
    // 用完必须 dispose 防止定时器泄漏
    result.dispose();
  });

  it('无 optsSignal 时超时应触发 abort', () => {
    vi.useFakeTimers();
    const result = mergeAbortSignals(undefined, 1000, 'LLM 请求超时');
    expect(result.signal.aborted).toBe(false);
    // 推进 1000ms 触发超时
    vi.advanceTimersByTime(1000);
    expect(result.signal.aborted).toBe(true);
    // 超时原因应为 DOMException（TimeoutError）
    const reason = result.signal.reason;
    expect(reason).toBeInstanceOf(DOMException);
    expect((reason as DOMException).name).toBe('TimeoutError');
    expect((reason as DOMException).message).toBe('LLM 请求超时');
  });

  it('optsSignal 已 aborted 时应立即传播', () => {
    const external = new AbortController();
    external.abort(new Error('用户取消'));
    const result = mergeAbortSignals(external.signal, 1000, 'LLM 请求超时');
    // 外部信号已 aborted，内部 signal 应立即 aborted
    expect(result.signal.aborted).toBe(true);
    // 原因应继承外部信号的 reason
    expect(result.signal.reason).toBeInstanceOf(Error);
    expect((result.signal.reason as Error).message).toBe('用户取消');
    // dispose 清理超时定时器（虽未触发但仍需清理）
    result.dispose();
  });

  it('optsSignal 运行中 abort 应传播到内部 signal', () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const result = mergeAbortSignals(external.signal, 5000, 'LLM 请求超时');
    expect(result.signal.aborted).toBe(false);
    // 外部信号 abort
    external.abort(new Error('外部中断'));
    expect(result.signal.aborted).toBe(true);
    expect(result.signal.reason).toBeInstanceOf(Error);
    expect((result.signal.reason as Error).message).toBe('外部中断');
    // 未到超时时间，不应是 TimeoutError
    expect(result.signal.reason).not.toBeInstanceOf(DOMException);
    result.dispose();
  });

  it('clearTimer 应阻止超时触发 abort', () => {
    vi.useFakeTimers();
    const result = mergeAbortSignals(undefined, 1000, 'LLM 请求超时');
    // 调用 clearTimer 清除超时定时器
    result.clearTimer();
    // 推进时间超过超时阈值，不应触发 abort
    vi.advanceTimersByTime(2000);
    expect(result.signal.aborted).toBe(false);
    // clearTimer 后仍需 dispose 完整清理
    result.dispose();
  });

  it('dispose 应完整清理（超时不触发 + 监听器移除）', () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const result = mergeAbortSignals(external.signal, 1000, 'LLM 请求超时');
    // dispose 完整清理
    result.dispose();
    // 推进时间超过超时阈值，不应触发 abort（定时器已清）
    vi.advanceTimersByTime(2000);
    expect(result.signal.aborted).toBe(false);
    // 外部信号 abort 后，内部 signal 不应被触发（监听器已移除）
    external.abort(new Error('外部中断'));
    expect(result.signal.aborted).toBe(false);
  });

  it('dispose 后外部 signal abort 不应影响已 dispose 的内部 signal', () => {
    // 验证 removeEventListener 生效：dispose 后外部 abort 不再传播
    const external = new AbortController();
    const result = mergeAbortSignals(external.signal, 10000, 'LLM 请求超时');
    result.dispose();
    external.abort();
    // 内部 signal 未被外部触发，保持未 abort 状态
    expect(result.signal.aborted).toBe(false);
  });
});
