/**
 * SecretStorage 访问通道（secretsAccess）— 超时兜底 / 结构化回执 / 失败文案 / 故障注入的不变量
 *
 * 背景（2026-10-24 审计推导）：钥匙串不可用时 store/delete/get 会 reject，ProviderStore
 * 与 userDataReset 此前裸调：写入失败要么裸抛穿膜、要么半完成态无回执；读取失败
 * （Promise.all 一 reject 全 throw）让配置面板静默空列表、把成功保存误报成失败。
 * 本模块把「永不 reject + 结构化回执」收成单点。
 *
 * 覆盖被测不变量：
 *   ① 永不 settle 的 store/delete/get → 到上限返回 ok=false + timedOut=true（不永久挂起）；
 *   ② 真 reject → timedOut=false，reason 原样透传；
 *   ③ 成功 → ok=true，且**不残留计时器**；
 *   ④ 读取成功但 value=undefined = 从未存过（正常空态，**不是**失败）；
 *   ⑤ 文案映射：超时说「钥匙串无响应、密钥可能未保存」，拒绝说「失败：原因」；
 *   ⑥ 故障注入（MEMORA_FAULT_SECRETS）：默认关（正常透传）；read/write/all 各自只
 *      强制对应侧面失败，且注入时**不触达**真实钥匙串替身（reason 自带变量名）。
 *
 * 变异靶标：去掉 Promise.race 的超时分支 → ① 用例会挂死（vitest 超时）而不是绿；
 * 去掉 finally clearTimeout → ③ 用例转红；去掉 try/catch → ② 用例 reject 穿膜转红；
 * 注入判定写坏（如 read 模式放过 get）→ ⑥ 对应用例转红。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** vscode 替身：可替换 get/store/delete 行为（成功 / 拒绝 / 永不 settle） */
const h = vi.hoisted(() => ({
  get: (_key: string) => Promise.resolve(undefined) as Promise<string | undefined>,
  store: (_key: string, _value: string) => Promise.resolve(),
  delete: (_key: string) => Promise.resolve(),
}));

/** 触达计数：故障注入用例断言「注入时不调真实替身」 */
const calls = vi.hoisted(() => ({ get: 0, store: 0, delete: 0 }));

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ update: () => Promise.resolve() }) },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
}));

import {
  WRITE_TIMEOUT_MS,
  deleteSecret,
  readSecret,
  secretErrorText,
  writeSecret,
} from '../secretsAccess.js';

/** 构造一个 get/store/delete 行为可替换的 SecretStorage 替身（带触达计数） */
function makeSecrets(): import('vscode').SecretStorage {
  return {
    get: (k: string) => {
      calls.get++;
      return h.get(k);
    },
    store: (k: string, v: string) => {
      calls.store++;
      return h.store(k, v);
    },
    delete: (k: string) => {
      calls.delete++;
      return h.delete(k);
    },
  } as unknown as import('vscode').SecretStorage;
}

