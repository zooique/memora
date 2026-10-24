/**
 * 配置写入通道（settingsWrite）— 超时兜底 / 失败文案的不变量
 *
 * 背景（2026-10-24 G9 真机实测）：只读 / 受管设置上 `getConfiguration().update()`
 * 会先改内存并触发 onDidChangeConfiguration，随后落盘失败而 promise **永不 settle**。
 * 调用方 await 之后的提示、回执、状态回推全部永不执行 ⇒ 用户输入被静默吞掉。
 *
 * 覆盖被测不变量：
 *   ① 永不 settle 的 update → 到上限即返回 ok=false + timedOut=true（不永久挂起）；
 *   ② 真 reject → timedOut=false，reason 原样透传（上层据此给可读文案）；
 *   ③ 写入成功 → ok=true，且**不残留计时器**（否则 5s 后事件循环仍被占着）；
 *   ④ 层级参数原样传给 VS Code（Global 缺省 / Workspace 显式）；
 *   ⑤ 文案映射：超时说「只读或被占用」，拒绝说「写入失败：原因」。
 *
 * 变异靶标：去掉 Promise.race 的超时分支 → ① 用例会挂死（vitest 超时）而不是绿；
 * 去掉 finally clearTimeout → ③ 用例转红。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** vscode 替身：可替换 update 行为（成功 / 拒绝 / 永不 settle） */
const h = vi.hoisted(() => ({
  update: (_key: string, _value: unknown, _target: unknown) => Promise.resolve(),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ update: h.update }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
}));

import { WRITE_TIMEOUT_MS, writeErrorText, writeSetting } from '../settingsWrite.js';

describe('settingsWrite.writeSetting', () => {
  beforeEach(() => {
    h.update = () => Promise.resolve();
  });

  it('成功写入 → ok:true 且不残留计时器', async () => {
    vi.useFakeTimers();
    try {
      const result = await writeSetting('providers', []);
      expect(result).toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('update 永不 settle → 到上限返回 ok:false + timedOut:true（不永久挂起）', async () => {
    vi.useFakeTimers();
    try {
      // 模拟真机只读设置：promise 永不落地
      h.update = () => new Promise<void>(() => {});
      const pending = writeSetting('providers', []);
      await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ ok: false, timedOut: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('update 立即 reject → ok:false + timedOut:false，reason 原样透传', async () => {
    h.update = () => Promise.reject(new Error('文件有未保存更改'));
    const result = await writeSetting('providers', []);
    expect(result).toMatchObject({ ok: false, timedOut: false });
    expect(result.ok === false && result.reason).toContain('文件有未保存更改');
  });

  it('层级参数：缺省 Global，显式 Workspace 原样传递', async () => {
    const update = vi.fn(() => Promise.resolve());
    h.update = update;
    await writeSetting('providers', []);
    await writeSetting('providers', undefined, 2 as never);
    expect(update).toHaveBeenNthCalledWith(1, 'providers', [], 1);
    expect(update).toHaveBeenNthCalledWith(2, 'providers', undefined, 2);
  });
});

describe('settingsWrite.writeErrorText', () => {
  it('超时 → 明说「只读或被占用」并提示可能已临时生效', () => {
    const text = writeErrorText('MCP 配置', { timedOut: true, reason: 'x' });
    // G9 真机验收过的原文，不得改写（用户照这句判断该去检查哪个文件）
    expect(text).toBe('MCP 配置写入超时：文件可能只读或被占用（设置可能已临时生效，但未落盘）');
  });

  it('真拒绝 → 带原始原因', () => {
    expect(writeErrorText('免确认设置', { timedOut: false, reason: '配置只读' })).toBe(
      '免确认设置写入失败：配置只读',
    );
  });
});
