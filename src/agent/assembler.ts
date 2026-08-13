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
import { UserProfile } from '@/memory/userProfile.js';
import { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import { InsightExtractor } from '@/agent/managers/insightExtractor.js';
import { RelationBuilder } from '@/agent/managers/relationBuilder.js';
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
import type { LlmProvider } from '@/llm/provider.js';
import type { ProviderRouter } from '@/llm/types.js';
import type { Memory } from '@/memory/types.js';
import type { AgentConfig, FileConsistencyCheck } from '@/agent/types.js';
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
  /** 护栏规则正则编译失败回调（宿主可据此发射 guardrailError 事件通知用户） */
  onGuardrailError?: (rule: string, message: string) => void;
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
   * 工具执行前检查回调（P3.4 补偿机制·仅一次语义）
   *
   * AgentLoop 每次工具执行前调用，检查是否已执行过。
   * 用于 outbox 模式：恢复时避免重复执行已完成的幂等工具。
   */
  preExecutionCheck?: (name: string, args: string) => { skip: boolean; previousResult?: string };
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
  | 'maxContextTokens'
  | 'sessionStore'
  | 'relationStore'
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
  | 'relationStore'
  | 'sessionStore'
  | 'locale'
  | 'callbacks'
> & {
  pctx: ProjectContext;
  personaPrompt: string;
  userProfile: UserProfile;
  toolExec: ToolExecutor;
  /** 角色包规则列表（Rule→guardrail 桥接），桥接到 guardrail 系统供运行时强制执行 */
  rolePackRules: readonly string[];
};

/**
 * Phase 4 子工厂参数：AssembleInput 共享字段 Pick 派生 + 阶段产物
 *
 * 同 LoopAndDepsParams（T-C2 收敛的第二半）。
 */
type LoopDependentParams = Pick<
  AssembleInput,
  'configDir' | 'backgroundProvider' | 'relationStore' | 'callbacks'
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
  userProfile: UserProfile;
  workProjection: WorkProjectionManager;
  skillManager: SkillManager;
  insightExtractor: InsightExtractor;
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
 *   2. 依赖 Provider 的组件：personaManager, userProfile, skillManager
 *   3. AgentLoop（依赖 toolExec + systemPromptPrefix）
 *   4. 依赖 Loop 的组件：insightExtractor, configManager, memoryInspector
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
    provider, backgroundProvider, providerRouter, pctx, personaPrompt, userProfile, toolExec,
    maxContextTokens, tracer, messages, enableContextSummary, relationStore,
    sessionStore, locale, callbacks, rolePackRules,
  } = params;

  // 系统前缀：角色 + 用户画像 + 当前时间
  const systemPrefixParts = [personaPrompt];
  const profilePrompt = userProfile.buildSystemPrompt();
  if (profilePrompt) systemPrefixParts.push(profilePrompt);
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

  const relationBuilder = new RelationBuilder(pctx.index, relationStore ?? null);
  const insightExtractor = new InsightExtractor(provider, pctx.index, relationBuilder);
  const sessionArchiver = new SessionArchiver(provider, pctx.index, sessionStore);
  const textPolisher = new TextPolishManager(backgroundProvider ?? provider);
  const roundSummaryGenerator = new RoundSummaryGenerator(provider, pctx.index);

  // Rule→guardrail 桥接：将角色包规则转换为 guardrail Memory 对象，
  // 合并到从记忆索引加载的 guardrail 规则中，供运行时强制执行。
  // 角色包规则是自然语言指令（如"不得擅自增删原文内容"），
  // 与 guardrail 系统的 regex 规则格式不同，但纳入同一规则池后
  // 未来可扩展自然语言规则匹配机制。
  const indexGuardrailRules = pctx.index.getBySource(SOURCE_LABELS.GUARDRAIL);
  const nowIso = new Date().toISOString();
  const rolePackGuardrailRules: Memory[] = rolePackRules.map((rule, i) => ({
    id: `role-pack:guardrail-${i}`,
    content: rule,
    source: 'guardrail',
    name: `role-pack-rule-${i}`,
    createdAt: nowIso,
    accessedAt: nowIso,
    score: 1.0,
  }));
  const mergedGuardrailRules = [...indexGuardrailRules, ...rolePackGuardrailRules];

  const loop = new AgentLoop({
    provider,
    providerRouter: providerRouter ?? undefined,
    bootstrapMemories: pctx.bootstrapMemories,
    toolExecutor: (name: string, args: string) =>
      toolExec.execute(name, args, insightExtractor.writeExtensions ?? undefined),
    systemPromptPrefix,
    toolDefinitions: toolExec.list,
    maxContextTokens,
    tracer,
    messages,
    enableContextSummary,
    guardrailRules: mergedGuardrailRules,
    onContextTruncated: callbacks?.onContextTruncated,
    onGuardrailError: callbacks?.onGuardrailError,
    onSessionEvent: callbacks?.onSessionEvent,
    onToolExecuted: callbacks?.onToolExecuted,
    preExecutionCheck: callbacks?.preExecutionCheck,
  });

  insightExtractor.bindGetRecentHistory((rounds: number) => loop.getRecentHistory(rounds));
  toolExec.setOnToolsChanged(() => loop.refreshToolDefinitions(toolExec.list));

  return { loop, insightExtractor, sessionArchiver, textPolisher, relationBuilder, roundSummaryGenerator };
}

