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

import { AgentLoop } from './loop.js';
import { ToolExecutor } from './toolExecutor.js';
import { MessageHistory } from './messageHistory.js';
import type { ProjectContext } from '@/memory/projectManager.js';
import { PersonaManager } from '@/persona/personaManager.js';
import { UserProfile } from '@/memory/userProfile.js';
import { WorkProjectionManager } from './workProjection.js';
import { SkillManager } from '@/skill/skillManager.js';
import { InsightExtractor } from './insightExtractor.js';
import { ConfigManager } from './configManager.js';
import { MemoryInspector } from './memoryInspector.js';
import { AutoConfigRefiner } from './autoConfigRefiner.js';
import type { LlmProvider } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type { ITracer } from './tracer.js';
import type { UIMessages } from './types.js';
import { SOURCE_LABELS } from '@/memory/types.js';

/** 组装器输入参数 */
export interface AssembleInput {
  provider: LlmProvider;
  backgroundProvider: LlmProvider | null;
  projectPath: string;
  configDir: string | undefined;
  personaName: string | undefined;
  maxContextTokens: number;
  sessionStore: ISessionStore | undefined;
  tracer: ITracer | undefined;
  messages: UIMessages | undefined;
  enableContextSummary: boolean;
  /** 已有的 SkillManager（首次为 null，后续复用） */
  existingSkillManager: SkillManager | null;
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
  /** 角色激活后的 system prompt */
  personaPrompt: string;
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
    tracer,
    messages,
    enableContextSummary,
    existingSkillManager,
  } = input;

  // ── Phase 1: 无依赖组件 ──

  const history = new MessageHistory(pctx.index, sessionStore);

  const workProjection = new WorkProjectionManager(
    pctx.index,
    backgroundProvider ?? provider,
  );

  const toolExec = new ToolExecutor(
    projectPath,
    pctx.security!, // A-004: Agent 层总是注入 createSecurityGuard，security 不为 null
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
  const systemPromptPrefix =
    systemPrefixParts.filter(Boolean).join('\n\n') +
    (systemPrefixParts.length > 0 ? '\n\n---\n\n' : '');

  // InsightExtractor 的 writeExtensions 在运行时由 Agent.chat() 设置
  // getRecentHistory 在 AgentLoop 创建后通过 bindGetRecentHistory 注入（消除 loopRef 闭包）
  const insightExtractor = new InsightExtractor(provider, pctx.index);

  const loop = new AgentLoop({
    provider,
    bootstrapMemories: pctx.bootstrapMemories,
    toolExecutor: (name: string, args: string) =>
      toolExec.execute(
        name,
        args,
        insightExtractor.writeExtensions ?? undefined,
      ),
    systemPromptPrefix,
    toolDefinitions: toolExec.getToolDefinitions(),
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

  const memoryInspector = new MemoryInspector(pctx.index, loop, history);

  // V-201: AutoConfigRefiner（模式 3：Agent 智能总结）
  const autoConfigRefiner = new AutoConfigRefiner(
    (suggestion) => configManager.suggestionCallback?.(suggestion),
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
    personaPrompt,
  };
}
