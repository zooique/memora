/**
 * E5 验收：`AgentEventScope` 的实例边界
 *
 * 用两台**彼此独立**的假事件发射器（模拟两个 Agent 实例）走真实装订/分发/解绑路径：
 *  - 面板 A 的作用域绑定实例 A、面板 B 绑定实例 B ⇒ A 的事件不流向 B（反之亦然）
 *  - `dispose()` 后实例上的监听器被移除（事件不再触达旧面板）
 *  - `bindTo` 换实例时先整体解绑旧实例（不残留）
 *
 * 不许把转发层 mock 掉：本用例直接调用生产类 `AgentEventScope.bindTo/dispose`，
 * 假发射器只实现 Agent 的 `on/off/emit` 对外契约。
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Agent } from '@zooique/memora';
import { AgentEventScope } from '../agentEventScope.js';

/** 假事件发射器：复刻 Agent 的 on/off/emit 最小契约（不做任何跨实例转发） */
class FakeEmitter {
  /** 事件名 → 监听器集合（Set 语义与内核 EventEmitter 一致） */
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  /** 注册监听器 */
  on(event: string, handler: (payload: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  /** 移除监听器 */
  off(event: string, handler: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  /** 分发事件（只触达本实例自己的监听器） */
  emit(event: string, payload?: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload);
  }

  /** 某事件上的监听器数量（断言解绑生效） */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

/**
 * 伪造 Agent（作用域只依赖 `on/off`，其余成员不参与本用例）
 *
 * @param emitter 该"实例"的事件发射器
 */
function fakeAgent(emitter: FakeEmitter): Agent {
  return emitter as unknown as Agent;
}

/**
 * 构造一个最小装订器：在目标实例上订阅 `sessionError` 并记录触达次数
 *
 * @param hits 触达计数数组（调用方断言用）
 */
function makeBinder(hits: string[]) {
  return (agent: Agent): Array<() => void> => {
    const handler = (): void => {
      hits.push('hit');
    };
    (agent as unknown as FakeEmitter).on('sessionError', handler);
    return [() => (agent as unknown as FakeEmitter).off('sessionError', handler)];
  };
}

describe('E5 · AgentEventScope 实例边界', () => {
  it('面板 A 订阅实例 A、面板 B 订阅实例 B：A 的事件不流向 B', () => {
    const emitterA = new FakeEmitter();
    const emitterB = new FakeEmitter();
    const hitsA: string[] = [];
    const hitsB: string[] = [];
    const scopeA = new AgentEventScope();
    const scopeB = new AgentEventScope();

    scopeA.bindTo(fakeAgent(emitterA), makeBinder(hitsA));
    scopeB.bindTo(fakeAgent(emitterB), makeBinder(hitsB));

    emitterA.emit('sessionError');
    expect(hitsA).toHaveLength(1);
    expect(hitsB).toHaveLength(0);

    emitterB.emit('sessionError');
    expect(hitsB).toHaveLength(1);
    expect(hitsA).toHaveLength(1);
  });

  it('dispose 后解绑：旧实例事件不再触达已销毁面板', () => {
    const emitter = new FakeEmitter();
    const hits: string[] = [];
    const scope = new AgentEventScope();

    scope.bindTo(fakeAgent(emitter), makeBinder(hits));
    expect(emitter.listenerCount('sessionError')).toBe(1);

    scope.dispose();
    expect(emitter.listenerCount('sessionError')).toBe(0);
    expect(scope.owner).toBeUndefined();
    emitter.emit('sessionError');
    expect(hits).toHaveLength(0);
  });

  it('bindTo 换实例：旧实例订阅先被清空（作用域只跟随当前实例）', () => {
    const emitterOld = new FakeEmitter();
    const emitterNew = new FakeEmitter();
    const hitsOld: string[] = [];
    const hitsNew: string[] = [];
    const scope = new AgentEventScope();

    scope.bindTo(fakeAgent(emitterOld), makeBinder(hitsOld));
    scope.bindTo(fakeAgent(emitterNew), makeBinder(hitsNew));

    expect(emitterOld.listenerCount('sessionError')).toBe(0);
    emitterOld.emit('sessionError');
    expect(hitsOld).toHaveLength(0);

    emitterNew.emit('sessionError');
    expect(hitsNew).toHaveLength(1);
  });
});
