/**
 * Agent 装配层 — 薄壳装配（ADR-VC-001 决策 2/3）
 *
 * 职责：
 *   - 复用 memora 内核 Agent 门面，注入宿主侧 provider + 存储 + 会话
 *   - 不重复实现内核能力（薄壳 + 装配）
 *
 * 装配：
 *   - LLM Provider：createDocReviewProvider（环境变量）
 *   - 记忆存储：WorkspaceStorage（.memora/memories.json）
 *   - 会话存储：WorkspaceSessionStore（.memora/sessions.json）
 */
import { Agent } from '@zooique/memora';
import { createDocReviewProvider } from './llmConfig.js';
import { WorkspaceStorage } from './workspaceStorage.js';
import { WorkspaceSessionStore } from './sessionStore.js';

/** 装配参数 */
export interface AssembleDocReviewOptions {
  /** 工作区路径（memora projectPath） */
  projectPath: string;
  /** 环境变量（默认 process.env，便于测试注入） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 装配并初始化「设计文档打磨」Agent
 *
 * @returns 已 init 的 Agent 实例
 */
export async function assembleDocReviewAgent(options: AssembleDocReviewOptions): Promise<Agent> {
  const { projectPath, env } = options;

  // 1. 创建 LLM Provider（宿主注入）
  const provider = createDocReviewProvider(env ?? process.env);

  // 2. 创建工作区记忆存储 + 会话存储（宿主注入持久化）
  const storage = new WorkspaceStorage(projectPath);
  storage.load();
  const sessionStore = new WorkspaceSessionStore(projectPath);
  sessionStore.load();

  // 3. 装配 Agent（薄壳，全部复用内核）
  const agent = new Agent({
    projectPath,
    provider,
    storage,
    sessionStore,
    permission: 'owner',
    allowedPaths: [projectPath],
    // 阶段 0：省略 configDir（不加载角色包），用内核默认 persona；后续阶段再接入
  });

  // 4. 初始化（加载记忆/技能/会话，注册内置工具）
  await agent.init();

  return agent;
}
