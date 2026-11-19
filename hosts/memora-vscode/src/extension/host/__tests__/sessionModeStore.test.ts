/**
 * 助手会话身份容器守卫
 *
 * 判据不是「get/set 能跑」，而是四条容易将来被当 bug「修」掉的边界：
 * ① 身份真源 = 工作区指针：换一个容器实例读同一份持久层，仍认得出同一条助手会话（跨重启有效）；
 * ② 未知会话一律 self（不从标签表 / 上次状态回填）；
 * ③ 同一时刻只有一个助手会话（`listManagedSessionIds` 长度 ≤ 1，覆盖即换）；
 * ④ 「当前归代理」= 助手会话 ∪ 代理驱动；收回 / 删除后都不算，删除同时清指针。
 */
import { describe, it, expect, vi } from 'vitest';
import { ASSISTANT_SESSION_KEY } from '../assistantSession.js';
import { SessionModeStore } from '../sessionModeStore.js';

/** 最小 Memento 假件：只实现容器用到的 get / update（update 同步生效，模拟 VS Code 内存语义） */
function makeMemento(initial?: unknown) {
  const data = new Map<string, unknown>();
  if (initial !== undefined) data.set(ASSISTANT_SESSION_KEY, initial);
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

describe('SessionModeStore · 助手会话身份容器', () => {
  it('未知会话一律回落 self，不猜助手', () => {
    const store = makeStore(makeMemento());
    expect(store.get('never-created')).toBe('self');
    expect(store.isManaged('never-created')).toBe(false);
    expect(store.listManagedSessionIds()).toEqual([]);
  });

  it('身份落工作区指针：换容器实例（模拟重启）仍认得出同一条助手会话', () => {
    const memento = makeMemento();
    const first = makeStore(memento);
    first.set('assistant-1', 'managed');

    // 模拟重开窗口 / 进程重启：新容器 + 同一份持久层
    const second = makeStore(memento);
    expect(second.isManaged('assistant-1')).toBe(true);
    expect(second.get('assistant-1')).toBe('managed');
    expect(second.listManagedSessionIds()).toEqual(['assistant-1']);
  });

  it('助手唯一：设了新助手会话即覆盖旧的', () => {
    const store = makeStore(makeMemento());
    store.set('assistant-1', 'managed');
    store.set('assistant-2', 'managed');

    expect(store.isManaged('assistant-1')).toBe(false);
    expect(store.isManaged('assistant-2')).toBe(true);
    expect(store.listManagedSessionIds()).toEqual(['assistant-2']);
  });

  it('显式回收 / 删除会话都清指针，助手身份不残留', () => {
    const store = makeStore(makeMemento());
    store.set('assistant-1', 'managed');
    store.set('assistant-1', 'self');
    expect(store.isManaged('assistant-1')).toBe(false);
    expect(store.listManagedSessionIds()).toEqual([]);

    store.set('assistant-2', 'managed');
    store.delete('assistant-2');
    expect(store.isManaged('assistant-2')).toBe(false);
    expect(store.listManagedSessionIds()).toEqual([]);
  });

  it('普通会话登记 self 不影响助手指针', () => {
    const store = makeStore(makeMemento());
    store.set('assistant-1', 'managed');
    store.set('work-1', 'self');

    expect(store.isManaged('assistant-1')).toBe(true);
    expect(store.isManaged('work-1')).toBe(false);
    expect(store.listManagedSessionIds()).toEqual(['assistant-1']);
  });

  it('代理建立 / 接管登记为本进程事件标签；删除会话一并清理', () => {
    const store = makeStore(makeMemento());
    store.set('s-child', 'self');
    store.markAgentDriven('s-child');

    expect(store.isAgentDriven('s-child')).toBe(true);
    expect(store.isAgentDriven('s-user')).toBe(false);

    store.delete('s-child');
    expect(store.isAgentDriven('s-child')).toBe(false);
  });

  it('启动时从指针恢复的助手会话带「恢复」事件标签；显式登记后标签清除', () => {
    const memento = makeMemento();
    makeStore(memento).set('assistant-1', 'managed');

    const restored = makeStore(memento);
    expect(restored.isRestored('assistant-1')).toBe(true);
    restored.set('assistant-1', 'managed');
    expect(restored.isRestored('assistant-1')).toBe(false);
  });
});
