/**
 * E4 验收：`AgentRegistry` 会话 → Agent 登记表
 *
 * 只验登记表本身（纯内存映射 + 注入工厂），不起真实 Agent：
 *
 * （下方「判据 3 · 装配层」describe 例外：它起真实 Agent，专为补强判据 3）
 *  - 同 sessionId 两次取回**同一实例**（不是每调一次新建）
 *  - 不同 sessionId 取回**不同实例**
 *  - 两次装配拿到**同一对**存储单例（类型 + 引用同一性，防各 Agent 自建一份）
 *  - **装配层**（判据 3 的真证明）：两个不同会话经 `createAgentForSession` 走**真实装配**
 *    （`assembleAgent` → `new Agent({ storage })` → `init()`）后，`agent.context.index`
 *    是**同一对象引用**——验「真实 Agent 实际用的记忆存储」，不是只验「登记表收到的参数相同」
 *  - 注销一个不影响另一个（**仅限进程内实例状态**）；注销后再取 = 重建新实例（close 后重建）
 *    ⚠️ 作用域界定：本判据**只覆盖进程内登记表状态**——关/注销 A 不改变登记表中 B 的引用与可取回性。
 *    跨进程告警通道在该场景下会失效：同进程多 Agent 共享 `.memora/.lock`，先关的实例会删掉锁文件，
 *    后来的实例失去「他人正持有」的告警。已登记 `PROJECTLOCK-SHARED-1`，**不在本片修复**。
 *    本判据不构成「关一个对一个毫无影响」的全称保证。
 *  - 并发同键只装配一次（在途去重复用同一 Promise）
 */
// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, IRoundStore, ISessionStore } from '@zooique/memora';
import {
  AgentRegistry,
  type ProjectStoreSingletons,
  type SessionAgentFactory,
} from '../agentRegistry.js';
// 真实装配路径（判据 3 装配层验证）所需依赖
import { assembleAgent } from '../assemble.js';
import { createHostMemoryStorage } from '../memoryStorage.js';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

// `assemble.ts` 间接 import `projectSearchProvider.ts`（模块级 import vscode），
// 本文件不触真实 VS Code API，用最小 mock 让模块可解析；被测路径不调用它。
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
}));

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

// ─────────────────────────────────────────────────────────────
// 判据 3 · 装配层（真证明）：真实 Agent 实际使用的记忆存储同一性
// ─────────────────────────────────────────────────────────────

/**
 * 播种角色包目录（真实 `assembleAgent` 的 init 必须能扫描到角色包）
 *
 * @param configDir 装配用的配置目录（`AssembleOptions.configDir`）
 */
function seedRolePacks(configDir: string): void {
  for (const name of ['默认助手', 'memora助手']) {
    const dir = join(configDir, 'role-packs', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ name, displayName: name, strategy: {} }),
      'utf-8',
    );
    writeFileSync(join(dir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  }
  mkdirSync(join(configDir, 'skills'), { recursive: true });
}

describe('E4 · 判据 3 装配层（真实装配路径）', () => {
  it('两会话经 createAgentForSession 真实装配后，实际使用的记忆存储是同一对象引用', async () => {
    const projectPath = makeTempDir('memora-e4-assembly-');
    const configDir = join(projectPath, 'config');
    seedRolePacks(configDir);

    // 与生产装配同一份共享单例（E3 硬约束）：会话 + 轮次 + 记忆存储
    const roundStore = new WorkspaceRoundStore(projectPath);
    roundStore.load();
    const sessionStore = new WorkspaceSessionStore(projectPath, roundStore);
    sessionStore.load();
    const sharedStorage = createHostMemoryStorage(projectPath);

    // 已装配实例（用例结束统一 close，逆序释放）
    const agents: Agent[] = [];

    // 工厂 = 生产 `assembleAgentForSession` 的同形实现：
    // 真实装配（assembleAgent → new Agent({ storage }) → init）→ 绑定目标会话
    const registry = new AgentRegistry({ sessionStore, roundStore }, async (sessionId) => {
      const agent = await assembleAgent({
        projectPath,
        configDir,
        sessionStore,
        roundStore,
        // 关键判据输入：所有会话 Agent 共用宿主持有的同一份记忆存储
        storage: sharedStorage,
        // 不引入后台摘要 LLM 调用与时序噪声
        archiveMode: 'manual',
        autoStartGc: false,
        allowedPaths: [projectPath],
        // Provider 仅构造、不发起网络请求：填必填的环境变量形态即可
        env: {
          MEMORA_BASE_URL: 'http://127.0.0.1:1/v1',
          MEMORA_MODEL: 'e4-probe',
          MEMORA_API_KEY: 'e4-probe',
        } as NodeJS.ProcessEnv,
      });
      // 绑定目标会话（生产装配同款：载入该会话消息并重建工作记忆）
      await agent.sessionManager!.switchToSession(sessionId);
      agents.push(agent);
      return agent;
    });

    try {
      // 两个**不同** sessionId：一会话一实例
      const a = await registry.createAgentForSession('2026-11-06-e4a');
      const b = await registry.createAgentForSession('2026-11-06-e4b');

      expect(a).not.toBe(b);
      // 真实装配出来的实例确实绑定到了各自会话
      expect(a.agentHistory?.currentSessionName).toBe('2026-11-06-e4a');
      expect(b.agentHistory?.currentSessionName).toBe('2026-11-06-e4b');

      // ── 判据 3 的真证明：真实 Agent 实际用的记忆存储是同一个对象 ──
      // `context.index` 是 Agent 内部 ProjectManager 实际装进 ProjectContext 的存储实例，
      // 不是工厂入参的副本 ⇒ 这一条才证明「共存储共记忆」在装配层成立。
      expect(a.context?.index).toBe(b.context?.index);
      expect(a.context?.index).toBe(sharedStorage);
    } finally {
      for (const agent of agents.reverse()) {
        await agent.close().catch(() => {
          // 关闭失败不影响判据结论（临时目录由 tmpDir helper 回收）
        });
      }
      sharedStorage.close?.();
    }
  }, 120_000);
});
