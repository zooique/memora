/**
 * LLM Provider 工厂：根据配置创建 Provider 实例
 * 内核只接收 baseUrl+model+apiKey 三板斧创建实例；不做 provider 名 → URL/模型 映射（宿主层职责）；
 * 不验证 apiKey（是否必需是下游 LLM 服务的决策，内核只是透传管道）
 */
import type { Config } from '@/config/loader.js';
import { LlmProvider } from '@/llm/provider.js';
import { OpenAICompatibleProvider } from '@/llm/openaiCompatible.js';
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';
import { safeSetTimeout } from '@/utils/safeTimer.js';

/** 单个 Provider 配置（createProviderFromConfig 入参）：baseUrl 可选，缺失时内部抛 configError */
export interface ProviderConfig {
  /** API 基础 URL（可选——内核在 createProviderFromConfig 内部做空值检查并报错） */
  baseUrl?: string;
  /** 默认模型名称（必填） */
  model: string;
  /** API 密钥（本地 LLM 如 Ollama 可为空字符串；宿主负责决定） */
  apiKey?: string;
  /** Provider 标识（仅用于日志，不影响路由） */
  provider?: string;
  /**
   * 是否支持原生工具调用（OpenAI Function Calling tools 协议）。
   *
   * 本地运行时（Ollama/LM Studio 等）是否支持原生 FC 无法从 baseUrl 推断，须宿主显式置 false；
   * 未填（undefined）→ OpenAICompatibleProvider 内回落 true（保留存量云 LLM 工具行为，
   * 互斥双能力位）。
   */
  supportsToolCalling?: boolean;
  /** 是否支持结构化输出（response_format / JSON mode）；未填 → 回落 false */
  supportsStructuredOutput?: boolean;
}

/** 从单个 Provider 配置创建 LlmProvider 实例（多 Provider 管理场景：为 providers 映射表中每个条目调用） */
export function createProviderFromConfig(
  name: string,
  providerConfig: ProviderConfig,
): LlmProvider {
  const { baseUrl, model, apiKey, provider } = providerConfig;

  if (provider === 'mock') {
    logger.warn({ provider: 'mock' }, '使用 Mock LLM Provider（仅用于测试）');
    return new MockProvider();
  }

  // baseUrl 和 model 是内核的直接需求，不做过多的回退逻辑
  const resolvedBaseUrl = (baseUrl || '').replace(/\/chat\/completions\/?$/, '');
  if (!resolvedBaseUrl) {
    throw configError(
      'LLM baseUrl 未配置',
      `provider "${name}" 缺少 baseUrl`,
      ['在宿主层填充 baseUrl（如 "https://api.xiaomimimo.com/v1"）'],
    );
  }
  if (!model) {
    throw configError(
      'LLM model 未配置',
      `provider "${name}" 缺少 model`,
      ['在宿主层填充 model（如 "deepseek-chat"）'],
    );
  }

  logger.info(
    { provider: provider ?? name, baseUrl: resolvedBaseUrl, model },
    `创建 LLM Provider: ${name}`,
  );

  return new OpenAICompatibleProvider(name, {
    baseUrl: resolvedBaseUrl,
    apiKey: apiKey ?? '',
    defaultModel: model,
    // 能力位透传：未填（undefined）由 OpenAICompatibleProvider 内按**各自方向**回落——
    // supportsToolCalling → true，supportsStructuredOutput → false（见上方字段文档；勿读成「默认都开」）。
    supportsToolCalling: providerConfig.supportsToolCalling,
    supportsStructuredOutput: providerConfig.supportsStructuredOutput,
  });
}

/**
 * 创建 LLM Provider（从完整 Config）
 * 唯一配置格式：providers 映射表 + active，宿主应确保 baseUrl+model 已显式设置
 */
export function createLlmProvider(config: Config): LlmProvider {
  const { llm } = config;

  if (!llm.providers || Object.keys(llm.providers).length === 0) {
    throw configError(
      'LLM providers 未配置',
      'llm.providers 映射表为空或未定义',
      ['在配置文件中配置 llm.providers（如 deepseek/openai 等）'],
    );
  }

  const active = llm.active ?? Object.keys(llm.providers)[0] ?? '';
  const providerConfig = llm.providers[active];
  if (!providerConfig) {
    throw configError('无效的 active Provider', `active="${active}" 不在 providers 映射表中`, [
      `可用的 Provider：${Object.keys(llm.providers).join(', ')}`,
      `在配置文件中设置 llm.active 为其中之一`,
      '或使用 `memora config llm use <name>` 切换',
    ]);
  }
  return createProviderFromConfig(active, {
    ...providerConfig,
    baseUrl: providerConfig.baseUrl ?? '',
  });
}

/** Mock LLM Provider：用于测试和开发 */
class MockProvider extends LlmProvider {
  readonly name = 'mock';

  async *chat(messages: Array<{ role: string; content: string }>) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const reply = `Mock 响应：${lastUser?.content ?? '(empty)'}`;

    for (const char of reply) {
      yield { content: char };
      await new Promise<void>((r) => safeSetTimeout(r, 5));
    }
    yield { finishReason: 'stop' as const };
  }
}
