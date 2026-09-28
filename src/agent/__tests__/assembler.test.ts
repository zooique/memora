/**
 * assembler 单元测试 — Agent 组件组装器工厂函数
 *
 * 覆盖范围：
 *   - security 校验（pctx.security=null 抛 MemoraError）
 *   - 4 阶段组装成功 + 返回值完整性（AssembleOutput 12 个字段）
 *   - systemPromptPrefix 组装（personaPrompt 内部非空 + 当前时间注入）
 *   - skillManager 复用（existingSkillManager 注入 vs 新建）
 *   - 配置透传（activeRolePack / configDir / tracer / enableContextSummary）
 *
 * 测试范式：真实 InMemoryStorage + 真实 SecurityGuard + mock LlmProvider（chat 返回空 AsyncIterable）+
 * mock fileStore + configDir=undefined 走降级路径，聚焦组装逻辑而非各组件自身行为（各组件已有独立测试）。
 *
 * 设计约束：
 * - 生产代码禁止 @ts-ignore / as any / as unknown as（零例外）
 * - 测试 mock 允许 as unknown as（构造部分实现的 mock 对象，TS 社区惯例）
 * - 类型导入使用 import type
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleComponents, buildSystemPromptPrefix } from '@/agent/assembler.js';
import type { AssembleInput, AgentHooks } from '@/agent/assembler.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { SkillManager } from '@/skill/skillManager.js';
import { MemoraError } from '@/utils/errors.js';
import { AGENT_EVENTS } from '@/utils/eventEmitter.js';
import type { LlmProvider } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { ProjectContext } from '@/memory/projectManager.js';
import type { Memory } from '@/memory/types.js';

// ─── 测试夹具 ─────────────────────────────────────────────

/** 临时项目根目录（每个 it 重建） */
let projectPath: string;
/** 真实 InMemoryStorage（pctx.index，组件依赖的真实存储） */
let storage: InMemoryStorage;
/** 真实 SecurityGuard（projectPath 在白名单内，confirmWrites=false 自动确认） */
let security: SecurityGuard;
/** mock provider（chat 返回空 AsyncIterable，assembleComponents 不调用 chat） */
let provider: LlmProvider;
/** mock backgroundProvider */
let backgroundProvider: LlmProvider;

beforeEach(async () => {
  // 创建临时项目目录
  projectPath = await mkdtemp(join(tmpdir(), 'memora-assembler-'));
  storage = new InMemoryStorage();
  security = new SecurityGuard(projectPath, projectPath);
  provider = createMockProvider('mock-provider');
  backgroundProvider = createMockProvider('mock-background');
});

afterEach(async () => {
  // 清理临时目录
  await rm(projectPath, { recursive: true, force: true });
});

/**
 * 构造 mock LlmProvider
 *
 * chat 返回空 AsyncIterable（assembleComponents 不调用 chat，
 * 但 WorkProjectionManager 等构造时会存储 provider 引用）
 *
 * @param name - provider 名称
 * @returns mock LlmProvider
 */
function createMockProvider(name: string): LlmProvider {
  const chatMock = vi.fn().mockImplementation(() => {
    return (async function* () {
      yield { content: '' } as LlmChunk;
    })();
  });
  return { name, chat: chatMock } as unknown as LlmProvider;
}

/**
 * 构造最小 AssembleInput
 * @param overrides - 字段覆写
 * @returns 完整 AssembleInput
 */
function createInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    provider,
    backgroundProvider,
    projectPath,
    configDir: undefined,
    activeRolePack: undefined,
    maxContextTokens: 1000,
    sessionStore: undefined,
    tracer: undefined,
    messages: undefined,
    enableContextSummary: false,
    rolePackTeams: [], // AgentConfig 收敛后必传；直构测试显式空数组
    existingSkillManager: null,
    ...overrides,
  };
}

/**
 * 构造最小 ProjectContext（Partial 断言，仅提供 assembler 用到的字段）
 * @param overrides - 字段覆写
 * @returns 完整 ProjectContext
 */
function createPctx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    projectPath,
    projectName: 'test-project',
    memoraDir: projectPath,
    index: storage,
    security,
    bootstrapMemories: [],
    ...overrides,
  } as ProjectContext;
}

// ─── security 校验 ────────────────────────────────────────

