/**
 * 任务 D 实测脚本 — 跨会话记忆（切片 D）
 *
 * 目的：验证 memora「摘要即记忆」跨会话闭环真实跑通：
 *   1. 会话 A：Agent 实例 A 对话，定下一个设计决策
 *   2. 检查 .memora/memories.json 是否出现 source='round-summary' 的记忆
 *   3. 会话 B：Agent 实例 B（新实例，共享同一 storage）问相关决策，确认能召回
 *
 * 运行方式（在 hosts/memora-vscode 下）：
 *   node --import tsx ../scripts 不可行，改用：
 *   npx tsx scripts/crossSessionMemory.mts
 *   或从仓库根： node --import tsx hosts/memora-vscode/scripts/crossSessionMemory.mts
 *
 * 环境变量从系统级（Machine）读取，供当前会话未继承时回退。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { Agent, SOURCE_LABELS } from '@zooique/memora';
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

/** 收集 Agent 流式输出为完整文本 */
async function collectText(gen: AsyncIterable<{ type: string; content?: string }>): Promise<string> {
  let out = '';
  for await (const chunk of gen) {
    if (chunk.type === 'text' && chunk.content) out += chunk.content;
  }
  return out;
}

/** 装配一个已 init 的 Agent（共享同一 storage，模拟同一工作区） */
async function createAgent(
  workspace: string,
  baseUrl: string,
  model: string,
  apiKey: string,
): Promise<{ agent: Agent }> {
  const storage = new WorkspaceStorage(workspace);
  storage.load();
  const sessionStore = new WorkspaceSessionStore(workspace);
  sessionStore.load();
  const agent = new Agent({
    projectPath: workspace,
    dataDir: join(workspace, '.memora'),
    // 单一真理源：宿主不自持角色包，configDir 指向内核 role-packs
    configDir: join(process.cwd(), '..', '..', 'role-packs'),
    provider: await createProvider(undefined, { MEMORA_BASE_URL: baseUrl, MEMORA_MODEL: model, MEMORA_API_KEY: apiKey }),
    storage,
    sessionStore,
    permission: 'owner',
    allowedPaths: [workspace],
  });
  await agent.init();
  return { agent };
}

/** 读取 memories.json 摘要条目 */
function readRoundSummaries(workspace: string): unknown[] {
  const file = join(workspace, '.memora', 'memories.json');
  if (!existsSync(file)) return [];
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')) as Array<{ source?: string }>;
    return list.filter((m) => m.source === SOURCE_LABELS.ROUND_SUMMARY);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const baseUrl = readEnv('MEMORA_BASE_URL');
  const model = readEnv('MEMORA_MODEL');
  const apiKey = readEnv('MEMORA_API_KEY');

  if (!baseUrl || !model || !apiKey) {
    console.error('❌ 缺少系统级环境变量 MEMORA_BASE_URL / MEMORA_MODEL / MEMORA_API_KEY');
    process.exit(1);
  }
  console.log(`✅ LLM 配置已读取：baseUrl=${baseUrl} model=${model}`);

  // 用临时工作区，避免污染真实项目
  const workspace = join(os.tmpdir(), `memora-cross-session-${Date.now()}`);
  mkdirSync(workspace, { recursive: true });
  console.log(`📁 临时工作区：${workspace}`);

  // ─── 会话 A：定下一个设计决策 ─────────────────────────
  console.log('\n=== 会话 A：Agent 实例 A 对话，定设计决策 ===');
  const { agent: agentA } = await createAgent(workspace, baseUrl, model, apiKey);

  const decisionText = await collectText(
    agentA.chat('我们决定：本插件的记忆功能采用 JSON 文件存储（memories.json），不引入 SQLite，以保持零依赖。请确认这个决策。'),
  );
  console.log('会话 A 回复：\n' + decisionText.slice(0, 500));

  // close() 会等待后台摘要生成落盘
  await agentA.close();
  console.log('✅ 会话 A 结束，等待异步摘要生成……');

  // 检查 memories.json 是否出现 round-summary
  const summariesAfterA = readRoundSummaries(workspace);
  console.log(`\n📊 会话 A 后 round-summary 记忆条数：${summariesAfterA.length}`);
  if (summariesAfterA.length === 0) {
    console.error('❌ 未发现 round-summary 记忆，摘要链路未跑通');
    process.exit(2);
  }
  console.log('✅ 摘要已沉淀：');
  for (const s of summariesAfterA) console.log('   -', (s as { content: string }).content);

  // ─── 会话 B：新 Agent 实例，共享同一 storage，问相关决策 ──
  console.log('\n=== 会话 B：Agent 实例 B（新实例）问相关决策 ===');
  const { agent: agentB } = await createAgent(workspace, baseUrl, model, apiKey);

  const recallText = await collectText(
    agentB.chat('我们之前定过记忆存储方案的决策，你还记得吗？请告诉我我们当初选了什么、为什么。'),
  );
  console.log('会话 B 回复：\n' + recallText.slice(0, 800));
  await agentB.close();

  // 判定：B 是否明确复述了会话 A 的决策（用正面关键词，避免"不用SQLite"误报）
  const recallKeywords = ['memories.json', 'JSON 文件', '零依赖', '文件存储'];
  const hitKeywords = recallKeywords.filter((k) => recallText.includes(k));
  console.log(`\n📊 会话 B 命中决策关键词：${hitKeywords.length > 0 ? hitKeywords.join('、') : '（无）'}`);
  // 需命中 ≥2 个正面关键词才算真正回忆起决策（单关键词可能是泛泛而谈）
  if (hitKeywords.length >= 2) {
    console.log('✅ 跨会话记忆闭环跑通：会话 B 召回了会话 A 的决策');
  } else {
    console.log('⚠️ 会话 B 正面关键词命中不足，可能未命中召回，需人工判断以下回复是否已回忆起决策：');
  }

  // 清理临时工作区
  rmSync(workspace, { recursive: true, force: true });
  console.log('\n🧹 已清理临时工作区');
}

main().catch((err) => {
  console.error('实测脚本异常：', err);
  process.exit(3);
});