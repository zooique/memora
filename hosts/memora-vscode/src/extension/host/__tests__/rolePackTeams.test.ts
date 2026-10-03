/**
 * 角色包队伍对账测试（幽灵引用清理，ADR-028 收敛补记 2026-10-03）
 *
 * 覆盖两组被测不变量：
 *
 * 1. `reconcileTeams` 纯函数语义：
 *    - 组长包已卸载 → 整组删除（组以组长为定义者）；
 *    - 组员包已卸载 → 从名单摘除，其余组员保留；
 *    - 摘后名单为空（含存量空名单组）→ 删组（对齐保存校验「至少 1 名组员」不变式）；
 *    - 健康数据原样返回（changed=false，未受损组保留原引用）。
 *
 * 2. `reconcileRolePackTeams` 编排语义：
 *    - 发现幽灵引用 → 写回 globalState（键 = ROLE_PACK_TEAMS_KEY）+ 热更新内核组数据；
 *    - 健康数据 → 零写回、零内核调用（幂等，不产生无意义持久化）；
 *    - 内核未就绪 / 存储缺失 → 安全跳过；
 *    - 存储写入失败 → 不抛出（对账失败不影响日常），且不热更新内核（双方保持旧态）。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { RolePackManager } from '@zooique/memora';
import type { Memento } from 'vscode';
import { reconcileTeams, reconcileRolePackTeams } from '../rolePackTeams.js';
import { ROLE_PACK_TEAMS_KEY } from '../../../shared/constants.js';

/** 内核角色包管理器桩：listMeta 返回给定包名集合（真源面），setRolePackTeams 记录调用 */
function rpmStub(names: string[]): { rpm: RolePackManager; setRolePackTeams: ReturnType<typeof vi.fn> } {
  const setRolePackTeams = vi.fn();
  const rpm = {
    listMeta: () => names.map((name) => ({ name })),
    setRolePackTeams,
  } as unknown as RolePackManager;
  return { rpm, setRolePackTeams };
}

/** Memento 桩：get 读当前值，update 可变存储（模拟写回后重读），可注入拒绝行为 */
function mementoStub(initial: unknown): {
  memento: Memento;
  update: ReturnType<typeof vi.fn>;
  dump: () => unknown;
} {
  let store: unknown = initial;
  const update = vi.fn(async (_key: string, value: unknown) => {
    store = value;
  });
  return {
    memento: { get: () => store, update } as unknown as Memento,
    update,
    dump: () => store,
  };
}

describe('reconcileTeams —— 对账纯函数语义', () => {
  it('组长包已卸载 → 整组删除（幽灵组长场景：内置包收紧后无删除事件）', () => {
    const { teams, changed } = reconcileTeams(
      [{ leader: '方案设计师', members: ['memora助手'] }],
      new Set(['memora助手']),
    );
    expect(teams).toEqual([]);
    expect(changed).toBe(true);
  });

  it('组员包已卸载 → 从名单摘除，其余组员与组长保留', () => {
    const healthy = { leader: 'A', members: ['B', 'C', 'D'] };
    const { teams, changed } = reconcileTeams([healthy], new Set(['A', 'C', 'D']));
    expect(teams).toEqual([{ leader: 'A', members: ['C', 'D'] }]);
    expect(changed).toBe(true);
  });

  it('摘后名单为空 → 删组（组员全部失效）', () => {
    const { teams, changed } = reconcileTeams(
      [{ leader: 'A', members: ['X', 'Y'] }],
      new Set(['A']),
    );
    expect(teams).toEqual([]);
    expect(changed).toBe(true);
  });

  it('存量空名单组 → 删组（不动组长的组员名单也为空的组不成立）', () => {
    const { teams, changed } = reconcileTeams(
      [{ leader: 'A', members: [] }],
      new Set(['A', 'B']),
    );
    expect(teams).toEqual([]);
    expect(changed).toBe(true);
  });

  it('健康数据 → 原样返回（changed=false，未受损组保留原引用）', () => {
    const healthy = { leader: 'A', members: ['B'] };
    const { teams, changed } = reconcileTeams([healthy], new Set(['A', 'B']));
    expect(teams).toEqual([healthy]);
    expect(teams[0]).toBe(healthy);
    expect(changed).toBe(false);
  });
});

describe('reconcileRolePackTeams —— 对账编排语义', () => {
  it('发现幽灵引用 → 写回 globalState + 热更新内核组数据（双收敛）', async () => {
    const { rpm, setRolePackTeams } = rpmStub(['memora助手']);
    const { memento, update } = mementoStub([{ leader: '方案设计师', members: ['memora助手'] }]);

    await reconcileRolePackTeams(rpm, memento);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(ROLE_PACK_TEAMS_KEY, []);
    // 内核热更新不可省：装配期已把幽灵队伍注入内核，仅写存储则本会话会议消费端仍见幽灵
    expect(setRolePackTeams).toHaveBeenCalledTimes(1);
    expect(setRolePackTeams).toHaveBeenCalledWith([]);
  });

  it('健康数据 → 零写回、零内核调用（幂等，不产生无意义持久化）', async () => {
    const { rpm, setRolePackTeams } = rpmStub(['A', 'B']);
    const { memento, update } = mementoStub([{ leader: 'A', members: ['B'] }]);

    await reconcileRolePackTeams(rpm, memento);

    expect(update).not.toHaveBeenCalled();
    expect(setRolePackTeams).not.toHaveBeenCalled();
  });

  it('内核未就绪（null）/ 存储缺失（undefined）→ 安全跳过', async () => {
    const { rpm, setRolePackTeams } = rpmStub(['A']);
    const { memento, update } = mementoStub([]);

    await reconcileRolePackTeams(null, memento);
    await reconcileRolePackTeams(rpm, undefined);

    expect(update).not.toHaveBeenCalled();
    expect(setRolePackTeams).not.toHaveBeenCalled();
  });

  it('存储写入失败 → 不抛出且不热更新内核（对账失败不影响日常）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { rpm, setRolePackTeams } = rpmStub(['memora助手']);
      const update = vi.fn(async () => {
        throw new Error('storage write failed');
      });
      const memento = { get: () => [{ leader: '幽灵组长', members: [] }], update } as unknown as Memento;

      await expect(reconcileRolePackTeams(rpm, memento)).resolves.toBeUndefined();

      expect(setRolePackTeams).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
