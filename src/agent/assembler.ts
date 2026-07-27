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

  // ── Phase 3: AgentLoop ──

  const systemPrefixParts = [personaPrompt];
  const profilePrompt = userProfile.buildSystemPrompt();
  if (profilePrompt) systemPrefixParts.push(profilePrompt);

  // 注入当前时间（让 Agent 知道实时时间，避免 LLM 知识截止日期滞后）
  // locale 可通过 AssembleInput.locale 注入（默认 'zh-CN'），实现国际化时间格式
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

  const systemPromptPrefix =
    systemPrefixParts.filter(Boolean).join('\n\n') +
    (systemPrefixParts.length > 0 ? '\n\n---\n\n' : '');

  // InsightExtractor 的 writeExtensions 在运行时由 Agent.chat() 设置
  // getRecentHistory 在 AgentLoop 创建后通过 bindGetRecentHistory 注入（消除 loopRef 闭包）
  // RelationBuilder 封装 ADR-014 关系构建逻辑，InsightExtractor 通过委托调用
  // relationStore 可选注入 RelationBuilder，未注入时跳过关系构建（降级优先）
  const relationBuilder = new RelationBuilder(pctx.index, relationStore ?? null);
  const insightExtractor = new InsightExtractor(provider, pctx.index, relationBuilder);

  // SessionArchiver（会话内容归档器，content 类记忆）
  // 与 InsightExtractor 同模式：构造时注入 provider + storage + sessionStore
  const sessionArchiver = new SessionArchiver(provider, pctx.index, sessionStore);

  // TextPolishManager（文本润色管理器，LLM 语法修正 + 表达优化）
  // 优先后台 Provider（不阻塞前台对话），降级前台（参照 WorkProjectionManager）
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
    onContextTruncated: input.onContextTruncated,
    onGuardrailError: input.onGuardrailError,
  });
  insightExtractor.bindGetRecentHistory((rounds: number) => loop.getRecentHistory(rounds));

  // 将 registerTool 的副作用链接到 AgentLoop，每次注册工具后自动刷新 system prompt 中的工具列表
  toolExec.setOnToolsChanged(() => loop.refreshToolDefinitions(toolExec.list));

  // ── Phase 4: 依赖 Loop 的组件 ──

  // ConfigManager 的 writeConfigFile 回调必须使用 config 级 FileStore（configDir），
  // 与设置面板 CRUD + personaWatcher 热重载路径一致，创建后立即可见
  const configFileStore = configDir ? new FileStore(configDir) : null;
  const configManager = new ConfigManager(
    pctx.index,
    skillManager,
    (msg: string) => loop.injectSystemMessage(msg),
    configFileStore ? (memory: Memory) => configFileStore.write(memory) : undefined,
    // 设定 CRUD 同步回调：ConfigManager.deleteRule/updateRule/deleteSkill 执行后，
    // 调用 loop.refreshBootstrapMemories 用最新的 rule+skill 记忆重建 system prompt bootstrap 段
    // 闭包内引用 configManager 自身——TS 严格模式允许（闭包执行时机晚于 const 初始化）
    () => loop.refreshBootstrapMemories(configManager.getBootstrapMemories()),
  );

  // MemoryAdvisor 在组合根装配（sourceHealth + suggest + detectConflicts 均由 Agent 直连）
  // L3 冲突检测：注入 backgroundProvider 到 MemoryAdvisor（可选，未注入时 detectConflicts 静默跳过）
  const memoryAdvisor = new MemoryAdvisor(pctx.index, backgroundProvider ?? null);
  // FIX-P1-3：MemoryInspector 不再注入 advisor，sourceHealth/suggest 由 Agent 直接委托 advisor
  // SPLIT-3 后 inspector 已回归纯存储读写，构造参数仅剩 relationStore（可选侧车）
  const memoryInspector = new MemoryInspector(
    pctx.index,
    loop,
    history,
    relationStore ?? null,
  );
  // L1 语义去重：注入 backgroundProvider 到 DedupManager（可选，未注入时 deduplicateMemories 静默跳过）
  const dedupManager = new DedupManager(pctx.index, backgroundProvider ?? null, input.onDedupCompleted);

  // AutoConfigRefiner（模式 3：Agent 智能总结）
  const autoConfigRefiner = new AutoConfigRefiner((suggestion) =>
    configManager.suggestionCallback?.(suggestion),
  );
  autoConfigRefiner.setBackgroundProvider(backgroundProvider);

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
