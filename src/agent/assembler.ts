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
 */

import { AgentLoop } from '@/agent/loop.js';
import { ToolExecutor } from '@/agent/toolExecutor.js';
import { MessageHistory } from '@/agent/messageHistory.js';
import type { ProjectContext } from '@/memory/projectManager.js';
import { PersonaManager } from '@/persona/personaManager.js';
import { SkillManager } from '@/skill/skillManager.js';
import { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import { SessionArchiver } from '@/agent/managers/sessionArchiver.js';
import { ConfigManager } from '@/agent/managers/configManager.js';
import { MemoryInspector } from '@/agent/managers/memoryInspector.js';
// DedupManager 在组合根装配，承担 L1 语义去重（SPLIT-3 拆分自 MemoryInspector）
import { DedupManager } from '@/agent/managers/dedupManager.js';
// MemoryAdvisor 在组合根装配，注入 MemoryInspector（组合根一致性）
import { MemoryAdvisor } from '@/agent/managers/memoryAdvisor.js';
import { AutoConfigRefiner } from '@/agent/managers/autoConfigRefiner.js';
import { TextPolishManager } from '@/agent/managers/textPolishManager.js';
import { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';

/** C1 截断优先复用 round-summary 的最大条数（ADR-023） */
const ROUND_SUMMARY_LOADER_MAX = 5;
import type { LlmProvider } from '@/llm/provider.js';
import type { ProviderRouter } from '@/llm/types.js';
import type { Memory } from '@/memory/types.js';
import type { AgentConfig, FileConsistencyCheck, PreExecutionResult } from '@/agent/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import { configError } from '@/utils/errors.js';
// FileStore 用于 configDir 存在时创建 config 级文件存储，
// 供 ConfigManager.confirmConfigSuggestion 写入配置文件（真理源）
import { FileStore } from '@/memory/store.js';
// M1 角色包清单：装配层引入角色包管理器，为插卡式提供生长点
// 当前与 PersonaManager + SkillManager 共存，未来可完全替代
import { RolePackManager } from '@/role-pack/rolePackManager.js';

/**
 * 组装器事件回调组
 *
 * T-C2 收敛：此前 8 个回调平铺在 AssembleInput 顶层 + 两个子工厂签名逐字段重复声明；
 * 收进单字段 `callbacks`，新增回调只改本接口一处。
 */
export interface AssembleCallbacks {
  /** 作品投影生成/更新回调（宿主可据此发射事件通知用户） */
  onWorkProjectionGenerated?: (sourcePath: string, summary: string) => void;
  /** 上下文截断回调 */
  onContextTruncated?: (skippedCount: number, keptCount: number) => void;
  /** 语义去重完成回调 */
  onDedupCompleted?: (report: { scannedCount: number; pairCount: number; deduplicatedCount: number; demotedIds: string[] }) => void;
  /**
   * 会话事件回调（不中断工作模型 v2.0）
   *
   * AgentLoop 处理 SessionEvent 时通知上层状态机。
   */
  onSessionEvent?: (eventType: string, detail: string) => void;
  /**
   * 工具执行完成回调（P3.3 执行计划管理·工具幂等）
   *
   * AgentLoop 每次工具执行完成后调用。
   */
  onToolExecuted?: (name: string, args: string, result: string, ok: boolean) => void;
  /**
   * 工具执行前检查回调（设计文档 §7.2.1，统一执行前检查点）
   *
   * AgentLoop 每次工具执行前调用，是"执行前约束"（审批/审计/参数改写/幂等去重）
   * 的单一物理落地载体。返回三态（PreExecutionResult）：放行/跳过/拒绝。
   */
  preExecutionCheck?: (name: string, args: string) => PreExecutionResult;
  /** 文件层前置条件断言回调（可选，T5：两段式契约结构化） */
  fileConsistencyCheck?: FileConsistencyCheck;
}

/**
 * 与 AgentConfig 同源的组装运行时参数
 *
 * T-C1/C2：Pick 派生自 AgentConfig（而 AgentConfig 又派生自 AgentOptions），
 * 消除 AssembleInput 与 AgentConfig 之间 10 个字段的逐一手写重复。
 */
type AssembleRuntimeParams = Pick<
  AgentConfig,
  | 'projectPath'
  | 'configDir'
  | 'personaName'
  | 'activeRolePack'
  | 'maxContextTokens'
  | 'sessionStore'
  | 'tracer'
  | 'messages'
  | 'enableContextSummary'
  | 'webSearchProvider'
>;

/** 组装器输入参数 */
export interface AssembleInput extends AssembleRuntimeParams {
  provider: LlmProvider;
  backgroundProvider: LlmProvider | null;
  /** Provider 路由选择器（P1-2 多模型路由基础，可选） */
  providerRouter?: ProviderRouter | null;
  /** 已有的 SkillManager（首次为 null，后续复用） */
  existingSkillManager: SkillManager | null;
  /**
   * systemPrompt 时间注入的 locale（默认 AGENT_CONSTANTS.DEFAULT_LOCALE = 'zh-CN'）。
   * 注入此字段可覆盖默认 locale，实现国际化时间格式。
   */
  locale?: string;
  /** 事件回调组（T-C2：8 个平铺回调收敛为一组） */
  callbacks?: AssembleCallbacks;
}

/**
 * Phase 3 子工厂参数：AssembleInput 共享字段 Pick 派生 + 阶段产物
 *
 * T-C2 只收敛了顶层 AssembleInput；子工厂此前内联手写 14 字段（其中 10 个与
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
  | 'callbacks'
> & {
  pctx: ProjectContext;
  /** 激活角色包的 L1 persona prompt（档 2-1 后角色包唯一；无激活角色包时为空串） */
  rolePackPrompt: string;
  /** 全局技能管理器（构建通用技能清单 + read_skill 全局源，两级技能渐进披露） */
  skillManager: SkillManager;
  toolExec: ToolExecutor;
};

/**
 * Phase 4 子工厂参数：AssembleInput 共享字段 Pick 派生 + 阶段产物
 *
 * 同 LoopAndDepsParams（T-C2 收敛的第二半）。
 */
type LoopDependentParams = Pick<
  AssembleInput,
  'configDir' | 'backgroundProvider' | 'callbacks'
> & {
  pctx: ProjectContext;
  loop: AgentLoop;
  history: MessageHistory;
  skillManager: SkillManager;
};

/** 组装器输出（所有创建的组件引用） */
export interface AssembleOutput {
  history: MessageHistory;
  loop: AgentLoop;
  toolExec: ToolExecutor;
  personaManager: PersonaManager;
  workProjection: WorkProjectionManager;
  skillManager: SkillManager;
  configManager: ConfigManager;
  memoryInspector: MemoryInspector;
  /**
   * 语义去重管理器（L1 LLM 记忆治理）
   *
   * SPLIT-3 闭环（2026-07-21）：从 MemoryInspector 拆分出 deduplicateMemories 职责，
   * 让 MemoryInspector 回归纯存储读写。Agent.deduplicateMemories() 委托本对象。
   */
  dedupManager: DedupManager;
  /**
   * 记忆顾问（L3 冲突检测 / sourceHealth / suggest）
   *
   * v2 REPEAT-PROXY-1 闭环：Agent.detectConflicts 收缩为直接调用 advisor，
   * 不再经 MemoryInspector 转发。assembler 显式返回 advisor 供 Agent 持有。
   */
  memoryAdvisor: MemoryAdvisor;
  autoConfigRefiner: AutoConfigRefiner;
  /** 会话内容归档器（content 类记忆） */
  sessionArchiver: SessionArchiver;
  /** 文本润色管理器（LLM 语法修正 + 表达优化） */
  textPolisher: TextPolishManager;
  /** 角色包管理器（M1 清单抽象）
   *
   * 装配层引入角色包清单作为统一读取抽象。
   * 当前与 PersonaManager + SkillManager 共存，行为不变。
   * 未来角色包文件完备后，可替代独立通道。
   */
  rolePackManager: RolePackManager;
  /** 轮次摘要生成器（记忆即摘要架构，Phase 1） */
  roundSummaryGenerator: RoundSummaryGenerator;
}

/**
 * 组装所有运行时组件
 *
 * 组件创建顺序（解决循环依赖）：
 *   1. 无依赖组件：history, workProjection, toolExec
 *   2. 依赖 Provider 的组件：personaManager, skillManager
 *   3. AgentLoop（依赖 toolExec + systemPromptPrefix）
 *   4. 依赖 Loop 的组件：configManager, memoryInspector
 *
 * @param pctx 项目上下文
 * @param input 组装参数
 * @returns 所有组件引用
 */

// ── 子工厂函数 ─────────────────────────────────────────────

/**
 * Phase 3：创建 AgentLoop 及其直接依赖
 */
async function createAgentLoopAndDeps(params: LoopAndDepsParams) {
  const {
    provider, backgroundProvider, providerRouter, pctx, rolePackPrompt, skillManager, toolExec,
    maxContextTokens, tracer, messages, enableContextSummary,
    sessionStore, locale, callbacks,
  } = params;

  // 系统前缀：角色包唯一（ADR-025 档 2-1：persona 兜底已移除——设定记忆唯一归角色包，
  // 无激活角色包时降级为空串；PersonaManager 保留为宿主切换 API，不再注入 system prompt）
  // 全局通用技能清单并列拼入（两级技能统一渐进披露 L1，2026-08-18）：
  // 通用技能全局激活（清单常驻），角色包技能随角色激活（清单在 rolePackPrompt 内）。
  const globalSkillList = skillManager.buildSkillList();
  const systemPrefixParts = [rolePackPrompt, globalSkillList].filter(Boolean);
  const now = new Date();
  const timeStr = now.toLocaleString(locale ?? AGENT_CONSTANTS.DEFAULT_LOCALE, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  systemPrefixParts.push(`当前时间：${timeStr}（${tz}）`);
  const systemPromptPrefix =
    systemPrefixParts.filter(Boolean).join('\n\n') +
    (systemPrefixParts.length > 0 ? '\n\n---\n\n' : '');

  const sessionArchiver = new SessionArchiver(provider, pctx.index, sessionStore);
  const textPolisher = new TextPolishManager(backgroundProvider ?? provider);
  const roundSummaryGenerator = new RoundSummaryGenerator(provider, pctx.index);

  // C1（ADR-023）：截断时优先复用已存 round-summary，避免现调 LLM 生成上下文摘要
  // 从记忆索引取最近 N 条 round-summary（按 createdAt 降序），拼接为历史摘要回退文本。
  const roundSummaryLoader = (): string => {
    try {
      const summaries = pctx.index
        .getBySource(SOURCE_LABELS.ROUND_SUMMARY)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, ROUND_SUMMARY_LOADER_MAX);
      if (summaries.length === 0) return '';
      return `[Earlier conversation summaries]\n${summaries.map((s) => `- ${s.content}`).join('\n')}`;
    } catch {
      // 记忆索引异常时降级为空（回退 LLM 摘要生成），不阻断截断
      return '';
    }
  };

  const loop = new AgentLoop({
    provider,
    providerRouter: providerRouter ?? undefined,
    bootstrapMemories: pctx.bootstrapMemories,
    toolExecutor: (name: string, args: string) =>
      toolExec.execute(name, args),
    systemPromptPrefix,
    toolDefinitions: toolExec.list,
    maxContextTokens,
    tracer,
    messages,
    enableContextSummary,
    onContextTruncated: callbacks?.onContextTruncated,
    onSessionEvent: callbacks?.onSessionEvent,
    onToolExecuted: callbacks?.onToolExecuted,
    preExecutionCheck: callbacks?.preExecutionCheck,
    roundSummaryLoader,
  });

  toolExec.setOnToolsChanged(() => loop.refreshToolDefinitions(toolExec.list));

  return { loop, sessionArchiver, textPolisher, roundSummaryGenerator };
}

/**
 * Phase 4：创建依赖 Loop 的组件
 */
function createLoopDependentComponents(params: LoopDependentParams) {
  const { pctx, loop, history, skillManager, configDir, backgroundProvider, callbacks } = params;

  const configFileStore = configDir ? new FileStore(configDir) : null;

  const memoryInspector = new MemoryInspector(pctx.index, loop, history);
  const memoryAdvisor = new MemoryAdvisor(pctx.index, backgroundProvider ?? null);
  const dedupManager = new DedupManager(pctx.index, backgroundProvider ?? null, callbacks?.onDedupCompleted);

  const configManager = new ConfigManager({
    index: pctx.index,
    skillManager,
    injectSystemMessage: (msg: string) => loop.injectSystemMessage(msg),
    // refreshBootstrapMemories 必须同步 bootstrap 段（SSOT：system prompt 与存储一致）
    refreshBootstrapMemories: () => loop.refreshBootstrapMemories(configManager.getBootstrapMemories()),
    writeConfigFile: configFileStore ? (memory: Memory) => configFileStore.write(memory) : undefined,
    fileConsistencyCheck: callbacks?.fileConsistencyCheck,
  });

  const autoConfigRefiner = new AutoConfigRefiner(
    (suggestion) => configManager.suggestionCallback?.(suggestion),
    {
      // 已有同名 rule 不再建议，防「血肉结晶为骨骼」重复沉淀
      isExistingRule: (name) => configManager.listRules().some((r) => r.name === name),
    },
  );
  autoConfigRefiner.setBackgroundProvider(backgroundProvider);

  return { configManager, memoryAdvisor, memoryInspector, dedupManager, autoConfigRefiner };
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
    personaName,
    activeRolePack,
    maxContextTokens,
    sessionStore,
    tracer,
    messages,
    enableContextSummary,
    existingSkillManager,
    locale,
  } = input;
  const callbacks = input.callbacks;

  // ── Phase 1: 无依赖组件 ──

  // Agent 层总是注入 createSecurityGuard，此处显式校验并收窄类型
  if (!pctx.security) {
    throw configError('security guard 未注入', undefined, ['检查 AgentOptions.permission 或 createSecurityGuard 配置']);
  }

  const history = new MessageHistory(sessionStore);

  const workProjection = new WorkProjectionManager(pctx.index, backgroundProvider ?? provider, callbacks?.onWorkProjectionGenerated);

  const toolExec = new ToolExecutor(
    projectPath,
    pctx.security,
    pctx.index,
    input.webSearchProvider,
    workProjection,
    configDir,
    sessionStore,
  );

  // ── Phase 2: 依赖 Provider 的组件 ──

  const personaManager = new PersonaManager(configDir);
  // 档 2-1（ADR-025）：persona 不再注入 system prompt（角色包唯一）；
  // load 仍执行以初始化目录扫描与激活状态（agent 门面 switchPersona/autoMatch 依赖），
  // 返回值丢弃。
  await personaManager.load(personaName);

  const skillManager = existingSkillManager ?? new SkillManager(configDir);
  await skillManager.load();

  // M1 角色包清单：创建角色包管理器，装配层自此只认"清单"不认"来源"
  // 当前角色包文件为可选，不存在时降级为 PersonaManager + SkillManager 联合
  // activeRolePack：宿主注入持久化的用户角色包选择，优先激活；未配置/包不存在回退首个
  const rolePackManager = new RolePackManager(configDir);
  await rolePackManager.load(activeRolePack);

  // 激活角色包的 L1 persona（角色包优先于 persona；无激活角色包时为空串）
  const rolePackPrompt = rolePackManager.buildSystemPrompt();

  // 渐进披露 L2：注入 read_skill 技能正文读取回调（read_skill 工具数据源）
  // 两级技能统一渐进披露（2026-08-18）：先查激活角色包内嵌技能，再查全局通用技能池。
  // rolePackManager 在 toolExec 之后创建，用回调注入解耦时序（见 toolExecutor.readSkill 注释）
  toolExec.readSkill = async (skillName: string) => {
    const rolePackContent = await rolePackManager.readSkillContent(skillName);
    if (rolePackContent) return rolePackContent;
    // 全局通用技能：SkillManager 条目正文（已由 load() 装载）
    const globalSkill = skillManager.get(skillName);
    return globalSkill ? globalSkill.content : null;
  };

  // ── Phase 3: AgentLoop + 其直接依赖 ──

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
      callbacks,
    });

  // ── Phase 4: 依赖 Loop 的组件 ──

  const { configManager, memoryAdvisor, memoryInspector, dedupManager, autoConfigRefiner } =
    createLoopDependentComponents({
      pctx,
      loop,
      history,
      skillManager,
      configDir,
      backgroundProvider,
      callbacks,
    });

  return {
    history,
    loop,
    toolExec,
    personaManager,
    workProjection,
    skillManager,
    configManager,
    memoryInspector,
    dedupManager,
    memoryAdvisor,
    autoConfigRefiner,
    sessionArchiver,
    textPolisher,
    rolePackManager,
    roundSummaryGenerator,
  };
}
