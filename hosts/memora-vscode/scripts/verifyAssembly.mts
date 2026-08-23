/**
 * 装配链路验证脚本 — 短板 1 的补测试（G1/G5 配置→注入→生效链路）
 *
 * 目的：把"配置→装配→Agent 生效"这条此前无行为测试覆盖的链路，用可复现脚本锁住：
 *   1. createVectorStore 工厂：未配置 → undefined；配置齐备 → 返回 JsonVectorStore
 *   2. createBackgroundProvider 工厂：未配置 → undefined；配置 → 返回 Provider 实例
 *   3. 注入 vectorStore 后内核 searchHybrid「从纯关键词升级为语义」：
 *      - 无 vectorStore 的 Agent：searchHybrid 命中【无】similarity
 *      - 注入 vectorStore（桩 embedding）的 Agent：命中【带】similarity（语义路径启用）
 *
 * 运行方式（在 hosts/memora-vscode 下）：
 *   npx tsx scripts/verifyAssembly.mts
 *
 * 用桩替换外部依赖（不接真实 vscode / 不触发真实 embedding API）：
 *   - 桩 ProviderStore（duck-type，仅供给创建工厂消费的窄面）
 *   - 桩 LlmProvider（chat 返回空，供 Agent 装配）
 *   - 桩 EmbeddingService（恒定全 1 向量 → 余弦相似度恒 1，稳定断言"相似度路径启用"；
 *     验证的是链路/machinery，非真实 embedding 质量）
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
  Agent,
  InMemoryStorage,
  JsonVectorStore,
  type LlmProvider,
  type ChatOptions,
  type LlmChunk,
  type EmbeddingService,
  type Memory,
  type IVectorStore,
} from '@zooique/memora';
import { createVectorStore, createBackgroundProvider } from '../src/extension/host/llmConfig.js';
import { WorkspaceSessionStore } from '../src/extension/host/sessionStore.js';
import type { ProviderStore } from '../src/extension/providers/providerStore.js';

/**
 * 桩 LLM Provider：chat() 仅产出空文本（Agent 装配用，不发起真实调用语义测试）
 */
