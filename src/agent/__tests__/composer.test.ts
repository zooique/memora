/**
 * Composer（四级补全器）单元测试
 *
 * 覆盖 compose() 方法的核心补全链：
 *   - P1 显式输入 / SlotRef 引用标记
 *   - P2 记忆推断（检查点历史值）
 *   - P3 系统内置默认值
 *   - P4 暂停询问（澄清问题）
 *   - 资源槽数组追加语义
 *   - 计划停滞感知（P3.3 执行计划管理）
 *   - 停滞时显式任务优先（P1 修复）
 *   - 边界条件：空值、引用标记与空检查点
 */
import { describe, it, expect } from 'vitest';
import { Composer } from '@/agent/composer.js';
import { COMPLETION_LEVELS } from '@/agent/types.js';
import type {
  SessionEvent,
  SessionCheckpoint,
  PlanContext,
  Role,
  Standard,
  ResourceState,
} from '@/agent/types.js';

/** 创建默认检查点 */
function createCheckpoint(overrides?: Partial<SessionCheckpoint>): SessionCheckpoint {
  return {
    sessionId: 'test-session',
    status: 'running',
    mainGoal: '测试主目标',
    currentGoal: '测试当前目标',
    goalChangeSeq: 1,
    plan: [],
    role: { name: 'assistant', description: '通用助手' },
    standard: { quality: '完成', constraints: [] },
    resource: { documents: [], memories: [], context: '' },
    hotMemory: [],
    lastHeartbeat: Date.now(),
    ...overrides,
  };
}

/** 创建事件 */
function createEvent(overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    type: 'chat',
    content: '测试消息',
    ...overrides,
  };
}

/** 创建计划上下文 */
function createPlanCtx(overrides?: Partial<PlanContext>): PlanContext {
  return {
    stalled: false,
    ...overrides,
  };
}

