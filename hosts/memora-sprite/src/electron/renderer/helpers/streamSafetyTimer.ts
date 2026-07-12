/**
 * 流式输出安全兜底定时器（从 chatPanelManager.ts 提取）
 *
 * 职责：
 *   30s/90s 二级兜底逻辑，防止流式输出挂起时 UI 无响应。
 *   - 30s 主定时器：无新 chunk 时通知主进程疑似卡死（onStreamStuck）
 *   - 90s 二级兜底：主进程未响应时本地清理流式状态（onFallbackCleanup）
 *
 * 提取原因：
 *   chatPanelManager.ts 1446 行超标，安全兜底定时器逻辑 ~58 行
 *   是相对独立的子功能，提取为自包含类降低 chatPanelManager 体量。
 *
 * 设计（模式 D：自包含类）：
 *   - 通过 hooks 注入 isStreaming/onStreamStuck/onFallbackCleanup 三个回调
 *   - 保留原始嵌套逻辑：90s 兜底仅在 30s 主定时器触发且仍在流式时启动
 *     （若流式在 30s 前正常结束则不创建 fallback 定时器，避免与后续新流式产生竞态）
 *   - reset() 每次先 clear() 再重建主定时器（多次调用不累积）
 *   - dispose() 等同 clear()，用于 cleanup 时统一清理
 */

/** 安全兜底定时器 hooks（由 ChatPanelManager 注入） */
export interface StreamSafetyTimerHooks {
  /** 查询当前是否仍在流式输出（定时器触发时判断是否需要执行兜底） */
  isStreaming(): boolean;
  /** 30s 主定时器触发且仍在流式时调用：通知主进程疑似卡死（主进程应 abort 当前对话） */
  onStreamStuck(): void;
  /** 90s 二级兜底触发且仍在流式时调用：主进程未响应，本地清理流式状态 */
  onFallbackCleanup(): void;
}

/**
 * 流式输出安全兜底定时器
 *
 * 30s/90s 二级兜底，防止 SPRITE_STREAM_END 丢失导致 UI 永远卡在"回答中"状态。
 * 每次收到新 chunk 时调用 reset() 重置定时器。
 */
export class StreamSafetyTimer {
  /** 30s 主定时器（无新 chunk 时触发 onStreamStuck） */
  private primaryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 90s 二级兜底定时器（主定时器触发后启动，主进程未响应时本地清理） */
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param hooks 回调注入（isStreaming 查询 + onStreamStuck 30s 通知 + onFallbackCleanup 90s 清理）
   * @param primaryMs 主定时器延迟（默认 30s）
   * @param fallbackMs 二级兜底总延迟（默认 90s = primaryMs + 60s 内部延迟）
   */
  constructor(
    private readonly hooks: StreamSafetyTimerHooks,
    private readonly primaryMs: number = 30_000,
    private readonly fallbackMs: number = 90_000,
  ) {}

  /**
   * 重置定时器（每次收到流式 chunk 时调用）
   *
   * 先清除旧定时器，再重新启动 30s 主定时器。
   * 多次调用不累积（clear + set 模式）。
   */
  reset(): void {
    this.clear();
    // 30s 主定时器：仅通知主进程疑似卡死，本地不清理状态，等待主进程的 END/ABORTED 驱动清理
    this.primaryTimer = setTimeout(() => {
      // 流式已正常结束则不触发兜底
      if (!this.hooks.isStreaming()) return;
      this.hooks.onStreamStuck();
      // 90s 二级兜底（远大于主进程 60s）：若主进程未响应才本地清理
      // 仅在主定时器触发且仍在流式时启动，避免与后续新流式产生竞态
      this.fallbackTimer = setTimeout(() => {
        if (!this.hooks.isStreaming()) return;
        // 清理 fallback timer 自身引用（已触发，置 null 让 clear() 不再尝试 clearTimeout）
        this.fallbackTimer = null;
        this.hooks.onFallbackCleanup();
      }, this.fallbackMs - this.primaryMs);
    }, this.primaryMs);
  }

  /**
   * 清除所有定时器（流式正常结束 / 手动停止 / cleanup 时调用）
   */
  clear(): void {
    if (this.primaryTimer !== null) {
      clearTimeout(this.primaryTimer);
      this.primaryTimer = null;
    }
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  /**
   * 销毁定时器（等同 clear，与其他 Manager 的 dispose 生命周期接口对齐）
   */
  dispose(): void {
    this.clear();
  }
}