class StubLlmProvider implements LlmProvider {
  readonly name = 'stub';
  readonly supportsStructuredOutput = false;
  async *chat(_messages: unknown[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    yield { content: '', finishReason: 'stop' };
  }
}

/**
 * 桩 EmbeddingService：恒定全 1 向量（维度 8）
 *
 * 任意文本 → 相同向量，余弦相似度恒 1，保证 vectorStore.search 必然返回命中且 similarity>0，
 * 从而稳定断言"注入 vectorStore 后 searchHybrid 走语义路径"（出现 similarity 字段）。
 * 注意：这不是 embedding 质量验证，是链路/machinery 验证。
 */
function makeStubEmbedding(): EmbeddingService {
  const vec = Array.from({ length: 8 }, () => 1);
  return {
    async embed(): Promise<number[]> {
      return vec;
    },
    async batchEmbed(texts: string[]): Promise<Array<{ text: string; vector: number[] } | null>> {
      return texts.map((t) => ({ text: t, vector: vec }));
    },
  };
}

/** 一条测试记忆（存 InMemoryStorage + vectorStore） */
const MEMORY: Memory = {
  id: 'content:决策',
  name: '决策',
  source: 'content',
  content: '我们决定记忆存储用 JSON 文件，保持零依赖',
  score: 0.9,
};

/** 输出一项检查结果 */
function report(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name}：${detail}`);
}

/** 装配一个已 init 的 Agent（可注入 vectorStore） */
async function makeAgent(workspace: string, vectorStore?: IVectorStore): Promise<Agent> {
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
    vectorStore,
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

  // ─── 1. createVectorStore 工厂 ────────────────────────────────
  console.log('\n=== createVectorStore 工厂 ===');
  // 未配置 → undefined（回退关键词）
  const unconfiguredStore = {
    getEmbeddingConfig: async () => ({ enabled: false }),
    getEmbeddingSecret: async () => '',
  } as unknown as ProviderStore;
  const noVs = await createVectorStore(unconfiguredStore, workspace);
  report('未配置 embedding → 返回 undefined（装配回退关键词）', noVs === undefined, `createVectorStore=${noVs}`);

  // 配置齐备 → 返回 JsonVectorStore（构造不触发真实 embedding 调用，离线安全）
  const configuredStore = {
    getEmbeddingConfig: async () => ({ enabled: true, model: 'text-embedding-3-small', baseUrl: 'https://api.example.com/v1' }),
    getEmbeddingSecret: async () => 'sk-test',
  } as unknown as ProviderStore;
  const vs = await createVectorStore(configuredStore, workspace);
  report('已配置 embedding → 返回 JsonVectorStore', vs !== undefined, `createVectorStore=${vs ? 'instance' : 'undefined'}`);

  // ─── 2. createBackgroundProvider 工厂 ─────────────────────────
  console.log('\n=== createBackgroundProvider 工厂 ===');
  const bgUnconfigured = { getBackground: async () => undefined } as unknown as ProviderStore;
  const noBg = await createBackgroundProvider(bgUnconfigured);
  report('未配置后台通道 → 返回 undefined（回退前台）', noBg === undefined, `createBackgroundProvider=${noBg}`);

  const bgConfigured = {
    getBackground: async () => ({ name: 'fast', displayName: '快', model: 'fast-model', baseUrl: 'https://api.example.com/v1', apiKey: 'sk', provider: 'cloud' }),
  } as unknown as ProviderStore;
  const bg = await createBackgroundProvider(bgConfigured);
  report('已配置后台通道 → 返回 LlmProvider 实例', bg !== undefined, `createBackgroundProvider=${bg ? bg.name : 'undefined'}`);

  // ─── 3. 注入 vectorStore 后 searchHybrid 语义升级 ─────────────
  console.log('\n=== 注入 vectorStore → searchHybrid 语义升级 ===');

  // a) 无 vectorStore 的 Agent：命中 similarity 恒 0（纯关键词路径；内核无 vector 时给 0）
  const agentNoVs = await makeAgent(workspace);
  const hitsNoVs = await agentNoVs.memory.searchHybrid('JSON 零依赖');
  const noVsSemantic = hitsNoVs.some((h) => (h.similarity ?? 0) > 0.3); // 内核语义阈值 0.3
  report(
    '无 vectorStore → 无语义命中（similarity≤0.3，纯关键词路径）',
    !noVsSemantic,
    `hits=${hitsNoVs.length}，maxSimilarity=${Math.max(...hitsNoVs.map((h) => h.similarity ?? 0), 0)}`,
  );
  await agentNoVs.close();

  // b) 注入 vectorStore 的 Agent：至少一个命中 similarity>0.3（语义路径启用，桩向量相似≈1）
  const embeddingVs = new JsonVectorStore(join(workspace, 'vectors.json'), makeStubEmbedding());
  await embeddingVs.load();
  await embeddingVs.batchUpsert([{ id: MEMORY.id, text: MEMORY.content }]); // 桩向量 → size>0
  const agentVs = await makeAgent(workspace, embeddingVs);
  const hitsVs = await agentVs.memory.searchHybrid('JSON 零依赖存储');
  const vsSemantic = hitsVs.some((h) => (h.similarity ?? 0) > 0.3);
  report(
    '注入 vectorStore → 语义命中（similarity>0.3）',
    vsSemantic,
    `hits=${hitsVs.length}，maxSimilarity=${Math.max(...hitsVs.map((h) => h.similarity ?? 0), 0)}`,
  );
  await agentVs.close();

  // ─── 清理 ─────────────────────────────────────────────────
  rmSync(workspace, { recursive: true, force: true });
  console.log('\n🧹 已清理临时工作区');
}

main().catch((err) => {
  console.error('实测脚本异常：', err);
  process.exit(3);
});