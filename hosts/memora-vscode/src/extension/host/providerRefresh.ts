/**
 * 配置变更 → 已装配实例的失效与重建（IMG-5）
 *
 * ## 为什么需要它
 *
 * `supportsVision` 等能力位是「配置的函数」，真源在磁盘（`memora.providers` 的 DTO）。
 * 内核 `LlmProvider` 把它作为 **readonly + 构造期赋值** 的字段（`openaiCompatible._setCapabilities`），
 * 这是**正确的封装**：能力位只有一个写入口（配置），运行时不该能改它。
 * 代价是「配置变了 ⇒ 派生副本（provider 实例）过期」，而**过期必须由副本持有者负责失效**。
 *
 * 本模块就是那个失效动作的唯一实现。三个前提都已存在于仓库，本模块不新增任何机制：
 *   1. 真源写通道唯一（`settingsWrite.writeSetting` = `getConfiguration().update()`）
 *      ⇒ **必触发** `onDidChangeConfiguration`；
 *   2. 监听器已存在并已判 `memora.providers` / `memora.activeProvider`（`extension.ts` 激活期）；
 *   3. 换实例的三个动作已在 `Agent` 上（`setProvider` / `setContextWindow` / `setMaxTokens`）。
 *
 * ## 两件事必须拆开（本模块的核心判断）
 *
 * - **按钮态**：`chat_providers` 投影读的是 store（真源）⇒ 与内核实例无关 ⇒ **总能立刻正确**。
 * - **入口门禁**：读的是内核 provider 实例 ⇒ 必须换实例，而换实例带 `assertNotBusy`
 *   ⇒ 有轮在跑时只能顺延（调用方置 stale，在下一个安全点补做）。
 *
 * 混为一谈的后果是「按钮亮了、发送仍被拦」——所以 `pushProviders` 在**所有**出口都执行，
 * 包括刷新失败时：按钮该按真源说话，门禁的滞后由调用方的顺延机制承担。
 *
 * ## 零 vscode 依赖
 *
 * 只依赖内核类型与 `resolveContextWindow`；宿主侧差异（怎么读真源、怎么造实例、怎么推投影）
 * 全部经 `ProviderRefreshDeps` 注入 ⇒ 可纯单测，不需要 vscode 替身。
 */
import { resolveContextWindow, type LlmProvider } from '@zooique/memora';

/**
 * 热刷新需要的 Agent 能力面（结构化最小集，不 import Agent 全域）
 *
 * 三个方法都是**同步**且带 `assertNotBusy`：连续同步调用之间没有 await，
 * 因此不存在「provider 换了、窗口没换」的半应用（busy 状态在同一 tick 内不会变）。
 * 若将来有人把其中任一改成异步，这条保证即失效——那时必须重新设计原子性。
 */
export interface RefreshingAgent {
  setProvider(provider: LlmProvider): void;
  setContextWindow(tokens: number): void;
  setMaxTokens(tokens: number | undefined): void;
}

/** 已激活配置的原始声明（只取热刷新要同步的两项；其余字段由 `buildProvider` 自行读） */
export interface ActiveConfigDecl {
  /** per-LLM 上下文窗口原始值（undefined ⇒ `resolveContextWindow` 回落内核默认） */
  contextWindow?: number;
  /** per-LLM 输出预算原始值（undefined ⇒ 内核回落） */
  maxTokens?: number;
}

