/** LLM Provider 抽象接口：所有 LLM 实现（DeepSeek/豆包/OpenAI/Mock）必须实现 */
import type { LlmChunk } from '@/llm/types.js';

/**
 * 图片引用（参考模型，非内联字节）。
 *
 * 设计（方案-图片输入-20261027 §5.1 / §5.3）：base64 字节**只**在 `formatMessages`
 * 序列化边界内临时物化，绝不进 `Message` / `RoundMessage` / `SessionMessage`——
 * 三个消息面统一只持 `ImageRef` 引用，避免持久化体积爆炸 + 内存双份 + 真源漂移。
 * `sha256` 是第二真相源去重键，恒等于用户给的那张图的哈希（可审计）；`bytes/width/height`
 * 供 token 计量（§5.9）与入口限额（§6.7）与三值比对（§5.4）复用，零重复解析。
 */
export interface ImageRef {
  /** 原图字节 sha256 —— 去重 / 缓存键 / 文件命中的第二真相源 */
  sha256: string;
  /** MIME（如 image/png），手 sniff 文件头得到，不引第三方依赖 */
  mime: string;
  /** 像素宽（手解析文件头，零依赖） */
  width: number;
  /** 像素高 */
  height: number;
  /** 原图字节数（入口限额 / 三值比对用） */
  bytes: number;
  /** 文件名（采集侧唯一生产点，D29）：无则 fallback；UI 展示与缺陷态文案用 */
  name: string;
}

/**
 * 图片解析器端口（内核只定类型，实现由宿主注入，内核零外部 IO）。
 *
 * 输入整个 `ImageRef`（而非只给 sha256）：宿主实现要拿 `mime` / `bytes` 做 D20 三值
 * 交叉校验（见下），只给哈希则无从比对。返回三者之一：
 *
 * - `{ url }`：**宿主已物化好**、模型侧可直接取用的完整图片 URL。
 *   ⚠️ 必须是「**模型**能取到」的形态——实践中就是 `data:{mime};base64,{...}`。
 *   **不可**返回 webview 专用 URI（`vscode-webview://…` / `asWebviewUri` 产物）：那是给
 *   面板**显示**用的同源限定源，模型请求发出去取不到图 ⇒ 服务端 400 或静默无图。
 *   注：`vscode.Uri` 的显示用途详见方案 §5.10（UI 显示走另一条路，与此处不是同一件事）。
 * - `{ text }`：**降级占位文案**（如 `[图片 a1b2c3d4.png, image/png, 412 KB, 存于 …]`），
 *   表示「图取不到，但有据可查」。⚠️ **不是** base64 载荷——文案的生产权归宿主，
 *   因为路径只有宿主知道；内核拿它做**不透明透传**（拼进 content 文本块），
 *   绝不参与 `data:` URI 拼接（方案 §5.4 收尾段 / §6.13）。
 * - `null`：未命中。此时由内核给最短兜底文案（不含路径——路径不该由内核知道）。
 *
 * 无论哪种降级形态，`formatMessages` 都产出**可见占位文本块**，不静默丢弃该图
 * （静默丢 = 模型困惑 + 用户零线索，方案 §5.4：「可见占位，不静默丢」）。
 */
export type ImageResolver = (ref: ImageRef) => { url: string } | { text: string } | null;

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * 轮次 ID（可选）：标识该消息归属的「问答轮次」。
   * 由 loop 在写入 user/assistant/tool 消息时附上当前 currentRoundId，
   * 作为替换式压缩（第一级 LRU）取 round-summary 的单一真理源——
   * roundId 随消息携带，不依赖任何外部序列的尾部对齐，杜绝错位替换。
   */
  roundId?: string;
  // 消息来源名称（可选，用于 function 调用结果标识，与 OpenAI API 对齐）
  name?: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  toolCallId?: string;
  /**
   * 图片附件引用（可选，多模态输入）。仅 user 消息携带；
   * base64 字节**不**存于此（见 `ImageRef` 注释），序列化时由 `ImageResolver` 物化。
   * 持久化天然带走（整对象 JSON），但 `MessageHistory.appendUser` 的 `userMessage`
   * 白名单必须显式拷此字段，否则重启 / 切会话后图静默消失（方案 §7 P0-12）。
   */
  attachments?: readonly ImageRef[];
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  // 工具定义（OpenAI Function Calling 格式）
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>; // JSON Schema
    };
  }>;
  /**
   * 结构化输出约束（OpenAI Function Calling 响应格式约束）。
   * 注意：response_format 不能与 tools 同时使用（OpenAI 协议限制），故 AgentLoop 默认不生成它
   * （见 loop.ts buildChatOptions 注释）——此处仅为调用方显式传入时的可选能力孔，不宣称任何
   * 「fallback 到纯文本 tool_call」的静默降级（文本出口不是可调用通道）。
   */
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
  /** 推理深度控制：'low'|'medium'|'high'，Provider 不支持时静默忽略 */
  reasoning_effort?: 'low' | 'medium' | 'high';
  /** 中止信号：用户取消时传入，Provider 应传给底层 fetch/stream 以支持中断 */
  signal?: AbortSignal;
  /** 请求超时（毫秒，默认 120s）：超时抛 networkError，由 callLlmWithRetry 决定是否重试 */
  timeoutMs?: number;
}

/** LLM Provider 抽象类：实现类需实现 chat() 流式方法 */
export abstract class LlmProvider {
  abstract readonly name: string;

  /**
   * 是否支持原生工具调用（OpenAI Function Calling 的 tools 协议）。
   *
   * 与 supportsStructuredOutput 互斥（response_format 不能与 tools 同时使用，OpenAI 协议限制）：
   * - 支持 tools → loop 走原生工具通道（列工具 + 传 tools 参数）。
   * - 支持 structured → loop 传 response_format（JSON mode 回落）。
   * - 两者皆 false → 无工具能力，loop 收起工具清单并显式告知（可观测，不静默）。
   *
   * 默认 **true**（存量行为）：云 LLM 绝大多数支持原生 FC（有工具集就传 tools，与历史一致）。
   * 本地运行时（Ollama/LM Studio 等）是否支持原生 FC 无法从 baseUrl 推断，须在宿主配置时
   * 显式置 false（互斥双能力位）。
   */
  readonly supportsToolCalling: boolean = true;

  /** 是否支持结构化输出（默认 false）。注意：response_format 不能与 tools 同时使用（OpenAI 协议限制） */
  readonly supportsStructuredOutput: boolean = false;

  /**
   * 是否支持视觉 / 多模态图片输入（默认 **false**，fail-closed）。
   *
   * 与 `supportsToolCalling` 默认 true 相反：能力缺失只是「功能不可用」，而「误判支持」会让图片
   * 静默发给不支持的模型 → 裸 400 / 烧钱。默认 false ⇒ 未显式声明的模型一律按「不支持」处理，
   * 由宿主复选框让用户声明（方案 §5.5 第②层 fail-closed 判据）。
   * 注意：**路由后** provider 的此值才是真源——主对话实走 `determineTaskType → router`，
   * 入口门禁必须读路由后的 provider（方案 §5.6 / R8-1），不得读 `opts.provider` 快照。
   */
  readonly supportsVision: boolean = false;

  /** 流式对话：返回 AsyncIterable，每项是一个增量块 */
  abstract chat(messages: Message[], opts?: ChatOptions): AsyncIterable<LlmChunk>;
}
