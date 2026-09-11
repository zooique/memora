/**
 * 回答前（Prepare）独立单元测试
 *
 * 覆盖 SeedPrepare.run：
 *   - 策略装配（上下文装配、L2 策略注入、工具暴露）
 *   - 会议机制（S5）：active 步骤声明 rolePack → 范围校验 → 本轮装配视角 + 前缀刷新 + 组清单注入
 *   - 回答前中断（signal.aborted）→ 返回 aborted，跳过用户消息入史
 *   - roundId 生成 + appendUser 溯源 + 会话命名 fire-and-forget
 */

import { describe, it, expect } from 'vitest';
import { SeedPrepare } from '@/agent/seed/prepare.js';
import {
  createHarness,
  collectGen,
} from './harness.js';

describe('SeedPrepare 回答前', () => {
  it('策略装配：装配上下文 → L2 策略注入 → 工具暴露', async () => {
    const { mocks, deps } = createHarness();

    const { chunks, result } = await collectGen(
      new SeedPrepare(deps).run('用户输入', new AbortController().signal),
    );

    // thinking 阶段提示（assembling → processing）
    expect(chunks).toEqual([
      { type: 'thinking', phase: 'assembling' },
      { type: 'thinking', phase: 'processing' },
    ]);

    // L2 策略注入 + 工具暴露面应用（工具面恒为 activePack）
    expect(mocks.loop.setStrategy).toHaveBeenCalledTimes(1);
    expect(mocks.applyRolePackToolExposure).toHaveBeenCalledTimes(1);
    // 上下文装配（对话层注入恒 hybrid；自动召回退役，assembleContext 单参无返回值）
    expect(mocks.contextPreparer.assembleContext).toHaveBeenCalledWith('用户输入');
    // roundId 生成 + 用户消息入史（同 roundId 溯源）
    expect(mocks.loop.setCurrentRoundId).toHaveBeenCalledTimes(1);
    const roundId = mocks.loop.setCurrentRoundId.mock.calls[0]?.[0];
    expect(mocks.history.appendUser).toHaveBeenCalledWith('用户输入', roundId);
    // 会话命名 fire-and-forget
    expect(mocks.sessionNamer.ensureSessionTitle).toHaveBeenCalledWith('2026-08-20', 'main', '用户输入');

    // 返回结果：仅 input + aborted（round 归属见 loop.currentRoundId）
    expect(result).toEqual({ input: '用户输入', aborted: false });
  });

  it('会议机制：active 步骤声明有效组员 rolePack → 表层装配视角 + 前缀刷新 + 组清单注入', async () => {
    const { mocks, deps } = createHarness();
    // 当前 active 步骤声明 rolePack='成员A'（组长为激活包），范围校验通过
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      plan: [{ id: 's1', description: '步骤1', status: 'active', order: 0, rolePack: '成员A' }],
    });
    mocks.rolePackManager.resolveRoundAssemblyRole.mockReturnValue('成员A');
    mocks.rolePackManager.buildTeamContextBlock.mockReturnValue('【小组会议角色（组长：组长；组员：成员A / 成员B）】...');

    await collectGen(new SeedPrepare(deps).run('输入', new AbortController().signal));

    // 范围校验接收入口收到任务项声明的 rolePack
    expect(mocks.rolePackManager.resolveRoundAssemblyRole).toHaveBeenCalledWith('成员A');
    // 本轮装配视角 = 成员A（表层装配：persona/rules/skills 换、键不换）
    expect(mocks.rolePackManager.setRoundAssemblyRole).toHaveBeenCalledWith('成员A');
    // 前缀刷新按本轮装配角色（键恒为 activePack 由门面实现保证）
    expect(mocks.refreshRolePackPrefixForRound).toHaveBeenCalledWith('成员A');
    // 组/成员清单注入 system prompt（防 LLM 编造角色名）
    expect(mocks.loop.injectSystemMessage).toHaveBeenCalledWith('【小组会议角色（组长：组长；组员：成员A / 成员B）】...');
  });

  it('会议机制：active 步骤越界 rolePack → 覆盖被忽略（回落 activePack）+ 前缀按 activePack 刷新', async () => {
    const { mocks, deps } = createHarness();
    // 越界角色（非组长/组员）→ 范围校验返回 null
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      plan: [{ id: 's1', description: '步骤1', status: 'active', order: 0, rolePack: '幻觉角色' }],
    });
    mocks.rolePackManager.resolveRoundAssemblyRole.mockReturnValue(null);

    await collectGen(new SeedPrepare(deps).run('输入', new AbortController().signal));

    // 越界忽略：不设置装配视角（回落 activePack）
    expect(mocks.rolePackManager.setRoundAssemblyRole).toHaveBeenCalledWith(null);
    expect(mocks.refreshRolePackPrefixForRound).toHaveBeenCalledWith(null);
  });

  it('会议机制（骨架预置 2026-09-07）：无在途计划 + 「小组会议」→ overwrite 预置骨架任务表', async () => {
    const { mocks, deps } = createHarness();
    // 无检查点（无在途计划）
    mocks.sessionManager.getCheckpoint.mockReturnValue(null);
    // 骨架预置：组长开场 + 组员各一步（rolePack）+ 汇总（与 tryBuildMeetingPlan 单入口一致）
    const steps = [
      { description: '组长 主持开场：讨论X' },
      { description: '组员1 发言：讨论X', rolePack: '组员1' },
      { description: '汇总各方观点：讨论X' },
    ];
    mocks.rolePackManager.tryBuildMeetingPlan.mockReturnValue(steps);

    await collectGen(new SeedPrepare(deps).run('小组会议：讨论X', new AbortController().signal));

    // overwrite 预置（writePlan 语义修复后为真清空——新会议替换一切旧计划）
    expect(mocks.sessionManager.writePlan).toHaveBeenCalledWith('overwrite', steps);
  });

  it('会议机制（骨架预置守卫）：在途计划存在时「小组会议」输入不预置（续会交由 LLM 按任务表推进）', async () => {
    const { mocks, deps } = createHarness();
    // 在途会议：plan 已有 pending 步骤（骨架预置后、未完成）
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      plan: [
        { id: 's1', description: '组长 主持开场：讨论X', status: 'done', order: 0 },
        { id: 's2', description: '组员1 发言：讨论X', status: 'active', order: 1, rolePack: '组员1' },
        { id: 's3', description: '汇总各方观点：讨论X', status: 'pending', order: 2 },
      ],
    });
    // 即便 tryBuildMeetingPlan 判定可触发（输入含「小组会议」），守卫也必须拦截
    const steps = [{ description: '组员1 发言', rolePack: '组员1' }];
    mocks.rolePackManager.tryBuildMeetingPlan.mockReturnValue(steps);
    // active 步骤（组员1）在名单内 → 范围校验通过
    mocks.rolePackManager.resolveRoundAssemblyRole.mockReturnValue('组员1');

    await collectGen(new SeedPrepare(deps).run('继续小组会议讨论', new AbortController().signal));

    // 不 overwrite（不重开/不叠加）——已有进度不被清空
    expect(mocks.sessionManager.writePlan).not.toHaveBeenCalled();
    // 视角仍按当前 active 步骤（组员1）装配
    expect(mocks.rolePackManager.setRoundAssemblyRole).toHaveBeenCalledWith('组员1');
  });

  it('回答前中断：signal.aborted → 返回 aborted，跳过技能注入与用户消息入史', async () => {
    const { mocks, deps } = createHarness();

    // 召回阶段前先中止 signal
    const ac = new AbortController();
    ac.abort();

    const { result } = await collectGen(new SeedPrepare(deps).run('输入', ac.signal));

    expect(result).toEqual({ input: '输入', aborted: true });
    // 中断后不再注入用户消息 / 不命名
    expect(mocks.loop.setCurrentRoundId).not.toHaveBeenCalled();
    expect(mocks.history.appendUser).not.toHaveBeenCalled();
    expect(mocks.sessionNamer.ensureSessionTitle).not.toHaveBeenCalled();
  });

  it('每次运行前清理临时 system 消息（技能 prompt 不跨轮累积）', async () => {
    const { mocks, deps } = createHarness();
    await collectGen(new SeedPrepare(deps).run('输入', new AbortController().signal));
    expect(mocks.loop.cleanTemporarySystemMessages).toHaveBeenCalledTimes(1);
  });

  it('无激活角色包时回退全局默认策略仍可正常完成', async () => {
    const { mocks, deps } = createHarness();
    // getActive 默认 null → 回退 DEFAULT_BEHAVIOR_STRATEGY
    const { result } = await collectGen(new SeedPrepare(deps).run('输入', new AbortController().signal));
    expect(result?.aborted).toBe(false);
    expect(mocks.loop.setStrategy).toHaveBeenCalledTimes(1);
  });
});