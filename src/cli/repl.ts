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
import { ToolExecutor, BUILTIN_TOOLS, type WriteExtensions } from '@/agent/tool-executor.js';
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
  formatActionSummary,
  formatStatPanel,
  formatMountedPanel,
  formatWarning,
  type ToolCallRecord,
} from './format.js';
import { MarkdownRenderer } from './markdown-renderer.js';
import { accumulateWrite, promptBatchWrites, type WriteAccumulator } from './diff-renderer.js';
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

  // 本轮工具调用记录（A-102），wrapToolExecutor 闭包捕获此数组引用
  const toolCallRecordsForTurn: ToolCallRecord[] = [];

  ({ history, loop } = rebuildAgentComponents(provider, projectPath, pctx, toolCallRecordsForTurn));

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

    // 新枝破土 N-101：记忆库统计面板
    if (input === '/stat') {
      try {
        const stats = await agent.getStats();
        console.log(formatStatPanel(stats));
      } catch (err) {
        const friendly = toFriendlyError(err);
        console.error(formatError(friendly.title, friendly.detail));
      }
      rl.prompt();
      continue;
    }

    // 新枝破土 N-102：查看当前挂载记忆
    if (input === '/mounted') {
      try {
        const memories = agent.getMountedMemories();
        console.log(formatMountedPanel(memories));
      } catch (err) {
        const friendly = toFriendlyError(err);
        console.error(formatError(friendly.title, friendly.detail));
      }
      rl.prompt();
      continue;
    }

    // 新枝破土 N-103：踢出指定记忆
    if (input.startsWith('/unmount')) {
      const name = input.slice('/unmount'.length).trim();
      if (!name) {
        console.log(pc.yellow('用法: /unmount <记忆名称>'));
        console.log(pc.dim('  输入 /mounted 查看当前挂载的记忆'));
        rl.prompt();
        continue;
      }
      try {
        const result = agent.unmountMemory(name);
        if (result.removed) {
          console.log(formatSuccess(`已踢出: ${result.name}`));
        } else {
          console.log(formatWarning(result.reason ?? '踢出失败'));
        }
      } catch (err) {
        const friendly = toFriendlyError(err);
        console.error(formatError(friendly.title, friendly.detail));
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
          ({ history, loop } = rebuildAgentComponents(
            provider,
            newCtx.memoraDir,
            newCtx,
            toolCallRecordsForTurn,
          ));
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
          ({ history, loop } = rebuildAgentComponents(
            provider,
            newCtx.memoraDir,
            newCtx,
            toolCallRecordsForTurn,
          ));
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

    // 重置本轮工具调用记录（A-102），wrapToolExecutor 闭包捕获的是数组引用
    toolCallRecordsForTurn.length = 0;

    let assistantContent = '';
    try {
      process.stdout.write('\n');
      // 流式 Markdown 渲染（A-103）
      const md = new MarkdownRenderer();
      for await (const chunk of loop.processUserInput(input)) {
        process.stdout.write(md.feed(chunk));
        assistantContent += chunk;
      }
      process.stdout.write(md.flush());
      process.stdout.write('\n');
    } catch (err) {
      // M-103：所有错误统一包装为友好错误
      const friendly = toFriendlyError(err);
      friendly.log();
      console.error(formatError(friendly.title, friendly.detail));
    }

    // A-102：对后结果摘要
    if (toolCallRecordsForTurn.length > 0) {
      process.stdout.write(formatActionSummary(toolCallRecordsForTurn) + '\n');
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
 * 包装 ToolExecutor，添加 M-205 工具调用可视化 + A-101 diff 确认 + A-102 记录
 */
function wrapToolExecutor(toolExec: ToolExecutor, toolCallRecords: ToolCallRecord[]) {
  return async (name: string, args: string): Promise<string> => {
    process.stderr.write(formatToolStart(name) + '\n');

    // 为 write_file 创建 diff 确认扩展（A-101）
    let extensions: WriteExtensions | undefined;
    if (name === 'write_file') {
      extensions = {
        onBeforeWrite: async (path, oldContent, newContent) => {
          const accumulators: WriteAccumulator[] = [];
          accumulateWrite(path, oldContent, newContent, accumulators);
          const ok = await promptBatchWrites(accumulators);

          // 记录摘要信息（A-102）
          const acc = accumulators[0]!;
          if (acc.diffResult.isBinary) {
            toolCallRecords.push({
              toolName: name,
              status: ok ? 'ok' : 'failed',
              summary: `${path}  ⚠二进制`,
              error: ok ? undefined : '用户拒绝写入',
            });
          } else if (acc.diffResult.isNewFile) {
            toolCallRecords.push({
              toolName: name,
              status: ok ? 'ok' : 'failed',
              summary: `${path}  新建 ${acc.diffResult.additions} 行`,
              error: ok ? undefined : '用户拒绝写入',
            });
          } else {
            toolCallRecords.push({
              toolName: name,
              status: ok ? 'ok' : 'failed',
              summary: `${path}  +${acc.diffResult.additions} −${acc.diffResult.removals}`,
              error: ok ? undefined : '用户拒绝写入',
            });
          }
          return ok;
        },
      };
    }

    try {
      const result = await toolExec.execute(name, args, extensions);
      process.stderr.write(formatToolResult(name, result) + '\n');
      process.stderr.write(formatToolEnd(name, true));

      // 记录非 write_file 工具的结果（A-102）
      // write_file 已在 onBeforeWrite 回调中记录
      if (name !== 'write_file') {
        toolCallRecords.push({
          toolName: name,
          status: 'ok',
          summary: makeToolSummary(name, args, result),
        });
      }

      return result;
    } catch (err) {
      process.stderr.write(formatToolEnd(name, false));

      // 记录失败的工具调用（A-102）
      if (name !== 'write_file') {
        toolCallRecords.push({
          toolName: name,
          status: 'failed',
          summary: makeToolSummary(name, args, ''),
          error: (err as Error).message.slice(0, 80),
        });
      }

      throw err;
    }
  };
}

/**
 * 生成工具调用的简短摘要（A-102 辅助）
 *
 * 从工具名称、参数和结果中提取关键信息，
 * 生成单行摘要（配合 ToolCallRecord.summary 使用）。
 */
function makeToolSummary(name: string, argsJson: string, result: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    // 解析失败则用空对象
  }

  switch (name) {
    case 'read_file': {
      const path = String(args['path'] ?? '?');
      const lines = result.split('\n').length;
      return `${path}  ${lines} 行`;
    }
    case 'list_dir': {
      const path = String(args['path'] ?? '.');
      const entries = result.split('\n').filter((l) => l.trim()).length;
      return `${path}  ${entries} 项`;
    }
    case 'search_memories': {
      const query = String(args['query'] ?? '?');
      const count = (result.match(/找到 (\d+) 条/) ?? [])[1] ?? '0';
      return `"${query}"  ${count} 条`;
    }
    default:
      return name;
  }
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
 * @param toolCallRecords A-102 工具调用记录数组（闭包引用，原地修改）
 */
function rebuildAgentComponents(
  provider: LlmProvider,
  projectPath: string,
  ctx: AgentBuildCtx,
  toolCallRecords: ToolCallRecord[],
): { history: MessageHistory; loop: AgentLoop } {
  const history = new MessageHistory(ctx.topicStore, createTopicSummarizer(provider));
  const toolExec = new ToolExecutor(projectPath, ctx.security, ctx.index);
  const loop = new AgentLoop({
    provider,
    bootstrapMemories: ctx.bootstrapMemories,
    toolExecutor: wrapToolExecutor(toolExec, toolCallRecords),
  });
  return { history, loop };
}

// createTopicSummarizer 已迁移到 agent 层（src/agent/topic-summarizer.ts）
// 此处保留 re-export 以兼容旧引用路径
export { createTopicSummarizer } from '@/agent/topic-summarizer.js';
