/**
 * Hand back 消费者骨架单元测试（P2 · 2026-11-17）
 *
 * 仿 HostedSessionNotice 的测试模式：宿主桩注入 deps，验证 handleHandBack 的路由行为。
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Agent } from '@zooique/memora';
import { HandBackConsumer, type HandBackConsumerDeps } from '../handBackConsumer.js';

/** 最小 Agent 桩（只有 agentLoop.enqueueCommandResult，够用即可） */
function makeAgentLoop(queue: string[]): Agent {
  return {
    agentLoop: {
      enqueueCommandResult: (text: string) => queue.push(text),
    },
  } as unknown as Agent;
}

function makeConsumer(deps: Partial<HandBackConsumerDeps> = {}) {
  const queue: string[] = [];
  const consumer = new HandBackConsumer({
    lookupCreator: () => undefined,
    getAgent: () => undefined,
    isManaged: () => false,
    ...deps,
  } satisfies HandBackConsumerDeps);
  return { consumer, queue };
}

describe('HandBackConsumer', () => {
  // ── 不是 Hand back 消息 → 跳过 ──
  it('非 HAND_BACK 前缀 → 返回 false，不投', () => {
    const { consumer, queue } = makeConsumer();
    expect(consumer.handleHandBack('worker-1', '[后台命令完成] foo')).toBe(false);
    expect(queue).toEqual([]);
  });

  // ── 解析失败（reason 缺失）→ 跳过 ──
  it('reason 缺失（合法前缀但解析失败）→ 返回 false', () => {
    const { consumer, queue } = makeConsumer();
    expect(consumer.handleHandBack('worker-1', '[HAND_BACK] suggestion: x')).toBe(false);
    expect(queue).toEqual([]);
  });

  // ── 正常路径：解析 → 格式化 → 注入助手 loop ──
  it('正常 Hand back 消息 → 注入助手 loop', () => {
    const queue: string[] = [];
    const consumer = new HandBackConsumer({
      lookupCreator: () => 'creator-1',
      getAgent: () => makeAgentLoop(queue),
      isManaged: () => true,
    });
    const ok = consumer.handleHandBack(
      'worker-1',
      '[HAND_BACK] reason: 超出范围 | suggestion: 新建会话',
    );
    expect(ok).toBe(true);
    // 规范化后的格式（parse → format）
    expect(queue).toEqual(['[HAND_BACK] reason: 超出范围 | suggestion: 新建会话']);
  });

  // ── 幂等守卫：同 worker + 同 reason 只投一次 ──
  it('幂等：同 Worker 同 reason 第二次不重复投', () => {
    const queue: string[] = [];
    const consumer = new HandBackConsumer({
      lookupCreator: () => 'creator-1',
      getAgent: () => makeAgentLoop(queue),
      isManaged: () => true,
    });
    consumer.handleHandBack('worker-1', '[HAND_BACK] reason: 超界');
    consumer.handleHandBack('worker-1', '[HAND_BACK] reason: 超界');
    expect(queue).toHaveLength(1);
  });

  // ── 幂等守卫：不同 reason 或不同 worker 各投各的 ──
  it('幂等键区分：不同 reason / 不同 worker 互不干扰', () => {
    const queue: string[] = [];
    const consumer = new HandBackConsumer({
      lookupCreator: () => 'creator-1',
      getAgent: () => makeAgentLoop(queue),
      isManaged: () => true,
    });
    consumer.handleHandBack('worker-1', '[HAND_BACK] reason: 超界A');
    consumer.handleHandBack('worker-1', '[HAND_BACK] reason: 超界B'); // 不同 reason
    consumer.handleHandBack('worker-2', '[HAND_BACK] reason: 超界A'); // 不同 worker
    expect(queue).toHaveLength(3);
  });

  // ── 降级：Worker 无登记创建者 → 不投 ──
  it('lookupCreator 返回 undefined → 返回 false，不崩', () => {
    const { consumer, queue } = makeConsumer({
      lookupCreator: () => undefined,
      isManaged: () => true,
    });
    expect(consumer.handleHandBack('worker-1', '[HAND_BACK] reason: x')).toBe(false);
    expect(queue).toEqual([]);
  });

  // ── 降级：助手已被收回 → 不投 ──
  it('助手 isManaged=false → 返回 false', () => {
    const { consumer } = makeConsumer({
      lookupCreator: () => 'creator-1',
      isManaged: () => false,
    });
    expect(consumer.handleHandBack('worker-1', '[HAND_BACK] reason: x')).toBe(false);
  });

  // ── 降级：助手 loop 实例未就绪 → 不投 ──
  it('getAgent 返回 undefined → 返回 false', () => {
    const { consumer } = makeConsumer({
      lookupCreator: () => 'creator-1',
      getAgent: () => undefined,
      isManaged: () => true,
    });
    expect(consumer.handleHandBack('worker-1', '[HAND_BACK] reason: x')).toBe(false);
  });

  // ── 规范化：parse → format 把歪格式矫正成标准格式 ──
  it('规范化：字段顺序乱也能矫正成标准格式', () => {
    const queue: string[] = [];
    const consumer = new HandBackConsumer({
      lookupCreator: () => 'creator-1',
      getAgent: () => makeAgentLoop(queue),
      isManaged: () => true,
    });
    // reason 放后面、字段顺序乱
    consumer.handleHandBack('worker-1', '[HAND_BACK] suggestion: y | reason: x');
    expect(queue[0]).toBe('[HAND_BACK] reason: x | suggestion: y');
  });
});
