/**
 * 能力位透传变异守卫（审查 IMG-3 / P0 的机检落地）
 *
 * ## 为什么需要它
 * 2026-10-28 的复核抓出一个断链：`supportsVision` 在内核 provider 层定义了、
 * 在宿主 DTO 里也能存能读，**但建房时没人把它传下去** ⇒ 该能力位恒 false、永不可用。
 *
 * 关键在于：**类型系统对此完全沉默**——
 *   - `OpenAICompatibleConfig` 里确有这个字段（静态检查绿）；
 *   - 两个 surface guard 只管「符号登记」，不管「能不能被传进来」（守卫绿）；
 *   - 断链发生在「谁来传值」这条调用关系上，编译器看不见。
 * 也就是说：这类缺陷**只能靠运行时行为**发现，静态门禁天然失明。
 *
 * ## 判据为什么用「运行时到达」而不是「源码里出现」
 * 若只断言「llmConfig.ts 的文本里包含 supportsVision」，把透传那行删掉、
 * 改成注释里提一句也能骗过守卫。故本守卫走**端到端**：
 *   构造一个「所有能力位都取非默认值」的 Provider 配置 → 经宿主唯一建房通路构建 →
 *   断言 provider 上真的读到了那个值。
 * 删掉任何一跳，provider 上就只剩内核默认值，断言立刻红。
 *
 * ## 清单为什么从源码抽取而不是手写数组
 * 手写一个 `['supportsToolCalling', ...]` 数组 = 第二份能力位清单，
 * 下一次加能力位时**忘了同步数组**就静默失去守卫（正是同一个坑的另一种形态）。
 * 故清单由 `protocol.ts` 的 **DTO 定义**抽取（`supports*` 字段），加字段自动纳入覆盖。
 * 抽取结果非空本身也是断言——抽到 0 个说明正则失配，守卫失明比守卫失败更危险。
 */
// @vitest-environment node（ProviderStore 依赖 vscode mock；jsdom 下 vi.mock('vscode') 失效）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider, createBackgroundProvider } from '../llmConfig.js';
import { ProviderStore } from '../../providers/providerStore.js';

/** protocol.ts（宿主 DTO 唯一定义处）的物理路径——从本测试文件位置反推，不依赖 cwd */
const PROTOCOL_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../shared/protocol.ts',
);

/**
 * 从 DTO 源码抽取全部 `supports*` 能力位字段名
 *
 * 只认 `export interface LlmProviderConfig { ... }` 块内的**顶层**两空格缩进字段，
 * 避免把别处的 supportsXxx 局部变量或注释误纳入。
 */