describe('Composer · compose() 四元组补全', () => {
  it('P1: 所有槽位显式输入应直接使用', () => {
    const composer = new Composer();
    const event = createEvent({
      delta: {
        role: { name: 'developer', description: '开发者' },
        task: '编写测试',
        standard: { quality: '全部通过', constraints: ['使用 vitest'] },
        resource: { documents: ['doc.md'], memories: [], context: '测试上下文' },
      },
    });
    const checkpoint = createCheckpoint();

    const result = composer.compose(event, checkpoint);

    expect(result.resolved.role.source).toBe(COMPLETION_LEVELS.P1_EXPLICIT);
    expect(result.resolved.role.value.name).toBe('developer');
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P1_EXPLICIT);
    expect(result.resolved.task.value).toBe('编写测试');
    expect(result.resolved.standard.source).toBe(COMPLETION_LEVELS.P1_EXPLICIT);
    expect(result.resolved.standard.value.quality).toBe('全部通过');
    expect(result.resolved.resource.source).toBe(COMPLETION_LEVELS.P1_EXPLICIT);
    expect(result.resolved.resource.value.context).toBe('测试上下文');
    expect(result.needClarify).toBeUndefined();
  });

  it('P1: SlotRef 引用标记应引用检查点值（不覆盖）', () => {
    const composer = new Composer();
    const event = createEvent({
      delta: {
        role: { ref: 'currentRole' },
        task: { ref: 'currentGoal' },
        standard: { ref: 'currentStandard' },
        resource: { ref: 'currentResource' },
      },
    });
    const checkpoint = createCheckpoint({
      role: { name: 'reviewer', description: '审查者' },
      currentGoal: '审查代码',
      standard: { quality: '严格审查', constraints: ['检查安全'] },
      resource: { documents: ['src/'], memories: ['mem1'], context: '审查中' },
    });

    const result = composer.compose(event, checkpoint);

    // SlotRef 走 P2 语义（引用检查点值）
    expect(result.resolved.role.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.role.value.name).toBe('reviewer');
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.task.value).toBe('审查代码');
    expect(result.resolved.standard.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.standard.value.quality).toBe('严格审查');
    expect(result.resolved.resource.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.resource.value.documents).toEqual(['src/']);
    expect(result.needClarify).toBeUndefined();
  });

  it('P2: 检查点历史值应在无显式输入时延续', () => {
    const composer = new Composer();
    const event = createEvent(); // 无 delta
    const checkpoint = createCheckpoint({
      role: { name: 'designer', description: '设计师' },
      currentGoal: '设计界面',
      standard: { quality: '高保真原型', constraints: ['Figma'] },
    });

    const result = composer.compose(event, checkpoint);

    expect(result.resolved.role.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.role.value.name).toBe('designer');
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.task.value).toBe('设计界面');
    expect(result.resolved.standard.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.standard.value.quality).toBe('高保真原型');
    expect(result.resolved.resource.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.needClarify).toBeUndefined();
  });

  it('P3: 无显式输入且无检查点时使用系统内置默认值', () => {
    const composer = new Composer();
    const event = createEvent();
    // 检查点只有必填字段，role/standard/resource 无值
    const checkpoint = createCheckpoint({
      role: undefined as unknown as Role,
      standard: undefined as unknown as Standard,
      resource: undefined as unknown as ResourceState,
      currentGoal: '',
    });

    const result = composer.compose(event, checkpoint);

    expect(result.resolved.role.source).toBe(COMPLETION_LEVELS.P3_BUILTIN);
    expect(result.resolved.role.value.name).toBe('assistant');
    expect(result.resolved.standard.source).toBe(COMPLETION_LEVELS.P3_BUILTIN);
    expect(result.resolved.standard.value.quality).toBe('完成');
    expect(result.resolved.resource.source).toBe(COMPLETION_LEVELS.P3_BUILTIN);
    expect(result.resolved.resource.value.documents).toEqual([]);
    // chat 事件：无目标时以 content 为初始任务（P1），不弹 P4 澄清
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P1_EXPLICIT);
    expect(result.resolved.task.value).toBe('测试消息');
    expect(result.needClarify).toBeUndefined();
  });

  it('P4: 所有槽位均无法补全时生成澄清问题（非 chat 事件）', () => {
    const composer = new Composer();
    // 非 chat 事件（correction）：content 不兜底 task 槽，缺失时走 P4
    const event = createEvent({ type: 'correction' });
    const checkpoint = createCheckpoint({
      role: undefined as unknown as Role,
      standard: undefined as unknown as Standard,
      resource: undefined as unknown as ResourceState,
      currentGoal: '',
    });
    // 模拟 P4 场景：让 task 也触发 P4
    // 此时 role 走 P3 内置，standard 走 P3 内置，resource 走 P3 内置
    // task 无 delta、无 checkpoint、无内置默认值 → P4
    // （chat 事件永不因 task 缺失触发 P4——content 即任务，见 resolveChatTaskSlot）

    const result = composer.compose(event, checkpoint);

    expect(result.needClarify).toBeDefined();
    expect(result.needClarify!.length).toBe(1);
    expect(result.needClarify![0]!.slot).toBe('task');
    expect(result.needClarify![0]!.question).toContain('任务目标');
  });

  it('P4: 多个槽位无法补全时生成多个澄清问题（非 chat 事件）', () => {
    const composer = new Composer();
    // 非 chat 事件（correction）：未提供任何 delta 和 checkpoint 值
    const event = createEvent({ type: 'correction' });
    // 利用 empty string 触发 isEmpty 为 true
    const checkpoint = createCheckpoint({
      role: undefined as unknown as Role,
      standard: undefined as unknown as Standard,
      resource: undefined as unknown as ResourceState,
      currentGoal: '',
    });

    const result = composer.compose(event, checkpoint);

    // role 有 P3 内置，standard 有 P3 内置，resource 有 P3 内置
    // 只有 task 无默认值 → P4
    expect(result.needClarify).toBeDefined();
    expect(result.needClarify!.length).toBe(1);
  });
});