describe('assembleComponents', () => {
  describe('security 校验', () => {
    it('pctx.security=null 抛 MemoraError（显式校验）', async () => {
      // 安全守卫未注入时，组装器应在起点抛错，避免后续组件拿到 null security
      const pctx = createPctx({ security: null });
      await expect(assembleComponents(pctx, createInput())).rejects.toThrow(MemoraError);
    });

    it('错误信息包含排查建议', async () => {
      // configError 的第三参数是排查建议数组，错误消息应包含可检索的关键词
      const pctx = createPctx({ security: null });
      try {
        await assembleComponents(pctx, createInput());
        expect.fail('应抛 MemoraError');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        const msg = (err as MemoraError).message;
        // 错误消息应包含 security guard 关键词，便于日志检索
        expect(msg).toContain('security guard');
      }
    });
  });

  // ─── 组装成功 + 返回值完整性 ────────────────────────────

  describe('组装成功 + 返回值完整性', () => {
    it('返回 AssembleOutput 包含全部 14 个字段', async () => {
      const output = await assembleComponents(createPctx(), createInput());

      // 14 个字段全部存在（history/loop/toolExec/
      // workProjection/skillManager/memoryInspector/
      // dedupManager/memoryAdvisor/roundSummaryGenerator/
      // sessionArchiver/textPolisher/rolePackManager/
      // sessionManager——由组装器创建，先于 loop/
      // contextPreparer）
      const expectedKeys = [
        'history',
        'loop',
        'toolExec',
        'workProjection',
        'skillManager',
        'memoryInspector',
        'dedupManager',
        'memoryAdvisor',
        'roundSummaryGenerator',
        'sessionArchiver',
        'textPolisher',
        'rolePackManager',
        'sessionManager',
        'contextPreparer',
      ];
      expect(Object.keys(output).sort()).toEqual(expectedKeys.sort());
    });

    it('所有组件实例均已创建（非 undefined/null）', async () => {
      const output = await assembleComponents(createPctx(), createInput());
      // 逐一验证组件实例存在
      expect(output.history).toBeDefined();
      expect(output.loop).toBeDefined();
      expect(output.toolExec).toBeDefined();
      expect(output.workProjection).toBeDefined();
      expect(output.skillManager).toBeDefined();
      expect(output.memoryInspector).toBeDefined();
      expect(output.memoryAdvisor).toBeDefined();
      expect(output.dedupManager).toBeDefined();
      expect(output.rolePackManager).toBeDefined();
      expect(output.sessionManager).toBeDefined();
    });
  });

  // ─── skillManager 复用 ─────────────────────────────────

  describe('skillManager 复用', () => {
    it('existingSkillManager=null 时新建 SkillManager 实例', async () => {
      const output = await assembleComponents(
        createPctx(),
        createInput({ existingSkillManager: null }),
      );
      // 返回值应是新建的 SkillManager 实例
      expect(output.skillManager).toBeInstanceOf(SkillManager);
    });

    it('existingSkillManager 提供时复用同一引用（避免重复 load）', async () => {
      // 首次组装创建 skillManager，二次组装传入已创建的实例应复用
      const first = await assembleComponents(createPctx(), createInput());
      const existing = first.skillManager;

      const second = await assembleComponents(
        createPctx(),
        createInput({ existingSkillManager: existing }),
      );
      // 返回值应严格等于传入引用（=== 引用相等）
      expect(second.skillManager).toBe(existing);
    });
  });

  // ─── 技能可见集两通道同源（回归护栏）─────────────
  //
  // 背景（复核实锤）：同一份「模型可看到的技能集」有两个交付通道 ——
  //   ① L1 枚举 `SkillManager.buildSkillList()`（写进 system prompt）
  //   ② `list_skills` 工具（assembler 注入 toolExec.listSkills 回调，>50 技能时的动态查询）
  // 若禁用过滤只落到 ①、② 仍只过滤 description（自写 filter）——
  // 而该处注释早已自称「两通道过滤标准必须一致」——注释声明与实现不同源，即本仓定义的「伤」。
  // 后果：模型改用 list_skills 时仍能看到并激活已禁用技能，禁用形同虚设且静默。
  //
  // 契约 = 两侧共用唯一真理源 `SkillManager.listAvailable()`；本组直接打真实工具链
  // （assembleComponents → toolExec.execute('list_skills')），确保任一侧回退自写 filter 即变红。

  describe('技能可见集两通道同源（L1 枚举 ≡ list_skills 工具）', () => {
    /**
     * 建一个隔离的技能 home：<home>/skills/ 下 a（有描述）/ b（有描述）/ nodesc（缺描述）
     * @returns 临时 home 绝对路径（调用方负责清理）
     */
    async function makeSkillHome(): Promise<string> {
      const home = await mkdtemp(join(tmpdir(), 'memora-assembler-skillhome-'));
      const dir = join(home, 'skills');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'a.md'), '---\nname: a\ndescription: 技能A\n---\n正文A', 'utf-8');
      writeFileSync(join(dir, 'b.md'), '---\nname: b\ndescription: 技能B\n---\n正文B', 'utf-8');
      // 缺 description：渐进披露层面不可用，两通道都不该出现
      writeFileSync(join(dir, 'nodesc.md'), '---\nname: nodesc\n---\n正文', 'utf-8');
      return home;
    }

    it('禁用技能在 list_skills 工具通道同样不出现（与 L1 枚举同集合）', async () => {
      const home = await makeSkillHome();
      try {
        const output = await assembleComponents(
          createPctx(),
          createInput({ existingSkillManager: new SkillManager(home), disabledSkills: ['a'] }),
        );

        // 通道 ②：真实工具链（execute 分派 → toolExec.listSkills 回调）
        const listed = await output.toolExec.execute('list_skills', '{}');

        // 若此处仍列出 a（工具侧只过滤 description）→ 断言变红
        expect(listed).not.toContain('- a：');
        expect(listed).toContain('- b：');

        // 同源断言：通道 ① 与 ② 必须看到同一集合（判据一旦分叉即双轨镜像）
        const l1 = output.skillManager.buildSkillList();
        expect(l1).not.toContain('- a：');
        expect(l1).toContain('- b：');
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    it('缺 description 的技能在 list_skills 工具通道同样不出现（G22 判据同点）', async () => {
      const home = await makeSkillHome();
      try {
        // 与上例对照：不设禁用集，只留「可用性」一条判据生效
        const output = await assembleComponents(
          createPctx(),
          createInput({ existingSkillManager: new SkillManager(home) }),
        );

        const listed = await output.toolExec.execute('list_skills', '{}');
        expect(listed).not.toContain('nodesc');
        // 同源：两判据都收口在 listAvailable，a/b 仍正常可见（防「一刀切清空」假绿）
        expect(listed).toContain('- a：');
        expect(listed).toContain('- b：');
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  });

  // ─── 配置透传 ──────────────────────────────────────────

  describe('配置透传', () => {
    it('activeRolePack 透传到 RolePackManager.load（角色不存在走降级）', async () => {
      // 传入不存在的 activeRolePack，RolePackManager 应降级到默认角色，组装仍成功
      const output = await assembleComponents(
        createPctx(),
        createInput({ activeRolePack: '不存在的角色包' }),
      );
      // rolePackPrompt 仅内部使用，通过 systemPromptPrefix 间接消费
      expect(output.rolePackManager).toBeDefined();
    });

    it('tracer 注入时组装成功（AgentLoop 接收 tracer）', async () => {
      // 传入 mock tracer，AgentLoop 构造时应接收并存储
      const mockTracer = {
        startSpan: vi.fn().mockReturnValue({
          setAttribute: vi.fn(),
          end: vi.fn(),
          recordException: vi.fn(),
        }),
      };
      const output = await assembleComponents(
        createPctx(),
        createInput({ tracer: mockTracer as unknown as AssembleInput['tracer'] }),
      );
      expect(output.loop).toBeDefined();
    });

    it('enableContextSummary=true 时组装成功', async () => {
      // 开启上下文摘要，AgentLoop 构造时接收
      const output = await assembleComponents(
        createPctx(),
        createInput({ enableContextSummary: true }),
      );
      expect(output.loop).toBeDefined();
    });
  });

  // ─── bootstrapMemories 透传 ────────────────────────────

  describe('bootstrapMemories 透传', () => {
    it('bootstrapMemories 非空时组装成功（AgentLoop 接收）', async () => {
      // 预置启动记忆，AgentLoop 构造时应接收
      const bootstrapMemory: Memory = {
        id: 'test:bootstrap-1',
        content: '用户偏好简洁回复',
        source: 'rule',
        name: 'concise-reply',
        createdAt: '2026-06-27T10:00:00.000Z',
        accessedAt: '2026-06-27T10:00:00.000Z',
      };
      const pctx = createPctx({ bootstrapMemories: [bootstrapMemory] });

      const output = await assembleComponents(pctx, createInput());
      expect(output.loop).toBeDefined();
    });
  });

  // ─── 会议逐步切换 ────────────────────────

  describe('会议逐步切换：getTaskTable 驱动装配视角钩子', () => {
    it('taskTable 每次注入都触发 applyActivePlanItemAssembly，active 任务项推进后仍触发', async () => {
      // 缺陷形态：若装配视角只在 prepare.run 设一次 → 后继 step 换角色不生效。
      // 此测试验证「任务表每轮注入 → applyActivePlanItemAssembly 钩子」的装配导线已接上
      //（真实 Agent 中该钩子由 applyActivePlanItemAssemblyIfChanged 实现换角色；
      //  resolveRoundAssemblyRole / setRoundAssemblyRole 的判定由 rolePackManager.test 会议机制用例覆盖）。
      const applyActivePlanItemAssembly = vi.fn();
      const output = await assembleComponents(
        createPctx(),
        createInput({
          hooks: {
            emit: vi.fn(),
            isChatBusy: () => false,
            requestPause: vi.fn(),
            applyActivePlanItemAssembly,
          },
        }),
      );
      // 建立会话检查点（writePlan 依赖 checkpoint 已建）
      output.sessionManager.createCheckpoint('小组会议：讨论');
      // 预置多步会议计划：组员1 与组员2 各一项（均带 rolePack）
      output.sessionManager.writePlan('overwrite', [
        { description: '组员1发言', rolePack: '组员1' },
        { description: '组员2发言', rolePack: '组员2' },
      ]);
      // 首次注入：应触发钩子（随当前 active step）
      output.loop.getTaskTable!();
      expect(applyActivePlanItemAssembly).toHaveBeenCalledTimes(1);
      // 组员1 发言完成 → 推进到组员2（active step 切换）
      const cp = output.sessionManager.getCheckpoint()!;
      const step1 = cp.plan.find((s) => s.description === '组员1发言')!;
      expect(output.sessionManager.updatePlanItemStatus(step1.id, 'done')).toBe(true);
      // 第二次注入：active step 已推进，钩子仍每轮触发（装配视角可随之切换）
      output.loop.getTaskTable!();
      expect(applyActivePlanItemAssembly).toHaveBeenCalledTimes(2);
    });

    it('无 checkpoint 时 getTaskTable 不触发装配视角钩子（短路）', async () => {
      // 保护性断言：checkpoint 未建立时任务表为空，钩子不应被调用（避免空转）
      const applyActivePlanItemAssembly = vi.fn();
      const output = await assembleComponents(
        createPctx(),
        createInput({
          hooks: {
            emit: vi.fn(),
            isChatBusy: () => false,
            requestPause: vi.fn(),
            applyActivePlanItemAssembly,
          },
        }),
      );
      // 未 createCheckpoint → getCheckpoint 为空 → getTaskTable 返回 '' 且不触发钩子
      expect(output.loop.getTaskTable!()).toBe('');
      expect(applyActivePlanItemAssembly).not.toHaveBeenCalled();
    });
  });

  // ─── 任务表未完成硬约束 ─────────────────────

  describe('任务表未完成硬约束（P3，2026-09-22）', () => {
    it('存在未完成任务项时 getTaskTable 追加「不得收尾」执行约束（首行进度契约不变）', async () => {
      const output = await assembleComponents(
        createPctx(),
        createInput({ hooks: { emit: vi.fn(), isChatBusy: () => false, requestPause: vi.fn() } }),
      );
      output.sessionManager.createCheckpoint('回归：任务表未完成约束');
      output.sessionManager.writePlan('overwrite', [
        { description: '步骤一' },
        { description: '步骤二' },
      ]);
      const table = output.loop.getTaskTable!();
      // 首行 [任务进度: 契约不可变（loop 替换式注入靠此前缀清理旧表）
      expect(table).toContain('[任务进度: 0/2');
      // 未完成 → 追加硬约束（防止 LLM 提前纯文本收尾，真实故障轮实证）
      expect(table).toContain('（执行约束，非历史信息）仍有任务项未标记「已完成」');
      expect(table).toContain('task_table_update');
      // 中止路径必须指向 task_table_update（唯一能改状态的工具：task_table_write 任何 mode 都不改 status）；
      // 且不得残留已废的旧 mode 词与 task_table_write 误引（TASKTABLE-NAME-1 收口：本 nudge 曾写 task_table_write (update)）
      expect(table).toContain('标记为 blocked');
      expect(table).not.toContain('(update)');
      expect(table).not.toContain('task_table_write');
    });

    it('全部任务项 done 时不追加约束（正常收尾不干扰）', async () => {
      const output = await assembleComponents(
        createPctx(),
        createInput({ hooks: { emit: vi.fn(), isChatBusy: () => false, requestPause: vi.fn() } }),
      );
      output.sessionManager.createCheckpoint('回归：任务表全 done');
      output.sessionManager.writePlan('overwrite', [{ description: '单步完成' }]);
      const cp = output.sessionManager.getCheckpoint()!;
      expect(output.sessionManager.updatePlanItemStatus(cp.plan[0]!.id, 'done')).toBe(true);
      const table = output.loop.getTaskTable!();
      expect(table).toContain('已完成');
      expect(table).not.toContain('（执行约束');
    });
  });

  // ─── task_table_update 全链寻址（防 mock 盲区）────────────────

  describe('task_table_update 全链寻址：短 id → 真实 sessionManager 命中', () => {
    async function assembleReal(): Promise<Awaited<ReturnType<typeof assembleComponents>>> {
      return assembleComponents(
        createPctx(),
        createInput({
          hooks: {
            emit: vi.fn(),
            isChatBusy: () => false,
            requestPause: vi.fn(),
          },
        }),
      );
    }

    it('writePlan 返回的 8 位短 id 经 task_table_update 可命中真实任务项（toolExecutor 解析 + 装配 updatePlanItem + sessionManager 全等）', async () => {
      const output = await assembleReal();
      output.sessionManager.createCheckpoint('测试计划');
      const newPlan = output.sessionManager.writePlan('overwrite', [
        { description: '第一步' },
        { description: '第二步' },
      ]);
      // task_table_write 装配层渲染的短 id = uuid 前 8 位（assembler.writePlan 事实源）
      const shortId = newPlan[1]!.id.slice(0, 8);
      const fullId = newPlan[1]!.id;

      const result = await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ plan_item_id: shortId, status: 'blocked' }),
      );

      // 若短 id 透传到 updatePlanItemStatus 全等匹配 → PLAN_ITEM_NOT_FOUND（断链）
      expect(result).toContain('已标记为 blocked');
      const cp = output.sessionManager.getCheckpoint()!;
      expect(cp.plan.find((s) => s.id === fullId)!.status).toBe('blocked');
    });

    it('行首序号经 task_table_update 在真实装配链同样命中（order 与 id 映射一致）', async () => {
      const output = await assembleReal();
      output.sessionManager.createCheckpoint('测试计划');
      const newPlan = output.sessionManager.writePlan('overwrite', [
        { description: '步骤甲' },
        { description: '步骤乙' },
      ]);
      const fullId = newPlan[0]!.id; // #1 = order 0

      const result = await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ plan_item_id: '1', status: 'done' }),
      );

      expect(result).toContain('已标记为 done');
      const cp = output.sessionManager.getCheckpoint()!;
      expect(cp.plan.find((s) => s.id === fullId)!.status).toBe('done');
    });

    it('未知 8 位短 id → PLAN_ITEM_NOT_FOUND 且不触碰任何任务项', async () => {
      const output = await assembleReal();
      output.sessionManager.createCheckpoint('测试计划');
      output.sessionManager.writePlan('overwrite', [{ description: '唯一步骤' }]);

      const result = await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ plan_item_id: 'ffffffff', status: 'done' }),
      );

      expect(result).toContain('[ERR:PLAN_ITEM_NOT_FOUND]');
      const cp = output.sessionManager.getCheckpoint()!;
      expect(cp.plan.every((s) => s.status !== 'done')).toBe(true);
    });

    it('最后一项标 done（≥3 项无验证任务项）→ 工具结果附收尾验证 nudge（ME-10）', async () => {
      const output = await assembleReal();
      output.sessionManager.createCheckpoint('测试计划');
      output.sessionManager.writePlan('overwrite', [
        { description: '实现功能 A' },
        { description: '实现功能 B' },
        { description: '接入调用方' },
      ]);

      // 前两项标 done（每项 done 后 ensureActivePlanItem 自动补位下一个）
      await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ plan_item_id: '1', status: 'done' }),
      );
      await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ plan_item_id: '2', status: 'done' }),
      );
      // 最后一项 done = 宣称完成；无验证任务项 → 命中 nudge
      const finalResult = await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ plan_item_id: '3', status: 'done' }),
      );

      expect(finalResult).toContain('已标记为 done');
      expect(finalResult).toContain('收尾提示');
      expect(finalResult).toContain('task_table_write');
      // 状态真实全 done
      const cp = output.sessionManager.getCheckpoint()!;
      expect(cp.plan.every((s) => s.status === 'done')).toBe(true);
    });

    it('全 done 但已有验证任务项 → 不附 nudge（零打扰）', async () => {
      const output = await assembleReal();
      output.sessionManager.createCheckpoint('测试计划');
      output.sessionManager.writePlan('overwrite', [
        { description: '实现功能 A' },
        { description: '实现功能 B' },
        { description: '验证整体流程可跑通' },
      ]);

      await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ plan_item_id: '1', status: 'done' }),
      );
      await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ plan_item_id: '2', status: 'done' }),
      );
      const finalResult = await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ plan_item_id: '3', status: 'done' }),
      );

      expect(finalResult).toContain('已标记为 done');
      expect(finalResult).not.toContain('收尾提示');
    });
  });
});

