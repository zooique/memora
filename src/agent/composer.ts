/**
 * 四级补全器（Composer）—— 不中断工作模型的输入解析层
 *
 * 设计文档：docs/根基/不中断工作模型演进.html
 *
 * 三源融合 + 四级补全链，将 SessionEvent 的增量四元组补全为完整的 ResolvedDelta。
 * 每个槽位独立走补全链，缺省时有明确来源。
 *
 * 补全链（槽位级）：
 *   P1 显式输入：event.delta 中用户明确提供的值 → 最高优先级
 *   P2 记忆推断：checkpoint 中已有的值（前序会话状态）→ 上下文延续
 *   P3 系统内置：代码内置默认值 → 兜底策略
 *   P4 暂停询问：以上都无法补全 → 生成澄清问题，暂停等待用户回答
 *
 * 合并规则（与 SessionEvent.delta 对齐）：
 *   - 增量槽引用：如「继续」→ 任务槽引用 currentGoal，不覆盖
 *   - 新值槽覆盖：如用户给出新标准 → 覆盖 standard 槽
 *   - 数组槽追加：如补充资源列表 → 追加到 resource 槽
 */
import { COMPLETION_LEVELS } from '@/agent/types.js';
import type {
  SessionEvent,
  SessionCheckpoint,
  FourTuple,
  Role,
  Standard,
  ResourceState,
  ClarifyQuestion,
  CompletionLevel,
  SlotRef,
  ComposeResult,
  PlanContext,
} from '@/agent/types.js';

/** 系统内置默认值 */
const SYSTEM_DEFAULTS = {
  /** 默认角色 */
  role: { name: 'assistant', description: '通用助手' } satisfies Role,
  /** 默认标准 */
  standard: { quality: '完成', constraints: [] } satisfies Standard,
  /** 默认资源 */
  resource: { documents: [], memories: [], context: '' } satisfies ResourceState,
} as const;

/**
 * 四级补全器
 *
 * 将 SessionEvent 的增量四元组与 SessionCheckpoint 的历史状态融合，
 * 按 P1→P2→P3→P4 链逐级补全每个槽位。
 */
export class Composer {
  /**
   * 补全四元组
   *
   * 对每个槽位独立执行补全链，返回完整 ResolvedDelta。
   * 若有槽位无法补全（到达 P4），返回 needClarify 并暂停。
   *
   * 计划停滞感知：当 planCtx.stalled 为 true 时，
   * 任务槽跳过 P2 记忆推断，直接降级 P4 暂停询问，
   * 避免在计划已完成时盲目延续 currentGoal。
   *
   * @param event - 增量事件（含用户输入和可选 delta）
   * @param checkpoint - 当前会话检查点（含历史状态）
   * @param planCtx - 可选的计划上下文（执行计划管理）
   * @returns 补全结果
   */
  compose(
    event: SessionEvent,
    checkpoint: SessionCheckpoint,
    planCtx?: PlanContext,
  ): ComposeResult {
    const needClarify: ClarifyQuestion[] = [];

    // 每个槽位独立走补全链
    const roleSlot = this.resolveSlot(
      'role',
      event.delta?.role,
      checkpoint.role,
      SYSTEM_DEFAULTS.role,
      needClarify,
    );

    // 任务槽：chat 事件走确定性规则（content 即用户意图，语义判断交给 LLM），
    // 永不触发 P4 澄清——「继续」「帮我写 X」都是自然语言任务，content 已携带；
    // 非 chat 事件（command/correction/clarify）保留原补全链（含停滞时 P4 澄清）。
    const taskSlot =
      event.type === 'chat'
        ? this.resolveChatTaskSlot(event, checkpoint, needClarify)
        : planCtx?.stalled && event.delta?.task === undefined
          ? // 场景：计划已完成/阻塞，用户未明确指定新任务时，
            // 不应盲目延续 currentGoal，而应询问用户下一步方向
            this.resolveStalledTaskSlot(checkpoint.currentGoal, needClarify, planCtx)
          : this.resolveSlot('task', event.delta?.task, checkpoint.currentGoal, '', needClarify);

    const standardSlot = this.resolveSlot(
      'standard',
      event.delta?.standard,
      checkpoint.standard,
      SYSTEM_DEFAULTS.standard,
      needClarify,
    );

    const resourceSlot = this.resolveResourceSlot(event.delta?.resource, checkpoint.resource);

    return {
      resolved: {
        role: roleSlot,
        task: taskSlot,
        standard: standardSlot,
        resource: resourceSlot,
      },
      needClarify: needClarify.length > 0 ? needClarify : undefined,
    };
  }

