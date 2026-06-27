/**
 * 消息装饰器（QC-R2-12 从 chatPanelManager.ts 提取）
 *
 * 职责：
 *   在消息气泡内渲染装饰性元素：召回记忆容器、思考阶段指示器、上下文截断提示。
 *   这些元素在流式输出过程中动态插入/更新，让用户感知精灵的工作状态。
 *
 * 提取原因：
 *   chatPanelManager.ts 1015 行超标（QC-R2-12），三段装饰器 DOM 逻辑 ~131 行
 *   是相对独立的子功能，提取为纯函数模块降低 chatPanelManager 体量。
 *   同时消除 createRecallContainer 在 appendMessage 和 setMemoryRecall 两处的重复调用。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，接收 bubble 元素作为参数
 *   - 召回记忆容器：支持初次创建和已存在时重建（setMemoryRecall 场景）
 *   - 思考阶段指示器：支持复用已存在的 .thinking-phase 元素
 *   - 截断提示：支持复用已存在的 .truncation-notice 元素
 */

/** 召回记忆摘要条目（与 Message.memoryRecall 一致） */
export interface MemoryRecallItem {
  /** 记忆名称 */
  name: string;
  /** 召回得分 */
  score: number;
  /** 记忆来源 */
  source: string;
}

/**
 * 思考阶段中文映射
 *
 * 将内核 yield 的 thinking phase 标识符映射为用户可读的中文文案。
 * 从 chatPanelManager.THINKING_PHASE_LABELS 迁移（QC-R2-12）。
 */
const THINKING_PHASE_LABELS: Record<string, string> = {
  recalling: '正在回忆...',
  processing: '正在处理...',
  archiving: '正在归档...',
};

/**
 * MS-12 构建召回记忆容器
 *
 * 每条召回记忆独立可点击，点击触发 memoryRecallClickCallback 跳转记忆详情。
 * 使用 createElement 替代 innerHTML，避免 XSS 风险（UX-08）。
 * 使用 data-action 属性替代直接 addEventListener，由事件委托统一处理（QC-11）。
 *
 * @param memories 召回记忆摘要列表
 * @returns 已填充的容器 DOM 元素
 */
export function createRecallContainer(memories: MemoryRecallItem[]): HTMLDivElement {
  const recallContainer = document.createElement('div');
  recallContainer.className = 'memory-recall-container';
  for (const recall of memories) {
    const recallItem = document.createElement('div');
    recallItem.className = 'memory-recall';
    // UX-08：使用 createElement 替代 innerHTML，避免 XSS 风险
    const iconSpan = document.createElement('span');
    iconSpan.textContent = '💡';
    recallItem.appendChild(iconSpan);
    const recallText = document.createElement('span');
    recallText.textContent = `召回记忆：${recall.name}（score: ${recall.score.toFixed(2)}）`;
    recallItem.appendChild(recallText);
    // QC-11 使用 data-action 属性替代直接 addEventListener，由构造函数中的事件委托统一处理
    recallItem.dataset.action = 'recall';
    recallItem.dataset.name = recall.name;
    recallContainer.appendChild(recallItem);
  }
  return recallContainer;
}

/**
 * MS-12 设置流式消息的召回记忆摘要
 *
 * 在 startStreaming 之后、text chunk 之前调用，
 * 将召回记忆摘要注入到消息气泡底部，用户可点击跳转记忆详情。
 * 若已存在召回容器，先移除再重建（避免重复追加）。
 * 无召回记忆时不创建容器。
 *
 * @param bubble 消息气泡元素（.message-bubble）
 * @param memories 召回记忆摘要列表（name/score/source）
 */
export function renderMemoryRecall(bubble: Element, memories: MemoryRecallItem[]): void {
  // 若已存在召回容器，先清空（避免重复追加）
  const existingContainer = bubble.querySelector('.memory-recall-container');
  if (existingContainer) {
    existingContainer.remove();
  }

  // 无召回记忆时不创建容器
  if (memories.length === 0) return;

  // 复用 createRecallContainer 统一构建逻辑
  const recallContainer = createRecallContainer(memories);
  // 插入到光标元素之前（若存在），否则追加到 bubble 末尾
  const cursor = bubble.querySelector('.cursor');
  if (cursor) {
    bubble.insertBefore(recallContainer, cursor);
  } else {
    bubble.appendChild(recallContainer);
  }
}

/**
 * UX-P2-01 显示思考阶段指示器
 *
 * 在消息气泡内显示"正在回忆.../处理.../归档..."提示，
 * 让用户在等待首个 text chunk 时知道精灵正在工作。
 * 当 text chunk 到达时，指示器会被 updateStreamingMessage 移除。
 * 若已存在 .thinking-phase 元素则复用并更新文案。
 *
 * @param bubble 消息气泡元素（.message-bubble）
 * @param phase 思考阶段（recalling/processing/archiving）
 */
export function showThinkingPhase(bubble: Element, phase: string): void {
  // 查找或创建思考阶段指示器
  let indicator = bubble.querySelector('.thinking-phase') as HTMLDivElement | null;
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'thinking-phase';
    bubble.appendChild(indicator);
  }

  // 更新阶段文案
  const label = THINKING_PHASE_LABELS[phase] ?? phase;
  indicator.textContent = `⚙️ ${label}`;
}

/**
 * OBS-02 在消息气泡顶部显示上下文截断提示条
 *
 * 当对话中发生上下文截断时，在消息气泡顶部插入持久提示条，
 * 告知用户部分历史消息已被省略。遵循"主动可见"原则，非 hover 显示。
 * 若已存在 .truncation-notice 元素则复用并更新文案。
 *
 * @param bubble 消息气泡元素（.message-bubble）
 * @param count 本次对话中发生的截断次数
 */
export function showTruncationNotice(bubble: Element, count: number): void {
  // 查找或创建截断提示条（插入到 bubble 顶部，thinking-phase 之前）
  let notice = bubble.querySelector('.truncation-notice') as HTMLDivElement | null;
  if (!notice) {
    notice = document.createElement('div');
    notice.className = 'truncation-notice';
    bubble.insertBefore(notice, bubble.firstChild);
  }

  // 更新提示文案（count > 1 时显示次数）
  notice.textContent = count > 1
    ? `⚠️ 上下文已截断 ${count} 次，部分历史已省略`
    : '⚠️ 上下文已截断，部分历史已省略';
}