function extractCapabilityFields(): string[] {
  const src = readFileSync(PROTOCOL_PATH, 'utf8');
  const head = src.indexOf('export interface LlmProviderConfig {');
  if (head < 0) throw new Error('守卫失明：protocol.ts 中找不到 LlmProviderConfig 定义');
  const tail = src.indexOf('\n}', head);
  if (tail < 0) throw new Error('守卫失明：LlmProviderConfig 块未闭合');
  const block = src.slice(head, tail);
  const found = [...block.matchAll(/^ {2}(supports[A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]);
  // 去重保序（同一字段名理论上只出现一次，防重复导致下文 ExtraKeys 判定混乱）
  return [...new Set(found)];
}

const CAPABILITY_FIELDS = extractCapabilityFields();

/** 内存版 configuration（hoisted：vi.mock 工厂提升后仍需引用） */
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

describe('能力位透传守卫 · 抽取面自检（防守卫失明）', () => {
  it('从 protocol.ts 抽到的能力位清单非空（抽到 0 个 = 正则失配，必须修守卫而非放行）', () => {
    expect(CAPABILITY_FIELDS.length).toBeGreaterThan(0);
  });

  it('清单含三个已知能力位（确认抽取命中的是 DTO 字段而非别处同名 token）', () => {
    expect(CAPABILITY_FIELDS).toEqual(
      expect.arrayContaining(['supportsToolCalling', 'supportsStructuredOutput', 'supportsVision']),
    );
  });
});

describe('能力位透传守卫 · 前台唯一通路（createProvider store 分支）', () => {
  let store: ProviderStore;

  beforeEach(() => {
    for (const k of Object.keys(h.store)) delete h.store[k];
    for (const k of Object.keys(secretsStore)) delete secretsStore[k];
    store = new ProviderStore(secrets as unknown as import('vscode').SecretStorage);
  });

  it.each(CAPABILITY_FIELDS)('%s 显式 true 能经建房通路**真的到达** provider', async (field) => {
    // 全部能力位都显式取 true：任何一跳漏传，落值都会回退成内核默认（看清方向后即为假）
    h.store['providers'] = [
      {
        name: 'cap',
        displayName: '能力探测',
        model: 'm',
        baseUrl: 'http://localhost:11434/v1',
        [field]: true,
      },
    ];
    h.store['activeProvider'] = 'cap';
    secretsStore['memora.provider.cap.apiKey'] = 'sk-cap-test';

    const provider = await createProvider(store, {});
    expect((provider as unknown as Record<string, unknown>)[field]).toBe(true);
  });

  it.each(CAPABILITY_FIELDS)('%s 显式 false 不被默认值吞掉（方向对称）', async (field) => {
    h.store['providers'] = [
      {
        name: 'cap',
        displayName: '能力探测',
        model: 'm',
        baseUrl: 'http://localhost:11434/v1',
        [field]: false,
      },
    ];
    h.store['activeProvider'] = 'cap';
    secretsStore['memora.provider.cap.apiKey'] = 'sk-cap-test';

    const provider = await createProvider(store, {});
    expect((provider as unknown as Record<string, unknown>)[field]).toBe(false);
  });
});

/**
 * 通道布局原则上要求「两个能力位如果不能同时到达前台与后台，必须有显式理由」。
 * 后台通道当前**刻意不传** supportsVision（理由见 llmConfig.ts 的注释：
 * 后台任务消息从来不带 attachments，在其上声明视觉能力会导致「图被静默跳过」），
 * 故此处把这条例外写成断言——将来有人直接补上透传时，本用例会红并强制其重读那段论证。
 */
describe('能力位透传守卫 · 通道布局（前台 / 后台）', () => {
  let store: ProviderStore;

  beforeEach(() => {
    for (const k of Object.keys(h.store)) delete h.store[k];
    for (const k of Object.keys(secretsStore)) delete secretsStore[k];
    store = new ProviderStore(secrets as unknown as import('vscode').SecretStorage);
  });

  /** 配置同一 Provider 同时作为前台与后台通道，全部能力位置 true */
  function seedAllTrue(): void {
    const base = {
      name: 'cap',
      displayName: '能力探测',
      model: 'm',
      baseUrl: 'http://localhost:11434/v1',
    };
    h.store['providers'] = [
      { ...base, ...Object.fromEntries(CAPABILITY_FIELDS.map((f) => [f, true])) },
    ];
    h.store['activeProvider'] = 'cap';
    h.store['backgroundProvider'] = 'cap';
    secretsStore['memora.provider.cap.apiKey'] = 'sk-cap-test';
  }

  it('通用能力位：前台开启的（工具调用 / 结构化输出）后台同样生效', async () => {
    seedAllTrue();
    const background = await createBackgroundProvider(store);
    const asRecord = background as unknown as Record<string, unknown>;
    expect(asRecord.supportsToolCalling).toBe(true);
    expect(asRecord.supportsStructuredOutput).toBe(true);
  });

  it('视觉能力位是**登记在案的例外**：后台恒不声明（想改这条，先读 llmConfig 的决策注释）', async () => {
    seedAllTrue();
    const background = await createBackgroundProvider(store);
    const asRecord = background as unknown as Record<string, unknown>;
    // 后台一经补上 supportsVision 透传，本断言即红——那正是本守卫要触发的「决策复审」。
    expect(asRecord.supportsVision).toBe(false);
  });
});
