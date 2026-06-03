/**
 * REPL 主循环
 *
 * 阶段一：readline 基础实现
 * 阶段二（M-205）：升级为 ANSI 美化版
 *   - picocolors 颜色（标题/错误/成功/警告/工具调用）
 *   - box-drawing 字符包裹工具结果
 *   - 工具调用开始/结束标记
 *
 * 分层修复（T-201）：本模块不直接调用 memory/ 层。
 * 所有 memory 操作（项目、领域、记忆索引）都通过 Agent 门面类中转。
 * 话题持久化（M-002）：
 *   - 用户输入 → MessageHistory.appendUser() → TopicStore
 *   - Agent 回复 → MessageHistory.appendAssistant() → TopicStore
 *   - 切换话题：/topic <name>
 *   - 列出话题：/topics
 */
import { createInterface, type Interface as RLInterface } from 'node:readline';
import { join } from 'node:path';
import type { Config } from '@/config/loader.js';
import { createLlmProvider } from '@/llm/factory.js';
import { AgentLoop } from '@/agent/loop.js';
import { ToolExecutor, BUILTIN_TOOLS } from '@/agent/tool-executor.js';
import { MessageHistory } from '@/agent/message-history.js';
import { toFriendlyError } from '@/utils/errors.js';
import type { LlmProvider } from '@/llm/provider.js';
import { logger } from '@/logging/logger.js';
import { createTopicSummarizer } from '@/agent/topic-summarizer.js';
import { Agent, type AgentBuildCtx } from '@/agent/agent.js';
import {
  formatWelcome,
  formatHelp,
  formatToolsList,
  formatMemoriesList,
  formatTopicsList,
  formatSuccess,
  formatError,
  formatToolResult,
  formatToolStart,
  formatToolEnd,
} from './format.js';
import pc from 'picocolors';

export interface ReplOptions {
  projectPath: string;
  config: Config;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const { projectPath, config } = opts;

  // T-201 修复：通过 Agent 门面类封装所有 memory/ 层访问
  const agent = new Agent({ projectPath, config });

  // 初始化 Agent（内部走 ProjectManager.initProject）
  const pctx = await agent.init();

  let history: MessageHistory;
  let loop: AgentLoop;

  // 加载统计
  if (pctx.loadResult.errors.length > 0) {
    logger.warn({ errors: pctx.loadResult.errors }, '部分记忆文件加载失败');
  }

  // 初始化 LLM
  const provider = createLlmProvider(config);
  ({ history, loop } = rebuildAgentComponents(provider, projectPath, pctx));

  // 显示欢迎（M-205 美化版 + M-207 项目名）
  console.log(
    formatWelcome({
      version: '0.1.0',
      projectPath,
      projectName: pctx.projectName,
      modelName: provider.name,
      dbPath: join(pctx.memoraDir, 'memora.db'),
      loadedCount: pctx.loadResult.loaded,
      bootstrapCount: pctx.bootstrapMemories.length,
      skippedCount: pctx.loadResult.skipped,
      globalRulesCount: pctx.globalMemories.length,
      currentTopic: history.currentTopicName,
    }),
  );

  // REPL 循环
  const rl: RLInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    if (input === '/exit' || input === '/quit') {
      console.log(formatSuccess('再见 👋'));
      break;
    }

    if (input === '/help') {
      console.log(formatHelp());
      rl.prompt();
      continue;
    }

    if (input === '/tools') {
      console.log(formatToolsList(BUILTIN_TOOLS));
      rl.prompt();
      continue;
    }

    if (input === '/memories') {
      console.log(formatMemoriesList(pctx.bootstrapMemories));
      rl.prompt();
      continue;
    }

    if (input.startsWith('/search ')) {
      const query = input.slice('/search'.length).trim();
      if (!query) {
        console.log(pc.dim('用法：/search <关键词>'));
      } else {
        try {
          // T-201 修复：通过 Agent 门面类搜索记忆
          const results = await agent.searchMemories(query, 10);
          if (results.length === 0) {
            console.log(pc.dim(`未找到与 "${query}" 相关的记忆`));
          } else {
            console.log(pc.dim('─'.repeat(60)));
            console.log(pc.cyan(`🔍 "${query}" 搜索结果（${results.length} 条）：`));
            for (const m of results) {
              console.log(`  ${pc.yellow(m.name)} ${pc.dim(String(m.weight))} ${pc.dim(m.type)}`);
              console.log(`    ${pc.dim(m.contentPreview)}`);
            }
            console.log(pc.dim('─'.repeat(60)));
          }
        } catch (err) {
          const friendly = toFriendlyError(err);
          console.error(formatError(friendly.title, friendly.detail));
        }
      }
      rl.prompt();
      continue;
    }

