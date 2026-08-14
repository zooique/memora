/**
 * LLM Provider 配置 — 插件宿主层
 *
 * 优先级（单一真理源）：
 *   1. 配置面板激活的 Provider（ProviderStore · settings.json + SecretStorage）
 *   2. 环境变量（MEMORA_BASE_URL / MEMORA_MODEL / MEMORA_API_KEY，回退）
 *
 * 复用 memora 内核 createProviderFromConfig（内核不负责 provider 映射，宿主负责）。
 */
import { createProviderFromConfig, type LlmProvider } from '@zooique/memora';
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