/**
 * SecretStorage 写入通道（secretsWrite）— 超时兜底 / 半完成态回执 / 失败文案的不变量
 *
 * 背景（2026-10-24 审计推导）：钥匙串不可用时 store/delete 会 reject，三个写入点
 * （ProviderStore.save / remove / userDataReset）此前裸调，失败要么裸抛穿膜、
 * 要么半完成态无回执。本模块把「永不 reject + 结构化回执」收成单点。
 *
 * 覆盖被测不变量：
 *   ① 永不 settle 的 store/delete → 到上限返回 ok=false + timedOut=true（不永久挂起）；
 *   ② 真 reject → timedOut=false，reason 原样透传；
 *   ③ 成功 → ok=true，且**不残留计时器**；
 *   ④ 文案映射：超时说「钥匙串无响应、密钥可能未保存」，拒绝说「失败：原因」。
 *
 * 变异靶标：去掉 Promise.race 的超时分支 → ① 用例会挂死（vitest 超时）而不是绿；
 * 去掉 finally clearTimeout → ③ 用例转红；去掉 try/catch → ② 用例 reject 穿膜转红。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** vscode 替身：可替换 store/delete 行为（成功 / 拒绝 / 永不 settle） */
const h = vi.hoisted(() => ({
  store: (_key: string, _value: string) => Promise.resolve(),
  delete: (_key: string) => Promise.resolve(),
}));

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ update: () => Promise.resolve() }) },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
}));

import { WRITE_TIMEOUT_MS, deleteSecret, secretErrorText, writeSecret } from '../secretsWrite.js';

/** 构造一个 store/delete 行为可替换的 SecretStorage 替身 */
function makeSecrets(): import('vscode').SecretStorage {
  return { store: h.store, delete: h.delete } as unknown as import('vscode').SecretStorage;
}

describe('secretsWrite.writeSecret / deleteSecret', () => {
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

  it('store 永不 settle → 到上限返回 ok:false + timedOut:true（不永久挂起）', async () => {
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

  it('delete 永不 settle → 到上限返回 ok:false + timedOut:true（不永久挂起）', async () => {
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

  it('store 立即 reject → ok:false + timedOut:false，reason 原样透传', async () => {
    h.store = () => Promise.reject(new Error('Credential Manager 不可用'));
    const result = await writeSecret(makeSecrets(), 'k', 'v');
    expect(result).toMatchObject({ ok: false, timedOut: false });
    expect(result.ok === false && result.reason).toContain('Credential Manager 不可用');
  });

  it('delete 立即 reject → ok:false + timedOut:false，reason 原样透传', async () => {
    h.delete = () => Promise.reject(new Error('凭证被占用'));
    const result = await deleteSecret(makeSecrets(), 'k');
    expect(result).toMatchObject({ ok: false, timedOut: false });
    expect(result.ok === false && result.reason).toContain('凭证被占用');
  });
});

describe('secretsWrite.secretErrorText', () => {
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