    // M-207：项目切换命令（T-201 修复：通过 Agent 门面类）
    if (input === '/project' || input.startsWith('/project ')) {
      const arg = input.slice('/project'.length).trim();
      if (!arg) {
        // 无参数：显示当前项目和已注册项目列表
        try {
          const projects = agent.listProjects();
          console.log(`当前项目：${pctx.projectName}（${projectPath}）`);
          if (projects.length > 0) {
            console.log('已注册项目：');
            for (const p of projects) {
              const marker = p.path === projectPath ? ' ←' : '';
              console.log(`  ${pc.cyan(p.name)} ${pc.dim(p.path)}${marker}`);
            }
          } else {
            console.log(pc.dim('（暂无已注册项目）'));
          }
        } catch (err) {
          const friendly = toFriendlyError(err);
          console.error(formatError(friendly.title, friendly.detail));
        }
      } else {
        try {
          const newCtx = await agent.switchProject(arg);
          // 重建 history / loop（provider 复用）
          ({ history, loop } = rebuildAgentComponents(provider, newCtx.memoraDir, newCtx));
          console.log(
            formatSuccess(
              `已切换到项目：${newCtx.projectName}（${newCtx.bootstrapMemories.length} 条记忆）`,
            ),
          );
        } catch (err) {
          const friendly = toFriendlyError(err);
          console.error(formatError(friendly.title, friendly.detail));
        }
      }
      rl.prompt();
      continue;
    }

    // M-208：领域切换命令（T-201 修复：通过 Agent 门面类）
    if (input === '/domain' || input.startsWith('/domain ')) {
      const arg = input.slice('/domain'.length).trim();
      if (!arg) {
        try {
          const domains = agent.listDomains();
          console.log(`当前领域：${agent.currentDomainName}`);
          console.log(`可用领域：${domains.join(', ') || '仅默认'}`);
        } catch (err) {
          const friendly = toFriendlyError(err);
          console.error(formatError(friendly.title, friendly.detail));
        }
      } else if (arg === agent.currentDomainName) {
        console.log(formatSuccess(`已在领域 ${arg} 中`));
      } else {
        try {
          const newCtx = await agent.switchDomain(arg);
          ({ history, loop } = rebuildAgentComponents(provider, newCtx.memoraDir, newCtx));
          console.log(
            formatSuccess(
              `已切换到领域：${agent.currentDomainName}（${newCtx.bootstrapMemories.length} 条记忆）`,
            ),
          );
        } catch (err) {
          const friendly = toFriendlyError(err);
          console.error(formatError(friendly.title, friendly.detail));
        }
      }
      rl.prompt();
      continue;
    }

    if (input === '/topic' || input.startsWith('/topic ')) {
      const newName = input.slice('/topic'.length).trim();
      if (!newName) {
        console.log(`当前话题：${history.currentTopicName}`);
      } else {
        const newFullName = history.switchTopic(newName);
        console.log(formatSuccess(`已切换话题：${newFullName}`));
      }
      rl.prompt();
      continue;
    }

    if (input === '/topics') {
      const topics = await history.listAllTopics();
      console.log(formatTopicsList(topics));
      rl.prompt();
      continue;
    }

    // 用户输入 → 通过 MessageHistory 追加到话题文件
    await history.appendUser(input);

    // 用户输入 → Agent Loop
    let assistantContent = '';
    try {
      process.stdout.write('\n');
      for await (const chunk of loop.processUserInput(input)) {
        process.stdout.write(chunk);
        assistantContent += chunk;
      }
      process.stdout.write('\n\n');
    } catch (err) {
      // M-103：所有错误统一包装为友好错误
      const friendly = toFriendlyError(err);
      friendly.log();
      console.error(formatError(friendly.title, friendly.detail));
    }

    // Agent 回复 → 通过 MessageHistory 追加到话题文件
    await history.appendAssistant(assistantContent);

    rl.prompt();
  }

  // 关闭 Agent（内部关闭数据库 + 释放锁文件）
  await agent.close();
  rl.close();
}

/**
 * 包装 ToolExecutor，添加 M-205 工具调用可视化
 */
function wrapToolExecutor(toolExec: ToolExecutor) {
  return async (name: string, args: string): Promise<string> => {
    process.stderr.write(formatToolStart(name) + '\n');
    try {
      const result = await toolExec.execute(name, args);
      process.stderr.write(formatToolResult(name, result) + '\n');
      process.stderr.write(formatToolEnd(name, true));
      return result;
    } catch (err) {
      process.stderr.write(formatToolEnd(name, false));
      throw err;
    }
  };
}

/**
 * 重建 Agent 组件
 *
 * 在项目切换、领域切换时，需要重建所有依赖 ctx 的组件：
 * MessageHistory、ToolExecutor、AgentLoop
 *
 * @param provider LLM 提供者
 * @param projectPath 当前项目路径
 * @param ctx 领域上下文（来自 Agent 门面类的 pctx）
 */
function rebuildAgentComponents(
  provider: LlmProvider,
  projectPath: string,
  ctx: AgentBuildCtx,
): { history: MessageHistory; loop: AgentLoop } {
  const history = new MessageHistory(ctx.topicStore, createTopicSummarizer(provider));
  const toolExec = new ToolExecutor(projectPath, ctx.security, ctx.index);
  const loop = new AgentLoop({
    provider,
    bootstrapMemories: ctx.bootstrapMemories,
    toolExecutor: wrapToolExecutor(toolExec),
  });
  return { history, loop };
}

// createTopicSummarizer 已迁移到 agent 层（src/agent/topic-summarizer.ts）
// 此处保留 re-export 以兼容旧引用路径
export { createTopicSummarizer } from '@/agent/topic-summarizer.js';
