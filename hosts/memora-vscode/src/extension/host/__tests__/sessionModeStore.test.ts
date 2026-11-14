/**
 * 会话运行模式容器守卫（托管模式 v0 · §14.21.4 甲案）
 *
 * 判据不是「get/set 能跑」，而是三条容易将来被当 bug「修」掉的边界：
 * ① 未知会话一律 self（不从「上次模式」回填）；
 * ② 会话 mode 不落盘——换一个容器实例读同一份 globalState，仍然读不到；
 * ③ 「上次模式」只给新建当默认值，非法值回落 self。
 */
import { describe, it, expect, vi } from 'vitest';
import { LAST_SESSION_MODE_KEY, SessionModeStore, originForMode } from '../sessionModeStore.js';

/** 最小 Memento 假件：只实现容器用到的 get / update */
function makeMemento(initial?: unknown) {
  const data = new Map<string, unknown>();
  if (initial !== undefined) data.set(LAST_SESSION_MODE_KEY, initial);
  return {
    get: vi.fn(<T>(key: string): T | undefined => data.get(key) as T | undefined),
    update: vi.fn(async (key: string, value: unknown): Promise<void> => {
      data.set(key, value);
    }),
  };
}

/** 把假件塞进构造签名（容器只消费 get / update，不需要完整 Memento） */
function makeStore(memento: ReturnType<typeof makeMemento>): SessionModeStore {
  return new SessionModeStore(
    memento as unknown as ConstructorParameters<typeof SessionModeStore>[0],
  );
}

describe('SessionModeStore · 会话级 mode 容器', () => {
  it('mode → origin 只有一处映射：managed ⇒ hosted，self ⇒ user', () => {
    expect(originForMode('managed')).toBe('hosted');
    expect(originForMode('self')).toBe('user');
  });
  it('未知会话一律回落 self，不猜托管', () => {
    const store = makeStore(makeMemento());
    expect(store.get('never-created')).toBe('self');
    expect(store.isManaged('never-created')).toBe(false);
  });

  it('set / delete 按会话寻址，互不串扰', () => {
    const store = makeStore(makeMemento());
    store.set('s-managed', 'managed');
    store.set('s-self', 'self');

    expect(store.isManaged('s-managed')).toBe(true);
    expect(store.isManaged('s-self')).toBe(false);

    store.delete('s-managed');
    expect(store.isManaged('s-managed')).toBe(false);
  });

  it('会话 mode 不落盘：换容器实例读同一份 globalState 仍回落 self', () => {
    const memento = makeMemento();
    const first = makeStore(memento);
    first.set('s1', 'managed');

    // 模拟重开窗口 / 进程重启：新容器 + 同一份持久层
    const second = makeStore(memento);
    expect(second.get('s1')).toBe('self');
  });

  it('「上次模式」默认 self，非法值回落 self', () => {
    expect(makeStore(makeMemento()).getLastMode()).toBe('self');
    // 脏数据不得被当成托管指令
    expect(makeStore(makeMemento('garbage')).getLastMode()).toBe('self');
  });

  it('「上次模式」写入 globalState，但不对现有会话回填', async () => {
    const memento = makeMemento();
    const store = makeStore(memento);

    await store.setLastMode('managed');
    expect(memento.update).toHaveBeenCalledWith(LAST_SESSION_MODE_KEY, 'managed');
    expect(store.getLastMode()).toBe('managed');
    // 关键边界：上次模式只服务「新建」，已有 / 未知会话仍按 self
    expect(store.get('existing-session')).toBe('self');
  });
});