/** 注入面：宿主差异全部收在这里 */
export interface ProviderRefreshDeps {
  /** 已装配 agent；`undefined` = 尚未装配（无派生副本需要失效） */
  getAgent(): RefreshingAgent | undefined;
  /**
   * 真源 → 激活配置声明。返回 `undefined` 表示**无激活配置**（env 回退路径）：
   * 此时能力位恒 false 且不随配置变化，重建没有意义，故跳过（不是失败）。
   */
  getActiveConfig(): Promise<ActiveConfigDecl | undefined>;
  /**
   * 按当前真源构造内核实例（宿主传 `createProvider` 的偏应用，见 `llmConfig.ts`）。
   *
   * 它是 async（读 SecretStorage）⇒ 可能超时 / 被拒。这类失败**不得**被当作「已生效」：
   * 保留旧实例 + 让调用方留 stale 才是诚实的。
   *
   * 注意：它与 `getActiveConfig` 各自读一次配置（`createProvider` 封装了「读配置 + 读密钥 +
   * 构造」，绕过它自拼实例 = 复制一份能力位映射 = 第二真源）。极端竞态（两次读之间用户又改
   * 配置）最多让窗口与实例差一次，而那次变更会再触发本函数 ⇒ 自愈。
   */
  buildProvider(): Promise<LlmProvider>;
  /** 推送 provider 列表投影（按钮态）。各出口都会调用，含失败出口 */
  pushProviders(): Promise<void>;
}

/** 刷新结果（调用方据此决定「清 stale」还是「留 stale」） */
export type ProviderRefreshOutcome =
  | {
      applied: true;
      /** 未做实例重建的原因（都不是失败：没有派生副本 / 无激活配置） */
      skipped?: 'not-assembled' | 'no-active';
    }
  | {
      applied: false;
      /** `load-failed` = 读真源或造实例失败；`busy` = 有轮在跑，`setProvider` 被 `assertNotBusy` 拒绝 */
      reason: 'load-failed' | 'busy';
      /**
       * 原始异常（供调用方转用户文案，如 `toNoticeText`）。
       *
       * 本模块刻意**不生成面向用户的文案**：内核报错文案是「跨层契约」（内核不知道宿主长什么样，
       * 见 `llmCaller` 一级门禁的文案纪律），宿主侧文案应由宿主自己派生；这里只如实透出原因。
       */
      error: unknown;
    };

/**
 * 让已装配实例与其投影跟上真源配置。
 *
 * 幂等：重复调用（如「下拉切换」与「配置变更监听」双执行）产生同样的终态，
 * 代价只是一次纯内存构造 + 一次投影推送 —— 这比引入「我刚做过」的抑制标记更简单，
 * 且抑制标记本身会变成第三处状态。**双执行是接受的取舍，不是疏漏。**
 *
 * @param deps 注入面（见 {@link ProviderRefreshDeps}）
 */
export async function refreshActiveProvider(
  deps: ProviderRefreshDeps,
): Promise<ProviderRefreshOutcome> {
  const agent = deps.getAgent();
  // 未装配：没有过期副本。投影仍推（面板可能已开、agent 仍在懒装配）——
  // 下次装配会直接读真源，天然是新值。
  if (!agent) {
    await deps.pushProviders();
    return { applied: true, skipped: 'not-assembled' };
  }

  let config: ActiveConfigDecl | undefined;
  try {
    config = await deps.getActiveConfig();
  } catch (err) {
    // 读失败 ≠ 已生效：保留旧实例，让调用方留 stale 等下次安全点重试
    await deps.pushProviders();
    return { applied: false, reason: 'load-failed', error: err };
  }
  // 无激活配置（env 回退）：能力位恒 false 且不随配置变化，重建无意义
  if (!config) {
    await deps.pushProviders();
    return { applied: true, skipped: 'no-active' };
  }

  let provider: LlmProvider;
  try {
    provider = await deps.buildProvider();
  } catch (err) {
    await deps.pushProviders();
    return { applied: false, reason: 'load-failed', error: err };
  }

  try {
    // 顺序有意：能力位（主目标）先落，窗口与预算次之。三者同步调用 ⇒ 无半应用窗口。
    agent.setProvider(provider);
    agent.setContextWindow(resolveContextWindow(config.contextWindow));
    agent.setMaxTokens(config.maxTokens);
  } catch (err) {
    // 唯一预期抛出点 = `assertNotBusy`。其余异常同样按「未生效」处理：
    // 宁可多留一次 stale 让下次重试，也不声称已生效（那会退货真价实的「UI 撒谎」）
    await deps.pushProviders();
    return { applied: false, reason: 'busy', error: err };
  }
  await deps.pushProviders();
  return { applied: true };
}
