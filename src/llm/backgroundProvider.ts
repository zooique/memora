/**
 * 后台 Provider 解析 + 失败升级（P2 窄版，2026-11-01）。
 *
 * **背景**：后台通道（轮次摘要 / 会话归档 / 文本润色 / 去重投影）走 `backgroundProvider`
 * （成本优先：更便宜的模型 / 更低配额 / 独立端点）。原实现是 `backgroundProvider ?? provider`
 * 裸回退——一旦后台通道这次失败，本次后台任务就整体失败（摘要丢失、归档跳过），
 * 而前台 Provider 明明可用。
 *
 * **本模块的职责**：把「后台失败 → 降级到前台重试一次」收敛为**唯一判定点**。
 * 后台消费者共用同一份解析结果，不在各自内部复制升级逻辑（自然生长：真理源 + 零差异段）。
 *
 * **覆盖面分两层（勿折叠为一个「共用」）**：
 * - **装配期**：三个消费者（`SessionArchiver` / `TextPolishManager` / `RoundSummaryGenerator`）全量接入；
 * - **热切换期**：只有归档 + 摘要跟随 `agent.setBackgroundProvider` 换新解析结果；
 *   `TextPolishManager` 无 `setBackgroundProvider` ⇒ 润色沿用**装配期实例**（既有缺口，
 *   见台账 `BG-ESCALATE-1` 未覆盖面）。
 *
 * **两条硬边界（刻意窄，防扩张成「动态分档」）**：
 * 1. **只作用于后台通道**：主对话 `AgentLoop` 的 Provider 完全不经过本模块
 *    —— 主对话换档 = 模型动态分档（`autotier`），已明确拒枝（见 `docs/方案-dsh吸收总推荐-20261101.md` §二）。
 * 2. **只在「尚未产出任何增量」时重试**：已流出过内容的失败不重试——重发会把半截内容
 *    重新生成一遍（正文重复），**失败比脏数据可接受**。
 */
import { logger } from '@/logging/logger.js';
import { LlmProvider } from '@/llm/provider.js';
import type { ChatOptions, Message } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';

/**
 * 解析后台通道实际使用的 Provider。
 *
 * - 未配置后台 Provider（`null`）→ **原样返回前台 Provider**（不包装饰器，零额外开销；
 *   这正是「缺省回退前台」契约的实现点）；
 * - 已配置 → 返回「后台优先 + 前台兜底」的升级包装器。
 *
 * @param background 宿主显式注入的后台 Provider（可为 null）
 * @param foreground 前台 Provider（升级重试的目标）
 * @returns 后台消费者应使用的 Provider 实例
 */
export function resolveBackgroundProvider(
  background: LlmProvider | null,
  foreground: LlmProvider,
): LlmProvider {
  return background ? new EscalatingProvider(background, foreground) : foreground;
}

/**
 * 「后台优先 + 前台失败升级」的 Provider 装饰器。
 *
 * 判定流程：先走 `primary`（后台）；若它在**未产出任何增量时**失败，则用 `fallback`（前台）
 * 重发一次。除此之外行为与 `primary` 完全一致（透传消息、选项、中止信号）。
 */
class EscalatingProvider extends LlmProvider {
  /** 上报给宿主的 Provider 名：`后台名(→前台名)`，使日志/遥测一眼能看出这是升级包装器 */
  readonly name: string;

  /** 后台 Provider（首选） */
  private readonly primary: LlmProvider;
  /** 前台 Provider（仅在后台未产出增量即失败时启用一次） */
  private readonly fallback: LlmProvider;

  constructor(primary: LlmProvider, fallback: LlmProvider) {
    super();
    this.primary = primary;
    this.fallback = fallback;
    this.name = `${primary.name}(→${fallback.name})`;

    // 能力位镜像 primary：装饰器只增加「失败升级」这一条行为，**不得改变能力语义**
    // （否则调用方按能力位做的判据会与实际执行面不符 = 谎报）。
    // 基类把三者声明为 own property（构造期赋值），prototype 上的 getter 会被它遮蔽，
    // 故此处用 defineProperty 直接覆写同名的 own property。
    for (const key of [
      'supportsToolCalling',
      'supportsStructuredOutput',
      'supportsVision',
    ] as const) {
      Object.defineProperty(this, key, {
        value: primary[key],
        enumerable: true,
        configurable: true,
      });
    }
  }

  /**
   * 流式对话：后台优先，未产出增量即失败时升级到前台重试一次。
   *
   * 三种不重试情形（顺序即判定优先级）：
   * 1. 用户已取消（`signal.aborted`）——重试等于把已取消的请求再发一次；
   * 2. 已产出增量（`yielded`）——重发会产生重复正文（脏数据）；
   * 3. （无第三：其余失败一律升级一次，失败即如实抛出，不吞异常）
   */
  async *chat(messages: Message[], opts?: ChatOptions): AsyncIterable<LlmChunk> {
    let yielded = false; // 是否已向调用方流出过增量（决定能否安全重试）

    try {
      for await (const chunk of this.primary.chat(messages, opts)) {
        yielded = true;
        yield chunk;
      }
      return; // 后台通道正常走完，前台兜底不触发
    } catch (err) {
      if (opts?.signal?.aborted) throw err;
      if (yielded) throw err;
      // 只在「未产出增量」的失败上升级：记一笔警告，便于宿主/维护者看出后台通道在退化
      logger.warn(
        { err, primary: this.primary.name, fallback: this.fallback.name },
        '后台 Provider 调用失败（未产出内容），升级到前台 Provider 重试一次',
      );
    }

    // 升级路径：前台重试一次（同样透传 opts，含中止信号与超时设置）
    for await (const chunk of this.fallback.chat(messages, opts)) {
      yield chunk;
    }
  }
}
