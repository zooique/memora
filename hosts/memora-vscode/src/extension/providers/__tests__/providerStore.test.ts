/**
 * ProviderStore — contextWindow 校验 + 旧全局 maxContextTokens 迁移
 *
 * 不引入真实 VS Code 运行时：用 vi.mock 提供内存版 workspace.getConfiguration + SecretStorage。
 * 仅覆盖 per-LLM contextWindow 护栏与迁移逻辑（其余路径由既有集成测试覆盖）。
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
      {
        name: 'deepseek',
        displayName: 'DeepSeek',
        model: 'deepseek-chat',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-x',
        contextWindow: 128000,
      },
      false,
    );
    expect(res.ok).toBe(true);
    const saved = (h.store['providers'] as Array<Record<string, unknown>>)[0];
    expect(saved.contextWindow).toBe(128000);
    // apiKey 不落 configuration（仅 SecretStorage）
    expect(saved.apiKey).toBeUndefined();
  });

  it('save：contextWindow 缺省（undefined）→ 仍允许保存（回落内核默认窗口）', async () => {
    const res = await store.save(
      {
        name: 'deepseek',
        displayName: 'DeepSeek',
        model: 'deepseek-chat',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-x',
      },
      false,
    );
    expect(res.ok).toBe(true);
    const saved = (h.store['providers'] as Array<Record<string, unknown>>)[0];
    expect(saved.contextWindow).toBeUndefined();
  });

  it.each([0, 999, 1.5, 10_000_001, -1])(
    'save：非法 contextWindow=%p → 拒绝并给 message',
    async (bad) => {
      const res = await store.save(
        {
          name: 'deepseek',
          displayName: 'DeepSeek',
          model: 'deepseek-chat',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-x',
          contextWindow: bad as number,
        },
        false,
      );
      expect(res.ok).toBe(false);
      expect(res.message).toBeTruthy();
    },
  );

  // ─── maxTokens 输出上限护栏（T1 / EMPTY-RESP-1，宿主独立 sanity 1–65536，非与内核对齐） ───

  it('save：合法 maxTokens（65536）→ ok 且持久化保留该字段', async () => {
    const res = await store.save(
      {
        name: 'mimo',
        displayName: 'MiMo',
        model: 'mimo-v2.6-pro',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-x',
        maxTokens: 65536,
      },
      false,
    );
    expect(res.ok).toBe(true);
    const saved = (h.store['providers'] as Array<Record<string, unknown>>)[0];
    expect(saved.maxTokens).toBe(65536);
  });

  it('save：maxTokens 缺省（undefined）→ 仍允许保存（不传 max_tokens，回服务端默认）', async () => {
    const res = await store.save(
      {
        name: 'deepseek',
        displayName: 'DeepSeek',
        model: 'deepseek-chat',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-x',
      },
      false,
    );
    expect(res.ok).toBe(true);
    const saved = (h.store['providers'] as Array<Record<string, unknown>>)[0];
    expect(saved.maxTokens).toBeUndefined();
  });

  it.each([0, -1, 1.5, 65_537, 100_000])(
    'save：非法 maxTokens=%p → 拒绝并给 message（宿主显式拒收，防 UI 值 ≠ 生效值）',
    async (bad) => {
      const res = await store.save(
        {
          name: 'mimo',
          displayName: 'MiMo',
          model: 'mimo-v2.6-pro',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-x',
          maxTokens: bad as number,
        },
        false,
      );
      expect(res.ok).toBe(false);
      expect(res.message).toBeTruthy();
    },
  );

  it('migrateMaxContextTokens：旧全局值并入首个 provider 的 contextWindow 并清除旧键', async () => {
    h.store['providers'] = [
      {
        name: 'deepseek',
        displayName: 'DeepSeek',
        model: 'deepseek-chat',
        baseUrl: 'https://api.example.com/v1',
      },
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
    h.store['providers'] = [
      {
        name: 'deepseek',
        displayName: 'DeepSeek',
        model: 'deepseek-chat',
        baseUrl: 'https://api.example.com/v1',
      },
    ];
    await store.migrateMaxContextTokens();
    expect(
      (h.store['providers'] as Array<Record<string, unknown>>)[0].contextWindow,
    ).toBeUndefined();
  });
});

describe('ProviderStore · save/remove 语义', () => {
  let store: ProviderStore;
  beforeEach(() => {
    h.store['providers'] = [];
    delete h.store['maxContextTokens'];
    delete h.store['activeProvider'];
    delete h.store['backgroundProvider'];
    for (const k of Object.keys(secretsStore)) delete secretsStore[k];
    store = new ProviderStore(secrets as unknown as import('vscode').SecretStorage);
  });

  it('save isEditing 且 apiKey 留空 → 保留原 apiKey（不覆盖既有 secret）', async () => {
    // 编辑模式 apiKey 留空 = 保留原值契约（providerStore.save 注释）
    secretsStore['memora.provider.deepseek.apiKey'] = 'orig-key';
    const res = await store.save(
      {
        name: 'deepseek',
        displayName: 'DeepSeek',
        model: 'deepseek-chat',
        baseUrl: 'https://api.example.com/v1',
        apiKey: '',
      },
      true,
    );
    expect(res.ok).toBe(true);
    // secret 不被覆盖 —— 用户编辑时留空不应清掉原 key
    expect(secretsStore['memora.provider.deepseek.apiKey']).toBe('orig-key');
  });

  it('remove 删除的若是后台 Provider → 同步清空后台引用（防悬空指向不存在的 name）', async () => {
    h.store['providers'] = [{ name: 'bg', displayName: 'BG', model: 'm', baseUrl: 'http://x/v1' }];
    h.store['backgroundProvider'] = 'bg';
    const res = await store.remove('bg');
    expect(res.ok).toBe(true);
    expect(h.store['providers']).toHaveLength(0);
    // ProviderStore.remove 的防悬空清理：后台引用随删除一并清空
    expect(h.store['backgroundProvider']).toBeUndefined();
  });

  it('remove 删除的是激活 Provider → 拒绝并提示先切换', async () => {
    h.store['providers'] = [
      { name: 'act', displayName: 'Act', model: 'm', baseUrl: 'http://x/v1' },
    ];
    h.store['activeProvider'] = 'act';
    const res = await store.remove('act');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('激活');
  });
});

/**
 * 密钥写入通道收口（2026-10-24 SEC-WRITE-1）
 *
 * 此前 save/remove 的 secrets 写入是裸调：钥匙串不可用时 reject 穿膜，半完成态
 * （配置落盘/密钥没落盘）无结构化回执。现经 secretsWrite 单通道后，回执必须：
 *   - 如实说明半完成事实（不谎报 ok:true，也不伪装全失败）；
 *   - 不自动回滚已落盘的配置（回滚自身也可能失败，用户字段是资产）；
 *   - 文案点出后果与出路（同名重添沿用旧密钥的安全面）。
 */
