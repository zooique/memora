/**
 * 装配层建会话直通包装测试（2026-11-17 真机缺陷回归 V2）
 *
 * 【为什么 V1 测试全绿却漏了 V2 回归】
 * V1 用 vi.fn（裸函数、无接收者）当替身，裸函数被裸调用不报错——真实目标是 class 方法，
 * 第一行就用 this.sessionModes。测试替身与真实形状不同构，等于没测到接线。
 *
 * 本文件两条硬守：
 *   ① owner 对象的方法被调用后，this 必须仍指向 owner（显式断言，不是偶然）；
 *   ② 装配层必须经该包装接入（结构性守卫，禁止手抄形参表 / 裸方法引用）。
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { lazyHostedSessionCreator, type HostedSessionOwner } from '../lazyHostedSessionCreator.js';
import type { HostedSessionCreator } from '../workSessionTools.js';

/**
 * 带 this 依赖的 owner 假对象（与真实 chatProvider 同形状：class 方法内部读 this）
 *
 * 关键：方法内部必须有 `this.x` 引用，这样被裸调用时会抛错——
 * 是 V2 回归（resolve 返回裸方法引用、this 丢失）在运行时的唯一可见信号。
 */
function makeOwner(): {
  x: string;
  createHostedSession: HostedSessionCreator;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  return {
    x: 'owner-bound',
    createHostedSession: async function (
      this: { x: string; calls: unknown[][] },
      calling: string,
      rolePack: string | undefined,
      title: string,
      text: string,
      sender: string,
      paths: readonly string[],
      mandate?: string,
    ) {
      // 硬守：方法被调用后 this.x 必须可访问（裸调用时这里会抛 TypeError）
      if (this.x !== 'owner-bound') {
        throw new Error(`this 绑定失效：this.x="${this.x}"，预期 "owner-bound"`);
      }
      calls.push([calling, rolePack, title, text, sender, paths, mandate]);
      return { ok: true, sid: `sid-${calls.length}`, title };
    },
    calls,
  };
}

describe('lazyHostedSessionCreator · owner 保活', () => {
  it('owner 方法被调用后 this 仍指向 owner（硬守，裸方法引用形态必红）', async () => {
    const owner = makeOwner();
    const call = lazyHostedSessionCreator(() => owner);

    await call('calling', 'writer', '标题', '正文', 'Memora', ['src'], '只读盘点');

    // 方法内部 this.x 可访问 = 证明 this 没丢
    expect(owner.calls).toHaveLength(1);
    // 显式断言返回值成功（间接证明 this 绑定没抛 TypeError）
    // 若工厂漏了 owner.context，这条会在上面那行抛 "Cannot read 'x'"
    expect((await call('c', undefined, 't', 'x', 'Memora', [])).ok).toBe(true);
  });

  it('七参逐参转发：末位可选参数 mandate 不丢', async () => {
    const owner = makeOwner();
    const call = lazyHostedSessionCreator(() => owner);

    await call('calling', 'writer', '统计', '开始', 'Memora', ['src/agent'], '只读盘点');

    expect(owner.calls[0]).toEqual([
      'calling',
      'writer',
      '统计',
      '开始',
      'Memora',
      ['src/agent'],
      '只读盘点', // ← 缺陷点：手抄形参表时这一位会消失
    ]);
  });

  it('不传 mandate 时按 undefined 转发（调用形态不变）', async () => {
    const owner = makeOwner();
    const call = lazyHostedSessionCreator(() => owner);

    await call('calling', undefined, '标题', '正文', 'Memora', []);

    // spread 按实参个数转发：不传即 6 位，目标侧第 7 参自然 undefined
    expect(owner.calls[0].length).toBe(7);
    expect(owner.calls[0][6]).toBeUndefined();
  });

  it('懒解析：构造时不取 owner，调用时才取（装配期面板尚未创建）', async () => {
    const owner = makeOwner();
    const resolve = vi.fn(() => owner);
    const call = lazyHostedSessionCreator(resolve);

    expect(resolve).not.toHaveBeenCalled(); // 构造期不触碰面板
    await call('c', undefined, 't', 'x', 'Memora', []);
    expect(resolve).toHaveBeenCalledTimes(1); // 调用期才解析
  });

  it('每次调用都重新 resolve owner（热重载 / 替换实例时拿新的）', async () => {
    const owner1 = makeOwner();
    const owner2 = makeOwner();
    let active = owner1;
    const resolve = () => active;
    const call = lazyHostedSessionCreator(resolve);

    await call('c1', undefined, 't', 'x', 'Memora', []);
    expect(owner1.calls).toHaveLength(1);
    expect(owner2.calls).toHaveLength(0);

    active = owner2; // 模拟热重载：面板实例被替换
    await call('c2', undefined, 't', 'x', 'Memora', []);
    expect(owner1.calls).toHaveLength(1); // 没再碰旧的
    expect(owner2.calls).toHaveLength(1); // 新调用路由到新 owner
  });

  it('返回值原样透出（成功与失败两种结果）', async () => {
    const okOwner: HostedSessionOwner = {
      createHostedSession: vi.fn<HostedSessionCreator>(async () => ({
        ok: true,
        sid: 's9',
        title: '标题',
      })),
    };
    const okCall = lazyHostedSessionCreator(() => okOwner);
    await expect(okCall('c', undefined, 't', 'x', 'Memora', [])).resolves.toEqual({
      ok: true,
      sid: 's9',
      title: '标题',
    });

    const failOwner: HostedSessionOwner = {
      createHostedSession: vi.fn<HostedSessionCreator>(async () => ({
        ok: false,
        code: 'E_DENIED',
        message: 'no',
      })),
    };
    const failCall = lazyHostedSessionCreator(() => failOwner);
    await expect(failCall('c', undefined, 't', 'x', 'Memora', [])).resolves.toEqual({
      ok: false,
      code: 'E_DENIED',
      message: 'no',
    });
  });

  /**
   * 结构性守卫：装配层必须经本包装接入，不得：
   *   ① 回退成手写形参表箭头函数（吞 mandate 的已知缺陷形态）；
   *   ② 传裸方法引用（this 丢失的 V2 回归形态）。
   * 任一形态出现本断言即红——两条都是真机实锤。
   */
  it('装配层必须经 lazyHostedSessionCreator 接入（禁手抄形参表 / 裸方法引用）', () => {
    const source = readFileSync(new URL('../../extension.ts', import.meta.url), 'utf8');
    // 正面：必须有包装调用
    expect(source).toContain('createHostedSession: lazyHostedSessionCreator(');
    // 负面 ①：禁手抄形参表箭头函数（已知吞 mandate）
    expect(source).not.toMatch(/createHostedSession:\s*\(\s*calling\s*,/);
    // 负面 ②：禁裸方法引用（已知 this 丢失）——resolve 参数里不能出现 .createHostedSession
    expect(source).not.toMatch(/lazyHostedSessionCreator\([^)]*\.createHostedSession[^)]*\)/);
  });
});
