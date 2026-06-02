/**
 * REPL 主循环
 *
 * 阶段一：readline 基础实现
 * 阶段二（M-205）：升级为 ANSI 美化版
 *   - picocolors 颜色（标题/错误/成功/警告/工具调用）
 *   - box-drawing 字符包裹工具结果
 *   - 工具调用开始/结束标记
 *
 * 分层（T-101 修复）：本模块只调 agent 层的 MessageHistory，不直接调 memory 层的 TopicStore
 * 话题持久化（M-002）：
 *   - 用户输入 → MessageHistory.appendUser() → TopicStore
 *   - Agent 回复 → MessageHistory.appendAssistant() → TopicStore
 *   - 切换话题：/topic <name>
 *   - 列出话题：/topics
 */
import { createInterface, type Interface as RLInterface } from 'node:readline';
import { join } from 'node:path';
import type { Config } from '../config/loader.js';
import { createLlmProvider } from '../llm/factory.js';
import { AgentLoop } from '../agent/loop.js';
import { ToolExecutor, BUILTIN_TOOLS } from '../agent/tool-executor.js';
import { MessageHistory } from '../agent/message-history.js';
import { ProjectManager } from '../memory/project-manager.js';
import { toFriendlyError } from '../utils/errors.js';
import type { TopicMessage } from '../memory/types.js';
import type { LlmProvider, Message } from '../llm/provider.js';
import type { MemoryIndex } from '../memory/index.js';
import type { TopicStore } from '../memory/topic-store.js';
import type { SecurityGuard } from '../security/path-guard.js';
import type { Memory } from '../memory/types.js';
import { logger } from '../logging/logger.js';
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

  // M-207：使用 ProjectManager 管理多项目并发
  const projectManager = new ProjectManager(config);
  let pctx = await projectManager.initProject(projectPath);

  let ctx = {
    domainName: 'default',
    memoraDir: pctx.memoraDir,
    fileStore: pctx.fileStore,
    index: pctx.index,
    topicStore: pctx.topicStore,
    security: pctx.security,
    bootstrapMemories: pctx.bootstrapMemories,
    loadResult: pctx.loadResult,
  };

  if (ctx.loadResult.errors.length > 0) {
    logger.warn({ errors: ctx.loadResult.errors }, '部分记忆文件加载失败');
  }

  // 初始化 LLM（先于 history，因为 summarizer 需要 provider 引用）
  const provider = createLlmProvider(config);

  // 根据项目上下文创建可切换的组件
  let currentProjectPath = projectPath;
  let { history, loop } = rebuildAgentComponents(provider, currentProjectPath, ctx);

  // 显示欢迎（M-205 美化版 + M-207 项目名）
  console.log(
    formatWelcome({
      version: '0.1.0',
      projectPath,
      projectName: pctx.projectName,
      modelName: provider.name,
      dbPath: join(ctx.memoraDir, 'memora.db'),
      loadedCount: ctx.loadResult.loaded,
      bootstrapCount: ctx.bootstrapMemories.length,
      skippedCount: ctx.loadResult.skipped,
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
      console.log(formatMemoriesList(ctx.bootstrapMemories));
      rl.prompt();
      continue;
    }

    if (input.startsWith('/search ')) {
      const query = input.slice('/search'.length).trim();
      if (!query) {
        console.log(pc.dim('用法：/search <关键词>'));
      } else {
        try {
          const results = await ctx.index.search(query, 10);
          if (results.length === 0) {
            console.log(pc.dim(`未找到与 "${query}" 相关的记忆`));
          } else {
            console.log(pc.dim('─'.repeat(60)));
            console.log(pc.cyan(`🔍 "${query}" 搜索结果（${results.length} 条）：`));
            for (const m of results) {
              console.log(`  ${pc.yellow(m.name)} ${pc.dim(String(m.weight))} ${pc.dim(m.type)}`);
              // 截断长内容
              const preview = m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content;
              console.log(`    ${pc.dim(preview)}`);
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

    // M-207：项目切换命令
    if (input === '/project' || input.startsWith('/project ')) {
      const arg = input.slice('/project'.length).trim();
      if (!arg) {
        // 无参数：显示当前项目和已注册项目列表
        const projects = projectManager.listProjects();
        console.log(`当前项目：${pctx.projectName}（${currentProjectPath}）`);
        if (projects.length > 0) {
          console.log('已注册项目：');
          for (const p of projects) {
            const marker = p.path === currentProjectPath ? ' ←' : '';
            console.log(`  ${pc.cyan(p.name)} ${pc.dim(p.path)}${marker}`);
          }
        } else {
          console.log(pc.dim('（暂无已注册项目）'));
        }
      } else {
        // 切换项目：arg 可以是项目名称或路径
        const projects = projectManager.listProjects();
        const target = projects.find((p) => p.name === arg || p.path === arg);
        if (!target) {
          console.log(formatError(`未找到项目：${arg}`, '使用 /project 查看已注册项目'));
        } else if (target.path === currentProjectPath) {
          console.log(formatSuccess(`已在项目 ${target.name} 中`));
        } else {
          try {
            pctx = await projectManager.initProject(target.path, target.name);
            ctx = {
              domainName: 'default',
              memoraDir: pctx.memoraDir,
              fileStore: pctx.fileStore,
              index: pctx.index,
              topicStore: pctx.topicStore,
              security: pctx.security,
              bootstrapMemories: pctx.bootstrapMemories,
              loadResult: pctx.loadResult,
            };
            currentProjectPath = target.path;
            ({ history, loop } = rebuildAgentComponents(provider, currentProjectPath, ctx));
            console.log(
              formatSuccess(
                `已切换到项目：${pctx.projectName}（${ctx.bootstrapMemories.length} 条记忆）`,
              ),
            );
          } catch (err) {
            const friendly = toFriendlyError(err);
            console.error(formatError(friendly.title, friendly.detail));
          }
        }
      }
      rl.prompt();
      continue;
    }

    // M-208：领域切换命令
    if (input === '/domain' || input.startsWith('/domain ')) {
      const arg = input.slice('/domain'.length).trim();
      if (!arg) {
        // 无参数：显示当前领域和可用领域列表
        const domains = pctx.domainManager.listDomains();
        console.log(`当前领域：${ctx.domainName}`);
        console.log(`可用领域：${domains.join(', ') || '仅默认'}`);
      } else if (arg === ctx.domainName) {
        console.log(formatSuccess(`已在领域 ${arg} 中`));
      } else {
        try {
          ctx = await pctx.domainManager.switchDomain(arg);
          // 重建所有依赖领域上下文的组件
          ({ history, loop } = rebuildAgentComponents(provider, currentProjectPath, ctx));
          console.log(
            formatSuccess(
              `已切换到领域：${ctx.domainName}（${ctx.bootstrapMemories.length} 条记忆）`,
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

  // M-207：通过 ProjectManager 关闭项目（释放锁文件 + 关闭数据库）
  await projectManager.closeProject();
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
 * 重建 Agent 组件（M-209 剪枝：消除 3 处重复）
 *
 * 在项目切换、领域切换时，需要重建所有依赖 ctx 的组件：
 * MessageHistory、ToolExecutor、AgentLoop
 *
 * @param provider LLM 提供者
 * @param projectPath 当前项目路径
 * @param ctx 领域上下文
 */
function rebuildAgentComponents(
  provider: LlmProvider,
  projectPath: string,
  ctx: {
    topicStore: TopicStore;
    security: SecurityGuard;
    index: MemoryIndex;
    bootstrapMemories: Memory[];
  },
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

/**
 * 创建话题摘要生成器（M-203-改 · M-209 记忆归档原则 v0.3）
 *
 * 设计：回调模式，避免在 MessageHistory 中硬依赖 LlmProvider
 * 策略：
 *   - 收集完整对话（user + assistant），截断到 800 字
 *   - 结构化提取：LLM 输出 JSON {约束/偏好/决策} → 格式化为可读文本
 *   - 低价值对话返回 null（跳过归档）
 *   - JSON 解析失败时降级为原始文本
 * 失败不抛出（fire-and-forget 模式，log 即可）
 *
 * @param provider LLM 提供者
 * @returns TopicSummarizer 回调函数
 */
export function createTopicSummarizer(
  provider: LlmProvider,
): (messages: TopicMessage[]) => Promise<string | null> {
  return async (messages: TopicMessage[]): Promise<string | null> => {
    // 收集完整对话（user + assistant），截断到 800 字以免 prompt 过长
    const conversation = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n')
      .slice(0, 800);

    const promptMessages: Message[] = [
      {
        role: 'system',
        content: `你是记忆价值评估与结构化提取助手。分析以下对话，提取用户独有的信息。

判断标准（记忆归档原则 v0.3 · 结构化）：
- 约束：用户透露的技术栈、环境限制、项目配置（大模型不知道的信息）
- 偏好：用户的代码风格偏好、工作流偏好、审美偏好、命名习惯
- 决策：用户做出的会影响未来交互的架构选型、策略决定

输出格式（严格 JSON，不含 markdown 代码块标记）：
- 对话全是通用问答/闲聊，无任何独有信息 → 只输出 SKIP
- 否则输出：{"约束":["..."], "偏好":["..."], "决策":["..."]}
- 空数组的字段可省略
- 每条 10-20 字，只提取用户独有的信息，不包含 LLM 已知的通用知识`,
      },
      { role: 'user', content: conversation },
    ];

    let result = '';
    for await (const chunk of provider.chat(promptMessages, { maxTokens: 150 })) {
      if (chunk.content) result += chunk.content;
    }
    const trimmed = result.trim();

    // LLM 返回 SKIP 或空白 → 低价值，不归档
    if (
      trimmed.toUpperCase() === 'SKIP' ||
      trimmed.toUpperCase().startsWith('SKIP') ||
      trimmed.length === 0
    ) {
      return null;
    }

    // v0.3：尝试解析结构化 JSON，格式化为可读文本存储
    try {
      const parsed = JSON.parse(trimmed) as Record<string, string[]>;
      const parts: string[] = [];
      if (parsed['约束']?.length) parts.push('约束：' + parsed['约束'].join('；'));
      if (parsed['偏好']?.length) parts.push('偏好：' + parsed['偏好'].join('；'));
      if (parsed['决策']?.length) parts.push('决策：' + parsed['决策'].join('；'));
      if (parts.length > 0) return parts.join(' | ');
    } catch {
      // JSON 解析失败，降级使用原始文本
    }

    return trimmed;
  };
}
