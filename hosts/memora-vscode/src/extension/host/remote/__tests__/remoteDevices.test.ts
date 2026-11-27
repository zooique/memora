/**
 * 设备表单测 —— 规范化 / 坏条目丢弃 / 增删改
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §5.9（权限三档）、§5.7（设备表落 globalState）
 */
import { describe, expect, it } from 'vitest';
import {
  RemoteDeviceStore,
  REMOTE_DEVICES_KEY,
  type RemoteDeviceMemento,
  type RemoteDeviceRecord,
} from '../remoteDevices.js';

/** 内存版 Memento（模拟 vscode.globalState） */
class MemoryMemento implements RemoteDeviceMemento {
  /** 键 → 值 */
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

/** 构造一条合法设备记录 */
function record(fingerprint: string, name: string): RemoteDeviceRecord {
  return {
    fingerprint,
    shortFp: `${fingerprint.slice(0, 4)}-${fingerprint.slice(4, 8)}`,
    name,
    tier: 'observe',
    pairedAt: 1,
  };
}

describe('RemoteDeviceStore — 读写', () => {
  it('upsert 保留其他设备，按指纹覆盖同一台', async () => {
    const store = new RemoteDeviceStore(new MemoryMemento());
    await store.upsert(record('AAAA1111', '手机一'));
    await store.upsert(record('BBBB2222', '手机二'));

    expect(
      store
        .list()
        .map((r) => r.name)
        .sort(),
    ).toEqual(['手机一', '手机二']);

    await store.upsert({ ...record('AAAA1111', '手机一改名'), tier: 'approve' });
    expect(store.list()).toHaveLength(2);
    expect(store.get('AAAA1111')?.name).toBe('手机一改名');
    expect(store.get('AAAA1111')?.tier).toBe('approve');
    expect(store.get('BBBB2222')?.name).toBe('手机二');
  });

  it('指纹大小写不敏感：小写写入、大写可查到', async () => {
    const store = new RemoteDeviceStore(new MemoryMemento());
    await store.upsert(record('aabbccdd', '手机'));
    expect(store.get('AABBCCDD')?.fingerprint).toBe('AABBCCDD');
  });

  it('读时逐条校验：坏条目丢弃并留痕，好条目保留', () => {
    const memento = new MemoryMemento();
    memento.values.set(REMOTE_DEVICES_KEY, [
      record('AAAA1111', '好设备'),
      { fingerprint: 123, name: '坏', tier: 'observe', pairedAt: 1 },
      { fingerprint: 'BBBB2222', name: '缺档位', pairedAt: 1 },
      'not-an-object',
    ]);
    const logs: string[] = [];

    const store = new RemoteDeviceStore(memento, (m) => logs.push(m));
    const list = store.list();

    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('好设备');
    expect(logs.filter((line) => line.includes('损坏'))).toHaveLength(3);
  });

  it('未写过设备表时 list 为空数组', () => {
    expect(new RemoteDeviceStore(new MemoryMemento()).list()).toEqual([]);
  });
});

describe('RemoteDeviceStore — 改档与撤销', () => {
  it('setTier：只改目标设备档位，其他设备与字段原样保留', async () => {
    const store = new RemoteDeviceStore(new MemoryMemento());
    await store.upsert(record('AAAA1111', '手机一'));
    await store.upsert(record('BBBB2222', '手机二'));

    expect(await store.setTier('aaaa1111', 'approve')).toBe(true);
    expect(store.get('AAAA1111')?.tier).toBe('approve');
    // 改档不得顺手抹掉名称 / 配对时间 / 短码
    expect(store.get('AAAA1111')?.name).toBe('手机一');
    expect(store.get('AAAA1111')?.pairedAt).toBe(1);
    expect(store.get('AAAA1111')?.shortFp).toBe('AAAA-1111');
    expect(store.get('BBBB2222')?.tier).toBe('observe');
  });

  it('setTier：设备不存在时返回 false 且不写表', async () => {
    const memento = new MemoryMemento();
    const store = new RemoteDeviceStore(memento);
    await store.upsert(record('AAAA1111', '手机一'));
    const before = JSON.stringify(memento.get(REMOTE_DEVICES_KEY));

    expect(await store.setTier('FFFF9999', 'send')).toBe(false);
    expect(JSON.stringify(memento.get(REMOTE_DEVICES_KEY))).toBe(before);
  });

  it('remove：删除目标设备、保留其余；不存在时返回 false', async () => {
    const store = new RemoteDeviceStore(new MemoryMemento());
    await store.upsert(record('AAAA1111', '手机一'));
    await store.upsert(record('BBBB2222', '手机二'));

    expect(await store.remove('AAAA1111')).toBe(true);
    expect(store.get('AAAA1111')).toBeUndefined();
    expect(store.get('BBBB2222')?.name).toBe('手机二');

    // 重复撤销是幂等的「没删到」，返回 false 而不是抛错
    expect(await store.remove('AAAA1111')).toBe(false);
  });
});

describe('RemoteDeviceStore — 单设备策略（replaceWith）', () => {
  it('换绑：表只剩新设备，并返回被替换掉的旧设备', async () => {
    const memento = new MemoryMemento();
    const store = new RemoteDeviceStore(memento);
    await store.upsert(record('AAAA1111', '旧手机'));
    await store.upsert(record('BBBB2222', '更旧手机'));

    const removed = await store.replaceWith(record('cccc3333', '新手机'));

    expect(store.list()).toHaveLength(1);
    expect(store.get('CCCC3333')?.name).toBe('新手机');
    expect(removed.map((r) => r.name).sort()).toEqual(['旧手机', '更旧手机']);
    // 一次写收敛：中间态（表里同时存在两台）从未落库
    expect(memento.get<RemoteDeviceRecord[]>(REMOTE_DEVICES_KEY)).toHaveLength(1);
  });

  it('换绑同一台设备：不产生「被替换」列表', async () => {
    const store = new RemoteDeviceStore(new MemoryMemento());
    await store.upsert(record('AAAA1111', '手机'));

    const removed = await store.replaceWith({ ...record('aaaa1111', '手机改名'), tier: 'send' });

    expect(removed).toEqual([]);
    expect(store.list()).toHaveLength(1);
    expect(store.get('AAAA1111')?.name).toBe('手机改名');
    expect(store.get('AAAA1111')?.tier).toBe('send');
  });
});
