/**
 * E4 验收：`AgentRegistry` 会话 → Agent 登记表
 *
 * 只验登记表本身（纯内存映射），不起真实 Agent：
 *  - 登记后按 sessionId 查回**同一个实例**（不是等值副本）
 *  - 未登记/已注销 ⇒ undefined
 *  - 构造期持有传入的**同一对**存储单例（类型强制，防各 Agent 自建一份）
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Agent, IRoundStore, ISessionStore } from '@zooique/memora';
import { AgentRegistry } from '../agentRegistry.js';

/**
 * 假 Agent（登记表只做 Map 存取，不触碰 Agent 内部）
 *
 * @param label 标识（用于断言取回的是同一个对象）
 */
function makeFakeAgent(label: string): Agent {
  return { label } as unknown as Agent;
}

/** 假会话存储（构造登记表只持有引用，不调用方法） */
const fakeSessionStore = {} as unknown as ISessionStore;
/** 假轮次存储（同上） */
const fakeRoundStore = {} as unknown as IRoundStore;

describe('E4 · AgentRegistry', () => {
  it('登记后能按 sessionId 查到同一个实例；未登记为 undefined', () => {
    const registry = new AgentRegistry({
      sessionStore: fakeSessionStore,
      roundStore: fakeRoundStore,
    });
    const agent = makeFakeAgent('session-a');

    registry.register('2026-11-05-main', agent);

    // 严格同一性：登记表存的是实例引用，不是快照/副本
    expect(registry.get('2026-11-05-main')).toBe(agent);
    expect(registry.get('2026-11-05-other')).toBeUndefined();
  });

  it('注销后查不到（会话关闭语义）', () => {
    const registry = new AgentRegistry({
      sessionStore: fakeSessionStore,
      roundStore: fakeRoundStore,
    });
    registry.register('2026-11-05-main', makeFakeAgent('session-a'));

    registry.unregister('2026-11-05-main');

    expect(registry.get('2026-11-05-main')).toBeUndefined();
  });

  it('持有构造期传入的同一对存储单例（不自建，E3 硬约束）', () => {
    const registry = new AgentRegistry({
      sessionStore: fakeSessionStore,
      roundStore: fakeRoundStore,
    });

    expect(registry.stores.sessionStore).toBe(fakeSessionStore);
    expect(registry.stores.roundStore).toBe(fakeRoundStore);
  });
});
