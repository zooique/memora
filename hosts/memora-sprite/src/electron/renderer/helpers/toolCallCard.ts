/**
 * 工具调用卡片渲染器（QC-R2-12 从 chatPanelManager.ts 提取）
 *
 * 职责：
 *   在消息气泡内渲染工具调用卡片，显示工具名、参数、执行状态和结果摘要。
 *   让用户感知精灵正在执行工具（如文件读取、记忆搜索等）。
 *
 * 提取原因：
 *   chatPanelManager.ts 1143 行超标（QC-R2-12），工具调用卡片 DOM 创建逻辑
 *   ~130 行是相对独立的子功能，提取为纯函数模块降低 chatPanelManager 体量。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，接收 bubble 元素作为参数
 *   - 创建卡片 DOM 结构（header + chevron + icon + name + spinner + status）
 *   - 支持按 toolCallId 精确定位 + 按 name 降级匹配
 *   - P1-SEC-02 使用 getAttribute + filter 匹配，避免 CSS 选择器注入风险
 */

/**
 * UX-P1-02 显示工具调用开始卡片
 *
 * 在消息气泡内渲染工具调用卡片，显示工具名和参数。
 * 卡片插入到光标元素之前（若存在），否则追加到 bubble 末尾。
 *
 * @param bubble 消息气泡元素（.message-bubble）
 * @param toolCallId 工具调用 ID（用于精确定位对应卡片）
 * @param name 工具名称
 * @param args 工具参数（可选，JSON 字符串）
 */
export function showToolStart(
  bubble: Element,
  toolCallId: string,
  name: string,
  args?: string,
): void {
  // 创建工具调用卡片
  const toolCard = document.createElement('div');
  toolCard.className = 'tool-call tool-call-running';
  toolCard.setAttribute('data-tool-call-id', toolCallId);
  toolCard.setAttribute('data-tool-name', name);

  // 工具图标 + 折叠箭头 + 名称 + 状态（含 spinner）
  const header = document.createElement('div');
  header.className = 'tool-call-header';
  // 折叠/展开箭头
  const chevron = document.createElement('span');
  chevron.className = 'tool-call-chevron';
  chevron.textContent = '▼';
  header.appendChild(chevron);
  const icon = document.createElement('span');
  icon.textContent = '🔧';
  header.appendChild(icon);
  const nameSpan = document.createElement('span');
  nameSpan.className = 'tool-call-name';
  nameSpan.textContent = name;
  header.appendChild(nameSpan);
  // UX-PP-12 执行中 spinner：旋转动画替代静态"执行中..."文本，增强视觉反馈
  const spinner = document.createElement('span');
  spinner.className = 'tool-call-spinner';
  header.appendChild(spinner);
  const status = document.createElement('span');
  status.className = 'tool-call-status';
  status.textContent = '执行中...';
  header.appendChild(status);

  // 点击表头折叠/展开参数和结果
  // QC-11 使用 data-action 属性替代直接 addEventListener，由构造函数中的事件委托统一处理
  header.dataset.action = 'toggle-collapse';
  // P3 键盘可访问性：tabindex 使工具调用折叠头可通过键盘聚焦并 Enter/Space 触发
  header.setAttribute('tabindex', '0');

  toolCard.appendChild(header);

  // 工具参数（若提供）
  if (args) {
    const argsDiv = document.createElement('div');
    argsDiv.className = 'tool-call-args';
    argsDiv.textContent = args;
    toolCard.appendChild(argsDiv);
  }

  // 插入到光标元素之前（若存在），否则追加到 bubble 末尾
  const cursor = bubble.querySelector('.cursor');
  if (cursor) {
    bubble.insertBefore(toolCard, cursor);
  } else {
    bubble.appendChild(toolCard);
  }
}

/**
 * UX-P1-02 更新工具调用结果
 *
 * 更新工具调用卡片状态为成功/失败，显示结果摘要。
 * 完成后自动折叠卡片，减少视觉干扰（用户可点击表头展开查看详情）。
 *
 * @param bubble 消息气泡元素（.message-bubble）
 * @param toolCallId 工具调用 ID（用于精确定位对应卡片）
 * @param name 工具名称（降级匹配时使用）
 * @param ok 是否成功
 * @param summary 结果摘要（可选）
 */
export function updateToolResult(
  bubble: Element,
  toolCallId: string,
  name: string,
  ok: boolean,
  summary?: string,
): void {
  // 查找对应工具的卡片（按 data-tool-call-id 精确定位）
  // P1-SEC-02 使用 getAttribute + filter 匹配，避免 CSS 选择器注入风险
  const allCards = bubble.querySelectorAll('.tool-call');
  const cards = Array.from(allCards).filter((card) => card.getAttribute('data-tool-call-id') === toolCallId);
  // 精确匹配失败时降级为按 name 匹配（兼容旧格式）
  // QC-TC-02 noUncheckedIndexedAccess 模式下 cards[0] 类型为 Element | undefined，需 ?? null 收窄
  let targetCard: Element | null = cards.length > 0 ? (cards[0] ?? null) : null;
  if (!targetCard) {
    // 降级：按 data-tool-name 匹配，取最后一个未完成的
    const nameCards = Array.from(allCards).filter((card) => card.getAttribute('data-tool-name') === name);
    for (const card of Array.from(nameCards)) {
      if (card.classList.contains('tool-call-running')) {
        targetCard = card;
        break;
      }
    }
  }
  if (!targetCard) return;

  // 更新卡片状态
  targetCard.classList.remove('tool-call-running');
  targetCard.classList.add(ok ? 'tool-call-success' : 'tool-call-failed');

  // UX-PP-12 移除 spinner（执行结束，不再需要旋转动画）
  const spinner = targetCard.querySelector('.tool-call-spinner');
  if (spinner) spinner.remove();

  // 更新状态文本
  const status = targetCard.querySelector('.tool-call-status');
  if (status) {
    status.textContent = ok ? '✓ 成功' : '✗ 失败';
  }

  // 追加结果摘要
  if (summary) {
    const resultDiv = document.createElement('div');
    resultDiv.className = 'tool-call-result';
    resultDiv.textContent = summary;
    targetCard.appendChild(resultDiv);
  }

  // 完成后自动折叠，减少视觉干扰（用户可点击表头展开查看详情）
  targetCard.classList.add('collapsed');
}