describe('ProviderStore 密钥写入通道（secretsWrite 收口）', () => {
  const VALID = {
    name: 'deepseek',
    displayName: 'DeepSeek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-real',
  };

  let store: ProviderStore;
  beforeEach(() => {
    h.store['providers'] = [];
    delete h.store['activeProvider'];
    delete h.store['backgroundProvider'];
    for (const k of Object.keys(secretsStore)) delete secretsStore[k];
    store = new ProviderStore(secrets as unknown as import('vscode').SecretStorage);
  });

  it('save：secrets.store 拒绝 → ok:false 且文案如实说明「配置已保存、密钥未保存」，配置不谎报', async () => {
    secrets.store.mockRejectedValueOnce(new Error('Credential Manager 不可用'));

    const res = await store.save({ ...VALID }, false);

    expect(res.ok).toBe(false);
    // 半完成态回执：先说配置已保存（事实），再说 API Key 失败（原因），最后给出路
    expect(res.message).toContain('服务商配置已保存');
    expect(res.message).toContain('API Key 失败：Credential Manager 不可用');
    expect(res.message).toContain('暂时无法使用');
    // 磁盘事实与回执一致：配置确已落盘（服务商会出现在列表）、密钥确未存上
    expect(h.store['providers']).toHaveLength(1);
    expect(secretsStore['memora.provider.deepseek.apiKey']).toBeUndefined();
  });

  it('save：secrets.store 永不 settle → 超时 ok:false（不永久挂起，文案指向钥匙串）', async () => {
    vi.useFakeTimers();
    try {
      secrets.store.mockImplementationOnce(() => new Promise<void>(() => {}));
      const pending = store.save({ ...VALID }, false);
      await vi.advanceTimersByTimeAsync(5000);
      const res = await pending;
      expect(res.ok).toBe(false);
      expect(res.message).toContain('服务商配置已保存');
      expect(res.message).toContain('超时');
      expect(res.message).toContain('系统钥匙串');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remove：secrets.delete 拒绝 → ok:false 且文案点出孤儿密钥后果，配置确已删、密钥仍在', async () => {
    // 先正常落一个 Provider（含密钥），再让 delete 失败
    await store.save({ ...VALID }, false);
    expect(secretsStore['memora.provider.deepseek.apiKey']).toBe('sk-real');
    secrets.delete.mockRejectedValueOnce(new Error('凭证被占用'));

    const res = await store.remove('deepseek');

    expect(res.ok).toBe(false);
    // 半完成态回执：配置已删是事实 + 孤儿密钥的安全后果（同名重添沿用旧 key）+ 出路
    expect(res.message).toContain('已从配置中删除');
    expect(res.message).toContain('API Key 清理 失败：凭证被占用');
    expect(res.message).toContain('重新添加同名服务商可能沿用旧密钥');
    // 磁盘事实与回执一致：配置确已删、密钥确成孤儿
    expect(h.store['providers']).toHaveLength(0);
    expect(secretsStore['memora.provider.deepseek.apiKey']).toBe('sk-real');
  });

  it('remove：secrets.delete 永不 settle → 超时 ok:false（不永久挂起）', async () => {
    await store.save({ ...VALID }, false);
    vi.useFakeTimers();
    try {
      secrets.delete.mockImplementationOnce(() => new Promise<void>(() => {}));
      const pending = store.remove('deepseek');
      await vi.advanceTimersByTimeAsync(5000);
      const res = await pending;
      expect(res.ok).toBe(false);
      expect(res.message).toContain('已从配置中删除');
      expect(res.message).toContain('超时');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