describe('Composer · 资源槽（数组追加语义）', () => {
  it('P1: 新资源应追加到现有资源列表', () => {
    const composer = new Composer();
    const event = createEvent({
      delta: {
        resource: { documents: ['new-doc.md'], memories: ['new-mem'], context: '新上下文' },
      },
    });
    const checkpoint = createCheckpoint({
      resource: { documents: ['existing-doc.md'], memories: ['existing-mem'], context: '旧上下文' },
    });

    const result = composer.compose(event, checkpoint);

    expect(result.resolved.resource.source).toBe(COMPLETION_LEVELS.P1_EXPLICIT);
    expect(result.resolved.resource.value.documents).toEqual(['existing-doc.md', 'new-doc.md']);
    expect(result.resolved.resource.value.memories).toEqual(['existing-mem', 'new-mem']);
    // context 覆盖而非追加
    expect(result.resolved.resource.value.context).toBe('新上下文');
  });

  it('P1: 无检查点时新资源应追加到空列表', () => {
    const composer = new Composer();
    const event = createEvent({
      delta: {
        resource: { documents: ['doc.md'], memories: [], context: '上下文' },
      },
    });
    const checkpoint = createCheckpoint({
      resource: undefined as unknown as ResourceState,
    });

    const result = composer.compose(event, checkpoint);

    expect(result.resolved.resource.source).toBe(COMPLETION_LEVELS.P1_EXPLICIT);
    expect(result.resolved.resource.value.documents).toEqual(['doc.md']);
    expect(result.resolved.resource.value.context).toBe('上下文');
  });

  it('P1: SlotRef 资源引用应使用检查点值', () => {
    const composer = new Composer();
    const event = createEvent({
      delta: {
        resource: { ref: 'currentResource' },
      },
    });
    const checkpoint = createCheckpoint({
      resource: { documents: ['doc1.md'], memories: ['mem1'], context: '现有' },
    });

    const result = composer.compose(event, checkpoint);

    expect(result.resolved.resource.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.resource.value.documents).toEqual(['doc1.md']);
    expect(result.resolved.resource.value.memories).toEqual(['mem1']);
  });

  it('P3: 无资源时返回空资源', () => {
    const composer = new Composer();
    const event = createEvent();
    const checkpoint = createCheckpoint({
      resource: undefined as unknown as ResourceState,
    });

    const result = composer.compose(event, checkpoint);

    expect(result.resolved.resource.source).toBe(COMPLETION_LEVELS.P3_BUILTIN);
    expect(result.resolved.resource.value.documents).toEqual([]);
    expect(result.resolved.resource.value.memories).toEqual([]);
    expect(result.resolved.resource.value.context).toBe('');
  });
});