/**
 * Phase 4：创建依赖 Loop 的组件
 */
function createLoopDependentComponents(params: LoopDependentParams) {
  const { pctx, loop, history, skillManager, configDir, backgroundProvider, relationStore, callbacks } = params;

  const configFileStore = configDir ? new FileStore(configDir) : null;

  // P0-1：memoryInspector 需先创建（持有 relationStore），供 ConfigManager 清理关系边
  const memoryInspector = new MemoryInspector(pctx.index, loop, history, relationStore ?? null);
  const memoryAdvisor = new MemoryAdvisor(pctx.index, backgroundProvider ?? null);
  const dedupManager = new DedupManager(pctx.index, backgroundProvider ?? null, callbacks?.onDedupCompleted);

  const configManager = new ConfigManager({
    index: pctx.index,
    skillManager,
    injectSystemMessage: (msg: string) => loop.injectSystemMessage(msg),
    // refreshBootstrapMemories 必须同步 bootstrap 段（SSOT：system prompt 与存储一致）
    refreshBootstrapMemories: () => loop.refreshBootstrapMemories(configManager.getBootstrapMemories()),
    writeConfigFile: configFileStore ? (memory: Memory) => configFileStore.write(memory) : undefined,
    // P0-1：删除配置时自动清理关联关系边
    removeRelationsByMemoryId: (memoryId: string) => memoryInspector.writeRemoveRelationsByMemoryId(memoryId),
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
    maxContextTokens,
    sessionStore,
    relationStore,
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
  );

  // ── Phase 2: 依赖 Provider 的组件 ──

  const personaManager = new PersonaManager(configDir);
  const personaPrompt = await personaManager.load(personaName);

  const userProfile = new UserProfile(pctx.index, relationStore ?? null);
  await userProfile.load();

  const skillManager = existingSkillManager ?? new SkillManager(configDir);
  await skillManager.load();

  // M1 角色包清单：创建角色包管理器，装配层自此只认"清单"不认"来源"
  // 当前角色包文件为可选，不存在时降级为 PersonaManager + SkillManager 联合
  const rolePackManager = new RolePackManager(configDir);
  await rolePackManager.load();

  // Rule→guardrail 桥接：提取当前激活角色包的规则列表，
  // 传给 createAgentLoopAndDeps 合并到 guardrail 规则池。
  const rolePackRules = rolePackManager.getActiveRules();

  // ── Phase 3: AgentLoop + 其直接依赖 ──

  const { loop, insightExtractor, sessionArchiver, textPolisher, roundSummaryGenerator } =
    await createAgentLoopAndDeps({
      provider,
      backgroundProvider,
      pctx,
      personaPrompt,
      userProfile,
      toolExec,
      maxContextTokens,
      tracer,
      messages,
      enableContextSummary,
      relationStore,
      sessionStore,
      locale,
      callbacks,
      rolePackRules,
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
      relationStore,
      callbacks,
    });

  return {
    history,
    loop,
    toolExec,
    personaManager,
    userProfile,
    workProjection,
    skillManager,
    insightExtractor,
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
