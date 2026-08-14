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
 *   - 网络搜索：FetchWebSearchProvider（Bing→DuckDuckGo 降级）
 */
import { Agent, FetchWebSearchProvider } from '@zooique/memora';
import type { ISessionStore } from '@zooique/memora';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocReviewProvider } from './llmConfig.js';
import { WorkspaceStorage } from './workspaceStorage.js';
import { WorkspaceSessionStore } from './sessionStore.js';

import type { ProviderStore } from '../providers/providerStore.js';

/** 装配参数 */
export interface AssembleDocReviewOptions {
  /** 工作区路径（memora projectPath） */
  projectPath: string;
  /** 大模型配置存储（配置面板装配后注入） */
  providerStore?: ProviderStore;
  /**
   * 会话存储（SSOT 复用：由 extension 单例注入，与 UI 面板共享同一实例）
   *
   * 不传时内部新建（独立用途/测试）。必须复用：否则 UI 面板与 Agent 各持一个
   * WorkspaceSessionStore 实例，双实例独立内存、覆盖写同一 sessions.json，
   * 会导致「UI 加载的会话记录不完整 / 互相覆盖丢消息」（无法加载会话记录根因）。
   */
  sessionStore?: ISessionStore;
  /** 环境变量（默认 process.env，便于测试注入） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 定位插件内置 skills 目录（configDir）
 *
 * 编译后本文件位于 dist/extension/host/assemble.js，上一级即 dist/extension/。
 * SkillManager 契约：configDir 是**含 skills 子目录的父目录**（内部拼 <configDir>/skills/），
 * 故此处返回 dist/extension/（而非 dist/extension/skills）——若多拼一层 skills，
 * 实际扫描将落到 dist/extension/skills/skills/ 而读不到技能（加载 count 0 根因，
 * SSOT：configDir 语义与 SkillManager 对齐）。
 */
function resolveSkillConfigDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, '..');
}

/**
 * 装配并初始化「设计文档打磨」Agent
 *
 * @returns 已 init 的 Agent 实例
 */
export async function assembleDocReviewAgent(options: AssembleDocReviewOptions): Promise<Agent> {
  const { projectPath, providerStore, sessionStore, env } = options;

  // 1. 创建 LLM Provider（宿主注入；优先配置面板的激活 Provider，回退环境变量）
  const provider = await createDocReviewProvider(providerStore, env ?? process.env);

  // 2. 创建工作区记忆存储 + 会话存储（宿主注入持久化）
  const storage = new WorkspaceStorage(projectPath);
  storage.load();
  // SSOT：复用 extension 单例 sessionStore（与 UI 面板共享同一实例，杜绝双实例覆盖写）；
  // 未注入时（独立用途/测试）才内部新建并加载。
  const store: ISessionStore =
    sessionStore ??
    (() => {
      const s = new WorkspaceSessionStore(projectPath);
      s.load();
      return s;
    })();

  // 3. 装配 Agent（薄壳，全部复用内核）
  const agent = new Agent({
    projectPath,
    // 记忆数据目录 = 工作区 .memora（注册表/锁文件落盘处，与存储同目录）
    dataDir: join(projectPath, '.memora'),
    // 配置目录 = 插件内置 skills/，加载 doc-review 技能（切片 B 自洽检查载体）
    configDir: resolveSkillConfigDir(),
    provider,
    storage,
    sessionStore: store,
    // 网络搜索（Bing→DuckDuckGo 降级，开箱即用，零依赖）
    webSearchProvider: new FetchWebSearchProvider(),
    permission: 'owner',
    allowedPaths: [projectPath],
  });

  // 4. 初始化（加载记忆/技能/会话，注册内置工具）
  await agent.init();

  return agent;
}
