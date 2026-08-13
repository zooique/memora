/**
 * LLM Provider 配置 — 插件宿主层
 *
 * 职责：
 *   - 从环境变量 / 工作区配置读取 baseUrl + model + apiKey，创建 memora LlmProvider
 *   - 复用 memora 内核的 createProviderFromConfig（内核不负责 provider 映射，宿主负责）
 *
 * 阶段 0：从环境变量读取（MEMORA_BASE_URL / MEMORA_MODEL / MEMORA_API_KEY）。
 * 后续阶段：改从 VS Code 配置 / 工作区 settings.json 读取，并做连接测试 UI。
 */
import { createProviderFromConfig, type LlmProvider } from '@zooique/memora';

/** 从环境变量创建 LLM Provider（DeepSeek 等 OpenAI 兼容端点） */
export function createDocReviewProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const baseUrl = env.MEMORA_BASE_URL;
  const model = env.MEMORA_MODEL;
  const apiKey = env.MEMORA_API_KEY ?? '';

  // baseUrl/model 缺失时抛出可读错误（引导配置）
  if (!baseUrl || !model) {
    throw new Error(
      '缺少 LLM 配置：请设置环境变量 MEMORA_BASE_URL 和 MEMORA_MODEL ' +
        '（如 MEMORA_BASE_URL=https://api.deepseek.com/v1 且 MEMORA_MODEL=deepseek-chat）',
    );
  }

  // 复用内核工厂：内核校验 baseUrl/model 并创建 OpenAICompatibleProvider
  return createProviderFromConfig('doc-review', {
    baseUrl,
    model,
    apiKey,
    provider: env.MEMORA_PROVIDER ?? 'doc-review',
  });
}