describe('secretsAccess.readSecret', () => {
  beforeEach(() => {
    h.get = () => Promise.resolve(undefined);
    h.store = () => Promise.resolve();
    h.delete = () => Promise.resolve();
  });

  it('读取成功 → ok:true + value 原样返回，且不残留计时器', async () => {
    vi.useFakeTimers();
    try {
      h.get = () => Promise.resolve('sk-real');
      expect(await readSecret(makeSecrets(), 'k')).toEqual({ ok: true, value: 'sk-real' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('读取成功但 value=undefined（从未存过）→ ok:true，不是失败', async () => {
    h.get = () => Promise.resolve(undefined);
    expect(await readSecret(makeSecrets(), 'k')).toEqual({ ok: true, value: undefined });
  });

  it('get 永不 settle → 到上限返回 ok=false + timedOut:true（不永久挂起）', async () => {
    vi.useFakeTimers();
    try {
      h.get = () => new Promise<string | undefined>(() => {});
      const pending = readSecret(makeSecrets(), 'k');
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ ok: false, timedOut: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('get 立即 reject → ok=false + timedOut:false，reason 原样透传', async () => {
    h.get = () => Promise.reject(new Error('Credential Manager 不可用'));
    const result = await readSecret(makeSecrets(), 'k');
    expect(result).toMatchObject({ ok: false, timedOut: false });
    expect(result.ok === false && result.reason).toContain('Credential Manager 不可用');
  });
});

describe('secretsAccess.writeSecret / deleteSecret', () => {
  beforeEach(() => {
    h.store = () => Promise.resolve();
    h.delete = () => Promise.resolve();
  });

  it('成功写入 → ok:true 且不残留计时器', async () => {
    vi.useFakeTimers();
    try {
      expect(await writeSecret(makeSecrets(), 'memora.provider.a.apiKey', 'sk-x')).toEqual({
        ok: true,
      });
      expect(await deleteSecret(makeSecrets(), 'memora.provider.a.apiKey')).toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('store 永不 settle → 到上限返回 ok=false + timedOut:true（不永久挂起）', async () => {
    vi.useFakeTimers();
    try {
      // 模拟钥匙串锁定 / COM 挂起：promise 永不落地
      h.store = () => new Promise<void>(() => {});
      const pending = writeSecret(makeSecrets(), 'k', 'v');
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ ok: false, timedOut: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delete 永不 settle → 到上限返回 ok=false + timedOut:true（不永久挂起）', async () => {
    vi.useFakeTimers();
    try {
      h.delete = () => new Promise<void>(() => {});
      const pending = deleteSecret(makeSecrets(), 'k');
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ ok: false, timedOut: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('store 立即 reject → ok=false + timedOut:false，reason 原样透传', async () => {
    h.store = () => Promise.reject(new Error('Credential Manager 不可用'));
    const result = await writeSecret(makeSecrets(), 'k', 'v');
    expect(result).toMatchObject({ ok: false, timedOut: false });
    expect(result.ok === false && result.reason).toContain('Credential Manager 不可用');
  });

  it('delete 立即 reject → ok=false + timedOut:false，reason 原样透传', async () => {
    h.delete = () => Promise.reject(new Error('凭证被占用'));
    const result = await deleteSecret(makeSecrets(), 'k');
    expect(result).toMatchObject({ ok: false, timedOut: false });
    expect(result.ok === false && result.reason).toContain('凭证被占用');
  });
});

describe('secretsAccess.secretErrorText', () => {
  it('超时 → 明说「钥匙串无响应」并提示密钥可能未保存', () => {
    expect(secretErrorText('API Key', { timedOut: true, reason: 'x' })).toBe(
      'API Key 超时：系统钥匙串未在期限内响应，密钥可能未保存',
    );
  });

  it('真拒绝 → 带原始原因', () => {
    expect(secretErrorText('API Key', { timedOut: false, reason: '钥匙串已锁定' })).toBe(
      'API Key 失败：钥匙串已锁定',
    );
  });
});

describe('secretsAccess 故障注入（MEMORA_FAULT_SECRETS，真机验点专用）', () => {
  beforeEach(() => {
    h.get = () => Promise.resolve('sk-real');
    h.store = () => Promise.resolve();
    h.delete = () => Promise.resolve();
    calls.get = 0;
    calls.store = 0;
    calls.delete = 0;
  });

  afterEach(() => {
    delete process.env.MEMORA_FAULT_SECRETS;
  });

  it('未设（默认）→ 三个访问全部正常透传', async () => {
    delete process.env.MEMORA_FAULT_SECRETS;
    expect(await readSecret(makeSecrets(), 'k')).toEqual({ ok: true, value: 'sk-real' });
    expect(await writeSecret(makeSecrets(), 'k', 'v')).toEqual({ ok: true });
    expect(await deleteSecret(makeSecrets(), 'k')).toEqual({ ok: true });
  });

  it('空串 → 等同未设（trim 后不命中任何模式）', async () => {
    process.env.MEMORA_FAULT_SECRETS = '  ';
    expect(await readSecret(makeSecrets(), 'k')).toEqual({ ok: true, value: 'sk-real' });
  });

  it('read → 只有 get 被强制失败（store/delete 不受影响），且不触达真实替身', async () => {
    process.env.MEMORA_FAULT_SECRETS = 'read';
    const r = await readSecret(makeSecrets(), 'k');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('MEMORA_FAULT_SECRETS=read');
    expect(calls.get).toBe(0); // 注入短路，不调 secrets.get
    expect(await writeSecret(makeSecrets(), 'k', 'v')).toEqual({ ok: true });
    expect(await deleteSecret(makeSecrets(), 'k')).toEqual({ ok: true });
    expect(calls.store).toBe(1);
    expect(calls.delete).toBe(1);
  });

  it('write → store/delete 被强制失败（get 不受影响），且不触达真实替身', async () => {
    process.env.MEMORA_FAULT_SECRETS = 'write';
    expect(await readSecret(makeSecrets(), 'k')).toEqual({ ok: true, value: 'sk-real' });
    const w = await writeSecret(makeSecrets(), 'k', 'v');
    expect(w.ok).toBe(false);
    expect(w.ok === false && w.reason).toContain('MEMORA_FAULT_SECRETS=write');
    const d = await deleteSecret(makeSecrets(), 'k');
    expect(d.ok).toBe(false);
    expect(calls.store).toBe(0);
    expect(calls.delete).toBe(0);
    expect(calls.get).toBe(1);
  });

  it('all → 三个访问全部强制失败', async () => {
    process.env.MEMORA_FAULT_SECRETS = 'all';
    expect((await readSecret(makeSecrets(), 'k')).ok).toBe(false);
    expect((await writeSecret(makeSecrets(), 'k', 'v')).ok).toBe(false);
    expect((await deleteSecret(makeSecrets(), 'k')).ok).toBe(false);
    expect(calls.get).toBe(0);
    expect(calls.store).toBe(0);
    expect(calls.delete).toBe(0);
  });

  it('大小写不敏感（READ 命中 read 模式）', async () => {
    process.env.MEMORA_FAULT_SECRETS = 'READ';
    expect((await readSecret(makeSecrets(), 'k')).ok).toBe(false);
  });
});