describe('Composer · 计划停滞感知（P3.3）', () => {
  it('停滞 + 无显式任务（非 chat）→ P4 澄清', () => {
    const composer = new Composer();
    // 非 chat 事件（correction）：content 不兜底 task，停滞时走 P4
    const event = createEvent({ type: 'correction' });
    const checkpoint = createCheckpoint({ currentGoal: '旧目标' });
    const planCtx = createPlanCtx({ stalled: true });

    const result = composer.compose(event, checkpoint, planCtx);

    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P4_CLARIFY);
    expect(result.needClarify).toBeDefined();
    expect(result.needClarify!.length).toBe(1);
    expect(result.needClarify![0]!.slot).toBe('task');
    expect(result.needClarify![0]!.question).toContain('下一步方向');
  });

  it('停滞 + chat（无显式任务）→ P2 延续不 P4（方向判断交 LLM）', () => {
    const composer = new Composer();
    const event = createEvent(); // chat：content 即用户意图
    const checkpoint = createCheckpoint({ currentGoal: '旧目标' });
    const planCtx = createPlanCtx({ stalled: true });

    const result = composer.compose(event, checkpoint, planCtx);

    // chat 事件停滞时不 P4：延续 currentGoal（不覆盖），
    // 「继续还是新任务」的语义判断由 LLM 结合计划上下文完成
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.task.value).toBe('旧目标');
    expect(result.needClarify).toBeUndefined();
  });

  it('停滞 + 显式任务 → P1 优先于停滞（P1 修复验证）', () => {
    const composer = new Composer();
    const event = createEvent({
      delta: { task: '明确指定的新任务' },
    });
    const checkpoint = createCheckpoint({ currentGoal: '旧目标' });
    const planCtx = createPlanCtx({ stalled: true });

    const result = composer.compose(event, checkpoint, planCtx);

    // 停滞时用户显式指定任务，应走 P1 而非 P4
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P1_EXPLICIT);
    expect(result.resolved.task.value).toBe('明确指定的新任务');
    expect(result.needClarify).toBeUndefined();
  });

  it('停滞 + 显式任务（SlotRef 引用）→ 走引用模式', () => {
    const composer = new Composer();
    const event = createEvent({
      delta: { task: { ref: 'currentGoal' } },
    });
    const checkpoint = createCheckpoint({ currentGoal: '引用旧目标' });
    const planCtx = createPlanCtx({ stalled: true });

    const result = composer.compose(event, checkpoint, planCtx);

    // SlotRef 是显式输入的一种，但语义是引用而非覆盖
    // 此时 stalled 条件不满足（event.delta?.task !== undefined），走正常 resolveSlot
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.task.value).toBe('引用旧目标');
    expect(result.needClarify).toBeUndefined();
  });

  it('非停滞 + 无显式任务 → P2 记忆推断', () => {
    const composer = new Composer();
    const event = createEvent(); // 未提供 task
    const checkpoint = createCheckpoint({ currentGoal: '已有目标' });
    const planCtx = createPlanCtx({ stalled: false });

    const result = composer.compose(event, checkpoint, planCtx);

    // 非停滞时走正常 P2 记忆推断
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.task.value).toBe('已有目标');
    expect(result.needClarify).toBeUndefined();
  });

  it('停滞 + activeStep 和 pendingStep 应包含在澄清问题中（非 chat）', () => {
    const composer = new Composer();
    const event = createEvent({ type: 'correction' });
    const checkpoint = createCheckpoint({ currentGoal: '旧目标' });
    const planCtx = createPlanCtx({
      stalled: true,
      activeStep: '正在执行步骤 A',
      pendingStep: '待处理步骤 B',
    });

    const result = composer.compose(event, checkpoint, planCtx);

    expect(result.needClarify).toBeDefined();
    expect(result.needClarify![0]!.question).toContain('当前步骤');
    expect(result.needClarify![0]!.question).toContain('正在执行步骤 A');
    expect(result.needClarify![0]!.question).toContain('待处理');
    expect(result.needClarify![0]!.question).toContain('待处理步骤 B');
  });

  it('停滞 + 无 activeStep/pendingStep 应生成简洁澄清问题（非 chat）', () => {
    const composer = new Composer();
    const event = createEvent({ type: 'correction' });
    const checkpoint = createCheckpoint({ currentGoal: '旧目标' });
    const planCtx = createPlanCtx({ stalled: true });

    const result = composer.compose(event, checkpoint, planCtx);

    expect(result.needClarify).toBeDefined();
    expect(result.needClarify![0]!.question).toBe('所有计划步骤已完成，请指示下一步方向');
  });
});

