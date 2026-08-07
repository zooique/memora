/**
 * 四级补全器（Composer）—— 不中断工作模型的输入解析层
 *
 * 设计文档：docs/根基/不中断工作模型演进.html §05
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
import type {
  SessionEvent,
  SessionCheckpoint,
  FourTuple,
  Role,
  Standard,
  ResourceState,
  ResolvedDelta,
  ClarifyQuestion,
  CompletionLevel,
} from '@/agent/types.js';

/** Composer 输出 */
export interface ComposeResult {
  /** 已解析的四元组增量 */
  resolved: ResolvedDelta;
  /** 需要澄清的问题（仅 P4 级别时非空，此时应暂停等待用户回答） */
  needClarify?: ClarifyQuestion[];
}

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
   * @param event - 增量事件（含用户输入和可选 delta）
   * @param checkpoint - 当前会话检查点（含历史状态）
   * @returns 补全结果
   */
  compose(event: SessionEvent, checkpoint: SessionCheckpoint): ComposeResult {
    const needClarify: ClarifyQuestion[] = [];

    // 每个槽位独立走补全链
    const roleSlot = this.resolveSlot(
      'role',
      event.delta?.role,
      checkpoint.role,
      SYSTEM_DEFAULTS.role,
      needClarify,
    );

    const taskSlot = this.resolveSlot(
      'task',
      event.delta?.task,
      checkpoint.currentGoal,
      '',
      needClarify,
    );

    const standardSlot = this.resolveSlot(
      'standard',
      event.delta?.standard,
      checkpoint.standard,
      SYSTEM_DEFAULTS.standard,
      needClarify,
    );

    const resourceSlot = this.resolveResourceSlot(
      event.delta?.resource,
      checkpoint.resource,
    );

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
   * 解析单个槽位（通用槽位：role/task/standard）
   *
   * 补全链：
   *   P1: event.delta 中有显式值 → 使用
   *   P2: checkpoint 中有历史值 → 延续
   *   P3: 系统内置默认值 → 兜底
   *   P4: 都无法补全 → 生成澄清问题
   *
   * @param slotName - 槽位名称
   * @param deltaValue - 事件增量中的值
   * @param checkpointValue - 检查点中的历史值
   * @param defaultVal - 系统内置默认值
   * @param needClarify - 澄清问题收集数组
   * @returns 补全后的槽位值及来源
   */
  private resolveSlot<T>(
    slotName: keyof FourTuple,
    deltaValue: T | undefined,
    checkpointValue: T | undefined,
    defaultVal: T,
    needClarify: ClarifyQuestion[],
  ): { value: T; source: CompletionLevel } {
    // P1: 显式输入
    if (deltaValue !== undefined) {
      return { value: deltaValue, source: 'P1-explicit' };
    }

    // P2: 记忆推断（检查点历史值）
    if (checkpointValue !== undefined && !this.isEmpty(checkpointValue)) {
      return { value: checkpointValue, source: 'P2-memory' };
    }

    // P3: 系统内置
    if (defaultVal !== undefined && !this.isEmpty(defaultVal)) {
      return { value: defaultVal, source: 'P3-builtin' };
    }

    // P4: 暂停询问
    needClarify.push({
      slot: slotName,
      question: this.clarifyQuestionFor(slotName),
    });
    // 返回空值占位，调用方检查 needClarify 后暂停
    return { value: defaultVal, source: 'P4-clarify' };
  }

  /**
   * 解析资源槽位（特殊处理：数组追加语义）
   *
   * 与通用槽位不同，资源槽的 delta 采用追加语义：
   * - P1: delta 中的新资源 → 追加到现有资源列表
   * - P2: 检查点历史资源 → 延续
   * - P3: 空资源 → 兜底
   */
  private resolveResourceSlot(
    deltaResource: Partial<ResourceState> | undefined,
    checkpointResource: ResourceState | undefined,
  ): { value: ResourceState; source: CompletionLevel } {
    // P1: 显式输入（追加语义）
    if (deltaResource !== undefined) {
      const base = checkpointResource ?? SYSTEM_DEFAULTS.resource;
      return {
        value: {
          documents: [...base.documents, ...(deltaResource.documents ?? [])],
          memories: [...base.memories, ...(deltaResource.memories ?? [])],
          context: deltaResource.context ?? base.context,
        },
        source: 'P1-explicit',
      };
    }

    // P2: 记忆推断
    if (checkpointResource !== undefined) {
      return { value: checkpointResource, source: 'P2-memory' };
    }

    // P3: 系统内置
    return { value: SYSTEM_DEFAULTS.resource, source: 'P3-builtin' };
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