/**
 * run_team_meeting 单元测试 — 工具内嵌 LLM 调用的评估/评审型会议
 *
 * 覆盖范围：
 *   - 参数校验：缺 group / 缺 topic / 组不存在 / 角色未装载 → MemoraError（ARGUMENT_ERROR）
 *   - persona 拼接：真实 RolePackManager 装载多角色 → system prompt 含各角色 persona 全文 + 组长标注
 *   - 单次调用：provider.chat 恒只被调用一次（系统视角：一次 LLM 调用完成多视角）
 *   - 组长汇总视角：组长被标注为「组长」且置于角色序列提示要求之一
 *   - 组员截断：组员超 MAX_TEAM_MEMBERS 时只取前上限名（getTeam 同 getActiveTeam 口径）
 *   - 未装载角色跳过：组员 persona 为空时该角色不进入 prompt，不报错
 *
 * 测试范式：真实 RolePackManager + 真实临时 role-packs 目录（与实际装配同源），
 * provider 用 mock（仅验证「收到一次调用 + 收到拼好的多角色 system prompt」）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolePackManager } from '@/role-pack/rolePackManager.js';
import { runTeamMeetingAssessment } from '@/agent/builtinToolHandlers.js';
import { ToolErrorCode } from '@/utils/errors.js';
import type { LlmProvider, Message } from '@/llm/provider.js';

/**
 * 便捷构造：写一个 folder 形态角色包（manifest.json + persona.md）
 */
async function writePack(packsDir: string, packName: string, persona: string): Promise<void> {
  const packDir = join(packsDir, packName);
  await mkdir(packDir, { recursive: true });
  await writeFile(
    join(packDir, 'manifest.json'),
    JSON.stringify({ name: packName, formatVersion: '1.0.0' }, null, 2),
    'utf-8',
  );
  await writeFile(join(packDir, 'persona.md'), persona, 'utf-8');
}

/** mock provider：记录收到的消息（证明调用次数 + 拼好的 system prompt），返回固定评审文本块 */
function makeMockProvider(): {
  provider: LlmProvider;
  received: Message[][];
} {
  const received: Message[][] = [];
  const chat = async function* (messages: Message[]): AsyncGenerator<{ content: string }> {
    received.push(messages);
    yield { content: '【组长】同意识记忆，但需防噪声成本。' };
    yield { content: '【组员】从体验角度再补充一条。' };
  };
  // 被测代码只用 provider.chat()，其余抽象成员以类型断言补齐
  return { provider: { chat } as unknown as LlmProvider, received };
}

