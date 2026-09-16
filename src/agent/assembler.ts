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

import { join } from 'node:path';
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
import { estimateTokensMessages } from '@/agent/contextManager.js';
// 工具幂等契约（接线下沉：onToolExecuted / preExecutionCheck 依赖幂等表 + 补偿判断）
import { BUILTIN_TOOL_IDEMPOTENCY, shouldSkipForIdempotency } from '@/agent/builtinTools.js';
// 任务表渲染（接线下沉：loop.getTaskTable 依赖）
import { renderTaskTable, buildCompletionVerifyNudge } from '@/agent/taskTableRenderer.js';
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
// run_team_meeting 会议实现（工具内嵌 LLM 调用；装配层持 provider + rolePackManager 闭包注入）
import { runTeamMeetingAssessment } from '@/agent/builtinToolHandlers.js';
// L3 脚本执行器（静态导入，避免每次调用动态加载）
import { runSkillScript, formatScriptResult } from '@/skill/skillScriptRunner.js';

/**
 * Turn 起始策略固定段（内核行为约束，2026-09-13，Turn 意图理解与模型思考展示设计 Part 2）。
 *
 * 约束式极简：只画"何时该查 / 何时该规划"的行为边界，不写步骤脚本
 * （对齐 Anthropic「目标+约束」指南——脚本化指示降低输出质量）。输出形态由 LLM 裁量。
 * 边界：与 search_memories 工具描述 / loop「记忆回想」软引导**不重复**——此处不点名"先回忆"
 * （记忆引导已两处，三处重复即带伤）。SSOT：本常量唯一真源，仅 buildSystemPromptPrefix 消费。
 */
