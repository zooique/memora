/**
 * E4 验收：`AgentRegistry` 会话 → Agent 登记表
 *
 * 只验登记表本身（纯内存映射 + 注入工厂），不起真实 Agent：
 *  - 同 sessionId 两次取回**同一实例**（不是每调一次新建）
 *  - 不同 sessionId 取回**不同实例**
 *  - 两次装配拿到**同一对**存储单例（类型 + 引用同一性，防各 Agent 自建一份）
 *  - 注销一个不影响另一个（**仅限进程内实例状态**）；注销后再取 = 重建新实例（close 后重建）
 *    ⚠️ 作用域界定：本判据**只覆盖进程内登记表状态**——关/注销 A 不改变登记表中 B 的引用与可取回性。
 *    跨进程告警通道在该场景下会失效：同进程多 Agent 共享 `.memora/.lock`，先关的实例会删掉锁文件，
 *    后来的实例失去「他人正持有」的告警。已登记 `PROJECTLOCK-SHARED-1`，**不在本片修复**。
 *    本判据不构成「关一个对一个毫无影响」的全称保证。
 *  - 并发同键只装配一次（在途去重复用同一 Promise）
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Agent, IRoundStore, ISessionStore } from '@zooique/memora';
import {
  AgentRegistry,
  type ProjectStoreSingletons,
  type SessionAgentFactory,
} from '../agentRegistry.js';

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
/** 共享存储单例对（所有用例共用同一引用，模拟生产注入） */
const sharedStores: ProjectStoreSingletons = {
  sessionStore: fakeSessionStore,
  roundStore: fakeRoundStore,
};

/**
 * 记录型工厂：按 sessionId 造独立假实例，并记录每次收到的单例引用
 *
 * @param calls 每次装配的入参快照（断言共享单例同一性）
 */
function makeRecordingFactory(
  calls: { sessionId: string; stores: ProjectStoreSingletons }[],
): SessionAgentFactory {
  return async (sessionId, stores) => {
    calls.push({ sessionId, stores });
    return makeFakeAgent(sessionId);
  };
}

describe('E4 · AgentRegistry', () => {
  it('登记后能按 sessionId 查到同一个实例；未登记为 undefined', () => {
    const registry = new AgentRegistry(sharedStores, async (id) => makeFakeAgent(id));
    const agent = makeFakeAgent('session-a');

    registry.register('2026-11-05-main', agent);

    // 严格同一性：登记表存的是实例引用，不是快照/副本
    expect(registry.get('2026-11-05-main')).toBe(agent);
    expect(registry.get('2026-11-05-other')).toBeUndefined();
  });

  it('注销后查不到（会话关闭语义）', () => {
    const registry = new AgentRegistry(sharedStores, async (id) => makeFakeAgent(id));
    registry.register('2026-11-05-main', makeFakeAgent('session-a'));

    registry.unregister('2026-11-05-main');

    expect(registry.get('2026-11-05-main')).toBeUndefined();
  });

  it('持有构造期传入的同一对存储单例（不自建，E3 硬约束）', () => {
    const registry = new AgentRegistry(sharedStores, async (id) => makeFakeAgent(id));

    expect(registry.stores.sessionStore).toBe(fakeSessionStore);
    expect(registry.stores.roundStore).toBe(fakeRoundStore);
  });

  it('同 sessionId 两次取回同一实例（工厂只装配一次）', async () => {
    const calls: { sessionId: string; stores: ProjectStoreSingletons }[] = [];
    const registry = new AgentRegistry(sharedStores, makeRecordingFactory(calls));

    const first = await registry.createAgentForSession('2026-11-05-a');
    const second = await registry.createAgentForSession('2026-11-05-a');

    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it('不同 sessionId 取回不同实例，且两次装配拿到同一套共享单例', async () => {
    const calls: { sessionId: string; stores: ProjectStoreSingletons }[] = [];
    const registry = new AgentRegistry(sharedStores, makeRecordingFactory(calls));

    const a = await registry.createAgentForSession('2026-11-05-a');
    const b = await registry.createAgentForSession('2026-11-05-b');

    // 是一会话一实例，不是等值副本
    expect(a).not.toBe(b);
    expect(calls).toHaveLength(2);
    // 共享单例判据：两次装配收到的是**同一对象**（不是各建一份）
    expect(calls[0].stores).toBe(calls[1].stores);
    expect(calls[0].stores).toBe(sharedStores);
  });

  it('并发取同一会话只装配一次（在途去重）', async () => {
    const calls: { sessionId: string; stores: ProjectStoreSingletons }[] = [];
    const registry = new AgentRegistry(sharedStores, makeRecordingFactory(calls));

    // 同时发起两次：第二次必须复用第一次的在途 Promise，而不是再装配一个
    const [first, second] = await Promise.all([
      registry.createAgentForSession('2026-11-05-a'),
      registry.createAgentForSession('2026-11-05-a'),
    ]);

    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it('注销一个实例不影响另一个（进程内登记表状态）；注销后再取为重建的新实例', async () => {
    const calls: { sessionId: string; stores: ProjectStoreSingletons }[] = [];
    const registry = new AgentRegistry(sharedStores, makeRecordingFactory(calls));

    const a = await registry.createAgentForSession('2026-11-05-a');
    const b = await registry.createAgentForSession('2026-11-05-b');

    // 注销 A（调用方随后自行 close A；登记表不碰生命周期）
    registry.unregister('2026-11-05-a');
    expect(registry.get('2026-11-05-a')).toBeUndefined();
    // B 不受影响：仍是同一实例
    expect(registry.get('2026-11-05-b')).toBe(b);

    // close 后重建：A 再取回的是新实例，不是已注销的旧对象
    const rebuilt = await registry.createAgentForSession('2026-11-05-a');
    expect(rebuilt).not.toBe(a);
    expect(calls).toHaveLength(3);
  });

  it('工厂失败不登记、不留在途标记（下一次可重试）', async () => {
    let attempts = 0;
    const registry = new AgentRegistry(sharedStores, async (id) => {
      attempts += 1;
      if (attempts === 1) throw new Error('装配失败');
      return makeFakeAgent(id);
    });

    await expect(registry.createAgentForSession('2026-11-05-a')).rejects.toThrow('装配失败');
    expect(registry.get('2026-11-05-a')).toBeUndefined();

    // 失败后在途已清 → 第二次走正常装配并登记
    const retried = await registry.createAgentForSession('2026-11-05-a');
    expect(registry.get('2026-11-05-a')).toBe(retried);
    expect(attempts).toBe(2);
  });
});