// ─── wireRuntimeCallbacks 运行时回调分支 ─────────────────────

describe('assembler · wireRuntimeCallbacks 运行时回调', () => {
  /** 携带可观测 hooks 的组装辅助 */
  function assembleWithHooks(hooks: Partial<AgentHooks> = {}) {
    return assembleComponents(
      createPctx(),
      createInput({
        hooks: {
          emit: vi.fn(),
          isChatBusy: () => false,
          requestPause: vi.fn(),
          ...hooks,
        },
      }),
    );
  }

  it('onPendingQuestion 空列表：不 emit 不暂停（短路）', async () => {
    const emit = vi.fn();
    const requestPause = vi.fn();
    const out = await assembleWithHooks({ emit, requestPause });
    out.loop.onPendingQuestion!([]);
    expect(emit).not.toHaveBeenCalled();
    expect(requestPause).not.toHaveBeenCalled();
  });

  it('onPendingQuestion 有问题：emit questionPending 事件 + requestPause 暂停', async () => {
    const emit = vi.fn();
    const requestPause = vi.fn();
    const out = await assembleWithHooks({ emit, requestPause });
    out.loop.onPendingQuestion!([{ slot: 'ask', question: '确认执行？' }]);
    expect(emit).toHaveBeenCalledWith(AGENT_EVENTS.questionPending, [
      { slot: 'ask', question: '确认执行？' },
    ]);
    expect(requestPause).toHaveBeenCalled();
  });

  it('onPlanItemBoundary：写入当前 active 任务项的 planItemLog（形态②：不改 plan 状态）', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    const plan = out.sessionManager.writePlan('overwrite', [{ description: '步骤一' }]);
    const planItemId = plan[0]!.id;
    // 变更前快照：active 未 done（LLM 未显式 update，边界不得自动推进）
    expect(out.sessionManager.getCheckpoint()!.plan[0]!.status).toBe('active');
    out.loop.onPlanItemBoundary!({ summary: '进展摘要' });
    const cp = out.sessionManager.getCheckpoint()!;
    // active 任务项的 planItemLog 追加了该次推进记录
    expect(cp.planItemLog?.length).toBeGreaterThan(0);
    expect(cp.planItemLog?.[0]?.summary).toBe('进展摘要');
    expect(cp.planItemLog?.[0]?.planItemId).toBe(planItemId);
    // 形态② 契约：边界只写日志不推进——任务项状态保持 active，不被自动 done（推进唯一写者 = task_table_update）
    expect(cp.plan[0]!.status).toBe('active');
  });

  it('getActivePlanItemMeta：有 active 任务项返回 planItemId/title', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    const plan = out.sessionManager.writePlan('overwrite', [{ description: '活动步骤' }]);
    const meta = out.loop.getActivePlanItemMeta!();
    expect(meta).toEqual({ planItemId: plan[0]!.id, title: '活动步骤' });
  });

  it('getActivePlanItemMeta：无 checkpoint 返回 null（短路）', async () => {
    const out = await assembleWithHooks();
    expect(out.loop.getActivePlanItemMeta!()).toBeNull();
  });

  it('hasInflightPlan：装配链上写入计划后为真（存在未完成任务项）', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    // 空 plan → 不在途
    expect(out.loop.hasInflightPlan!()).toBe(false);
    out.sessionManager.writePlan('overwrite', [{ description: '步骤一' }]);
    // 写入后 ensureActivePlanItem 激活首个 pending → 在途
    expect(out.loop.hasInflightPlan!()).toBe(true);
  });

  it('hasInflightPlan：全部 done → 为假（ensureActivePlanItem 场景 3，无 pending/active）', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    const plan = out.sessionManager.writePlan('overwrite', [{ description: '唯一步骤' }]);
    out.sessionManager.updatePlanItemStatus(plan[0]!.id, 'done');
    // 全 done：既无 active 也无 pending → 不在途（区别于「表存在」口径）
    expect(out.loop.hasInflightPlan!()).toBe(false);
  });

  it('planManager.writePlan：返回含任务项摘要与角色标注的渲染结果', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    // 直接触发装配的 planManager（writePlan 分发归 SessionManager）
    const rendered = out.toolExec.planManager!.writePlan('overwrite', [
      { description: '组员发言', rolePack: '组员1' },
    ]);
    expect(rendered).toContain('组员1'); // 角色标注
    expect(rendered).toContain('任务表已更新');
  });

  it('planManager.updatePlanItem：不存在的任务项返回 PLAN_ITEM_NOT_FOUND', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    expect(out.toolExec.planManager!.updatePlanItem('nope', 'done')).toContain(
      '[ERR:PLAN_ITEM_NOT_FOUND]',
    );
  });

  it('planManager.getPlan：无 checkpoint 时返回空计划', async () => {
    const out = await assembleWithHooks();
    expect(out.toolExec.planManager!.getPlan()).toEqual([]);
  });

  it('tracer 注入时 contextPreparer 走非空容量来源分支', async () => {
    const tracer = {
      startSpan: vi
        .fn()
        .mockReturnValue({ setAttribute: vi.fn(), end: vi.fn(), recordException: vi.fn() }),
    } as never;
    const out = await assembleComponents(
      createPctx(),
      createInput({
        tracer: tracer as never,
      }),
    );
    expect(out.contextPreparer).toBeDefined();
    expect(out.memoryInspector).toBeDefined();
  });
});

// ─── buildSystemPromptPrefix · Turn 起始策略注入 ──

describe('buildSystemPromptPrefix · Turn 起始策略', () => {
  it('systemPromptPrefix 含三行边界指令（约束式，非步骤脚本）', () => {
    const prefix = buildSystemPromptPrefix('persona', 'skills', 'zh-CN');
    expect(prefix).toContain('## Turn 起始策略');
    expect(prefix).toContain('需要外部信息时，先调用工具调查再回答，不要凭记忆猜测');
    expect(prefix).toContain('任务需要多步推进时，使用任务表工具规划执行');
    expect(prefix).toContain('简单问题直接回答');
  });

  it('策略段在时间戳之后注入（注意力位），分隔线前收尾', () => {
    const prefix = buildSystemPromptPrefix('persona', 'skills', 'zh-CN');
    const tsIdx = prefix.indexOf('当前时间：');
    const strategyIdx = prefix.indexOf('## Turn 起始策略');
    const sepIdx = prefix.indexOf('\n\n---\n\n');
    expect(tsIdx).toBeGreaterThan(-1);
    expect(strategyIdx).toBeGreaterThan(tsIdx);
    expect(sepIdx).toBeGreaterThan(strategyIdx);
  });
});
