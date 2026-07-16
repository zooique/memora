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

  const workProjection = new WorkProjectionManager(pctx.index, backgroundProvider ?? provider);

  const toolExec = new ToolExecutor(
    projectPath,
    pctx.security,
    pctx.index,
    workProjection,
  );

  // ── Phase 2: 依赖 Provider 的组件 ──

  const personaManager = new PersonaManager(configDir, pctx.index);
  const personaPrompt = await personaManager.load(personaName);

  const userProfile = new UserProfile(pctx.index);
  await userProfile.load();

  const skillManager = existingSkillManager ?? new SkillManager(configDir, pctx.index);
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
  });
  insightExtractor.bindGetRecentHistory((rounds: number) => loop.getRecentHistory(rounds));

  // ── Phase 4: 依赖 Loop 的组件 ──

  const fileStore = pctx.fileStore;
  const configManager = new ConfigManager(
    pctx.index,
    skillManager,
    (msg: string) => loop.injectSystemMessage(msg),
    configDir ? (memory: Memory) => fileStore.write(memory) : undefined,
  );

  // MemoryAdvisor 在组合根装配，显式注入 MemoryInspector（组合根一致性）
  // advisor（必填）移到 relationStore（可选）之前，参数顺序符合"必填在前"惯例
  // L3 冲突检测：注入 backgroundProvider 到 MemoryAdvisor（可选，未注入时 detectConflicts 静默跳过）
  const memoryAdvisor = new MemoryAdvisor(pctx.index, backgroundProvider ?? null);
  // L1 语义去重：注入 backgroundProvider 到 MemoryInspector（可选，未注入时 deduplicateMemories 静默跳过）
  const memoryInspector = new MemoryInspector(
    pctx.index,
    loop,
    history,
    memoryAdvisor,
    relationStore ?? null,
    backgroundProvider ?? null,
  );

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
    autoConfigRefiner,
    sessionArchiver,
    textPolisher,
  };
}
