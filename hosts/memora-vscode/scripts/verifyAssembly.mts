/**
 * 装配链路验证脚本 — 配置→注入→生效链路的行为锁
 *
 * 目的：把"配置→装配→Agent 生效"这条链路用可复现脚本锁住：
 *   1. createBackgroundProvider 工厂：未配置 → undefined；配置 → 返回 Provider 实例
 *   2. search_memories 纯关键词链路：预置记忆 → searchByKeyword 命中（无向量通道，
 *      similarity 恒 0；关键词=字面匹配，未命中属预期，LLM 换词重试）
 *
 * 运行方式（在 hosts/memora-vscode 下）：
 *   npx tsx scripts/verifyAssembly.mts
 *
 * 用桩替换外部依赖（不接真实 vscode / 不触发真实 API）：
 *   - 桩 ProviderStore（duck-type，仅供给创建工厂消费的窄面）
 *   - 桩 LlmProvider（chat 返回空，供 Agent 装配）
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
  Agent,
  InMemoryStorage,
  type LlmProvider,
  type ChatOptions,
  type LlmChunk,
  type Memory,
} from '@zooique/memora';
import { createBackgroundProvider } from '../src/extension/host/llmConfig.js';
import { WorkspaceSessionStore } from '../src/extension/host/sessionStore.js';
import type { ProviderStore } from '../src/extension/providers/providerStore.js';

/**
 * 桩 LLM Provider：chat() 仅产出空文本（Agent 装配用，不发起真实调用语义测试）
 *
 * 双能力位均声明 false（implements 非 extends，不继承基类默认值、字段须逐一自声明）：
 * 桩零工具能力，不宣称原生 FC——宣称能力零消费即幻觉。
 */
class StubLlmProvider implements LlmProvider {
  readonly name = 'stub';
  readonly supportsStructuredOutput = false;
  readonly supportsToolCalling = false;
  async *chat(_messages: unknown[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    yield { content: '', finishReason: 'stop' };
  }
}

/** 一条测试记忆（存 InMemoryStorage） */
const MEMORY: Memory = {
  id: 'content:决策',
  name: '决策',
  source: 'content',
  content: '我们决定记忆存储用 JSON 文件，保持零依赖',
  createdAt: '2026-09-24T00:00:00.000Z', // Memory 必填字段（写入时刻）
  accessedAt: '2026-09-24T00:00:00.000Z', // Memory 必填字段（最近访问时刻）
};

/** 累计检查失败数（❌ 须翻转退出码，否则验证脚本永远绿 = 静默失效） */
let failedCount = 0;

/** 输出一项检查结果（失败计入 failedCount） */
function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failedCount++;
  console.log(`${ok ? '✅' : '❌'} ${name}：${detail}`);
}

/** 装配一个已 init 的 Agent（纯关键词链路，无向量注入） */
async function makeAgent(workspace: string): Promise<Agent> {
  const storage = new InMemoryStorage();
  storage.upsert(MEMORY); // 预置记忆供检索
  const sessionStore = new WorkspaceSessionStore(workspace);
  sessionStore.load();
  const agent = new Agent({
    projectPath: workspace,
    dataDir: join(workspace, '.memora'),
    configDir: join(process.cwd(), 'src', 'extension'),
    provider: new StubLlmProvider(),
    storage,
    sessionStore,
    permission: 'owner',
    allowedPaths: [workspace],
  });
  await agent.init();
  return agent;
}

async function main(): Promise<void> {
  const workspace = join(os.tmpdir(), `memora-assembly-verify-${Date.now()}`);
  mkdirSync(workspace, { recursive: true });
  console.log(`📁 临时工作区：${workspace}`);

  // ─── 1. createBackgroundProvider 工厂 ─────────────────────────
  console.log('\n=== createBackgroundProvider 工厂 ===');
  const bgUnconfigured = { getBackground: async () => undefined } as unknown as ProviderStore;
  const noBg = await createBackgroundProvider(bgUnconfigured);
  report('未配置后台通道 → 返回 undefined（回退前台）', noBg === undefined, `createBackgroundProvider=${noBg}`);

  const bgConfigured = {
    getBackground: async () => ({ name: 'fast', displayName: '快', model: 'fast-model', baseUrl: 'https://api.example.com/v1', apiKey: 'sk', provider: 'cloud' }),
  } as unknown as ProviderStore;
  const bg = await createBackgroundProvider(bgConfigured);
  report('已配置后台通道 → 返回 LlmProvider 实例', bg !== undefined, `createBackgroundProvider=${bg ? bg.name : 'undefined'}`);

  // ─── 2. search_memories 纯关键词链路 ──────────────────────────
  // 无向量通道，searchByKeyword 纯关键词；命中=字面匹配。
  console.log('\n=== search_memories 纯关键词链路 ===');
  const agent = await makeAgent(workspace);
  // agent.memory 是 getter（每次访问新表达式，空断言不跨访问保持）→ 捕获到本地变量再判空
  const memory = agent.memory;
  if (!memory) throw new Error('agent.memory 未初始化（init 后应可用）——链路装配失败');
  const hits = await memory.searchByKeyword('JSON 零依赖');
  report(
    '预置记忆 → searchByKeyword 关键词命中（字面匹配 JSON）',
    hits.length > 0,
    `hits=${hits.length}，top=${hits[0]?.contentPreview?.slice(0, 30) ?? '（空）'}`,
  );
  // 语义近义用例须与内容**零字面重叠**：查询词若在内容里字面存在（如「存储」↔「记忆存储用」），
  // 命中是关键词匹配的正确行为，测的就不是「近义不命中」了
  const nearMiss = await memory.searchByKeyword('持久层选型利弊'); // 近义说法、零字面重叠
  report(
    '语义近义（换说法、零字面重叠）→ 不命中（纯关键词预期，LLM 须换词重试）',
    nearMiss.length === 0,
    `hits=${nearMiss.length}`,
  );
  await agent.close();

  // ─── 清理 ─────────────────────────────────────────────────
  rmSync(workspace, { recursive: true, force: true });
  console.log('\n🧹 已清理临时工作区');

  // 任一检查 ❌ 即整体失败（退出码翻红，供门禁/CI 消费）
  if (failedCount > 0) {
    console.error(`\n❌ 验证未通过：${failedCount} 项检查失败`);
    process.exit(1);
  }
  console.log('\n✅ 全部检查通过');
}

main().catch((err) => {
  console.error('实测脚本异常：', err);
  process.exit(3);
});