  /**
   * 判断值是否为 SlotRef 引用标记
   *
   * @param value - 待判断的值
   * @returns 是否为 SlotRef
   */
  private isSlotRef(value: unknown): value is SlotRef {
    return (
      typeof value === 'object' &&
      value !== null &&
      'ref' in value &&
      typeof (value as SlotRef).ref === 'string'
    );
  }

  /**
   * 解析单个槽位（通用槽位：role/task/standard）
   *
   * 补全链：
   *   P1: event.delta 中有显式值 → 使用（若是 SlotRef 引用标记 → 走引用模式）
   *   P2: checkpoint 中有历史值 → 延续
   *   P3: 系统内置默认值 → 兜底
   *   P4: 都无法补全 → 生成澄清问题
   *
   * @param slotName - 槽位名称
   * @param deltaValue - 事件增量中的值（支持 SlotRef 引用标记）
   * @param checkpointValue - 检查点中的历史值
   * @param defaultVal - 系统内置默认值
   * @param needClarify - 澄清问题收集数组
   * @returns 补全后的槽位值及来源
   */
  private resolveSlot<T>(
    slotName: keyof FourTuple,
    deltaValue: T | SlotRef | undefined,
    checkpointValue: T | undefined,
    defaultVal: T,
    needClarify: ClarifyQuestion[],
  ): { value: T; source: CompletionLevel } {
    // P1: 显式输入
    if (deltaValue !== undefined) {
      // 处理 SlotRef 引用标记：如 { ref: 'currentGoal' } → 引用 checkpoint 值，不覆盖
      if (this.isSlotRef(deltaValue)) {
        // 引用标记：从 checkpoint 取历史值（P2 语义），不覆盖
        if (checkpointValue !== undefined && !this.isEmpty(checkpointValue)) {
          return { value: checkpointValue, source: COMPLETION_LEVELS.P2_MEMORY };
        }
        // 引用标记但 checkpoint 为空 → 走 P3 兜底
        if (defaultVal !== undefined && !this.isEmpty(defaultVal)) {
          return { value: defaultVal, source: COMPLETION_LEVELS.P3_BUILTIN };
        }
        // 引用标记且无兜底 → P4 暂停询问
        needClarify.push({
          slot: slotName,
          question: this.clarifyQuestionFor(slotName),
        });
        return { value: defaultVal, source: COMPLETION_LEVELS.P4_CLARIFY };
      }
      // 非引用标记：新值槽覆盖模式
      return { value: deltaValue, source: COMPLETION_LEVELS.P1_EXPLICIT };
    }

    // P2: 记忆推断（检查点历史值）
    if (checkpointValue !== undefined && !this.isEmpty(checkpointValue)) {
      return { value: checkpointValue, source: COMPLETION_LEVELS.P2_MEMORY };
    }

    // P3: 系统内置
    if (defaultVal !== undefined && !this.isEmpty(defaultVal)) {
      return { value: defaultVal, source: COMPLETION_LEVELS.P3_BUILTIN };
    }

    // P4: 暂停询问
    needClarify.push({
      slot: slotName,
      question: this.clarifyQuestionFor(slotName),
    });
    // 返回空值占位，调用方检查 needClarify 后暂停
    return { value: defaultVal, source: COMPLETION_LEVELS.P4_CLARIFY };
  }

  /**
   * 解析资源槽位（特殊处理：数组追加语义）
   *
   * 与通用槽位不同，资源槽的 delta 采用追加语义：
   * - P1: delta 中的新资源（非 SlotRef）→ 追加到现有资源列表，不覆盖
   * - P1: delta 为 SlotRef 引用标记 → 引用 checkpoint 资源，不追加
   * - P2: 检查点历史资源 → 延续
   * - P3: 空资源 → 兜底
   */
  private resolveResourceSlot(
    deltaResource: Partial<ResourceState> | SlotRef | undefined,
    checkpointResource: ResourceState | undefined,
  ): { value: ResourceState; source: CompletionLevel } {
    // P1: 显式输入
    if (deltaResource !== undefined) {
      // 处理 SlotRef 引用标记：引用 checkpoint 资源，不追加
      if (this.isSlotRef(deltaResource)) {
        if (checkpointResource !== undefined) {
          return { value: checkpointResource, source: COMPLETION_LEVELS.P2_MEMORY };
        }
        return { value: SYSTEM_DEFAULTS.resource, source: COMPLETION_LEVELS.P3_BUILTIN };
      }

      // 非引用标记：追加语义（数组追加，context 覆盖）
      const base = checkpointResource ?? SYSTEM_DEFAULTS.resource;
      return {
        value: {
          documents: [...base.documents, ...(deltaResource.documents ?? [])],
          memories: [...base.memories, ...(deltaResource.memories ?? [])],
          context: deltaResource.context ?? base.context,
        },
        source: COMPLETION_LEVELS.P1_EXPLICIT,
      };
    }

    // P2: 记忆推断
    if (checkpointResource !== undefined) {
      return { value: checkpointResource, source: COMPLETION_LEVELS.P2_MEMORY };
    }

    // P3: 系统内置
    return { value: SYSTEM_DEFAULTS.resource, source: COMPLETION_LEVELS.P3_BUILTIN };
  }

