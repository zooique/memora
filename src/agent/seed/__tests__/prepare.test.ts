/**
 * 回答前（Prepare）独立单元测试
 *
 * 覆盖 SeedPrepare.run：
 *   - 策略装配（上下文装配、L2 策略注入、工具暴露）
 *   - 会议机制：active 任务项声明 rolePack → 范围校验 → 本轮装配视角 + 前缀刷新 + 组清单注入
 *   - 回答前中断（signal.aborted）→ 返回 aborted，跳过用户消息入史
 *   - roundId 生成 + appendUser 溯源 + 会话命名 fire-and-forget
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SeedPrepare, refreshTurnAssembly } from '@/agent/seed/prepare.js';
import { createHarness, collectGen } from './harness.js';

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
    expect(mocks.sessionNamer.ensureSessionTitle).toHaveBeenCalledWith(
      '2026-08-20',
      'main',
      '用户输入',
    );

    // 返回结果：仅 input + aborted（round 归属见 loop.currentRoundId）
    expect(result).toEqual({ input: '用户输入', aborted: false });
  });

  it('会议机制：active 任务项声明有效组员 rolePack → 表层装配视角 + 前缀刷新 + 组清单注入', async () => {
    const { mocks, deps } = createHarness();
    // 当前 active 任务项声明 rolePack='成员A'（组长为激活包），范围校验通过
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      plan: [{ id: 's1', description: '步骤1', status: 'active', order: 0, rolePack: '成员A' }],
    });
    mocks.rolePackManager.resolveRoundAssemblyRole.mockReturnValue('成员A');
    mocks.rolePackManager.buildTeamContextBlock.mockReturnValue(
      '【小组会议角色（组长：组长；组员：成员A / 成员B）】...',
    );

    await collectGen(new SeedPrepare(deps).run('输入', new AbortController().signal));

    // 范围校验接收入口收到任务项声明的 rolePack
    expect(mocks.rolePackManager.resolveRoundAssemblyRole).toHaveBeenCalledWith('成员A');
    // 本轮装配视角 = 成员A（表层装配：persona/rules/skills 换、键不换）
    expect(mocks.rolePackManager.setRoundAssemblyRole).toHaveBeenCalledWith('成员A');
    // 前缀刷新按本轮装配角色（键恒为 activePack 由门面实现保证）
    expect(mocks.refreshRolePackPrefixForRound).toHaveBeenCalledWith('成员A');
    // 组/成员清单注入 system prompt（防 LLM 编造角色名）
    expect(mocks.loop.injectSystemMessage).toHaveBeenCalledWith(
      '【小组会议角色（组长：组长；组员：成员A / 成员B）】...',
    );
  });

  it('会议机制：active 任务项越界 rolePack → 覆盖被忽略（回落 activePack）+ 前缀按 activePack 刷新', async () => {
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
    // 骨架数据经 getActiveTeam（公开 SSOT 出口：组长 + 有效组员）取；组装由真函数
    // buildMeetingPlanSkeleton 承担（不经 mock）：组长开场 + 组员各一项（rolePack）+ 汇总
    const items = [
      { description: '组长 主持开场：讨论X' },
      { description: '组员1 发言：讨论X', rolePack: '组员1' },
      { description: '汇总各方观点：讨论X' },
    ];
    mocks.rolePackManager.getActiveTeam.mockReturnValue({ leader: '组长', members: ['组员1'] });

    await collectGen(new SeedPrepare(deps).run('小组会议：讨论X', new AbortController().signal));

    // overwrite 预置（overwrite = 真清空——新会议替换一切旧计划）
    expect(mocks.sessionManager.writePlan).toHaveBeenCalledWith('overwrite', items);
  });

  it('会议机制（骨架预置守卫）：在途计划存在时「小组会议」输入不预置（续会交由 LLM 按任务表推进）', async () => {
    const { mocks, deps } = createHarness();
    // 在途谓词（SSOT = SessionManager.hasInflightPlan）须显式声明：默认 false 会落到「新会议」分支
    mocks.sessionManager.hasInflightPlan.mockReturnValue(true);
    // 在途会议：plan 已有未完成任务项（骨架预置后、未完成）
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      plan: [
        { id: 's1', description: '组长 主持开场：讨论X', status: 'done', order: 0 },
        {
          id: 's2',
          description: '组员1 发言：讨论X',
          status: 'active',
          order: 1,
          rolePack: '组员1',
        },
        { id: 's3', description: '汇总各方观点：讨论X', status: 'pending', order: 2 },
      ],
    });
    // 即便 getActiveTeam 返回有效队伍且输入含「小组会议」（骨架判定可触发），守卫也必须拦截
    mocks.rolePackManager.getActiveTeam.mockReturnValue({ leader: '组长', members: ['组员1'] });
    // active 任务项（组员1）在名单内 → 范围校验通过
    mocks.rolePackManager.resolveRoundAssemblyRole.mockReturnValue('组员1');

    await collectGen(new SeedPrepare(deps).run('继续小组会议讨论', new AbortController().signal));

    // 不 overwrite（不重开/不叠加）——已有进度不被清空
    expect(mocks.sessionManager.writePlan).not.toHaveBeenCalled();
    // 视角仍按当前 active 任务项（组员1）装配
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
    const { result } = await collectGen(
      new SeedPrepare(deps).run('输入', new AbortController().signal),
    );
    expect(result?.aborted).toBe(false);
    expect(mocks.loop.setStrategy).toHaveBeenCalledTimes(1);
  });
});

describe('refreshTurnAssembly（两个 turn 入口的唯一共用点）', () => {
  it('先 await 常驻规则读盘，再按 active 任务项同步刷新前缀（顺序不可颠倒）', async () => {
    const { mocks, deps } = createHarness();
    // 调用顺序真源：两个桩各记一笔，断言「读盘在前、前缀刷新在后」
    const order: string[] = [];
    mocks.refreshResidentRulesContext.mockImplementation(async () => {
      order.push('resident');
    });
    mocks.refreshRolePackPrefixForRound.mockImplementation(() => {
      order.push('prefix');
    });
    mocks.sessionManager.getCheckpoint.mockReturnValue({
      plan: [{ id: 's1', description: '步骤1', status: 'active', order: 0, rolePack: '成员A' }],
    });
    mocks.rolePackManager.resolveRoundAssemblyRole.mockReturnValue('成员A');

    await refreshTurnAssembly(deps);

    expect(order).toEqual(['resident', 'prefix']);
    expect(mocks.refreshRolePackPrefixForRound).toHaveBeenCalledWith('成员A');
  });

  it('防御位：注入依赖抛错 ⇒ 吞掉并继续刷新前缀（不中断 turn）', async () => {
    const { mocks, deps } = createHarness();
    mocks.refreshResidentRulesContext.mockRejectedValue(new Error('注入面意外抛错'));

    // 不抛到调用方
    await expect(refreshTurnAssembly(deps)).resolves.toBeUndefined();
    // 后半段照常执行（缓存/空段语义由内层 manager 保证，这里只钉「不中断」）
    expect(mocks.refreshRolePackPrefixForRound).toHaveBeenCalled();
  });

  it('prepare.run 走组合函数（常驻规则刷新恰好一次）', async () => {
    const { mocks, deps } = createHarness();
    await collectGen(new SeedPrepare(deps).run('输入', new AbortController().signal));
    expect(mocks.refreshResidentRulesContext).toHaveBeenCalledTimes(1);
  });

  it('结构守卫：两个入口都调 refreshTurnAssembly；active 谓词只落一处（禁入口各抄一份）', () => {
    // 为什么用源码扫描而不是只测行为：入口若各自再抄一份 active 谓词/刷新逻辑，
    // 行为测试仍可能全绿（两份分别都对），只有结构约束能把「同一组合函数」钉死。
    //
    // 🔴 **失效条件说明（本守卫是形状守卫，不是语义守卫——红了先读这三句，别直接删）：**
    // 1. 本守卫守的是「**两个 turn 入口不得各自实现 active 谓词 / 刷新链**」，
    //    **不是**「必须用 `.plan.find(` / `getCheckpoint` 这些具体写法」。下面的字面量只是
    //    当前实现的形状指纹，不是契约本身。
    // 2. 红了先看语义：若新实现**仍然只有一处**、且**两个入口共用**（例如改成 `findIndex`、
    //    `for` 循环、或封装成具名函数），代码是对的、甚至更好 ⇒ **改本守卫的匹配式，不要删守卫**。
    // 3. **删除本守卫必须同时删除它保护的约束说明**（refreshTurnAssembly 的 JSDoc 与本节注释）——
    //    不允许「守卫挡烦了就删」：只删守卫、留下「两入口共用」的承诺，等于给后来者一个无人核对的谎。
    //
    // 断言的三个字面量都是本仓既有的稳定写法，改动它们等于改动本契约，须同步改本测试。
    const seedDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const prepareSrc = readFileSync(join(seedDir, 'prepare.ts'), 'utf8');
    const orchestratorSrc = readFileSync(join(seedDir, 'orchestrator.ts'), 'utf8');

    // ① 两个入口都以 await 调用同一组合函数
    expect(prepareSrc).toContain('await refreshTurnAssembly(');
    expect(orchestratorSrc).toContain('await refreshTurnAssembly(');
    // ② 续跑入口不得自己读 checkpoint / 找 active 任务项（谓词唯一落点在 prepare.ts 的组合函数）
    expect(orchestratorSrc).not.toContain('getCheckpoint');
    expect(orchestratorSrc).not.toContain('.plan.find(');
    // ③ 谓词在 prepare.ts 内也只出现一次（组合函数本身）
    expect(prepareSrc.split('.plan.find(').length - 1).toBe(1);
  });
});
