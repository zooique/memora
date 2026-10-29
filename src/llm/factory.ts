/**
 * LLM Provider 工厂：根据配置创建 Provider 实例
 * 内核只接收 baseUrl+model+apiKey 三板斧创建实例；不做 provider 名 → URL/模型 映射（宿主层职责）；
 * 不验证 apiKey（是否必需是下游 LLM 服务的决策，内核只是透传管道）
 *
 * 边界澄清：
 *   - createProviderFromConfig —— 【规范入口】宿主传入单个 provider 的 baseUrl+model+apiKey，内核校验后
 *     创建 OpenAICompatibleProvider。provider 选择/默认值策略全在宿主侧，内核不代劳。
 *   - createLlmProvider —— 【配置驱动便利】从完整 Config 读 llm.active 解析激活 provider（选择在内核侧）。
 *     仅适用于把整份 Config 托管给内核的场景；边界守法的宿主应自建 provider 后调 createProviderFromConfig，
 *     避免把"哪个 provider 激活"这一宿主策略委托给内核。
 */
import type { Config } from '@/config/loader.js';
import type { ImageResolver } from '@/llm/provider.js';
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
  /**
   * 是否支持图片输入（多模态 vision / content parts）；未填 → 回落 **false**（失败必闭）
   *
   * 【持久化数据】与上面两个能力位同性质：宿主须经「DTO → 表单 → 存储 → 建房」全链路透传。
   * 缺省方向选 false 而非 true，是因为「声称看得见图却看不懂」比「坦承不支持」危害更大——
   * 前者让图片静默丢失且用户无法归因，后者由 llmCaller 一级门禁明确拒收并给出可执行建议。
   */
  supportsVision?: boolean;
  /**
   * 图片解析器（运行时回调，**不可持久化**）
   *
   * 【运行时注入】与上面三个能力位**性质不同**：这是宿主持有的函数句柄，不能进任何 JSON 配置。
   * 内核只调用它把 ImageRef 换成「URL 或 占位文本」，自身不读文件、不发网络请求
   * （零外部读写是内核边界，见 provider.ts 的 ImageResolver 定义）。
   *
   * 因此本字段只属于**建房入参**（ProviderConfig），**不属于宿主的持久化 DTO**——
   * 宿主 DTO 里只有 supportsVision 这一「用户声明」，resolver 由宿主在调用本函数时直接传入。
   * 未注入 → formatMessages 走降级：推可见占位文本块，**绝不静默丢该图**（见 openaiCompatible）。
   */
  imageResolver?: ImageResolver;
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
    throw configError('LLM baseUrl 未配置', `provider "${name}" 缺少 baseUrl`, [
      '在宿主层填充 baseUrl（如 "https://api.xiaomimimo.com/v1"）',
    ]);
  }
  if (!model) {
    throw configError('LLM model 未配置', `provider "${name}" 缺少 model`, [
      '在宿主层填充 model（如 "deepseek-chat"）',
    ]);
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
    // supportsToolCalling → true，supportsStructuredOutput / supportsVision → false
    // （见上方字段文档；勿读成「默认都开」）。
    supportsToolCalling: providerConfig.supportsToolCalling,
    supportsStructuredOutput: providerConfig.supportsStructuredOutput,
    supportsVision: providerConfig.supportsVision,
    imageResolver: providerConfig.imageResolver,
  });
}

/**
 * 创建 LLM Provider（从完整 Config）
 * 唯一配置格式：providers 映射表 + active，宿主应确保 baseUrl+model 已显式设置
 */
export function createLlmProvider(config: Config): LlmProvider {
  const { llm } = config;

  if (!llm.providers || Object.keys(llm.providers).length === 0) {
    throw configError('LLM providers 未配置', 'llm.providers 映射表为空或未定义', [
      '在配置文件中配置 llm.providers（如 deepseek/openai 等）',
    ]);
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