const TURN_START_STRATEGY_PROMPT = `## Turn 起始策略
需要外部信息时，先调用工具调查再回答，不要凭记忆猜测；
任务需要多步推进时，使用任务表工具规划执行；
简单问题直接回答。`;

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
  // 内核固定行为段（Part 2）：Turn 起始策略，放时间戳后（最接近用户消息，LLM 注意力位）。
  // 单点注入（SSOT）：TURN_START_STRATEGY_PROMPT 常量唯一真源，本函数是唯一消费点；
  // 初始化/刷新共用本函数，角色切换不丢失。
  systemPrefixParts.push(TURN_START_STRATEGY_PROMPT);
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
  /** 主动提问时请求软暂停（ask_user question_pending 触发） */
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
  /**
   * 会议逐步切换（T1，2026-09-06 收口）：按当前 active 任务表步骤的 rolePack 刷新本轮装配视角。
   *
   * 由 taskTable 每轮注入时驱动——与任务表渲染同源（同读「当前 active step」），弥补
   * 此前装配视角只在 prepare.run 设一次、后继 step 换角色不生效的缺口（展示层正确/装配层冻结）。
   * 内部防重：视角未变化则跳过，避免每轮迭代重复重建前缀。缺省 no-op（纯工厂单测不触发）。
   */
  applyActiveStepAssembly?: () => void;
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
  | 'projectSearchProvider'
  | 'vectorStore'
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
 * 装配 loop 运行时回调 + 任务表管理（接线下沉：onPendingQuestion/onStepBoundary/getTaskTable/planManager）
 *
 * 这些闭包原内联在 Agent.assembleComponents 尾部，现回填到组装器——接线本质是组件间协作，
 * 属装配职责（装配逻辑单一真理源）。
 * 注：loop.onPaused 不再在此装配——暂停收口（Agent.consumeExecutionStream）统一写 pauseMeta。
 * 注：任务表停滞检测已迁移到单 turn step 循环内嵌（2026-09-04 收敛：多 turn 编排已砍）。
 *
 * @param loop AgentLoop（装配其 onPendingQuestion/onStepBoundary/getTaskTable）
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
  // 主动提问（ask_user 工具检出）：发射 questionPending 事件（宿主渲染提问 UI）+
  // 触发暂停（pauseMeta 记 reason/source，供重启恢复展示"问了什么"）。
  loop.onPendingQuestion = (questions) => {
    if (questions.length === 0) return;
    hooks?.emit(AGENT_EVENTS.questionPending, questions);
    // 触发软暂停：handleAskUser 检出 ask_user 返回 'paused' 后由 consumeExecutionStream 翻 PAUSED
    const reason = `需要澄清：${questions.map((q) => q.question).join('; ')}`;
    hooks?.requestPause(reason, 'agent');
  };

  // step 边界回调（每次 LLM 迭代完成后触发）：写 stepLog 关联任务表步骤（取 active 步骤 ID）。
  // 单向引用——plan 仍是任务状态真理源，stepLog 是其时间轴投影（避免双写）
  loop.onStepBoundary = (stepInfo) => {
    const activeStepId = sessionManager
      .getCheckpoint()
      ?.plan.find((s) => s.status === 'active')?.id;
    sessionManager.completeStep({
      planStepId: activeStepId,
      summary: stepInfo.summary,
    });
  };

  // active step 元信息回调（阶段二步级折叠，2026-09-08 路 B′）：loop 迭代完成时取当前
  // active 步骤 { stepId, title }，供 loop 对比推进产 step_boundary 事件。无任务表返回 null，
  // 宿主端据此不产边界（静默）。与 onStepBoundary 同源取 active step，真理源一致。
  loop.getActiveStepMeta = () => {
    const cp = sessionManager.getCheckpoint();
    const active = cp?.plan.find((s) => s.status === 'active');
    return active
      ? { stepId: active.id, title: active.description ?? active.id }
      : null;
  };

  // 在途任务表判定回调（单一真理源 = SessionManager.hasInflightPlan）：loop 注入 needsPlanning
  // nudge 前询问「是否已有在途任务表」。与 prepare 的会议骨架守卫共用同一谓词——同一命题
  // 禁两处各自实现（曾为 prepare 内联谓词 + loop 借 getActiveStepMeta 存在性两处）。
  loop.hasInflightPlan = () => sessionManager.hasInflightPlan();

  // 装配任务表注入回调：每次迭代 LLM 调用前统一注入
  loop.getTaskTable = () => {
    const cp = sessionManager.getCheckpoint();
    if (!cp) return '';
    // 会议逐步切换：每轮按当前 active step 派生装配视角（与任务表渲染同源；防重见 agent.applyActiveStepAssemblyIfChanged）
    hooks?.applyActiveStepAssembly?.();
    return renderTaskTable(cp.plan, cp.stepLog);
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
      // updatePlanStepStatus 返回 true ⇒ checkpoint/plan 必存在（sessionManager.ts:1154 早退契约），用非空断言保证
      const plan = sessionManager.getCheckpoint()!.plan;
      const step = plan.find((s) => s.id === stepId);
      // 收尾验证 nudge（2026-09-07 ME-10）：把最后一步标 done = LLM 宣称任务完成——
      // 若全 done 且无执行性验证步骤，追加提示引导补真验证（触发条件确定性，内容交 LLM）。
      // 仅 done 路径触发（blocked 是中止宣告，无需 nudge）；判定函数返回 null = 零打扰。
      const result = `步骤 [${stepId.slice(0, 8)}] "${step!.description}" 已标记为 ${status}`;
      if (status === 'done') {
        return result + (buildCompletionVerifyNudge(plan) ?? '');
      }
      return result;
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
  // 角色包底盘占用（system prompt 总体 token）= 装配此刻即确定的真值，早于 prepare；
  // 冷启动 / 重启首屏即可显示真实占比。与运行时 prepare 用同一 estimateTokensMessages 估算器（口径一致）。
  const rolePackBaseTokens = estimateTokensMessages([{ content: systemPromptPrefix }]);

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
    rolePackBaseTokens,
    toolDefinitions: toolExec.list,
    // 完整内置定义注入只读闸（toolReadonly 查询 readonly 标记；单一真理源取 toolExec.builtinDefinitions）
    builtinTools: toolExec.builtinDefinitions,
    maxContextTokens,
    tracer,
    messages,
    enableContextSummary,
    // 卸载式压缩落盘目录：项目级 .memora/outputs。两条约束同时满足——在 SecurityGuard 信任根
    // （memoraDir）内 → read_file 可回取；`.memora` 属 IGNORED_DIR_NAMES → search_project/list_dir
    // 不命中，不污染项目检索（故不落用户级 ~/.memora，那在信任根外，引用读不回）
    offloadDir: join(pctx.memoraDir, 'outputs'),
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
      // D1-②：有写副作用且需在崩溃/重启后保留执行记录的工具，执行完成后立即落盘
      // completedToolCalls——使「工具重跑排重 / 补偿」在进程崩溃/重启后仍生效（幂等契约跨重启可靠）。
      // 分级落盘依据（对照四态语义）：
      //   - non-idempotent：记录供补偿回滚（compensateAllNonIdempotent）使用，必须落盘；
      //   - idempotent-key：记录供恢复时排重（避免重复写入），需落盘；
      //   - idempotent（task_table_update）：重跑安全，无需立即落盘（会话收尾/其它 flush 点兜底）；
      //   - read-only：永不跳过且重跑无害，落盘纯属 IO 浪费，不落盘。
      if (idempotent === 'non-idempotent' || idempotent === 'idempotent-key') {
        // 有写副作用且需持久化记录的工具：完成后立即落盘 completedToolCalls（SessionManager 恒实现）
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

  // G4 预算联动（2026-08-31）：search_project 执行期读取 loop 最近一轮 prepare 的剩余预算，
  // 预算紧张时自动下探结果条数上限（loop 创建后注入，与 read_skill 同款时序解耦）
  toolExec.setBudgetProvider(() => loop.getLastBudget()?.remainingTokens);

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
    input.projectSearchProvider,
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
  // P-6（2026-09-06）：AssembleInput.rolePackTeams 已由 AgentConfig 收敛为必选（Agent 构造 ?? [] 归一化），
  // 此处直接透传，无 null 传播；漏传在编译期即报错
  rolePackManager.setRolePackTeams(rolePackTeams);
  await rolePackManager.load(activeRolePack);

  // 激活角色包的 L1 persona（角色包唯一；无激活角色包时为空串）
  const rolePackPrompt = rolePackManager.buildSystemPrompt();

  // run_team_meeting：注入评估/评审型会议回调（工具内嵌一次 LLM 调用）
  // rolePackManager 建于 toolExec 之后，用回调注入解耦时序（同 readSkill/registerWork 模式）。
  // 闭包收敛 rolePackManager（getTeam 组解析 + buildSystemPrompt persona 全文）与前台 provider（单次 chat）。
  toolExec.runTeamMeeting = async (group: string, topic: string) =>
    runTeamMeetingAssessment({
      resolveTeam: (g) => rolePackManager.getTeam(g),
      buildPersona: (n) => rolePackManager.buildSystemPrompt(n),
      provider,
      group,
      topic,
    });

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

  // 装配 loop 运行时回调 + 任务表管理（onPendingQuestion/onStepBoundary/getTaskTable/planManager）
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
  // 接线 search_memories 语义后端：toolExec 先于 memoryInspector 构造，故此处后注入；
  // 注入后 search_memories 走 searchHybrid（语义+关键词+superseded 过滤+accessedAt/溯源揭示，§3.3）
  toolExec.setMemoryInspector(memoryInspector);
  // 接线 memoryRecalled 事件（§2.4 保留改语义定案）：search_memories 命中记忆 → 宿主广播
  // 「LLM 查询记忆命中 N 条」；warmRecall（恢复例外）由 Agent 门面另发 memoryRecalled。
  toolExec.setOnMemoryRecalled((info) => hooks?.emit(AGENT_EVENTS.memoryRecalled, info));
  // 接线工具召回与装配期内容互斥（§5.1）：search_memories 排除「正文或摘要已在眼前」的轮次
  // round-summary，避免 LLM 拿回眼前内容的摘要重复。排除集从 loop 工作记忆视图精确派生
  // （getExclusionRoundIds = 视图内 ∪ 被替换 ∪ 在途），与模型窗口无关，取代旧的固定 20 轮代理量。
  toolExec.setExclusionRoundIdsProvider(() => loop.getExclusionRoundIds());

  // ── 输入增强管线 ──

  // ContextPreparer 依赖已装配的 loop/history/rolePackManager；策略推导走 rolePackManager（SSOT）。
  const contextPreparer = new ContextPreparer({
    loop,
    rolePackManager,
    getIndex: () => pctx.index,
    config: {
      // 组装器可选字段（undefined）收窄为 deps 的显式 null（关闭语义）
      tracer: tracer ?? null,
      vectorStore: vectorStore ?? null,
      messages,
      // 上下文预算装配的容量来源（动态轮数派生基准）
      maxContextTokens,
    },
    // 事件发射桥接到 Agent 强类型 emit（Agent 侧按 AGENT_EVENT_SET 校验）
    emit: (event, data) => hooks?.emit(event, data),
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
  };
}
