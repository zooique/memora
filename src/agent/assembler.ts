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
import type { LlmProvider } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type { IMemoryRelationStore } from '@/memory/relationStore.js';
import type { ITracer } from '@/agent/tracer.js';
import type { UIMessages } from '@/agent/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import { configError } from '@/utils/errors.js';
// FileStore 用于 configDir 存在时创建 config 级文件存储，
// 供 ConfigManager.confirmConfigSuggestion 写入配置文件（真理源）
import { FileStore } from '@/memory/store.js';

/** 组装器输入参数 */
export interface AssembleInput {
  provider: LlmProvider;
  backgroundProvider: LlmProvider | null;
  projectPath: string;
  configDir: string | undefined;
  personaName: string | undefined;
  maxContextTokens: number;
  sessionStore: ISessionStore | undefined;
  /** 记忆关系存储（可选，ADR-014 侧车模型，不传则跳过关系构建） */
  relationStore: IMemoryRelationStore | undefined;
  tracer: ITracer | undefined;
  messages: UIMessages | undefined;
  enableContextSummary: boolean;
  /** 已有的 SkillManager（首次为 null，后续复用） */
  existingSkillManager: SkillManager | null;
  /**
   * systemPrompt 时间注入的 locale（默认 AGENT_CONSTANTS.DEFAULT_LOCALE = 'zh-CN'）。
   * 注入此字段可覆盖默认 locale，实现国际化时间格式。
   */
  locale?: string;
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
}

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
async function createAgentLoopAndDeps(params: {
  provider: LlmProvider;
  backgroundProvider: LlmProvider | null;
  pctx: ProjectContext;
  personaPrompt: string;
  userProfile: UserProfile;
  toolExec: ToolExecutor;
  maxContextTokens: number;
  tracer?: ITracer;
  messages?: UIMessages;
  enableContextSummary: boolean;
  relationStore?: IMemoryRelationStore;
  sessionStore?: ISessionStore;
  locale?: string;
  onContextTruncated?: (skippedCount: number, keptCount: number) => void;
  onGuardrailError?: (rule: string, message: string) => void;
  onSessionEvent?: (eventType: string, detail: string) => void;
  onToolExecuted?: (name: string, args: string, result: string, ok: boolean) => void;
  preExecutionCheck?: (name: string, args: string) => { skip: boolean; previousResult?: string };
}) {
  const {
    provider, backgroundProvider, pctx, personaPrompt, userProfile, toolExec,
    maxContextTokens, tracer, messages, enableContextSummary, relationStore,
    sessionStore, locale, onContextTruncated, onGuardrailError, onSessionEvent,
    onToolExecuted, preExecutionCheck,
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

  const loop = new AgentLoop({
    provider,
    bootstrapMemories: pctx.bootstrapMemories,
    toolExecutor: (name: string, args: string) =>
      toolExec.execute(name, args, insightExtractor.writeExtensions ?? undefined),
    systemPromptPrefix,
    toolDefinitions: toolExec.list,
    maxContextTokens,
    tracer,
    messages,
    enableContextSummary,
    guardrailRules: pctx.index.getBySource(SOURCE_LABELS.GUARDRAIL),
    onContextTruncated,
    onGuardrailError,
    onSessionEvent,
    onToolExecuted,
    preExecutionCheck,
  });

  insightExtractor.bindGetRecentHistory((rounds: number) => loop.getRecentHistory(rounds));
  toolExec.setOnToolsChanged(() => loop.refreshToolDefinitions(toolExec.list));

  return { loop, insightExtractor, sessionArchiver, textPolisher, relationBuilder };
}

/**
 * Phase 4：创建依赖 Loop 的组件
 */
function createLoopDependentComponents(params: {
  pctx: ProjectContext;
  loop: AgentLoop;
  history: MessageHistory;
  skillManager: SkillManager;
  configDir?: string;
  backgroundProvider: LlmProvider | null;
  relationStore?: IMemoryRelationStore;
  onDedupCompleted?: (report: {
    scannedCount: number; pairCount: number; deduplicatedCount: number; demotedIds: string[];
  }) => void;
}) {
  const { pctx, loop, history, skillManager, configDir, backgroundProvider, relationStore, onDedupCompleted } = params;

  const configFileStore = configDir ? new FileStore(configDir) : null;
  const configManager = new ConfigManager(
    pctx.index,
    skillManager,
    (msg: string) => loop.injectSystemMessage(msg),
    configFileStore ? (memory: Memory) => configFileStore.write(memory) : undefined,
    () => loop.refreshBootstrapMemories(configManager.getBootstrapMemories()),
  );

  const memoryAdvisor = new MemoryAdvisor(pctx.index, backgroundProvider ?? null);
  const memoryInspector = new MemoryInspector(pctx.index, loop, history, relationStore ?? null);
  const dedupManager = new DedupManager(pctx.index, backgroundProvider ?? null, onDedupCompleted);

  const autoConfigRefiner = new AutoConfigRefiner((suggestion) =>
    configManager.suggestionCallback?.(suggestion),
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

  // ── Phase 1: 无依赖组件 ──

  // Agent 层总是注入 createSecurityGuard，此处显式校验并收窄类型
  if (!pctx.security) {
    throw configError('security guard 未注入', undefined, ['检查 AgentOptions.permission 或 createSecurityGuard 配置']);
  }

  const history = new MessageHistory(sessionStore);

  const workProjection = new WorkProjectionManager(pctx.index, backgroundProvider ?? provider, input.onWorkProjectionGenerated);

  const toolExec = new ToolExecutor(
    projectPath,
    pctx.security,
    pctx.index,
    workProjection,
    configDir,
  );

  // ── Phase 2: 依赖 Provider 的组件 ──

  const personaManager = new PersonaManager(configDir);
  const personaPrompt = await personaManager.load(personaName);

  const userProfile = new UserProfile(pctx.index);
  await userProfile.load();

  const skillManager = existingSkillManager ?? new SkillManager(configDir);
  await skillManager.load();

  // ── Phase 3: AgentLoop + 其直接依赖 ──

  const { loop, insightExtractor, sessionArchiver, textPolisher } =
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
      onContextTruncated: input.onContextTruncated,
      onGuardrailError: input.onGuardrailError,
      onSessionEvent: input.onSessionEvent,
      onToolExecuted: input.onToolExecuted,
      preExecutionCheck: input.preExecutionCheck,
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
      onDedupCompleted: input.onDedupCompleted,
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
  };
}
