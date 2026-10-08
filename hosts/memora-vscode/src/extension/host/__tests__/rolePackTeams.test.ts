/**
 * 角色包队伍健康检测测试（幽灵引用标注 · 只读不写回，ADR-028 收敛补记 2026-10-08 语义变更）
 *
 * 覆盖两组被测不变量：
 *
 * 1. `inspectTeamsHealth` 纯函数语义：
 *    - 组长包已卸载 → leaderMissing=true（遗留队伍，UI 给清理入口）；
 *    - 组员包已卸载 → missingMembers 列出缺员（UI 标注，用户编辑保存即修复）；
 *    - 健康数据 → 全健康视图（不改输入，零删除语义）；
 *    - 空池护栏：包池为空 = 扫描失败窗口（构建中/安装损坏），全部按健康处理跳过检测
 *      （2026-10-07 事故根因：把瞬时状态当成永久事实，旧清理语义下曾静默删除全部队伍）。
 *
 * 2. `inspectRolePackTeams` 编排语义：
 *    - 只读不写回：零 globalState.update、零内核调用（存储即真源，检测是派生视图）；
 *    - 内核未就绪 / 存储缺失 → 返回空表（UI 不标注，安全跳过）；
 *    - 检测异常 → 吞掉返回空表（不影响日常），存储保留原样。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { RolePackManager } from '@zooique/memora';
import type { Memento } from 'vscode';
import { inspectTeamsHealth, inspectRolePackTeams } from '../rolePackTeams.js';
import { ROLE_PACK_TEAMS_KEY } from '../../../shared/constants.js';

/** 内核角色包管理器桩：listMeta 返回给定包名集合（真源面） */
function rpmStub(names: string[]): { rpm: RolePackManager; listMeta: ReturnType<typeof vi.fn> } {
  const listMeta = vi.fn(() => names.map((name) => ({ name })));
  const rpm = { listMeta } as unknown as RolePackManager;
  return { rpm, listMeta };
}

/** Memento 桩：get 读当前值；update 记录调用（新语义下必须零调用） */
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

describe('inspectTeamsHealth —— 检测纯函数语义', () => {
  it('组长包已卸载 → leaderMissing=true（遗留队伍场景：内置包收紧后无删除事件）', () => {
    const health = inspectTeamsHealth(
      [{ leader: '方案设计师', members: ['memora助手'] }],
      new Set(['memora助手']),
    );
    expect(health.get('方案设计师')).toEqual({
      leaderMissing: true,
      missingMembers: [],
    });
  });

  it('组员包已卸载 → missingMembers 列出缺员，健康组员不列入', () => {
    const health = inspectTeamsHealth(
      [{ leader: 'A', members: ['B', 'C', 'D'] }],
      new Set(['A', 'C', 'D']),
    );
    expect(health.get('A')).toEqual({ leaderMissing: false, missingMembers: ['B'] });
  });

  it('健康数据 → 全健康视图（零删除语义，输入原样不动）', () => {
    const teams = [{ leader: 'A', members: ['B'] }];
    const health = inspectTeamsHealth(teams, new Set(['A', 'B']));
    expect(health.get('A')).toEqual({ leaderMissing: false, missingMembers: [] });
    // 输入未被修改（纯函数）
    expect(teams).toEqual([{ leader: 'A', members: ['B'] }]);
  });

  it('空池护栏：包池为空（扫描失败窗口）→ 全部按健康处理跳过检测', () => {
    const health = inspectTeamsHealth(
      [{ leader: 'A', members: ['B'] }],
      new Set<string>(),
    );
    expect(health.get('A')).toEqual({ leaderMissing: false, missingMembers: [] });
  });
});

describe('inspectRolePackTeams —— 检测编排语义', () => {
  it('只读不写回：受损数据检出但零 globalState.update、零内核调用', () => {
    const { rpm, listMeta } = rpmStub(['memora助手']);
    const { memento, update } = mementoStub([{ leader: '方案设计师', members: ['memora助手'] }]);

    const health = inspectRolePackTeams(rpm, memento);

    // 存储即真源：检测是派生视图，禁止写回（2026-10-07 事故的语义断根）
    expect(update).not.toHaveBeenCalled();
    // 检测结果正确下发
    expect(health.get('方案设计师')).toEqual({ leaderMissing: true, missingMembers: [] });
    expect(listMeta).toHaveBeenCalledTimes(1);
  });

  it('内核未就绪（null）/ 存储缺失（undefined）→ 返回空表安全跳过', () => {
    const { rpm } = rpmStub(['A']);
    const { memento, update } = mementoStub([]);

    expect(inspectRolePackTeams(null, memento).size).toBe(0);
    expect(inspectRolePackTeams(rpm, undefined).size).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('存储读取/包池枚举异常 → 吞掉返回空表（检测失败不影响日常）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rpm = {
        listMeta: () => {
          throw new Error('pool scan failed');
        },
      } as unknown as RolePackManager;
      const memento = {
        get: () => [{ leader: 'A', members: ['B'] }],
      } as unknown as Memento;

      expect(inspectRolePackTeams(rpm, memento).size).toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('存储键不变（ROLE_PACK_TEAMS_KEY 读取，形态兼容旧数据）', () => {
    const { rpm } = rpmStub(['A', 'B']);
    const { memento } = mementoStub([{ leader: 'A', members: ['B'] }]);

    // 旧语义写入的数据无需迁移，直接可检测
    const health = inspectRolePackTeams(rpm, memento);
    expect(health.get('A')).toEqual({ leaderMissing: false, missingMembers: [] });
    expect(ROLE_PACK_TEAMS_KEY).toBe('memora.rolePackTeams');
  });
});
