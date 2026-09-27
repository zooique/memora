/**
 * 命令：运行能力演示（隔离开箱即用，Output Channel 输出）
 *
 * 目的：让用户「一键看到内核能力」——在全局隔离演示区（~/.memora-demo）装配独立
 * Agent，注入编排好的演示提示词，消费 agent.chat() 流式写入 output channel，结束后
 * dump 操作流（ITracer span 标签）；累计指标的展示收敛在对话面板透明区（memora.showMetrics），
 * 演示区不重复渲染。完整展示内核的角色包 / loop / 记忆 / 工具 / 可观测五大能力。
 *
 * 隔离设计（关键）：
 *   - projectPath 指向全局隔离目录（~/.memora-demo），不与当前工作区共用记忆/会话/
 *     注册表/锁文件——演示产物绝不污染用户真实项目。
 *   - 不传 sessionStore → assembleAgent 内部新建独立 WorkspaceSessionStore，不与
 *     主面板单例共享，双实例不写同一文件。
 *   - 复用 vscodeTracer 单例（ITracer 采集不落盘，trace 仅在内存缓冲展示，安全）。
 *
 * 薄壳纪律（ADR-VC-001）：只消费内核能力，零内核改动、零新 UI、无范围外优化。
 */
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Agent, AgentChunk } from '@zooique/memora';
import { assembleAgent } from '../host/assemble.js';
import { vscodeTracer } from '../host/tracer.js';

/** 全局隔离演示区目录名（存入用户主目录，彻底隔离于任意工作区） */
const DEMO_DIR_NAME = '.memora-demo';

/**
 * 演示提示词（编排多阶段，触发内核多能力）
 *
 * 编排思路：
 *   1. 召回阶段：提问触发记忆召回（首次演示区无记忆，展示空召回→后续可沉淀，属正常）；
 *   2. 工具阶段：要求联网搜索＋真实抓取，触发 web_search / web_fetch 工具调用；
 *   3. 记忆阶段：要求把要点写入演示区文件并作结，触发 write_file + 收尾摘要沉淀记忆；
 *   4. 观察阶段：透明面板 / output channel 实时呈现工具卡片、操作流、指纹与指标。
 *
 * 注意：演示区 Agent 的 allowedPaths 已由 assembleAgent 限定为隔离 projectPath，
 * LLM 写入文件只落在演示区内，不会越界（内核 pathGuard 保证）。
 */
const DEMO_PROMPT = `这是一次 Memora 内核能力演示，请按以下步骤执行并清晰展示每一步：
1. 先用联网搜索工具（web_search）搜索「Memora AI Agent 框架」的最新介绍；
2. 抓取一个真实结果的正文（web_fetch）；
3. 根据抓取内容，用写文件工具（write_file）把一段要点摘要写入当前演示工作区的
   demo-summary.md 文件；
4. 读回该文件确认写入成功（read_file）；
5. 最后用中文总结：本轮你使用了哪些工具、各自作用，以及你观察到的流程。
请逐步完成，不要一次性跳过步骤。`;

/**
 * 运行 Memora 能力演示（输出到 Output Channel）
 *
 * @param configDir 插件内置配置目录（内置角色包所在，随 extension.ts 注入）
 * @returns Promise<void>
 */
