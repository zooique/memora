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
    rolePackTeams: [], // P-6（2026-09-06）：AgentConfig 收敛后必传；直构测试显式空数组
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
    dbPath: join(projectPath, 'memora.db'),
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
      const output = await assembleComponents(createPctx(), createInput({ existingSkillManager: null }));
      // 返回值应是新建的 SkillManager 实例
      expect(output.skillManager).toBeInstanceOf(SkillManager);
    });

    it('existingSkillManager 提供时复用同一引用（避免重复 load）', async () => {
      // 首次组装创建 skillManager，二次组装传入已创建的实例应复用
      const first = await assembleComponents(createPctx(), createInput());
      const existing = first.skillManager;

      const second = await assembleComponents(createPctx(), createInput({ existingSkillManager: existing }));
      // 返回值应严格等于传入引用（=== 引用相等）
      expect(second.skillManager).toBe(existing);
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

  // ─── 会议逐步切换（T1，2026-09-06）────────────────────────

  describe('会议逐步切换：getTaskTable 驱动装配视角钩子', () => {
    it('taskTable 每次注入都触发 applyActiveStepAssembly，active step 推进后仍触发', async () => {
      // 缺口 A 收口：此前装配视角只在 prepare.run 设一次、后继 step 换角色不生效。
      // 此测试验证「任务表每轮注入 → applyActiveStepAssembly 钩子」的装配导线已接上
      //（真实 Agent 中该钩子由 applyActiveStepAssemblyIfChanged 实现换角色；
      //  resolveRoundAssemblyRole / setRoundAssemblyRole 的判定由 rolePackManager.test S5 覆盖）。
      const applyActiveStepAssembly = vi.fn();
      const output = await assembleComponents(
        createPctx(),
        createInput({
          hooks: {
            emit: vi.fn(),
            isChatBusy: () => false,
            requestPause: vi.fn(),
            applyActiveStepAssembly,
          },
        }),
      );
      // 建立会话检查点（writePlan 依赖 checkpoint 已建）
      output.sessionManager.createCheckpoint('小组会议：讨论');
      // 预置多步会议计划：组员1 与组员2 各一步（均带 rolePack）
      output.sessionManager.writePlan('overwrite', [
        { description: '组员1发言', rolePack: '组员1' },
        { description: '组员2发言', rolePack: '组员2' },
      ]);
      // 首次注入：应触发钩子（随当前 active step）
      output.loop.getTaskTable!();
      expect(applyActiveStepAssembly).toHaveBeenCalledTimes(1);
      // 组员1 发言完成 → 推进到组员2（active step 切换）
      const cp = output.sessionManager.getCheckpoint()!;
      const step1 = cp.plan.find((s) => s.description === '组员1发言')!;
      expect(output.sessionManager.updatePlanStepStatus(step1.id, 'done')).toBe(true);
      // 第二次注入：active step 已推进，钩子仍每轮触发（装配视角可随之切换）
      output.loop.getTaskTable!();
      expect(applyActiveStepAssembly).toHaveBeenCalledTimes(2);
    });

    it('无 checkpoint 时 getTaskTable 不触发装配视角钩子（短路）', async () => {
      // 保护性断言：checkpoint 未建立时任务表为空，钩子不应被调用（避免空转）
      const applyActiveStepAssembly = vi.fn();
      const output = await assembleComponents(
        createPctx(),
        createInput({
          hooks: {
            emit: vi.fn(),
            isChatBusy: () => false,
            requestPause: vi.fn(),
            applyActiveStepAssembly,
          },
        }),
      );
      // 未 createCheckpoint → getCheckpoint 为空 → getTaskTable 返回 '' 且不触发钩子
      expect(output.loop.getTaskTable!()).toBe('');
      expect(applyActiveStepAssembly).not.toHaveBeenCalled();
    });
  });

  // ─── task_table_update 全链寻址（2026-09-06 P0 断链修复，防 mock 盲区）────────────────

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

    it('writePlan 返回的 8 位短 id 经 task_table_update 可命中真实步骤（toolExecutor 解析 + 装配 updateStep + sessionManager 全等）', async () => {
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
        JSON.stringify({ step_id: shortId, status: 'blocked' }),
      );

      // 修复前：短 id 透传到 updatePlanStepStatus 全等匹配 → STEP_NOT_FOUND（断链）
      expect(result).toContain('已标记为 blocked');
      const cp = output.sessionManager.getCheckpoint()!;
      expect(cp.plan.find((s) => s.id === fullId)!.status).toBe('blocked');
    });

    it('# 序号经 task_table_update 在真实装配链同样命中（order 与 id 映射一致）', async () => {
      const output = await assembleReal();
      output.sessionManager.createCheckpoint('测试计划');
      const newPlan = output.sessionManager.writePlan('overwrite', [
        { description: '步骤甲' },
        { description: '步骤乙' },
      ]);
      const fullId = newPlan[0]!.id; // #1 = order 0

      const result = await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ step_id: '1', status: 'done' }),
      );

      expect(result).toContain('已标记为 done');
      const cp = output.sessionManager.getCheckpoint()!;
      expect(cp.plan.find((s) => s.id === fullId)!.status).toBe('done');
    });

    it('未知 8 位短 id → STEP_NOT_FOUND 且不触碰任何步骤', async () => {
      const output = await assembleReal();
      output.sessionManager.createCheckpoint('测试计划');
      output.sessionManager.writePlan('overwrite', [{ description: '唯一步骤' }]);

      const result = await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ step_id: 'ffffffff', status: 'done' }),
      );

      expect(result).toContain('[ERR:STEP_NOT_FOUND]');
      const cp = output.sessionManager.getCheckpoint()!;
      expect(cp.plan.every((s) => s.status !== 'done')).toBe(true);
    });

    it('最后一步标 done（≥3 步无验证步骤）→ 工具结果附收尾验证 nudge（ME-10）', async () => {
      const output = await assembleReal();
      output.sessionManager.createCheckpoint('测试计划');
      output.sessionManager.writePlan('overwrite', [
        { description: '实现功能 A' },
        { description: '实现功能 B' },
        { description: '接入调用方' },
      ]);

      // 前两步标 done（每步 done 后 ensureActiveStep 自动补位下一个）
      await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ step_id: '1', status: 'done' }),
      );
      await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ step_id: '2', status: 'done' }),
      );
      // 最后一步 done = 宣称完成；无验证步骤 → 命中 nudge
      const finalResult = await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ step_id: '3', status: 'done' }),
      );

      expect(finalResult).toContain('已标记为 done');
      expect(finalResult).toContain('收尾提示');
      expect(finalResult).toContain('task_table_write');
      // 状态真实全 done
      const cp = output.sessionManager.getCheckpoint()!;
      expect(cp.plan.every((s) => s.status === 'done')).toBe(true);
    });

    it('全 done 但已有验证步骤 → 不附 nudge（零打扰）', async () => {
      const output = await assembleReal();
      output.sessionManager.createCheckpoint('测试计划');
      output.sessionManager.writePlan('overwrite', [
        { description: '实现功能 A' },
        { description: '实现功能 B' },
        { description: '验证整体流程可跑通' },
      ]);

      await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ step_id: '1', status: 'done' }),
      );
      await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ step_id: '2', status: 'done' }),
      );
      const finalResult = await output.toolExec.execute(
        'task_table_update',
        JSON.stringify({ step_id: '3', status: 'done' }),
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
    expect(emit).toHaveBeenCalledWith(AGENT_EVENTS.questionPending, [{ slot: 'ask', question: '确认执行？' }]);
    expect(requestPause).toHaveBeenCalled();
  });

  it('onStepBoundary：写入当前 active 步骤的 stepLog', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    out.sessionManager.writePlan('overwrite', [{ description: '步骤一' }]);
    out.loop.onStepBoundary!({ summary: '进展摘要' });
    const cp = out.sessionManager.getCheckpoint()!;
    // active 步骤的 stepLog 追加了该次推进记录
    expect(cp.stepLog?.length).toBeGreaterThan(0);
    expect(cp.stepLog?.[0]?.summary).toBe('进展摘要');
  });

  it('getActiveStepMeta：有 active 步骤返回 stepId/title', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    const plan = out.sessionManager.writePlan('overwrite', [{ description: '活动步骤' }]);
    const meta = out.loop.getActiveStepMeta!();
    expect(meta).toEqual({ stepId: plan[0]!.id, title: '活动步骤' });
  });

  it('getActiveStepMeta：无 checkpoint 返回 null（短路）', async () => {
    const out = await assembleWithHooks();
    expect(out.loop.getActiveStepMeta!()).toBeNull();
  });

  it('hasInflightPlan：装配链上写入计划后为真（存在未完成步骤）', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    // 空 plan → 不在途
    expect(out.loop.hasInflightPlan!()).toBe(false);
    out.sessionManager.writePlan('overwrite', [{ description: '步骤一' }]);
    // 写入后 ensureActiveStep 激活首个 pending → 在途
    expect(out.loop.hasInflightPlan!()).toBe(true);
  });

  it('hasInflightPlan：全部 done → 为假（ensureActiveStep 场景 3，无 pending/active）', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    const plan = out.sessionManager.writePlan('overwrite', [{ description: '唯一步骤' }]);
    out.sessionManager.updatePlanStepStatus(plan[0]!.id, 'done');
    // 全 done：既无 active 也无 pending → 不在途（区别于「表存在」口径）
    expect(out.loop.hasInflightPlan!()).toBe(false);
  });

  it('planManager.writePlan：返回含步骤摘要与角色标注的渲染结果', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    // 直接触发装配的 planManager（writePlan 分发归 SessionManager）
    const rendered = out.toolExec.planManager!.writePlan('overwrite', [
      { description: '组员发言', rolePack: '组员1' },
    ]);
    expect(rendered).toContain('组员1'); // 角色标注
    expect(rendered).toContain('任务表已更新');
  });

  it('planManager.updateStep：不存在的步骤返回 STEP_NOT_FOUND', async () => {
    const out = await assembleWithHooks();
    out.sessionManager.createCheckpoint('测试计划');
    expect(out.toolExec.planManager!.updateStep('nope', 'done')).toContain('[ERR:STEP_NOT_FOUND]');
  });

  it('planManager.getPlan：无 checkpoint 时返回空计划', async () => {
    const out = await assembleWithHooks();
    expect(out.toolExec.planManager!.getPlan()).toEqual([]);
  });

  it('vectorStore 注入时 memoryInspector 启用混合搜索（setVectorStore 分支）', async () => {
    // 注入 mock vectorStore → assembler 走 setVectorStore 分支
    const vectorStore = { search: vi.fn(), upsert: vi.fn(), delete: vi.fn(), close: vi.fn() } as never;
    const out = await assembleWithHooks();
    const withStore = await assembleComponents(
      createPctx(),
      createInput({ vectorStore }),
    );
    expect(withStore.memoryInspector).toBeDefined();
    expect(out.loop).toBeDefined();
  });

  it('tracer + vectorStore 注入时 contextPreparer 走非空容量来源分支', async () => {
    const vectorStore = { search: vi.fn(), upsert: vi.fn(), delete: vi.fn(), close: vi.fn() } as never;
    const tracer = {
      startSpan: vi.fn().mockReturnValue({ setAttribute: vi.fn(), end: vi.fn(), recordException: vi.fn() }),
    } as never;
    const out = await assembleComponents(
      createPctx(),
      createInput({
        vectorStore,
        tracer: tracer as never,
      }),
    );
    expect(out.contextPreparer).toBeDefined();
    expect(out.memoryInspector).toBeDefined();
  });
});

// ─── buildSystemPromptPrefix · Turn 起始策略注入（2026-09-13，Part 2）──

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
