/**
 * LLM Provider 配置 — 插件宿主层
 *
 * 优先级（单一真理源）：
 *   1. 配置面板激活的 Provider（ProviderStore · settings.json + SecretStorage）
 *   2. 环境变量（MEMORA_BASE_URL / MEMORA_MODEL / MEMORA_API_KEY，回退）
 *
 * 复用 memora 内核 createProviderFromConfig（内核不负责 provider 映射，宿主负责）。
 */
import { createProviderFromConfig, type ImageResolver, type LlmProvider } from '@zooique/memora';
import type { ProviderStore } from '../providers/providerStore.js';

/**
 * 创建 LLM Provider
 *
 * @param store 大模型配置存储（可选；传了则优先读激活 Provider）
 * @param env 环境变量（默认 process.env，便于测试注入）
 * @param imageResolver 图片解析器（宿主持有；IMG-2 之前无调用方 → 缺省 undefined）
 *   运行时回调，不进 DTO/settings.json（函数不可持久化）。宿主把 ImageRef 换成
 *   「已落盘 URL」或「占位文本」，内核拿到即用，自身不读文件、不发网络请求。
 *   未注入 → 内核序列化时该图走降级跳过；配合 supportsVision=false 的一级门禁，图片根本走不到这一步。
 * @returns 已配置的 LlmProvider 实例
 */
export async function createProvider(
  store?: ProviderStore,
  env: NodeJS.ProcessEnv = process.env,
  imageResolver?: ImageResolver,
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
        // 能力位透传（互斥双能力位）：未声明（undefined）交内核回落，**两键方向不同**——
        // supportsToolCalling → true（缺省保留工具调用能力）；supportsStructuredOutput → false（缺省不发 response_format）。
        // 勿读成「默认都开」；内核 SSOT = openaiCompatible 构造器的 `?? true` / `?? false`。
        supportsToolCalling: active.supportsToolCalling,
        supportsStructuredOutput: active.supportsStructuredOutput,
        // 视觉能力位：与上面两位同构透传（未填 → 内核回落 false）。
        // 注入面分工（勿混）：能力位是**用户声明**（进 DTO、可持久化）；
        // 图片解析器是**运行时回调**（函数、不可持久化），由下方的 resolver 参数单独传入，
        // 不进 DTO——两者都汇集到同一个 createProviderFromConfig 入参。
        supportsVision: active.supportsVision,
        imageResolver,
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
      '缺少 LLM 配置：请在设置面板「大模型」页中添加配置，或设置环境变量 ' +
        'MEMORA_BASE_URL 和 MEMORA_MODEL（如 MEMORA_BASE_URL=https://api.xiaomimimo.com/v1 且 MEMORA_MODEL=deepseek-chat）',
    );
  }

  // 复用内核工厂：内核校验 baseUrl/model 并创建 OpenAICompatibleProvider
  //
  // 本分支**不落任何能力声明**（与既有 supportsToolCalling / supportsStructuredOutput 同处理）：
  // 环境变量是 CI / 本地兜底通道，没有「用户勾选」这一能力位来源，一律交内核回落。
  // 同理不注入 imageResolver——视觉能力位在此必为 false，一级门禁会先拦住图片，
  // 传了解析器也永远不会被调用；与其留一条死接线误导后来者，不如不接。
  return createProviderFromConfig('memora', {
    baseUrl,
    model,
    apiKey,
    provider: env.MEMORA_PROVIDER ?? 'memora',
  });
}

/**
 * 创建后台模型 Provider（多 Provider 路由）
 *
 * 后台任务（轮次摘要 / 会话归档 / 文本润色 / 去重判定）走独立 Provider，可选用轻量快模型
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
    // 能力位透传：后台通道与前台同构
    supportsToolCalling: background.supportsToolCalling,
    supportsStructuredOutput: background.supportsStructuredOutput,
    //
    // ⚠️ 此处**刻意不传 supportsVision**（与上面两位处理不同，勿误补）：
    // 后台通道（轮次摘要 / 会话归档 / 文本润色 / 去重判定）的消息由各处自行拼装，
    // 已核实全部 `.map()` 成纯文本字符串，从不携带 attachments ⇒ 无图片来源。
    // 在「没有图片来源」的通道上声明视觉能力，后果比不声明更坏：
    //   声明 true 但无 imageResolver ⇒ 图被静默跳过（用户看到 AI 像没看见图，无法归因）；
    //   不声明（false）⇒ 万一将来误入图片，一级门禁明确拒收而非静默丢弃。
    // 即：**宁可被门禁拦，不可被静默丢**。若日后后台真要处理图片，须能力位与解析器**一起**补。
  });
}
