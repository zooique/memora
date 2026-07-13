/**
 * CLI 交互层测试
 *
 * 覆盖范围：
 * - start：创建 readline 实例 + 注册 line/close 事件
 *   - line 事件：trim 输入，空行跳过，非空调用 inputHandler
 *   - close 事件：调用所有 onClose 注册的回调
 * - output：写入 stdout
 * - error：写入 stderr（追加换行）
 * - stop：关闭 readline 实例 + 清空引用
 * - onClose：注册关闭回调
 *
 * Mock 策略：
 * - vi.mock('node:readline') 拦截 createInterface，返回带 on/close 方法的 mock 对象
 * - vi.spyOn(process.stdout/stderr, 'write') 拦截输出，不污染终端
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock readline：createInterface 返回带 on/close 的 mock 对象
// 事件回调通过 mockRL._handlers 捕获，测试中手动触发
const mockRL = {
  on: vi.fn(),
  close: vi.fn(),
  // 捕获的事件回调（测试中手动触发）
  _handlers: new Map<string, (...args: unknown[]) => void>(),
};

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => mockRL),
}));

// 导入被测模块（在 vi.mock 之后）
import { CliInteraction } from '../../../sprite/cli/interaction.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 CliInteraction 实例并捕获 readline 事件回调 */
function createInteractionWithCapturedHandlers(): {
  interaction: CliInteraction;
  triggerLine: (line: string) => void;
  triggerClose: () => void;
} {
  const interaction = new CliInteraction();
  const inputHandler = vi.fn();
  interaction.start(inputHandler);

  // 从 mockRL.on 调用中提取事件回调
  const onCalls = mockRL.on.mock.calls;
  const lineCall = onCalls.find(([event]) => event === 'line');
  const closeCall = onCalls.find(([event]) => event === 'close');

  return {
    interaction,
    triggerLine: (line: string) => lineCall?.[1]?.(line),
    triggerClose: () => closeCall?.[1]?.(),
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('CliInteraction', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // 重置 handlers 捕获
    mockRL._handlers.clear();
    // spy 输出流，不污染终端
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // ─── start ─────────────────────────────────────────────

  it('start 应调用 createInterface 创建 readline 实例', async () => {
    const { createInterface } = await import('node:readline');
    const interaction = new CliInteraction();
    interaction.start(vi.fn());

    expect(createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stdout,
    });
  });

  it('start 应注册 line 和 close 事件回调', () => {
    const interaction = new CliInteraction();
    interaction.start(vi.fn());

    const events = mockRL.on.mock.calls.map(([event]) => event);
    expect(events).toContain('line');
    expect(events).toContain('close');
  });

  // ─── start · line 事件 ────────────────────────────────

  it('line 事件收到非空输入应调用 inputHandler（trim 后）', () => {
    const inputHandler = vi.fn();
    const interaction = new CliInteraction();
    interaction.start(inputHandler);

    // 触发 line 事件
    const lineCallback = mockRL.on.mock.calls.find(([e]) => e === 'line')?.[1];
    lineCallback?.('  hello world  ');

    expect(inputHandler).toHaveBeenCalledWith({ text: 'hello world' });
  });

  it('line 事件收到空行（trim 后为空）应跳过不调用 inputHandler', () => {
    const inputHandler = vi.fn();
    const interaction = new CliInteraction();
    interaction.start(inputHandler);

    const lineCallback = mockRL.on.mock.calls.find(([e]) => e === 'line')?.[1];
    lineCallback?.('   ');

    expect(inputHandler).not.toHaveBeenCalled();
  });

  it('line 事件收到纯空白行应跳过', () => {
    const inputHandler = vi.fn();
    const interaction = new CliInteraction();
    interaction.start(inputHandler);

    const lineCallback = mockRL.on.mock.calls.find(([e]) => e === 'line')?.[1];
    lineCallback?.('\t\t');

    expect(inputHandler).not.toHaveBeenCalled();
  });

  // ─── start · close 事件 ───────────────────────────────

  it('close 事件应调用所有通过 onClose 注册的回调', () => {
    const interaction = new CliInteraction();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    interaction.start(vi.fn());
    interaction.onClose(handler1);
    interaction.onClose(handler2);

    // 触发 close 事件
    const closeCallback = mockRL.on.mock.calls.find(([e]) => e === 'close')?.[1];
    closeCallback?.();

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('close 事件无注册回调时应安全执行（不抛错）', () => {
    const interaction = new CliInteraction();
    interaction.start(vi.fn());

    const closeCallback = mockRL.on.mock.calls.find(([e]) => e === 'close')?.[1];
    expect(() => closeCallback?.()).not.toThrow();
  });

  // ─── output ────────────────────────────────────────────

  it('output 应写入 stdout', () => {
    const interaction = new CliInteraction();
    interaction.output('消息内容');

    expect(stdoutSpy).toHaveBeenCalledWith('消息内容');
  });

  it('output 应原样写入（不追加换行）', () => {
    const interaction = new CliInteraction();
    interaction.output('文本');

    // 仅调用一次，参数为原文本
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith('文本');
  });

  // ─── error ─────────────────────────────────────────────

  it('error 应写入 stderr 并追加换行', () => {
    const interaction = new CliInteraction();
    interaction.error('错误内容');

    expect(stderrSpy).toHaveBeenCalledWith('错误内容\n');
  });

  // ─── stop ──────────────────────────────────────────────

  it('stop 应调用 rl.close() 关闭 readline 实例', () => {
    const interaction = new CliInteraction();
    interaction.start(vi.fn());

    interaction.stop();

    expect(mockRL.close).toHaveBeenCalledTimes(1);
  });

  it('stop 在未 start 时应安全执行（rl 为 null）', () => {
    const interaction = new CliInteraction();
    expect(() => interaction.stop()).not.toThrow();
  });

  it('stop 后 line 事件不应再触发 inputHandler（引用已清空）', () => {
    const inputHandler = vi.fn();
    const interaction = new CliInteraction();
    interaction.start(inputHandler);
    interaction.stop();

    // stop 后 inputHandler 引用被清空，即使 line 事件触发也不调用
    const lineCallback = mockRL.on.mock.calls.find(([e]) => e === 'line')?.[1];
    lineCallback?.('hello');

    expect(inputHandler).not.toHaveBeenCalled();
  });

  // ─── onClose ───────────────────────────────────────────

  it('onClose 应支持注册多个回调（Set 去重）', () => {
    const interaction = new CliInteraction();
    const handler = vi.fn();
    interaction.start(vi.fn());

    // 同一 handler 注册两次（Set 应去重）
    interaction.onClose(handler);
    interaction.onClose(handler);

    const closeCallback = mockRL.on.mock.calls.find(([e]) => e === 'close')?.[1];
    closeCallback?.();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('onClose 在未 start 时也应能注册回调', () => {
    const interaction = new CliInteraction();
    const handler = vi.fn();
    interaction.onClose(handler);

    // start 后触发 close，handler 应被调用
    interaction.start(vi.fn());
    const closeCallback = mockRL.on.mock.calls.find(([e]) => e === 'close')?.[1];
    closeCallback?.();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
