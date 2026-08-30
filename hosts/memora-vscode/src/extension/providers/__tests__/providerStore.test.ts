/**
 * ProviderStore — contextWindow 校验 + 旧全局 maxContextTokens 迁移（2026-08-29 窗口模型收敛）
 *
 * 不引入真实 VS Code 运行时：用 vi.mock 提供内存版 workspace.getConfiguration + SecretStorage。
 * 仅覆盖本次新增的 per-LLM contextWindow 护栏与迁移逻辑（其余路径由既有集成测试覆盖）。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** 内存版 configuration 存储（hoisted 以便在 vi.mock 工厂内引用） */
const h = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  const config = {
    store,
    get: (key: string, def?: unknown) => (key in store ? store[key] : def),
    update: (key: string, val: unknown) => {
      store[key] = val;
    },
    inspect: (key: string) => ({ globalValue: key in store ? store[key] : undefined }),
  };
  return { config, store };
});

/** 内存版 SecretStorage（apiKey 存储，与 contextWindow 校验无关但构造需要） */
const secretsStore: Record<string, string> = {};
const secrets = {
  get: vi.fn(async (k: string) => secretsStore[k] ?? null),
  store: vi.fn(async (k: string, v: string) => {
    secretsStore[k] = v;
  }),
  delete: vi.fn(async (k: string) => {
    delete secretsStore[k];
  }),
};

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: { getConfiguration: () => h.config },
}));

import { ProviderStore } from '../providerStore.js';

describe('ProviderStore.contextWindow 护栏 + 迁移', () => {
  let store: ProviderStore;
  beforeEach(() => {
    h.store['providers'] = [];
    delete h.store['maxContextTokens'];
    for (const k of Object.keys(secretsStore)) delete secretsStore[k];
    store = new ProviderStore(secrets as unknown as import('vscode').SecretStorage);
  });

  it('save：含合法 contextWindow → ok 且持久化保留该字段', async () => {
    const res = await store.save(
      { name: 'deepseek', displayName: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', contextWindow: 128000 },
      false,
    );
    expect(res.ok).toBe(true);
    const saved = (h.store['providers'] as Array<Record<string, unknown>>)[0];
    expect(saved.contextWindow).toBe(128000);
    // apiKey 不落 configuration（仅 SecretStorage）
    expect(saved.apiKey).toBeUndefined();
  });

  it('save：contextWindow 缺省（undefined）→ 仍允许保存（回落内核默认 120K）', async () => {
    const res = await store.save(
      { name: 'deepseek', displayName: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' },
      false,
    );
    expect(res.ok).toBe(true);
    const saved = (h.store['providers'] as Array<Record<string, unknown>>)[0];
    expect(saved.contextWindow).toBeUndefined();
  });

  it.each([0, 999, 1.5, 10_000_001, -1])('save：非法 contextWindow=%p → 拒绝并给 message', async (bad) => {
    const res = await store.save(
      { name: 'deepseek', displayName: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', contextWindow: bad as number },
      false,
    );
    expect(res.ok).toBe(false);
    expect(res.message).toBeTruthy();
  });

  it('migrateMaxContextTokens：旧全局值并入首个 provider 的 contextWindow 并清除旧键', async () => {
    h.store['providers'] = [
      { name: 'deepseek', displayName: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.example.com/v1' },
      { name: 'local', displayName: '本地', model: 'local', baseUrl: 'http://localhost:11434/v1' },
    ];
    h.store['maxContextTokens'] = 64000;

    await store.migrateMaxContextTokens();

    const saved = h.store['providers'] as Array<Record<string, unknown>>;
    expect(saved[0].contextWindow).toBe(64000);
    // 第二个 provider 不受影响（首个未配置者才被填充）
    expect(saved[1].contextWindow).toBeUndefined();
    // 旧全局键已清除（无双真理源残留）
    expect(h.store['maxContextTokens']).toBeUndefined();
  });

  it('migrateMaxContextTokens：无旧全局值 → 无动作', async () => {
    h.store['providers'] = [{ name: 'deepseek', displayName: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.example.com/v1' }];
    await store.migrateMaxContextTokens();
    expect((h.store['providers'] as Array<Record<string, unknown>>)[0].contextWindow).toBeUndefined();
  });
});
