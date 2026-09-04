/**
 * 主动提问验证脚本 — [ASK] 解析 + question_pending 事件 + 回答续跑闭环
 *
 * 目的：验证内核在 LLM 结构化输出 `[ASK] 问题` 时：
 *   1. 发射 questionPending 事件（宿主可渲染提问 UI）
 *   2. Agent 暂停（翻 PAUSED）
 *   3. 用户回答后经 resumeExecution 续跑，回答进入上下文并继续
 *
 * 运行方式（在 hosts/memora-vscode 下）：
 *   node --import ../../node_modules/tsx/dist/loader.mjs scripts/verifyClarify.mts
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { Agent } from '@zooique/memora';
import { WorkspaceStorage } from '../src/extension/host/workspaceStorage.js';
import { WorkspaceSessionStore } from '../src/extension/host/sessionStore.js';
import { createProvider } from '../src/extension/host/llmConfig.js';

/** 读取环境变量，优先进程级，回退系统级（Machine） */
function readEnv(name: string): string | undefined {
  return process.env[name] ?? getMachineEnv(name);
}

/** 读取 Windows 系统级（Machine）环境变量 */
function getMachineEnv(name: string): string | undefined {
  try {
    const buf = execSync(
      `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${name}','Machine')"`,
      { encoding: 'utf8' },
    );
    return buf.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 收集 Agent 流式输出为完整文本 + 事件序列 */
async function collectFlow(
  gen: AsyncGenerator<{ type: string; content?: string }>,
): Promise<{ text: string; events: string[] }> {
  let out = '';
  const events: string[] = [];
  for await (const chunk of gen) {
    if (chunk.type === 'text' && chunk.content) out += chunk.content;
    events.push(chunk.type);
  }
  return { text: out, events };
}

async function main(): Promise<void> {
  const baseUrl = readEnv('MEMORA_BASE_URL');
  const model = readEnv('MEMORA_MODEL');
  const apiKey = readEnv('MEMORA_API_KEY');
  if (!baseUrl || !model || !apiKey) {
    console.error('❌ 缺少环境变量 MEMORA_BASE_URL / MEMORA_MODEL / MEMORA_API_KEY');
    process.exit(1);
  }

  // 临时工作区
  const workspace = join(os.tmpdir(), `memora-clarify-${Date.now()}`);
  mkdirSync(join(workspace, '.memora'), { recursive: true });

  // 装配 Agent（configDir 指向插件 skills 目录）
  const storage = new WorkspaceStorage(workspace);
  storage.load();
  const sessionStore = new WorkspaceSessionStore(workspace);
  sessionStore.load();
  const agent = new Agent({
    projectPath: workspace,
    dataDir: join(workspace, '.memora'),
    configDir: join(process.cwd(), 'src', 'extension'),
    provider: await createProvider(undefined, { MEMORA_BASE_URL: baseUrl, MEMORA_MODEL: model, MEMORA_API_KEY: apiKey }),
    storage,
    sessionStore,
    permission: 'owner',
    allowedPaths: [workspace],
  });
  await agent.init();

  // 监听主动提问事件
  const pendingQuestions: string[] = [];
  agent.on('questionPending', (questions) => {
    for (const q of questions) pendingQuestions.push(q.question);
    console.log(`🔔 questionPending 事件：${questions.map((q) => q.question).join('；')}`);
  });

  // 第一轮：引导 LLM 用 ask_user 工具提问（2026-09-04 通道收敛，替代 [ASK] 文本）
  const input =
    '请帮我写一个系统设计文档。但在动手前，请先调用 ask_user 工具问清楚：这个系统主要面向什么用户？只做这一步，不要执行其他工具。';
  const first = await collectFlow(agent.chat(input));

  console.log('\n=== 第一轮输出 ===');
  console.log(first.text.slice(0, 500));
  console.log('事件序列：', first.events.join(' → '));

  // 判定1：是否触发了主动提问
  const triggered = pendingQuestions.length > 0;
  console.log(`\n📊 questionPending 事件触发：${triggered ? '✅' : '⚠️'}`);
  if (!triggered) {
    console.log('⚠️ 未触发主动提问，请人工判断 LLM 是否调用了 ask_user');
  }

  // 判定2：是否进入暂停（PAUSED）
  const paused = first.events.includes('paused');
  console.log(`📊 进入暂停（paused chunk）：${paused ? '✅' : '⚠️'}`);

  // 用户回答 → answerQuestion 回填 + resumeExecution 续跑
  if (triggered && paused) {
    const answer =
      '目标用户是中小企业的前端工程师。请基于这个回答，继续给出系统设计文档的核心模块划分。';
    console.log(`\n💬 用户回答：${answer}`);
    agent.answerQuestion([answer]);
    const second = await collectFlow(agent.resumeExecution(answer));
    console.log('\n=== 续跑输出 ===');
    console.log(second.text.slice(0, 800));
    console.log('事件序列：', second.events.join(' → '));

    const continued = second.events.some((e) => e === 'done') && second.text.length > 0;
    console.log(`\n📊 回答后续跑成功：${continued ? '✅' : '⚠️'}`);
    if (triggered && paused && continued) {
      console.log('✅ 主动提问→回答→续跑 全链路跑通');
    }
  }

  await agent.close();
  rmSync(workspace, { recursive: true, force: true });
  console.log('\n🧹 已清理临时工作区');
}

main().catch((err) => {
  console.error('验证脚本异常：', err);
  process.exit(3);
});