/**
 * 装配层建会话直通包装测试（2026-11-17 真机缺陷回归）
 *
 * 缺陷背景：装配层手写的 6 参箭头函数静默吞掉第 7 个可选参数 `mandate`，
 * 导致 `SessionMeta.workOrder` 在生产路径永不落盘，且 TypeScript 不报错
 * （可选参数使「6 参函数」可赋给「7 参签名」）。
 *
 * 本文件守两件事：
 *   ① 直通包装逐参转发（含末位可选参数）——参数表由类型派生，不再手抄；
 *   ② 装配层必须经该包装接入——防止有人回退成手抄形参表（结构性守卫）。
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { lazyHostedSessionCreator } from '../lazyHostedSessionCreator.js';
import type { HostedSessionCreator } from '../workSessionTools.js';

describe('lazyHostedSessionCreator', () => {
  it('七参逐参转发：末位可选参数 mandate 不丢', async () => {
    // 记录目标实参原样，便于逐位断言
    const spy = vi.fn<HostedSessionCreator>(async () => ({ ok: true, sid: 's1', title: 't' }));
    const call = lazyHostedSessionCreator(() => spy);

    await call('calling', 'role-pack', '标题', '正文', 'Memora', ['src/agent'], '只读盘点');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toHaveLength(7);
    expect(spy.mock.calls[0]).toEqual([
      'calling',
      'role-pack',
      '标题',
      '正文',
      'Memora',
      ['src/agent'],
      '只读盘点', // ← 缺陷点：手抄形参表时这一位会消失
    ]);
  });

  it('不传 mandate 时按 undefined 转发（调用形态不变）', async () => {
    const spy = vi.fn<HostedSessionCreator>(async () => ({ ok: true, sid: 's1', title: 't' }));
    const call = lazyHostedSessionCreator(() => spy);

    await call('calling', undefined, '标题', '正文', 'Memora', []);

    // spread 按实参个数转发：不传即 6 位，目标侧末位可选参数自然为 undefined
    expect(spy.mock.calls[0]).toHaveLength(6);
    expect(spy.mock.calls[0][6]).toBeUndefined();
  });

  it('懒解析：构造时不取实现，调用时才取（装配期面板尚未创建）', async () => {
    const resolved = vi.fn<HostedSessionCreator>(async () => ({ ok: true, sid: 's', title: 't' }));
    const resolve = vi.fn(() => resolved);
    const call = lazyHostedSessionCreator(resolve);

    expect(resolve).not.toHaveBeenCalled(); // 构造期不触碰面板
    await call('c', undefined, 't', 'x', 'Memora', []);
    expect(resolve).toHaveBeenCalledTimes(1); // 调用期才解析
  });

  it('返回值原样透出（成功与失败两种结果）', async () => {
    const okCreator = lazyHostedSessionCreator(() => async () => ({
      ok: true,
      sid: 's9',
      title: '标题',
    }));
    await expect(okCreator('c', undefined, 't', 'x', 'Memora', [])).resolves.toEqual({
      ok: true,
      sid: 's9',
      title: '标题',
    });

    const failCreator = lazyHostedSessionCreator(() => async () => ({
      ok: false,
      code: 'E_DENIED',
      message: 'no',
    }));
    await expect(failCreator('c', undefined, 't', 'x', 'Memora', [])).resolves.toEqual({
      ok: false,
      code: 'E_DENIED',
      message: 'no',
    });
  });

  it('结构性守卫：装配层必须经本包装接入，不得回退手抄形参表', () => {
    // 判据：extension.ts 的 deps 装配里，createHostedSession 必须以 lazyHostedSessionCreator 装配。
    // 若有人改回 `(calling, rolePack, ...) => chatProvider.createHostedSession(...)`，
    // 本断言会红——那是 2026-11-17 真机缺陷的原始形态。
    const source = readFileSync(new URL('../../extension.ts', import.meta.url), 'utf8');
    expect(source).toContain('createHostedSession: lazyHostedSessionCreator(');
    expect(source).not.toMatch(/createHostedSession:\s*\(\s*calling\s*,/);
  });
});