export async function runDemoCommand(configDir: string): Promise<void> {
  // 创建 output channel（唯一演示出口，纯文本视图，改动最小）
  const output = vscode.window.createOutputChannel('Memora 演示');
  output.show(true);

  const header = () => {
    output.appendLine('═'.repeat(48));
    output.appendLine('Memora 内核能力演示');
    output.appendLine('═'.repeat(48));
  };
  header();

  // 隔离演示区路径（全局主目录下，与任何工作区隔离）
  const demoPath = join(homedir(), DEMO_DIR_NAME);
  output.appendLine(`• 隔离演示区：${demoPath}`);
  try {
    mkdirSync(demoPath, { recursive: true });
  } catch (err) {
    output.appendLine(`✖ 无法创建演示区：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let agent: Agent;
  try {
    // 独立装配（不传 sessionStore → 内部独立会话存储，不共享主面板单例；含搜索/抓取/存储/tracer）
    agent = await assembleAgent({
      projectPath: demoPath,
      // dataDir 由 assembleAgent 内部 = join(projectPath, '.memora')，落演示区内
      configDir,
    });
    await agent.init();
    output.appendLine('• Agent 装配完成：角色包已加载，内置工具已注册');
  } catch (err) {
    output.appendLine(`✖ Agent 装配失败：${err instanceof Error ? err.message : String(err)}`);
    output.appendLine('  请先在设置中配置并激活一个可用的大模型（memora.configureModel）。');
    return;
  }

  output.appendLine('');
  output.appendLine('▶ 演示提示词：');
  output.appendLine(DEMO_PROMPT.trim());
  output.appendLine('');

  // 消费 chat() 流，按 chunk 类型格式化写入 output channel
  try {
    for await (const chunk of agent.chat(DEMO_PROMPT)) {
      appendChunk(output, chunk);
    }
  } catch (err) {
    output.appendLine(`✖ 对话异常中断：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await agent.close();
  }

  // 演示结束：dump 操作流（可观测面之一）；累计指标已由对话面板透明区（memora.showMetrics）
  // 收敛展示，演示区只 dump 操作流、不重复渲染指标（单一真源：chatPanel.postMetrics）
  output.appendLine('');
  dumpObservability(output, agent2RecentTraces());
  output.appendLine('═'.repeat(48));
  output.appendLine('演示结束。以上为默认输出；如需透明面板实时展示，请打开对话面板。');
}

/**
 * 按 chunk 类型渲染一行输出（对齐内核 AgentChunk 契约）
 *
 * @param output Output Channel
 * @param chunk 内核流式 chunk
 */
function appendChunk(output: vscode.OutputChannel, chunk: AgentChunk): void {
  switch (chunk.type) {
    case 'thinking':
      output.appendLine(`   [思考] 阶段：${chunk.phase}`);
      break;
    case 'text':
      output.appendLine(chunk.content);
      break;
    case 'tool_start':
      output.appendLine(`   ➤ 工具开始：${chunk.name}`);
      break;
    case 'tool_result':
      output.appendLine(
        `   ➤ 工具结束：${chunk.name} ${chunk.ok ? '✓ 成功' : '✖ 失败'}` +
          (chunk.summary ? ` · ${chunk.summary}` : ''),
      );
      break;
    case 'selfReview':
      output.appendLine('   [自审查] 终审');
      break;
    case 'retry':
      output.appendLine(`   [LLM 重试] 第 ${chunk.attempt}/${chunk.maxRetries} 次`);
      break;
    case 'paused':
      output.appendLine('   [暂停]');
      break;
    case 'question_pending':
      output.appendLine(`   [待提问] ${chunk.questions.map((q) => q.question).join('；')}`);
      break;
    case 'error':
      output.appendLine(`✖ 错误：${chunk.message}`);
      break;
    case 'aborted':
      output.appendLine(`✖ 中断：${chunk.reason}`);
      break;
    case 'done':
      output.appendLine('[完成]');
      break;
    default:
      break;
  }
}

/**
 * 提取演示 Agent 的最近操作流（trace span 标签）
 *
 * 复用 vscodeTracer 单例缓冲（ITracer 不落盘，仅内存、仅观感标签）。
 * getRecentTraces() 已按「新→旧」返回 { label } 序列，直接透传即可。
 *
 * @returns 操作流标签序列（新→旧，缺省为空）
 */
function agent2RecentTraces(): { label: string }[] {
  return vscodeTracer.getRecentTraces(20);
}

/**
 * 在 Output Channel 末尾 dump 操作流（演示可观测面之一）。
 * 注意：仅 dump 操作流标签——累计指标的展示收敛在对话面板透明区（chatPanel.postMetrics，
 * memora.showMetrics 开关），演示区不重复实现指标渲染（避免同语义多实现，SSOT）。
 *
 * @param output Output Channel
 * @param traces 最近操作流（span 标签，新→旧）
 */
function dumpObservability(output: vscode.OutputChannel, traces: { label: string }[]): void {
  output.appendLine('── 可观测汇总 ──');
  if (traces.length > 0) {
    output.appendLine('最近操作流（新→旧）：');
    for (const t of traces) output.appendLine('   › ' + t.label);
  } else {
    output.appendLine('（无 trace 记录）');
  }
  output.appendLine('（累计指标请开启 memora.showMetrics 后从对话面板透明区查看）');
}