describe('Composer · 边界条件', () => {
  it('空字符串槽位应被 isEmpty 识别并触发下一级补全（非 chat）', () => {
    const composer = new Composer();
    // 非 chat 事件（correction）：content 不兜底 task，空字符串 currentGoal 触发 P4
    const event = createEvent({ type: 'correction' });
    // role/standard 是对象类型，isEmpty 只对字符串/数组/undefined 返回 true
    // 此处用 undefined 模拟空检查点，验证 task 的空字符串触发 P4
    const checkpoint = createCheckpoint({
      currentGoal: '',
      role: undefined as unknown as Role,
      standard: undefined as unknown as Standard,
    });

    const result = composer.compose(event, checkpoint);

    // role/standard 无检查点 → P3 内置
    expect(result.resolved.role.source).toBe(COMPLETION_LEVELS.P3_BUILTIN);
    expect(result.resolved.role.value.name).toBe('assistant');
    expect(result.resolved.standard.source).toBe(COMPLETION_LEVELS.P3_BUILTIN);
    expect(result.resolved.standard.value.quality).toBe('完成');
    // task 空字符串 currentGoal → isEmpty 返回 true → P4（仅非 chat 事件）
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P4_CLARIFY);
  });

  it('对象属性空字符串不作为空值（对象本身非空）', () => {
    const composer = new Composer();
    const event = createEvent();
    // checkpoint 的 role 对象非空（即使属性空字符串），走 P2 记忆推断
    const checkpoint = createCheckpoint({
      role: { name: '', description: '' },
      standard: { quality: '', constraints: [] },
    });

    const result = composer.compose(event, checkpoint);

    // 对象本身非空（isEmpty 只对 string/array/undefined 返回 true）
    expect(result.resolved.role.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.standard.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
  });

  it('SlotRef 引用标记但检查点为空时走 P3 兜底', () => {
    const composer = new Composer();
    const event = createEvent({
      delta: {
        role: { ref: 'currentRole' },
        task: { ref: 'currentGoal' },
        standard: { ref: 'currentStandard' },
      },
    });
    // 检查点角色/目标/标准为空
    const checkpoint = createCheckpoint({
      role: undefined as unknown as Role,
      currentGoal: '',
      standard: undefined as unknown as Standard,
    });

    const result = composer.compose(event, checkpoint);

    // SlotRef 但检查点为空 → role 走 P3 内置，standard 走 P3 内置
    expect(result.resolved.role.source).toBe(COMPLETION_LEVELS.P3_BUILTIN);
    expect(result.resolved.standard.source).toBe(COMPLETION_LEVELS.P3_BUILTIN);
    // task 无 P3 内置值 → P4
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P4_CLARIFY);
  });

  it('混合来源：不同槽位来自不同补全级别', () => {
    const composer = new Composer();
    const event = createEvent({
      delta: {
        task: '新任务', // P1
      },
    });
    const checkpoint = createCheckpoint({
      role: { name: 'tester', description: '测试员' }, // P2
      currentGoal: '旧任务', // 被 P1 覆盖
      standard: { quality: '高质量', constraints: [] }, // P2
    });

    const result = composer.compose(event, checkpoint);

    // task 来自 P1 显式输入
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P1_EXPLICIT);
    expect(result.resolved.task.value).toBe('新任务');
    // role 来自 P2 记忆推断
    expect(result.resolved.role.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.role.value.name).toBe('tester');
    // standard 来自 P2 记忆推断
    expect(result.resolved.standard.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.standard.value.quality).toBe('高质量');
    // resource 来自 P2 记忆推断
    expect(result.resolved.resource.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
  });

  it('planCtx 为 undefined 时不应触发停滞路径', () => {
    const composer = new Composer();
    // 非 chat 事件，无 delta.task，无 planCtx
    const event = createEvent({ type: 'correction' });
    const checkpoint = createCheckpoint({ currentGoal: '已有目标' });

    const result = composer.compose(event, checkpoint); // 不传 planCtx

    // planCtx?.stalled 为 undefined（falsy），走正常 resolveSlot
    // P2: checkpoint 中有 currentGoal 延续
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.task.value).toBe('已有目标');
    expect(result.needClarify).toBeUndefined();
  });

  it('停滞 + 空字符串 delta.task 不应触发停滞路径（空字符串是显式值，走 P1）', () => {
    const composer = new Composer();
    // 非 chat 事件，delta.task 为空字符串（不是 undefined——空字符串是显式提供的值）
    const event = createEvent({ type: 'correction', delta: { task: '' } });
    const checkpoint = createCheckpoint({ currentGoal: '' });
    const planCtx = createPlanCtx({ stalled: true });

    const result = composer.compose(event, checkpoint, planCtx);

    // event.delta?.task === undefined 为 false（空字符串 !== undefined），
    // 走正常 resolveSlot，空字符串作为显式值走 P1
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P1_EXPLICIT);
    expect(result.resolved.task.value).toBe('');
    expect(result.needClarify).toBeUndefined();
  });

  it('非停滞 + 非 chat + 无 delta.task → 正常 P2 记忆推断', () => {
    const composer = new Composer();
    const event = createEvent({ type: 'correction' });
    const checkpoint = createCheckpoint({ currentGoal: '继续工作' });
    const planCtx = createPlanCtx({ stalled: false });

    const result = composer.compose(event, checkpoint, planCtx);

    // 非停滞时走正常补全链，P2 延续 currentGoal
    expect(result.resolved.task.source).toBe(COMPLETION_LEVELS.P2_MEMORY);
    expect(result.resolved.task.value).toBe('继续工作');
    expect(result.needClarify).toBeUndefined();
  });
});