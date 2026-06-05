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
 *
 * 盲点修复（P0-1/P0-2）：REPL 对话流和话题切换必须走 Agent 主流程
 * （agent.chat() / agent.switchTopic()），不再直接调用 loop/history，
 * 确保 v4.0 后处理（角色匹配/技能匹配/信号检测/轮次归档/用户画像）生效。
 */
import { createInterface, type Interface as RLInterface } from 'node:readline';
import type { Config } from '@/config/loader.js';
import { BUILTIN_TOOLS } from '@/agent/tool-executor.js';
import { toFriendlyError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';
import { Agent } from '@/agent/agent.js';
import {
  formatWelcome,
  formatHelp,
  formatToolsList,
  formatMemoriesList,
  formatRecall,
  formatThinking,
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
import pc from 'picocolors';

export interface ReplOptions {
  projectPath: string;
  config: Config;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const { projectPath, config } = opts;

  // T-201 修复：通过 Agent 门面类封装所有 memory/ 层访问
  const agent = new Agent({ projectPath, config });

  // 初始化 Agent（内部走 ProjectManager.initProject + _initProviders）
  const pctx = await agent.init();

  // 加载统计
  if (pctx.loadResult.errors.length > 0) {
    logger.warn({ errors: pctx.loadResult.errors }, '部分记忆文件加载失败');
  }

  // v1.2：Provider 管理已收归 Agent 门面类（新枝破土 · P2 分层修复）
  // REPL 不再自行创建 providers Map，所有 Provider 操作通过 Agent API：
  //   - agent.listProviders()：列出已注册 Provider
  //   - agent.getActiveProviderName()：获取当前激活的 Provider 名
  //   - agent.switchProvider(name)：切换 Provider
  //
  // 翠幕天罗 P2 修复：REPL 不再自行创建 MessageHistory / AgentLoop，
  // 直接使用 Agent 内部的 loop 和 history，避免切换项目后内外不同步。

  // 本轮工具调用记录（A-102），从 agent.chat() 的 tool_start/tool_result 事件收集
  const toolCallRecordsForTurn: ToolCallRecord[] = [];

  // 从 Agent 获取内部 history 引用（仅用于 /topic 无参数时显示当前话题名）
  let history = agent.agentHistory!;

  // 显示欢迎（M-205 美化版 + M-207 项目名 + v1.2 Provider 信息）
  console.log(
    formatWelcome({
      version: '0.1.0',
      projectPath,
      projectName: pctx.projectName,
      modelName: agent.getActiveProviderName() ?? 'unknown',
      dbPath: pctx.dbPath,
      loadedCount: pctx.loadResult.loaded,
      bootstrapCount: pctx.bootstrapMemories.length,
      skippedCount: pctx.loadResult.skipped,
      globalRulesCount: pctx.globalMemories.length,
      currentTopic: history.currentTopicName,
      activePersona: agent.getActivePersonaName(),
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
          // 切换后重新获取 Agent 内部的 history 引用
          history = agent.agentHistory!;
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

    if (input === '/topic' || input.startsWith('/topic ')) {
      const newName = input.slice('/topic'.length).trim();
      if (!newName) {
        console.log(`当前话题：${history.currentTopicName}`);
      } else {
        // P0-2 修复：走 agent.switchTopic()，确保旧话题归档 + 记忆卸载 + 轮次重置
        const newFullName = await agent.switchTopic(newName);
        // 切换后更新 history 引用（agent 内部已重建）
        history = agent.agentHistory!;
        console.log(formatSuccess(`已切换话题：${newFullName}`));
      }
      rl.prompt();
      continue;
    }

    if (input === '/topics') {
      const topics = await agent.listAllTopics();
      console.log(formatTopicsList(topics));
      rl.prompt();
      continue;
    }

    // v1.2：Provider 切换命令（通过 Agent 门面类，P2 分层修复）
    if (input === '/provider' || input.startsWith('/provider ')) {
      const name = input.slice('/provider'.length).trim();
      if (!name) {
        // 列出所有 Provider（通过 Agent API）
        const providerNames = agent.listProviders();
        const activeName = agent.getActiveProviderName();
        console.log(pc.cyan('已注册的 LLM Provider：'));
        console.log(pc.dim('─'.repeat(40)));
        for (const pName of providerNames) {
          const marker = pName === activeName ? ' *' : '  ';
          console.log(`${marker} ${pName}`);
        }
        console.log(pc.dim('─'.repeat(40)));
        console.log('* 当前激活的 Provider');
        console.log(pc.dim('切换：/provider <name>'));
        rl.prompt();
        continue;
      }

      try {
        // 通过 Agent 门面类切换 Provider
        agent.switchProvider(name);
        console.log(formatSuccess(`已切换到 Provider：「${name}」`));
      } catch (err) {
        const friendly = toFriendlyError(err);
        console.error(formatError(friendly.title, friendly.detail));
      }
      rl.prompt();
      continue;
    }

    // v1.1：角色查看/切换命令（P-6xx 角色系统）
    if (input === '/persona' || input.startsWith('/persona ')) {
      const name = input.slice('/persona'.length).trim();
      if (!name) {
        // 列出所有角色 + 当前激活状态
        const personas = agent.listPersonas();
        const activeName = agent.getActivePersonaName();
        const mode = agent.getPersonaMode();
        console.log(pc.cyan('可用角色：'));
        console.log(pc.dim('─'.repeat(40)));
        for (const p of personas) {
          const marker = p.name === activeName ? ' *' : '  ';
          const desc = p.description ? pc.dim(` — ${p.description}`) : '';
          console.log(`${marker} ${pc.bold(p.name)}${desc}`);
        }
        console.log(pc.dim('─'.repeat(40)));
        console.log(
          `* 当前角色：${pc.green(activeName || '无')}（模式：${mode === 'auto' ? '自动匹配' : '手动固定'}）`,
        );
        console.log(pc.dim('切换：/persona <name>  |  模式：/persona auto | /persona manual'));
      } else if (name === 'auto') {
        agent.setPersonaMode('auto');
        console.log(formatSuccess('已切换为自动匹配模式'));
      } else if (name === 'manual') {
        agent.setPersonaMode('manual');
        console.log(formatSuccess('已切换为手动固定模式'));
      } else {
        try {
          agent.switchPersona(name);
          console.log(formatSuccess(`已切换到角色：「${name}」`));
        } catch (err) {
          const friendly = toFriendlyError(err);
          console.error(formatError(friendly.title, friendly.detail));
        }
      }
      rl.prompt();
      continue;
    }

    // P0-1 修复：走 agent.chat() 主流程，确保 v4.0 后处理全部生效
    // （角色匹配/技能匹配/信号检测/轮次归档/用户画像/话题召回）
    // agent.chat() 内部已处理 appendUser + appendAssistant，REPL 不再手动追加

    // 重置本轮工具调用记录（A-102）
    toolCallRecordsForTurn.length = 0;

    try {
      process.stdout.write('\n');
      // 流式 Markdown 渲染（A-103）+ 工具调用可视化（从 agent.chat() 事件收集）
      const md = new MarkdownRenderer();
      for await (const chunk of agent.chat(input)) {
        if (chunk.type === 'text') {
          process.stdout.write(md.feed(chunk.content));
        } else if (chunk.type === 'thinking') {
          // 思考/进度提示：淡色输出，让用户知道 Agent 当前在做什么
          process.stderr.write(formatThinking(chunk.phase) + '\n');
        } else if (chunk.type === 'recall') {
          // 记忆召回通知：告知用户 Agent 召回了多少条相关记忆
          process.stderr.write(formatRecall(chunk.count) + '\n');
        } else if (chunk.type === 'tool_start') {
          // A-102：记录工具调用开始
          process.stderr.write(formatToolStart(chunk.name) + '\n');
          toolCallRecordsForTurn.push({
            toolName: chunk.name,
            status: 'ok',
            summary: (chunk.args ?? '').slice(0, 80),
          });
        } else if (chunk.type === 'tool_result') {
          // A-102：更新工具调用结果
          const summaryText = chunk.summary ?? '';
          process.stderr.write(formatToolResult(chunk.name, summaryText) + '\n');
          process.stderr.write(formatToolEnd(chunk.name, chunk.ok));
          const record = toolCallRecordsForTurn.find(
            (r) => r.toolName === chunk.name && r.status === 'ok' && !r.error,
          );
          if (record) {
            record.summary = `${chunk.name}: ${summaryText.slice(0, 60)}`;
            if (!chunk.ok) {
              record.status = 'failed';
              record.error = summaryText.slice(0, 80);
            }
          }
        }
      }
      process.stdout.write(md.flush());
      process.stdout.write('\n');
    } catch (err) {
      // M-103：所有错误统一包装为友好错误
      const friendly = toFriendlyError(err);
      friendly.log();
      console.error(formatError(friendly.title, friendly.detail));
    }

    // A-102：工具结果摘要
    if (toolCallRecordsForTurn.length > 0) {
      process.stdout.write(formatActionSummary(toolCallRecordsForTurn) + '\n');
    }

    rl.prompt();
  }

  // 关闭 Agent（内部关闭数据库 + 释放锁文件）
  await agent.close();
  rl.close();
}
