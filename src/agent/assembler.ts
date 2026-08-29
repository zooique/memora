/**
 * Agent 组件组装器 — 从 Agent 门面类拆出的工厂逻辑
 *
 * 职责：
 *   - 创建并连接所有运行时组件（MessageHistory / AgentLoop / Managers）
 *   - 返回组装结果供 Agent 门面类持有
 *
 * 设计原则：
 *   - 纯工厂逻辑，不持有状态
 *   - Agent 门面类通过 assembleComponents() 获取组件引用
 *   - 组件间的依赖关系在此处显式声明
 *   - 角色相关功能统一由 RolePackManager 承载
 */

import { AgentLoop } from '@/agent/loop.js';
import { ToolExecutor } from '@/agent/toolExecutor.js';
import { MessageHistory } from '@/agent/messageHistory.js';
import type { ProjectContext } from '@/memory/projectManager.js';
import { SkillManager } from '@/skill/skillManager.js';
import { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import { SessionArchiver } from '@/agent/managers/sessionArchiver.js';
import { MemoryInspector } from '@/agent/managers/memoryInspector.js';
// DedupManager 在组合根装配，承担 L1 语义去重
import { DedupManager } from '@/agent/managers/dedupManager.js';
// MemoryAdvisor 在组合根装配，注入 MemoryInspector（组合根一致性）
import { MemoryAdvisor } from '@/agent/managers/memoryAdvisor.js';
import { TextPolishManager } from '@/agent/managers/textPolishManager.js';
import { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';
import { SessionManager } from '@/agent/managers/sessionManager.js';
// 输入增强管线（角色/记忆/技能增强的叶子逻辑）
import { ContextPreparer } from '@/agent/contextPreparer.js';
// 检查点恢复协议（温记忆召回 / 契约重注入 / 任务表预判）
import { CheckpointRestoreCoordinator } from '@/agent/checkpointRestoreCoordinator.js';
// 工具幂等契约（接线下沉：onToolExecuted / preExecutionCheck 依赖幂等表 + 补偿判断）
import { BUILTIN_TOOL_IDEMPOTENCY, shouldSkipForIdempotency } from '@/agent/builtinTools.js';
// 任务表渲染（接线下沉：loop.getTaskTable 依赖）
import { renderTaskTable } from '@/agent/taskTableRenderer.js';
import { logger } from '@/logging/logger.js';

/** 截断优先复用 round-summary 的最大条数 */
const ROUND_SUMMARY_LOADER_MAX = 5;
import type { LlmProvider } from '@/llm/provider.js';
import type { ProviderRouter } from '@/llm/types.js';
import type {
  AgentConfig,
  FileConsistencyCheck,
  PreExecutionResult,
  ToolExecutionRecord,
  IdempotencyLevel,
} from '@/agent/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import { AGENT_EVENTS, type AgentEventName } from '@/utils/eventEmitter.js';
import { configError } from '@/utils/errors.js';
// 角色包管理器（唯一角色真理源）
import { RolePackManager } from '@/role-pack/rolePackManager.js';
// L3 脚本执行器（静态导入，避免每次调用动态加载）
import { runSkillScript, formatScriptResult } from '@/skill/skillScriptRunner.js';

/**
 * 构建 systemPromptPrefix 的共享函数（SSOT）
 *
 * 初始化时和刷新时都必须使用此函数，确保前缀包含：
 *   1. 角色包 L1 persona + 技能清单（rolePackPrompt）
 *   2. 全局技能 L1 清单（globalSkillList）
 *   3. 作品投影装配注入块（workProjectionContext，可选：极简元数据清单，AI 按需 read_file）
 *   4. 当前时间戳
 *   5. 分隔线
 *
 * 历史：refreshPersonaPrefixOnLoop 此前只拼接 rolePackPrompt，
 * 丢失全局技能清单和时间戳——首次角色切换后全局技能永久不可见。
 * 本函数作为唯一真理源，两处调用均走此处。
 *
 * @param rolePackPrompt 角色包构建的 prompt（含 L1 persona + 角色包技能清单）
 * @param globalSkillList 全局技能清单（SkillManager.buildSkillList()）
 * @param locale 时间格式化 locale
 * @param workProjectionContext 作品投影装配注入块（可选；由 WorkProjectionManager.loadAndGetContextBlock() 产出）
 * @returns 完整的 systemPromptPrefix
 */
export function buildSystemPromptPrefix(
  rolePackPrompt: string,
  globalSkillList: string,
  locale?: string,
  workProjectionContext?: string,
): string {
  const systemPrefixParts = [rolePackPrompt, globalSkillList, workProjectionContext].filter(Boolean);
  const now = new Date();
  const timeStr = now.toLocaleString(locale ?? AGENT_CONSTANTS.DEFAULT_LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  systemPrefixParts.push(`当前时间：${timeStr}（${tz}）`);
  return (
    systemPrefixParts.filter(Boolean).join('\n\n') +
    (systemPrefixParts.length > 0 ? '\n\n---\n\n' : '')
  );
}

/**
 * Agent 门面注入的稳定能力（接线下沉载体）
 *
 * 此前 8 个接线回调平铺在 Agent.assembleComponents 内联闭包 + AssembleCallbacks
 * 逐字段重复声明；收进单一 `hooks` 后，Agent 只传稳定能力（emit/守卫/暂停），
 * 接线闭包语义在组装器内唯一实现（装配逻辑单一真理源）。
 *
 * 边界：只传 Agent 的稳定能力（非私有状态），避免反向依赖泄漏；
 * hooks 可选——缺省时按 no-op 接线，供纯工厂单测使用。
 */
export interface AgentHooks {
  /**
   * 发射 Agent 事件（宿主订阅广播；由 Agent 侧按 AGENT_EVENT_SET 校验事件名合法性）。
   * 载荷放宽为 unknown：事件数据形状由 AgentEventMap 定（多数为对象，questionPending 为数组），
   * 桥接侧负责强类型断言。
   */
  emit: (event: AgentEventName, data: unknown) => void;
  /** 会话忙状态查询（SessionManager 守卫） */
  isChatBusy: () => boolean;
  /** 主动提问/澄清时请求软暂停（与 needClarify 共享暂停/恢复机制） */
  requestPause: (reason: string, source: 'user' | 'agent' | 'system') => void;
  /**
   * 宿主工具执行前检查回调（统一执行入口 · 单点聚合检查）
   *
   * 审批/审计/参数改写/幂等去重途经的宿主闸门。放行后由组装器内部幂等检查续接。
   */
  preExecutionCheck?: (name: string, args: string) => PreExecutionResult;
  /** 文件层前置条件断言回调（可选，两段式契约结构化；预留键，暂未被消费） */
  fileConsistencyCheck?: FileConsistencyCheck;
  /**
   * 角色包激活后应用工具暴露面（检查点恢复协议角色契约重注入触发）
   *
   * 走 Agent 生命周期（toolMode/能力白名单 → setToolWhitelist → loop 快照 + system prompt 同步）；
   * 缺省 no-op（纯工厂单测不触发）。
   */
  applyRolePackToolExposure?: () => void;
  /**
   * 角色包激活后刷新 loop 前缀（检查点恢复协议角色契约重注入触发）
   *
   * 走 Agent 生命周期（buildSystemPromptPrefix 真理源 → loop.refreshRolePackPrefix + ChatOptions）；
   * 缺省 no-op（纯工厂单测不触发）。
   */
  refreshRolePackPrefixOnLoop?: () => void;
}

/**
 * 与 AgentConfig 同源的组装运行时参数
 *
 * Pick 派生自 AgentConfig（而 AgentConfig 又派生自 AgentOptions），
 * 消除 AssembleInput 与 AgentConfig 之间 10 个字段的逐一手写重复。
 */
type AssembleRuntimeParams = Pick<
  AgentConfig,
  | 'projectPath'
  | 'configDir'
  | 'activeRolePack'
  | 'rolePackTeams'
  | 'builtinFallbackRole'
  | 'maxContextTokens'
  | 'sessionStore'
  | 'roundStore'
  | 'tracer'
  | 'messages'
  | 'enableContextSummary'
  | 'webSearchProvider'
  | 'fetchProvider'
  | 'codeExecutionProvider'
  | 'vectorStore'
  | 'recallExcludeSources'
  | 'strategyOverride'
>;

/** 组装器输入参数 */
export interface AssembleInput extends AssembleRuntimeParams {
  provider: LlmProvider;
  backgroundProvider: LlmProvider | null;
  /** Provider 路由选择器（多模型路由基础，可选） */
  providerRouter?: ProviderRouter | null;
  /** 已有的 SkillManager（首次为 null，后续复用） */
  existingSkillManager: SkillManager | null;
  /**
   * systemPrompt 时间注入的 locale（默认 AGENT_CONSTANTS.DEFAULT_LOCALE = 'zh-CN'）。
   * 注入此字段可覆盖默认 locale，实现国际化时间格式。
   */
  locale?: string;
  /** Agent 门面注入的稳定能力（接线下沉载体；缺省按 no-op 接线，供纯工厂单测） */
  hooks?: AgentHooks;
}

/**
 * 子工厂参数：AssembleInput 共享字段 Pick 派生 + 阶段产物
 *
 * 只收敛了顶层 AssembleInput；子工厂此前内联手写 14 字段（其中 10 个与
 * AssembleInput 重复声明，locale 等后加字段曾同时改 3 处）。Pick 派生后
 * 共享字段的类型由 AssembleInput 单一继承——新增字段只改 AssembleInput 一处，
 * 且同一字段两处类型不可能漂移（tsc 锁死）。
 */
type LoopAndDepsParams = Pick<
  AssembleInput,
  | 'provider'
  | 'backgroundProvider'
  | 'providerRouter'
  | 'maxContextTokens'
  | 'tracer'
  | 'messages'
  | 'enableContextSummary'
  | 'sessionStore'
  | 'locale'
  | 'hooks'
> & {
  pctx: ProjectContext;
  /** 激活角色包的 L1 persona prompt（档 2-1 后角色包唯一；无激活角色包时为空串） */
  rolePackPrompt: string;
  /** 全局技能管理器（构建通用技能清单 + read_skill 全局源，两级技能渐进披露） */
  skillManager: SkillManager;
  toolExec: ToolExecutor;
  /** 会话管理器（先于 loop 创建，工具执行回调可直接写入，消除暂存队列补丁） */
  sessionManager: SessionManager;
  /** 作品投影装配注入块（L1 name+description 清单 + L2 always 正文，两级渐进披露） */
  workProjectionContext: string;
};

/**
 * 子工厂参数：AssembleInput 共享字段 Pick 派生 + 阶段产物
 *
 * 同 LoopAndDepsParams（收敛的第二半）。
 */
type LoopDependentParams = Pick<AssembleInput, 'backgroundProvider' | 'hooks'> & {
  pctx: ProjectContext;
  loop: AgentLoop;
  history: MessageHistory;
};

/** 组装器输出（所有创建的组件引用） */
export interface AssembleOutput {
  history: MessageHistory;
  loop: AgentLoop;
  toolExec: ToolExecutor;
  workProjection: WorkProjectionManager;
  skillManager: SkillManager;
  memoryInspector: MemoryInspector;
  /**
   * 语义去重管理器（L1 LLM 记忆治理）
   *
   * 承担 deduplicateMemories 职责，MemoryInspector 回归纯存储读写。
   * Agent.deduplicateMemories() 委托本对象。
   */
  dedupManager: DedupManager;
  /**
   * 记忆顾问（L3 冲突检测 / sourceHealth / suggest）
   *
   * Agent.detectConflicts 直接调用 advisor，不再经 MemoryInspector 转发。
   * assembler 显式返回 advisor 供 Agent 持有。
   */
  memoryAdvisor: MemoryAdvisor;
  /** 会话归档器（负责生成/更新 SessionMeta） */
  sessionArchiver: SessionArchiver;
  /** 文本润色管理器（LLM 语法修正 + 表达优化） */
  textPolisher: TextPolishManager;
  /** 角色包管理器（角色+技能+规则的唯一真理源） */
  rolePackManager: RolePackManager;
  /** 轮次摘要生成器（记忆即摘要架构） */
  roundSummaryGenerator: RoundSummaryGenerator;
  /** 会话管理器（接线下沉后由组装器创建并返回，Agent 直接持有） */
  sessionManager: SessionManager;
  /** 输入增强管线（角色/记忆/技能增强，Agent 门面保留编排调用点） */
  contextPreparer: ContextPreparer;
  /** 检查点恢复协议（温记忆召回 / 契约重注入 / 任务表预判，Agent 保留公开 API 委托） */
  checkpointRestoreCoordinator: CheckpointRestoreCoordinator;
}

/**
 * 组装所有运行时组件
 *
 * 组件创建顺序（解决循环依赖）：
 *   1. 无依赖组件：history, workProjection, toolExec
 *   2. 依赖 Provider 的组件：skillManager, rolePackManager
 *   3. AgentLoop（依赖 toolExec + systemPromptPrefix）
 *   4. 依赖 Loop 的组件：configManager, memoryInspector
 *
 * @param pctx 项目上下文
 * @param input 组装参数
 * @returns 所有组件引用
 */

// ── 子工厂函数 ─────────────────────────────────────────────

/**
 * 会话事件分发
 *
 * AgentLoop 处理 SessionEvent 时通知会话管理器：按事件类型触发状态机转换或检查点更新。
 *
 * @param sm 会话管理器
 * @param eventType 事件类型（correction=修正目标 / clarify=澄清心跳 / chat=对话心跳）
 * @param detail 事件详情（correction 时为目标文本）
 */
function dispatchSessionEvent(sm: SessionManager, eventType: string, detail: string): void {
  switch (eventType) {
    case 'correction':
      // 修正事件：更新目标版本
      sm.updateGoal(detail);
      break;
    case 'clarify':
      // 澄清事件：记录心跳
      sm.heartbeat();
      break;
    case 'chat':
      // 对话事件：记录心跳
      sm.heartbeat();
      break;
    default:
      break;
  }
}

/**
 * 装配 loop 运行时回调 + 任务表管理（接线下沉：onPendingQuestion/onRoundBoundary/getTaskTable/planManager）
 *
 * 这些闭包原内联在 Agent.assembleComponents 尾部，现回填到组装器——接线本质是组件间协作，
 * 属装配职责（装配逻辑单一真理源）。
 * 注：loop.onPaused 不再在此装配——暂停收口（Agent.consumeExecutionStream）统一写 pauseMeta。
 *
 * @param loop AgentLoop（装配其 onPendingQuestion/onRoundBoundary/getTaskTable）
 * @param toolExec 工具执行器（装配其 planManager）
 * @param sessionManager 会话管理器（全部闭包的操作落点）
 * @param hooks Agent 门面注入的稳定能力（emit/requestPause；可选，缺省 no-op）
 */
function wireRuntimeCallbacks(
  loop: AgentLoop,
  toolExec: ToolExecutor,
  sessionManager: SessionManager,
  hooks: AgentHooks | undefined,
): void {
  // 兜底停滞计数器：连续无 task_table_update 的回合数（装配期闭包，rebuild 重建归零）
  let stalledRoundCount = 0;

  // 主动提问（回答中检测到 LLM 结构化输出 [ASK]）：发射 questionPending 事件（宿主渲染提问 UI）+ 触发暂停。
  // 与 needClarify（P4 目标槽位补全）触发源不同，但共享 pause/resume 机制
  loop.onPendingQuestion = (questions) => {
    if (questions.length === 0) return;
    hooks?.emit(AGENT_EVENTS.questionPending, questions);
    // 触发软暂停：handleTextResponse 返回 'paused' 后由 consumeExecutionStream 翻 PAUSED
    const reason = `需要澄清：${questions.map((q) => q.question).join('; ')}`;
    hooks?.requestPause(reason, 'agent');
  };

  loop.onRoundBoundary = (roundInfo) => {
    // completeRound 写 roundLog 关联 plan 步骤（取 active 步骤 ID）。此前不传 stepId 使 roundLog 与 plan
    // 无法关联（不可追溯）；单向引用——plan 仍是任务状态真理源，roundLog 是其时间轴投影（避免双写）
    const activeStepId = sessionManager
      .getCheckpoint()
      ?.plan.find((s) => s.status === 'active')?.id;
    sessionManager.completeRound({
      stepId: activeStepId,
      summary: roundInfo.summary,
    });

    // 兜底停滞检测：连续 3 轮无 task_table_update 且 plan 有未完任务 → 将 active step 标记为 blocked
    stalledRoundCount++;
    if (stalledRoundCount >= 3) {
      const cp = sessionManager.getCheckpoint();
      if (cp) {
        const activeStep = cp.plan.find((s) => s.status === 'active');
        const hasPending = cp.plan.some((s) => s.status === 'pending' || s.status === 'active');
        if (activeStep && hasPending) {
          // 经 updatePlanStepStatus 标脏，checkpointDirty 置位确保阻塞标记可落盘
          sessionManager.updatePlanStepStatus(activeStep.id, 'blocked');
          loop.injectSystemMessage(
            `[系统] 检测到任务表停滞（连续 3 回合未更新步骤状态），已自动将步骤 "${activeStep.description}" 标记为 blocked。请使用 task_table_update 推进剩余任务，或使用 task_table_write 重新规划。`,
          );
        }
      }
      // 复位计数器（无论是否触发，防止无限触发）
      stalledRoundCount = 0;
    }
  };

  // 装配任务表注入回调：每次迭代 LLM 调用前统一注入
  loop.getTaskTable = () => {
    const cp = sessionManager.getCheckpoint();
    if (!cp) return '';
    return renderTaskTable(cp.plan, cp.roundLog);
  };

  // 装配任务表工具回调（planManager）
  toolExec.planManager = {
    writePlan: (mode, steps) => {
      // 分发归位 SessionManager.writePlan（计划写入口 SSOT，可被单测直接覆盖）
      const newPlan = sessionManager.writePlan(mode, steps);
      return `任务表已更新（${mode}），当前共 ${newPlan.length} 个步骤：\n${newPlan
        .map((s) => `  - [${s.id.slice(0, 8)}] ${s.description}${s.rolePack ? `（角色：${s.rolePack}）` : ''}`)
        .join('\n')}`;
    },
    updateStep: (stepId, status) => {
      // 状态变更收口 SessionManager.updatePlanStepStatus（内部标脏 + 心跳，唯一写点）。
      // 必须经此写点置 checkpointDirty，否则计划变更可能永不落盘
      if (!sessionManager.updatePlanStepStatus(stepId, status)) {
        return `[ERR:STEP_NOT_FOUND] 未找到步骤 ${stepId}`;
      }
      const step = sessionManager.getCheckpoint()?.plan.find((s) => s.id === stepId);
      // 兜底停滞计数器复位（LLM 调用了 task_table_update，说明未停滞）
      stalledRoundCount = 0;
      return `步骤 [${stepId.slice(0, 8)}] "${step!.description}" 已标记为 ${status}`;
    },
    getPlan: () => {
      const cp = sessionManager.getCheckpoint();
      return (cp?.plan ?? []).map((s) => ({
        id: s.id,
        description: s.description,
        status: s.status,
        order: s.order,
        rolePack: s.rolePack,
      }));
    },
  };
}

/**
 * 创建 AgentLoop 及其直接依赖
 */
async function createAgentLoopAndDeps(params: LoopAndDepsParams) {
  const {
    provider,
    backgroundProvider,
    providerRouter,
    pctx,
    rolePackPrompt,
    skillManager,
    toolExec,
    maxContextTokens,
    tracer,
    messages,
    enableContextSummary,
    sessionStore,
    locale,
    sessionManager,
    hooks,
    workProjectionContext,
  } = params;

  // 系统前缀：使用共享函数构建（SSOT：buildSystemPromptPrefix）
  // 包含角色包 L1 persona + 全局技能清单 + 作品投影装配块（L1 清单 + L2 always 正文）+ 当前时间戳
  const globalSkillList = skillManager.buildSkillList();
  const systemPromptPrefix = buildSystemPromptPrefix(
    rolePackPrompt,
    globalSkillList,
    locale,
    workProjectionContext,
  );

  // 后台组件统一使用 backgroundProvider，降级到前台 provider（SSOT：与 textPolisher 同模式）
  const sessionArchiver = new SessionArchiver(backgroundProvider ?? provider, sessionStore);
  const textPolisher = new TextPolishManager(backgroundProvider ?? provider);
  const roundSummaryGenerator = new RoundSummaryGenerator(
    backgroundProvider ?? provider,
    pctx.index,
  );

  // 截断时优先复用已存 round-summary，避免现调 LLM 生成上下文摘要
  // 仅取当前会话 roundIds 对应的摘要（round-based：会话由 roundIds 列表定义，摘要以 roundId 溯源）——
  // 防止其他会话（分叉分支/会话切换遗留）的摘要渗入当前上下文"遗忘补偿"。
  // sessionStore 缺失（未注入）时降级为全量最近摘要（保底可用性），不阻断截断。
  const roundSummaryLoader = (): string => {
    try {
      // 惰性求取当前会话 roundIds：checkpoint 未就绪时降级全量（新会话无历史摘要可复用）
      let allowedRoundIds: ReadonlySet<string> | null = null;
      const sessionId = sessionManager?.getCheckpoint()?.sessionId ?? '';
      if (sessionStore && sessionId) {
        const ids = sessionStore.getRoundIds(sessionId);
        allowedRoundIds = new Set(Array.isArray(ids) ? ids : []);
      }
      const summaries = pctx.index
        .getBySource(SOURCE_LABELS.ROUND_SUMMARY)
        .filter(
          (s) =>
            allowedRoundIds === null ||
            (s.roundId !== undefined && allowedRoundIds.has(s.roundId)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, ROUND_SUMMARY_LOADER_MAX);
      if (summaries.length === 0) return '';
      return `[Earlier conversation summaries]\n${summaries.map((s) => `- ${s.content}`).join('\n')}`;
    } catch (err) {
      // 记忆索引异常时降级为空（回退 LLM 摘要生成），不阻断截断
      logger.debug({ err }, 'roundSummaryLoader：记忆索引异常，降级为空');
      return '';
    }
  };

  const loop = new AgentLoop({
    provider,
    providerRouter: providerRouter ?? undefined,
    bootstrapMemories: pctx.bootstrapMemories,
    toolExecutor: (name: string, args: string) => toolExec.execute(name, args),
    systemPromptPrefix,
    toolDefinitions: toolExec.list,
    // 完整内置定义注入只读闸（toolReadonly 查询 readonly 标记；单一真理源取 toolExec.builtinDefinitions）
    builtinTools: toolExec.builtinDefinitions,
    maxContextTokens,
    tracer,
    messages,
    enableContextSummary,
    // 替换式压缩第一级：按 roundId 取已存 round-summary（无摘要返回 null，该轮不替换交第二级压缩）
    getRoundSummary: (roundId: string): string | null => {
      try {
        const found = pctx.index
          .getBySource(SOURCE_LABELS.ROUND_SUMMARY)
          .find((s) => s.roundId === roundId);
        return found ? found.content : null;
      } catch (err) {
        // 记忆索引异常时降级为 null（替换层 no-op），不阻断压缩链
        logger.debug({ err, roundId }, 'getRoundSummary：记忆索引异常，降级为 null');
        return null;
      }
    },
    // 上下文截断 → 广播 contextTruncated 事件（宿主可提示用户）
    onContextTruncated: (skippedCount, keptCount) => {
      hooks?.emit(AGENT_EVENTS.contextTruncated, { skippedCount, keptCount });
    },
    // LLM 主动压缩完成 → 广播 contextCompressed 事件（宿主可提示"为保持专注已压缩"）
    onContextCompressed: (target, replacedCount, summaryLength) => {
      hooks?.emit(AGENT_EVENTS.contextCompressed, { target, replacedCount, summaryLength });
    },
    // 会话事件 → 分发到会话管理器（状态机转换/心跳，接线下沉后内联）
    onSessionEvent: (eventType, detail) => dispatchSessionEvent(sessionManager, eventType, detail),
    // 工具执行完成回调（幂等 outbox 落点）：记录执行到检查点供恢复排重
    // sessionManager 先于 loop 创建，此处可直接写入——无需暂存队列补丁
    onToolExecuted: (name, args, toolResult, ok) => {
      // 幂等级别查内置映射表，自定义工具默认非幂等
      const idempotent: IdempotencyLevel = BUILTIN_TOOL_IDEMPOTENCY[name] ?? 'non-idempotent';
      const record: ToolExecutionRecord = {
        name,
        argsSignature: args,
        executedAt: Date.now(),
        resultSummary: toolResult.slice(0, 100),
        ok,
        idempotent,
      };
      sessionManager.logToolExecution(record);
      // D1-②：非只读工具（有写副作用）完成后立即落盘其 completedToolCalls——使「工具重跑排重」
      // 在进程崩溃/重启后仍生效（幂等契约跨重启可靠），而非依赖闭环边界/关闭 flush。
      // 只读幂等工具可安全重跑，故不落盘以省 IO。
      if (idempotent !== 'idempotent') {
        // 非只读工具完成后立即落盘 completedToolCalls（SessionManager 恒实现，强调用不设可选链）
        sessionManager.flushNow();
      }
    },
    // 工具执行前检查（统一执行入口·单点聚合）：宿主审批优先（denied 短路返回），放行后再做内部幂等检查。
    // ⚠️ 宿主未注入 preExecutionCheck 时 → 完全降级为仅内部幂等检查。
    // 这是单用户信任模型下的显式决策（intentionally left blank），
    // 多用户/服务端部署必须在宿主层注入真实审批策略（权限/路径/只读等）。
    preExecutionCheck: (name, args): PreExecutionResult => {
      // 1. 宿主审批（审批/审计/参数改写/白名单/只读拦截）
      const hostResult = hooks?.preExecutionCheck?.(name, args);
      if (hostResult?.denied) return hostResult; // 拒绝：直接短路，阻止工具意图
      if (hostResult?.skip) return hostResult; // 跳过：宿主决定不执行
      // 2. 内部幂等检查（补偿机制·仅一次语义）：仅对幂等工具生效，非幂等工具不跳过
      // 幂等契约委托 shouldSkipForIdempotency（SSOT）：non-idempotent 不跳过（失败可重试）；
      // 幂等工具仅上次执行成功（ok=true）时跳过
      const idempotent: IdempotencyLevel = BUILTIN_TOOL_IDEMPOTENCY[name] ?? 'non-idempotent';
      const idemResult = shouldSkipForIdempotency(
        sessionManager.getCheckpoint()?.completedToolCalls,
        name,
        args,
        idempotent,
      );
      return {
        skip: idemResult.skip,
        previousResult: idemResult.previousResult,
        overrideArgs: hostResult?.overrideArgs,
      };
    },
    roundSummaryLoader,
  });

  toolExec.setOnToolsChanged(() => loop.refreshToolDefinitions(toolExec.list));

  return { loop, sessionArchiver, textPolisher, roundSummaryGenerator };
}

/**
 * 创建依赖 Loop 的组件
 */
function createLoopDependentComponents(params: LoopDependentParams) {
  const { pctx, loop, history, backgroundProvider, hooks } = params;

  const memoryInspector = new MemoryInspector(pctx.index, loop, history);
  const memoryAdvisor = new MemoryAdvisor(pctx.index, backgroundProvider ?? null);
  const dedupManager = new DedupManager(pctx.index, backgroundProvider ?? null, (report) => {
    hooks?.emit(AGENT_EVENTS.dedupCompleted, {
      deduplicatedCount: report.deduplicatedCount,
      demotedIds: report.demotedIds,
    });
  });

  return { memoryAdvisor, memoryInspector, dedupManager };
}

// ── 主组装函数 ─────────────────────────────────────────────

export async function assembleComponents(
  pctx: ProjectContext,
  input: AssembleInput,
): Promise<AssembleOutput> {
  const {
    provider,
    backgroundProvider,
    projectPath,
    configDir,
    activeRolePack,
    rolePackTeams,
    builtinFallbackRole,
    maxContextTokens,
    sessionStore,
    roundStore,
    tracer,
    messages,
    enableContextSummary,
    existingSkillManager,
    locale,
    vectorStore,
    recallExcludeSources,
  } = input;
  const hooks = input.hooks;

  // ── 无依赖组件 ──

  // Agent 层总是注入 createSecurityGuard，此处显式校验并收窄类型
  if (!pctx.security) {
    throw configError('security guard 未注入', undefined, [
      '检查 AgentOptions.permission 或 createSecurityGuard 配置',
    ]);
  }

  const history = new MessageHistory(sessionStore, undefined, undefined, roundStore);

  // 作品投影登记/更新 → 广播 workProjectionGenerated 事件（宿主可展示通知）
  // 投影落项目级目录（pctx.memoraDir/work-projections.json）而非记忆库：随项目隔离，换项目即消失（记忆系统纯化）
  // 方案（2026-08-26 剪枝）：作品投影 = 用户主动触发的极简索引（JSON 单文件），AI 按需 read_file 读取原文
  const workProjection = new WorkProjectionManager(pctx.memoraDir, (sourcePath, description) => {
    hooks?.emit(AGENT_EVENTS.workProjectionGenerated, { sourcePath, summary: description });
  }, projectPath);

  const toolExec = new ToolExecutor(
    projectPath,
    pctx.security,
    pctx.index,
    input.webSearchProvider,
    sessionStore,
    input.fetchProvider,
    input.codeExecutionProvider,
  );

  // ── 会话管理器（先于 loop 创建）──

  // SessionManager 构造只存 getter（getHistory/getLoop 惰性取用），不访问 history/loop 本体——
  // 因此可先于 loop 创建，使 loop 的工具执行回调（onToolExecuted/preExecutionCheck）装配期即可
  // 直接写入，无需工具执行期再借助暂存窗口。
  // loop 经闭包变量后赋引用；装配期不会触发 getLoop。
  let loopRef: AgentLoop | null = null;
  const sessionManager = new SessionManager(
    () => history,
    () => loopRef!,
    sessionStore,
    () => hooks?.isChatBusy() ?? false,
    // 会话事件转发：桥接到 Agent 强类型 emit（Agent 侧按 AGENT_EVENT_SET 校验，避免不安全断言）
    (event, data) => hooks?.emit(event, data),
  );

  // ── 依赖 Provider 的组件 ──

  const skillManager = existingSkillManager ?? new SkillManager(configDir);
  await skillManager.load();

  // M1 角色包清单：创建角色包管理器，角色相关功能的唯一真理源
  // activeRolePack：宿主注入持久化的用户角色包选择，§4.1 单链优先激活；未配置/包不存在落兜底包（不再回退 items[0]）
  const rolePackManager = new RolePackManager(configDir);
  // 宿主装配级参数注入：兜底角色覆盖（须存在，否则回退内核常量）+ 组数据（会议名单容器）
  rolePackManager.setBuiltinFallbackRole(builtinFallbackRole ?? null);
  rolePackManager.setRolePackTeams(rolePackTeams ?? []);
  await rolePackManager.load(activeRolePack);

  // 激活角色包的 L1 persona（角色包唯一；无激活角色包时为空串）
  const rolePackPrompt = rolePackManager.buildSystemPrompt();

  // 渐进披露 L2：注入 read_skill 技能正文读取回调（read_skill 工具数据源）
  // 两级技能统一渐进披露：先查激活角色包内嵌技能，再查全局通用技能池。
  // rolePackManager 在 toolExec 之后创建，用回调注入解耦时序（见 toolExecutor.readSkill 注释）
  toolExec.readSkill = async (skillName: string) => {
    const rolePackContent = await rolePackManager.readSkillContent(skillName);
    if (rolePackContent) return rolePackContent;
    // 全局通用技能：SkillManager 条目正文（已由 load() 装载）
    const globalSkill = skillManager.get(skillName);
    return globalSkill ? globalSkill.content : null;
  };

  // 渐进披露 L3：注入 read_resource 资源读取回调
  // 两级技能统一 L3：先查激活角色包内嵌技能的资源，再查全局通用技能
  toolExec.readResource = async (skillName: string, resourcePath: string) => {
    const rolePackResource = await rolePackManager.readSkillResource(skillName, resourcePath);
    if (rolePackResource) return rolePackResource;
    return skillManager.readResource(skillName, resourcePath);
  };

  // 渐进披露 L3：注入 run_skill_script 脚本执行回调
  toolExec.runSkillScript = async (skillName: string, scriptPath: string, args: string[]) => {
    // 先查激活角色包内嵌技能的脚本路径
    const rolePackPath = rolePackManager.getSkillScriptPath(skillName, scriptPath);
    if (rolePackPath) {
      const scriptInfo = rolePackManager.getSkillScriptInfo(skillName, scriptPath);
      if (scriptInfo) {
        const result = await runSkillScript(
          rolePackPath,
          scriptInfo.runtime,
          args,
          scriptInfo.timeout,
        );
        return formatScriptResult(result);
      }
    }
    // 再查全局通用技能
    const globalPath = skillManager.getScriptPath(skillName, scriptPath);
    if (globalPath) {
      const scripts = skillManager.listScripts(skillName);
      const scriptInfo = scripts.find((s) => s.path === scriptPath);
      if (scriptInfo) {
        const result = await runSkillScript(
          globalPath,
          scriptInfo.runtime,
          args,
          scriptInfo.timeout,
        );
        return formatScriptResult(result);
      }
    }
    return null;
  };

  // 渐进披露 L3：注入 list_resources 资源清单回调
  toolExec.listResources = async (skillName: string) => {
    // 先查激活角色包，再查全局通用技能
    const roleResources = rolePackManager.listSkillResources(skillName);
    if (roleResources.length > 0) {
      return JSON.stringify(
        roleResources.map((r) => ({ path: r.path, size: r.size })),
        null,
        2,
      );
    }
    const globalResources = skillManager.listResources(skillName);
    return JSON.stringify(
      globalResources.map((r) => ({ path: r.path, size: r.size })),
      null,
      2,
    );
  };

  // 渐进披露 L1 补充：注入 list_skills 技能清单回调 (使用 SkillManager.formatSkillForPrompt SSOT)
  toolExec.listSkills = async () => {
    const lines: string[] = ['【全局通用技能】'];
    const allGlobalSkills = skillManager.list;
    for (const skill of allGlobalSkills) {
      const formatted = SkillManager.formatSkillForPrompt(skill);
      if (formatted) lines.push(formatted);
    }
    // 技能清单跟随本轮装配视角（会议内 = 任务项角色；非会议 = activePack）
    const perspectiveName = rolePackManager.roundAssemblyPerspective ?? rolePackManager.activeName;
    if (perspectiveName) {
      lines.push('');
      lines.push(`【装配角色技能（${perspectiveName}）】`);
      // Bug 6 修复：直接用结构化数据（RolePackAssembly.skills），不再正则解析 prompt 文本
      const assembly = rolePackManager.get(perspectiveName);
      const skills = assembly?.skills ?? [];
      for (const skill of skills) {
        const fallbackName = skill.file
          ? rolePackManager.deriveSkillNameFromFile(skill.file)
          : undefined;
        const formatted = SkillManager.formatSkillForPrompt(skill, fallbackName);
        if (formatted) lines.push(formatted);
      }
    }
    return lines.join('\n');
  };

  // 作品投影登记：注入 register_work 工具回调（用户主动触发，写 JSON 索引）
  // 复用 read_skill 的注入回调模式——ToolExecutor 不持有 WorkProjectionManager，装配层解耦时序
  toolExec.registerWork = async (sourcePath: string, description: string) => {
    const entry = await workProjection.registerWork(sourcePath, description);
    return entry
      ? `✅ 已登记作品索引：${entry.name}（${entry.description}）\n源文件：${entry.source}`
      : '[ERR:REGISTER_FAILED] 作品索引登记失败';
  };

  // ── AgentLoop + 其直接依赖 ──

  // 作品投影装配注入：使用 SSOT 读取路径（刷新 + 读取合为单一操作）
  // 刷新失败不阻断装配——loadAndGetContextBlock 内部已容错，返回空串即不注入（投影是可选项，非装配硬依赖）
  const workProjectionContext = await workProjection.loadAndGetContextBlock();

  const { loop, sessionArchiver, textPolisher, roundSummaryGenerator } =
    await createAgentLoopAndDeps({
      provider,
      backgroundProvider,
      pctx,
      rolePackPrompt,
      skillManager,
      toolExec,
      maxContextTokens,
      tracer,
      messages,
      enableContextSummary,
      sessionStore,
      locale,
      sessionManager,
      hooks,
      workProjectionContext,
    });
  loopRef = loop;

  // 装配 loop 运行时回调 + 任务表管理（onPendingQuestion/onRoundBoundary/getTaskTable/planManager）
  wireRuntimeCallbacks(loop, toolExec, sessionManager, hooks);

  // ── 依赖 Loop 的组件 ──

  const { memoryAdvisor, memoryInspector, dedupManager } = createLoopDependentComponents({
    pctx,
    loop,
    history,
    backgroundProvider,
    hooks,
  });

  // 绑定记忆写入回调：round-summary 沉淀后广播 memoryAdded 事件
  roundSummaryGenerator.setOnMemoryAdded((info) => {
    hooks?.emit(AGENT_EVENTS.memoryAdded, info);
  });
  // 注入 VectorStore 到 MemoryInspector，启用混合搜索
  if (vectorStore) {
    memoryInspector.setVectorStore(vectorStore);
  }

  // ── 输入增强管线 ──

  // ContextPreparer 依赖已装配的 loop/history/rolePackManager；策略推导走 rolePackManager（SSOT）。
  const contextPreparer = new ContextPreparer({
    history,
    loop,
    rolePackManager,
    getIndex: () => pctx.index,
    config: {
      // 组装器可选字段（undefined）收窄为 deps 的显式 null（关闭语义）
      tracer: tracer ?? null,
      vectorStore: vectorStore ?? null,
      recallExcludeSources,
      messages,
      // 上下文预算装配的容量来源（动态轮数派生基准）
      maxContextTokens,
    },
    // 事件发射桥接到 Agent 强类型 emit（Agent 侧按 AGENT_EVENT_SET 校验）
    emit: (event, data) => hooks?.emit(event, data),
  });

  // ── 检查点恢复协议 ──

  // CheckpointRestoreCoordinator 依赖已装配的 sessionManager/loop；
  // 恢复协议只依赖稳定接口（sessionManager/history/loop），生命周期回调由 hooks 注入。
  const checkpointRestoreCoordinator = new CheckpointRestoreCoordinator({
    sessionManager,
    history,
    loop,
    getIndex: () => pctx.index,
    rolePackManager,
    config: {
      tracer: tracer ?? null,
      vectorStore: vectorStore ?? null,
      recallExcludeSources,
    },
    // 事件发射桥接到 Agent 强类型 emit
    emit: (event, data) => hooks?.emit(event, data),
    // 角色契约重注入命中时走 Agent 生命周期（缺省 no-op，供纯工厂单测）
    applyRolePackToolExposure: hooks?.applyRolePackToolExposure ?? (() => {}),
    refreshRolePackPrefixOnLoop: hooks?.refreshRolePackPrefixOnLoop ?? (() => {}),
  });

  return {
    history,
    loop,
    toolExec,
    workProjection,
    skillManager,
    memoryInspector,
    dedupManager,
    memoryAdvisor,
    sessionArchiver,
    textPolisher,
    rolePackManager,
    roundSummaryGenerator,
    sessionManager,
    contextPreparer,
    checkpointRestoreCoordinator,
  };
}
