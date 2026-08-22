/**
 * LLM Provider 配置 — 插件宿主层
 *
 * 优先级（单一真理源）：
 *   1. 配置面板激活的 Provider（ProviderStore · settings.json + SecretStorage）
 *   2. 环境变量（MEMORA_BASE_URL / MEMORA_MODEL / MEMORA_API_KEY，回退）
 *
 * 复用 memora 内核 createProviderFromConfig（内核不负责 provider 映射，宿主负责）。
 */
import { join } from 'node:path';
import { createProviderFromConfig, EmbeddingProvider, JsonVectorStore, type LlmProvider, type IVectorStore } from '@zooique/memora';
import type { ProviderStore } from '../providers/providerStore.js';

/**
 * 创建 LLM Provider
 *
 * @param store 大模型配置存储（可选；传了则优先读激活 Provider）
 * @param env 环境变量（默认 process.env，便于测试注入）
 * @returns 已配置的 LlmProvider 实例
 */
export async function createProvider(
  store?: ProviderStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LlmProvider> {
  // 1. 优先：配置面板激活的 Provider
  if (store) {
    const active = await store.getActive();
    if (active) {
      return createProviderFromConfig('memora', {
        baseUrl: active.baseUrl,
        model: active.model,
        apiKey: active.apiKey,
        provider: active.provider,
      });
    }
  }

  // 2. 回退：环境变量
  const baseUrl = env.MEMORA_BASE_URL;
  const model = env.MEMORA_MODEL;
  const apiKey = env.MEMORA_API_KEY ?? '';

  // baseUrl/model 缺失时抛出可读错误（引导打开配置面板）
  if (!baseUrl || !model) {
    throw new Error(
      '缺少 LLM 配置：请在侧边栏「大模型配置」中添加上下文，或设置环境变量 ' +
        'MEMORA_BASE_URL 和 MEMORA_MODEL（如 MEMORA_BASE_URL=https://api.deepseek.com/v1 且 MEMORA_MODEL=deepseek-chat）',
    );
  }

  // 复用内核工厂：内核校验 baseUrl/model 并创建 OpenAICompatibleProvider
  return createProviderFromConfig('memora', {
    baseUrl,
    model,
    apiKey,
    provider: env.MEMORA_PROVIDER ?? 'memora',
  });
}

/**
 * 创建后台模型 Provider（G5 多 Provider 路由，2026-08-23）
 *
 * 后台任务（轮次摘要 / 会话归档 / 洞察提取 / 去重判定）走独立 Provider，可选用轻量快模型
 * 节省成本。store 未配置后台通道（getBackgroundName 为空 / name 不存在）返回 undefined——
 * 内核 backgroundProvider 缺省回退到与实时对话相同 Provider，零破坏性。
 *
 * @param store Provider 存储（读取后台 Provider 选择）
 * @returns 后台 LlmProvider 实例；无独立后台配置返回 undefined
 */
export async function createBackgroundProvider(
  store?: ProviderStore,
): Promise<LlmProvider | undefined> {
  if (!store) return undefined;
  const background = await store.getBackground();
  if (!background) return undefined;
  // 与 createProvider 同构：复用内核工厂构建 OpenAI 兼容 Provider
  return createProviderFromConfig('memora-background', {
    baseUrl: background.baseUrl,
    model: background.model,
    apiKey: background.apiKey,
    provider: background.provider,
  });
}

/**
 * 创建向量存储（G1 记忆语义检索，2026-08-23）
 *
 * 配置了 Embedding（model + baseUrl + apiKey）时创建 JsonVectorStore 注入 Agent，
 * MemoryInspector.searchHybrid 据此启用语义召回（从纯关键词升级为「向量+关键词」混合）。
 * 未配置返回 undefined → 装配不注入 vectorStore，搜召回归关键词（零破坏性）。
 *
 * @param store Provider 存储（读取 embedding 配置）
 * @param dataDir 数据目录（vectors.json 落盘处，与记忆同目录）
 * @returns 已 load 的向量存储；未配置返回 undefined
 */
export async function createVectorStore(
  store?: ProviderStore,
  dataDir?: string,
): Promise<IVectorStore | undefined> {
  if (!store || !dataDir) return undefined;
  const cfg = await store.getEmbeddingConfig();
  if (!cfg.enabled || !cfg.model || !cfg.baseUrl) return undefined;
  const apiKey = await store.getEmbeddingSecret();
  if (!apiKey) return undefined;
  // 复用内核 EmbeddingProvider（OpenAI 兼容 /embeddings）+ JsonVectorStore（JSON 持久化向量索引）
  const embeddingProvider = new EmbeddingProvider({ baseUrl: cfg.baseUrl, apiKey, model: cfg.model });
  const vectorStore = new JsonVectorStore(join(dataDir, 'vectors.json'), embeddingProvider);
  await vectorStore.load();
  return vectorStore;
}