describe('runTeamMeetingAssessment', () => {
  let dir: string;
  /** 角色包管理器（真实装载，映射实际装配链路） */
  let manager: RolePackManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'run-team-meeting-'));
    manager = new RolePackManager(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 装配一个「组长 + 2 组员」的组，各自 persona 语义可辨 */
  async function setupTeam(): Promise<void> {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    // 组长：设计视角
    await writePack(packsDir, '设计师', '你是产品设计师，讲究种子最小单元与体验直觉。');
    // 组员：技术视角
    await writePack(packsDir, '工程师', '你是工程师，关注实现复杂度与稳定性。');
    // 组员：数据视角
    await writePack(packsDir, '数据分析师', '你是数据分析师，强调指标量化与成本控制。');
    manager.setRolePackTeams([{ leader: '设计师', members: ['工程师', '数据分析师'] }]);
    await manager.load('设计师');
  }

  it('一次调用完成多角色评估：system prompt 含各角色 persona 全文 + 组长标注', async () => {
    await setupTeam();
    const { provider, received } = makeMockProvider();

    const result = await runTeamMeetingAssessment({
      resolveTeam: (g) => manager.getTeam(g),
      buildPersona: (n) => manager.buildSystemPrompt(n),
      provider,
      group: '设计师',
      topic: '该不该加记忆功能',
    });

    // 仅一次 provider.chat（单次 LLM 调用，非逐视角多次切换）
    expect(received).toHaveLength(1);
    const calledWith = received[0]!;
    const system = calledWith.find((m) => m.role === 'system')!.content;
    const user = calledWith.find((m) => m.role === 'user')!.content;

    // 各角色 persona 全文真实注入（语义可辨，非空壳标签）
    expect(system).toContain('产品设计师，讲究种子最小单元');
    expect(system).toContain('工程师，关注实现复杂度');
    expect(system).toContain('数据分析师，强调指标量化');
    // 组长唯一汇总视角标注（角色①=组长），组员为独立视角
    expect(system).toContain('角色1（组长）名称：设计师');
    expect(system).toContain('角色2（组员）名称：工程师');
    expect(system).toContain('以组长「设计师」视角做简短汇总');
    // user 为正式评估指令（收尾 prompt）
    expect(user).toContain('正式评估');

    // 返回评审文本（provider 产出的拼接结果）
    expect(result).toContain('【组长】');
    expect(result).toContain('【组员】');
  });

  it('缺 group / 缺 topic → ARGUMENT_ERROR', async () => {
    await setupTeam();
    const { provider } = makeMockProvider();
    const base = {
      resolveTeam: (g: string) => manager.getTeam(g),
      buildPersona: (n: string) => manager.buildSystemPrompt(n),
      provider,
    };

    for (const bad of [
      { ...base, group: '', topic: 'x' },
      { ...base, group: '  ', topic: 'x' },
      { ...base, group: '设计师', topic: '' },
    ] as const) {
      await expect(runTeamMeetingAssessment({ ...bad } as never)).rejects.toMatchObject({
        errorCode: ToolErrorCode.ARGUMENT_ERROR,
      });
    }
  });

  it('组不存在 → ARGUMENT_ERROR（不给假会议的静默通过）', async () => {
    await setupTeam();
    const { provider } = makeMockProvider();
    await expect(
      runTeamMeetingAssessment({
        resolveTeam: (g) => manager.getTeam(g),
        buildPersona: (n) => manager.buildSystemPrompt(n),
        provider,
        group: '不存在的组',
        topic: '某议题',
      }),
    ).rejects.toMatchObject({ errorCode: ToolErrorCode.ARGUMENT_ERROR });
  });

  it('组员超 MAX_TEAM_MEMBERS：解析时截断，超限角色不参与会议', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '组长', '组长设定');
    // 5 个组员（超上限 4）全部真实装载
    for (let i = 1; i <= 5; i++) {
      await writePack(packsDir, `组员${i}`, `组员${i}设定`);
    }
    manager.setRolePackTeams([
      { leader: '组长', members: ['组员1', '组员2', '组员3', '组员4', '组员5'] },
    ]);
    await manager.load('组长');

    // getTeam 与 getActiveTeam 同截断口径（队长 1 + 组员 ≤ 4）
    const team = manager.getTeam('组长');
    expect(team!.members).toHaveLength(4);
    expect(team!.members).toEqual(['组员1', '组员2', '组员3', '组员4']);

    const { provider, received } = makeMockProvider();
    await runTeamMeetingAssessment({
      resolveTeam: (g) => manager.getTeam(g),
      buildPersona: (n) => manager.buildSystemPrompt(n),
      provider,
      group: '组长',
      topic: '限员议题',
    });
    const calledWith = received[0]!;
    const system = calledWith.find((m) => m.role === 'system')!.content;
    // 前 4 名组员在内，第 5 名被截断出局（不进入 prompt）
    expect(system).toContain('组员4设定');
    expect(system).not.toContain('组员5设定');
  });

  it('未装载的组员 persona 为空 → 跳过该角色，不报错', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '组长', '组长设定');
    await writePack(packsDir, '已装载组员', '已装载组员设定');
    // 「未装载组员」不在 role-packs 目录（悬空引用）→ buildSystemPrompt 返回空串 → 跳过
    manager.setRolePackTeams([{ leader: '组长', members: ['已装载组员', '未装载组员'] }]);
    await manager.load('组长');

    const { provider, received } = makeMockProvider();
    const result = await runTeamMeetingAssessment({
      resolveTeam: (g) => manager.getTeam(g),
      buildPersona: (n) => manager.buildSystemPrompt(n),
      provider,
      group: '组长',
      topic: '缺员议题',
    });

    const calledWith = received[0]!;
    const system = calledWith.find((m) => m.role === 'system')!.content;
    // 未装载角色不进入 prompt；已装载组长 + 组员照常开会
    expect(system).toContain('组长设定');
    expect(system).toContain('已装载组员设定');
    expect(system).not.toContain('未装载组员');
    expect(result.length).toBeGreaterThan(0);
  });

  it('全部角色未装载 → 无法开会（ARGUMENT_ERROR）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    // 只声明组，不装载任何角色包
    manager.setRolePackTeams([{ leader: '组长', members: ['组员'] }]);
    await manager.load('组长');

    const { provider } = makeMockProvider();
    await expect(
      runTeamMeetingAssessment({
        resolveTeam: (g) => manager.getTeam(g),
        buildPersona: (n) => manager.buildSystemPrompt(n),
        provider,
        group: '组长',
        topic: '议题',
      }),
    ).rejects.toMatchObject({ errorCode: ToolErrorCode.ARGUMENT_ERROR });
  });
});
