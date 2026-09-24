/**
 * llmConfig — Provider 构建的宿主契约
 *
 * 覆盖缺口：`createProvider` 的 **store 分支**（配置面板激活的 Provider）此前零覆盖——
 * 既有 hostIntegration 只测环境变量回退分支（store 恒传 undefined）。
 * 该分支是能力位（supportsToolCalling / supportsStructuredOutput）进入内核的**唯一通路**，
 * 而能力位错一位的后果是工具调用整链失效（无原生 FC 的模型静默失败即此面），故以测试锁死
 * 「原样透传」与「缺省方向不对称（toolCalling→true / structured→false）」两件事实。
 *
 * 不引入真实 VS Code 运行时：vi.mock 提供内存版 workspace.getConfiguration + SecretStorage
 * （与 providerStore 的测试同构）。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** 内存版 configuration（hoisted：vi.mock 工厂在提升后仍需引用） */
const h = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  const config = {
    get: (key: string, def?: unknown) => (key in store ? store[key] : def),
    update: (key: string, val: unknown) => {
      store[key] = val;
    },
    inspect: (key: string) => ({ globalValue: key in store ? store[key] : undefined }),
  };
  return { config, store };
});

/** 内存版 SecretStorage（apiKey 通道） */
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

import { ProviderStore } from '../../providers/providerStore.js';
import { createProvider, createBackgroundProvider } from '../llmConfig.js';

/** 本地运行时形态的 Provider：能力位显式且**双向都取非默认值** → 可验「未被默认值覆盖」 */
const LOCAL_PROVIDER = {
  name: 'ollama',
  displayName: '本地 Ollama',
  model: 'qwen2.5',
  baseUrl: 'http://localhost:11434/v1',
  supportsToolCalling: false,
  supportsStructuredOutput: true,
};

/** 云 Provider 形态：不落能力位 → 走内核缺省方向 */
const CLOUD_PROVIDER = {
  name: 'cloud',
  displayName: '云服务',
  model: 'deepseek-chat',
  baseUrl: 'https://api.example.com/v1',
};

describe('llmConfig · Provider 构建（能力位唯一通路）', () => {
  let store: ProviderStore;

  beforeEach(() => {
    for (const k of Object.keys(h.store)) delete h.store[k];
    for (const k of Object.keys(secretsStore)) delete secretsStore[k];
    store = new ProviderStore(secrets as unknown as import('vscode').SecretStorage);
  });

  it('store 分支：能力位原样透传（显式 false/true 均不被内核默认值覆盖）', async () => {
    h.store['providers'] = [{ ...LOCAL_PROVIDER }];
    h.store['activeProvider'] = 'ollama';

    const provider = await createProvider(store, {});

    expect(provider.supportsToolCalling).toBe(false);
    expect(provider.supportsStructuredOutput).toBe(true);
  });

  it('store 分支：未声明能力位 → 按各自方向回落（toolCalling=true / structured=false）', async () => {
    h.store['providers'] = [{ ...CLOUD_PROVIDER }];
    h.store['activeProvider'] = 'cloud';

    const provider = await createProvider(store, {});

    // 方向不对称：既非「默认都开」也非「默认都关」
    expect(provider.supportsToolCalling).toBe(true);
    expect(provider.supportsStructuredOutput).toBe(false);
  });

  it('优先级：有激活 Provider 时不再落环境变量分支（env 残缺也不报错）', async () => {
    h.store['providers'] = [{ ...LOCAL_PROVIDER }];
    h.store['activeProvider'] = 'ollama';

    // env 缺 MEMORA_BASE_URL / MEMORA_MODEL——若误落 env 分支会抛「缺少 LLM 配置」
    await expect(createProvider(store, {})).resolves.toBeDefined();
  });

  it('无激活 Provider → 落环境变量分支并继承同一套缺省方向', async () => {
    const provider = await createProvider(store, {
      MEMORA_BASE_URL: 'https://api.example.com/v1',
      MEMORA_MODEL: 'deepseek-chat',
    });

    expect(provider.supportsToolCalling).toBe(true);
    expect(provider.supportsStructuredOutput).toBe(false);
  });

  it('createBackgroundProvider：配置了后台通道 → 能力位同样原样透传', async () => {
    h.store['providers'] = [{ ...LOCAL_PROVIDER }];
    h.store['backgroundProvider'] = 'ollama';

    const provider = await createBackgroundProvider(store);

    expect(provider?.supportsToolCalling).toBe(false);
    expect(provider?.supportsStructuredOutput).toBe(true);
  });

  it('createBackgroundProvider：未配置后台通道 → undefined（内核回退前台 Provider）', async () => {
    h.store['providers'] = [{ ...LOCAL_PROVIDER }];

    await expect(createBackgroundProvider(store)).resolves.toBeUndefined();
  });
});