  /**
   * 判断值是否为空
   *
   * 空字符串、空数组视为空，undefined 视为空。
   */
  private isEmpty(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
  }

  /**
   * 解析 chat 事件的任务槽（确定性规则，不做语义判断）
   *
   * chat 事件的 content 即用户此刻的意图——「继续」「改成那样」「帮我写总结」都是
   * 自然语言任务描述。代码只做确定性补全，不做「这是新任务还是继续」的语义判断：
   *   - delta.task 显式提供（含 SlotRef）：走通用补全链（P1/P2/P3/P4）
   *   - 检查点已有目标（currentGoal 非空）：P2 延续，不覆盖
   *     （「继续」类增量直接引用 currentGoal，避免 content 误覆盖目标）
   *   - 检查点无目标（新会话/目标清空）：以 content 为初始目标（P1 显式）
   * 永不因「无任务槽」触发 P4 澄清——内容是否需要澄清属语义判断，由 LLM 在对话流中完成。
   *
   * @param event - 增量事件（chat 类型）
   * @param checkpoint - 当前会话检查点
   * @param needClarify - 澄清问题收集数组（仅 SlotRef 引用不存在时可能产生）
   * @returns 补全结果
   */
  private resolveChatTaskSlot(
    event: SessionEvent,
    checkpoint: SessionCheckpoint,
    needClarify: ClarifyQuestion[],
  ): { value: string; source: CompletionLevel } {
    // P1: 显式 delta.task（结构化任务）优先，走通用补全链（含 SlotRef 处理）
    if (event.delta?.task !== undefined) {
      return this.resolveSlot('task', event.delta.task, checkpoint.currentGoal, '', needClarify);
    }
    // 已有目标：P2 延续（不覆盖，「继续」类增量直接引用 currentGoal）
    if (checkpoint.currentGoal && checkpoint.currentGoal.trim().length > 0) {
      return { value: checkpoint.currentGoal, source: COMPLETION_LEVELS.P2_MEMORY };
    }
    // 无目标：以 chat 内容为初始目标（P1 显式）
    return { value: event.content, source: COMPLETION_LEVELS.P1_EXPLICIT };
  }

  /**
   * 解析停滞状态下的任务槽（执行计划管理）
   *
   * 当计划停滞时，任务槽跳过 P2 记忆推断，直接生成 P4 澄清问题。
   * 问题包含当前活跃步骤和待处理步骤信息，辅助用户决策。
   * 仅当 event.delta.task 未提供（无显式任务指定）时触发。
   *
   * @param currentGoal - 检查点当前目标（用于兜底）
   * @param needClarify - 澄清问题收集数组
   * @param planCtx - 计划上下文
   * @returns 补全结果（P4 级别）
   */
  private resolveStalledTaskSlot(
    currentGoal: string,
    needClarify: ClarifyQuestion[],
    planCtx: PlanContext,
  ): { value: string; source: CompletionLevel } {
    // 构建包含上下文信息的澄清问题
    const contextParts: string[] = [];
    if (planCtx.activeStep) {
      contextParts.push(`当前步骤：${planCtx.activeStep}`);
    }
    if (planCtx.pendingStep) {
      contextParts.push(`待处理：${planCtx.pendingStep}`);
    }

    const contextHint = contextParts.length > 0 ? `（${contextParts.join('；')}）` : '';
    const question = `所有计划步骤已完成${contextHint}，请指示下一步方向`;

    needClarify.push({
      slot: 'task',
      question,
    });

    // 返回 currentGoal 作为占位值，调用方检查 needClarify 后暂停
    return { value: currentGoal, source: COMPLETION_LEVELS.P4_CLARIFY };
  }

  /**
   * 生成槽位澄清问题
   */
  private clarifyQuestionFor(slot: keyof FourTuple): string {
    const questions: Record<keyof FourTuple, string> = {
      role: '请指定 Agent 角色（如：开发者、审查者、旅行规划师）',
      task: '请描述当前任务目标',
      standard: '请指定完成标准（如：代码必须通过所有测试）',
      resource: '请提供相关资源（文档路径、参考记忆等）',
    };
    return questions[slot];
  }
}
