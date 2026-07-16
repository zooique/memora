/**
 * 消息装饰器模块测试
 *
 * 覆盖范围：
 * - createRecallContainer：创建召回记忆容器 DOM
 * - renderMemoryRecall：在气泡内渲染召回记忆
 * - showThinkingPhase：显示思考阶段指示器
 * - showTruncationNotice：显示上下文截断提示
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRecallContainer,
  renderMemoryRecall,
  showThinkingPhase,
  showTruncationNotice,
} from '../../../electron/renderer/helpers/messageDecorations.js';
import type { MemoryRecallItem } from '../../../electron/renderer/helpers/messageDecorations.js';

// ─── 测试辅助：创建消息气泡元素 ──────────────────────────
function createBubble(): HTMLDivElement {
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  document.body.appendChild(bubble);
  return bubble;
}

/** 创建包含光标元素的气泡（模拟流式输出中） */
function createBubbleWithCursor(): HTMLDivElement {
  const bubble = createBubble();
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  bubble.appendChild(cursor);
  return bubble;
}

/** 创建召回记忆条目 */
function makeRecall(name: string, score = 0.9, source = 'insight'): MemoryRecallItem {
  return { name, score, source };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

// ─── createRecallContainer ────────────────────────────────

describe('createRecallContainer', () => {
  it('空数组应返回容器（包含 header 和空 list）', () => {
    const container = createRecallContainer([]);
    expect(container.className).toBe('memory-recall-container');
    // 新结构：header + list
    expect(container.children.length).toBe(2);
    expect(container.children[0].className).toBe('memory-recall-header');
    expect(container.children[1].className).toBe('memory-recall-list');
    // list 为空
    expect((container.children[1] as HTMLDivElement).children.length).toBe(0);
  });

  it('单条记忆应创建 header + list 结构', () => {
    const container = createRecallContainer([makeRecall('用户偏好')]);
    expect(container.className).toBe('memory-recall-container');
    // 新结构：header + list
    expect(container.children.length).toBe(2);
    const header = container.children[0] as HTMLDivElement;
    const list = container.children[1] as HTMLDivElement;
    expect(header.className).toBe('memory-recall-header');
    expect(list.className).toBe('memory-recall-list');
    // list 包含一条记忆
    expect(list.children.length).toBe(1);
    const item = list.children[0] as HTMLDivElement;
    expect(item.className).toBe('memory-recall');
    expect(item.dataset.action).toBe('recall');
    expect(item.dataset.name).toBe('用户偏好');
  });

  it('多条记忆应创建对应数量的条目在 list 中', () => {
    const memories = [
      makeRecall('记忆A', 0.9),
      makeRecall('记忆B', 0.7),
      makeRecall('记忆C', 0.5),
    ];
    const container = createRecallContainer(memories);
    // 新结构：header + list
    expect(container.children.length).toBe(2);
    const list = container.children[1] as HTMLDivElement;
    expect(list.children.length).toBe(3);
  });

  it('每条条目应包含图标和名称文本', () => {
    const container = createRecallContainer([makeRecall('测试记忆', 0.85)]);
    const list = container.children[1] as HTMLDivElement;
    const item = list.children[0] as HTMLDivElement;
    // 图标 span
    const iconSpan = item.children[0] as HTMLSpanElement;
    expect(iconSpan.innerHTML).toContain('icon-lightbulb');
    // 名称 span（新结构中不再显示 score）
    const textSpan = item.children[1] as HTMLSpanElement;
    expect(textSpan.textContent).toContain('测试记忆');
  });

  it('每条条目应设置 data-action="recall" 用于事件委托', () => {
    const container = createRecallContainer([
      makeRecall('A'),
      makeRecall('B'),
    ]);
    const list = container.children[1] as HTMLDivElement;
    for (const item of Array.from(list.children)) {
      const el = item as HTMLElement;
      expect(el.dataset.action).toBe('recall');
    }
  });

  it('每条条目应设置 data-name 为记忆名称', () => {
    const container = createRecallContainer([
      makeRecall('name1'),
      makeRecall('name2'),
    ]);
    const list = container.children[1] as HTMLDivElement;
    const names = Array.from(list.children).map(
      (c) => (c as HTMLElement).dataset.name,
    );
    expect(names).toEqual(['name1', 'name2']);
  });
});

// ─── renderMemoryRecall ───────────────────────────────────

describe('renderMemoryRecall', () => {
  it('无召回记忆时不创建容器', () => {
    const bubble = createBubble();
    renderMemoryRecall(bubble, []);
    expect(bubble.querySelector('.memory-recall-container')).toBeNull();
  });

  it('有召回记忆时创建容器', () => {
    const bubble = createBubble();
    renderMemoryRecall(bubble, [makeRecall('测试')]);
    const container = bubble.querySelector('.memory-recall-container');
    expect(container).not.toBeNull();
    // 新结构：header + list
    expect(container!.children.length).toBe(2);
  });

  it('重复调用应先移除旧容器再重建', () => {
    const bubble = createBubble();
    // 第一次
    renderMemoryRecall(bubble, [makeRecall('A')]);
    // 第二次
    renderMemoryRecall(bubble, [makeRecall('B'), makeRecall('C')]);
    const containers = bubble.querySelectorAll('.memory-recall-container');
    expect(containers.length).toBe(1);
    // 新结构：header + list（始终是 2 个子元素）
    expect(containers[0].children.length).toBe(2);
    // list 中应有 2 条记忆
    const list = containers[0].children[1] as HTMLDivElement;
    expect(list.children.length).toBe(2);
  });

  it('光标存在时容器应插入到光标之前', () => {
    const bubble = createBubbleWithCursor();
    renderMemoryRecall(bubble, [makeRecall('测试')]);
    // 容器应在光标之前
    const container = bubble.querySelector('.memory-recall-container');
    const cursor = bubble.querySelector('.cursor');
    expect(container).not.toBeNull();
    expect(cursor).not.toBeNull();
    // container 的 nextSibling 应为 cursor
    expect(container!.nextSibling).toBe(cursor);
  });

  it('无光标时应追加到 bubble 末尾', () => {
    const bubble = createBubble();
    bubble.appendChild(document.createElement('span'));
    renderMemoryRecall(bubble, [makeRecall('测试')]);
    const container = bubble.querySelector('.memory-recall-container');
    // 容器应该是 bubble 的最后一个子元素
    expect(bubble.lastChild).toBe(container);
  });

  it('空数组调用应移除已有容器', () => {
    const bubble = createBubble();
    renderMemoryRecall(bubble, [makeRecall('A')]);
    expect(bubble.querySelector('.memory-recall-container')).not.toBeNull();
    renderMemoryRecall(bubble, []);
    expect(bubble.querySelector('.memory-recall-container')).toBeNull();
  });
});

// ─── showThinkingPhase ────────────────────────────────────

describe('showThinkingPhase', () => {
  it('首次调用应创建 .thinking-phase 元素', () => {
    const bubble = createBubble();
    showThinkingPhase(bubble, 'recalling');
    const indicator = bubble.querySelector('.thinking-phase');
    expect(indicator).not.toBeNull();
    expect(indicator!.innerHTML).toContain('icon-gear');
    expect(indicator!.textContent).toContain('正在回忆相关记忆…');
  });

  it('recalling 阶段应显示中文"正在回忆相关记忆"', () => {
    const bubble = createBubble();
    showThinkingPhase(bubble, 'recalling');
    const indicator = bubble.querySelector('.thinking-phase');
    expect(indicator!.innerHTML).toContain('icon-gear');
    expect(indicator!.textContent).toContain('正在回忆相关记忆…');
  });

  it('processing 阶段应显示中文"正在处理请求"', () => {
    const bubble = createBubble();
    showThinkingPhase(bubble, 'processing');
    const indicator = bubble.querySelector('.thinking-phase');
    expect(indicator!.innerHTML).toContain('icon-gear');
    expect(indicator!.textContent).toContain('正在处理请求…');
  });

  it('archiving 阶段应显示中文"正在归档对话"', () => {
    const bubble = createBubble();
    showThinkingPhase(bubble, 'archiving');
    const indicator = bubble.querySelector('.thinking-phase');
    expect(indicator!.innerHTML).toContain('icon-gear');
    expect(indicator!.textContent).toContain('正在归档对话…');
  });

  it('未知阶段应显示原始 phase 值', () => {
    const bubble = createBubble();
    showThinkingPhase(bubble, 'unknown_phase');
    const indicator = bubble.querySelector('.thinking-phase');
    expect(indicator!.innerHTML).toContain('icon-gear');
    expect(indicator!.textContent).toContain('unknown_phase');
  });

  it('复用已存在的 .thinking-phase 元素（不创建新元素）', () => {
    const bubble = createBubble();
    showThinkingPhase(bubble, 'recalling');
    const first = bubble.querySelector('.thinking-phase');
    showThinkingPhase(bubble, 'processing');
    const second = bubble.querySelector('.thinking-phase');
    // 应复用同一个元素
    expect(second).toBe(first);
    // 文案已更新
    expect(second!.innerHTML).toContain('icon-gear');
    expect(second!.textContent).toContain('正在处理请求…');
  });

  it('多次切换阶段应始终只有一个 .thinking-phase 元素', () => {
    const bubble = createBubble();
    showThinkingPhase(bubble, 'recalling');
    showThinkingPhase(bubble, 'processing');
    showThinkingPhase(bubble, 'archiving');
    const indicators = bubble.querySelectorAll('.thinking-phase');
    expect(indicators.length).toBe(1);
  });
});

// ─── showTruncationNotice ─────────────────────────────────

describe('showTruncationNotice', () => {
  it('首次调用应创建 .truncation-notice 元素', () => {
    const bubble = createBubble();
    // 先添加一个子元素，确保 insertBefore 正确工作
    bubble.appendChild(document.createElement('span'));
    showTruncationNotice(bubble, 1);
    const notice = bubble.querySelector('.truncation-notice');
    expect(notice).not.toBeNull();
  });

  it('首次调用应创建图标 + 文本 + 关闭按钮三段结构', () => {
    const bubble = createBubble();
    showTruncationNotice(bubble, 1);
    const notice = bubble.querySelector('.truncation-notice')!;
    // 图标 span（含 SVG use 引用）
    const icon = notice.querySelector('.truncation-icon');
    expect(icon).not.toBeNull();
    expect(icon!.querySelector('use')?.getAttribute('href')).toBe('#icon-warning');
    // 文本 span
    const text = notice.querySelector('.truncation-text');
    expect(text).not.toBeNull();
    expect(text!.textContent).toBe('上下文已截断，部分历史已省略');
    // 关闭按钮
    const closeBtn = notice.querySelector('.truncation-close') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn.dataset.action).toBe('dismiss-truncation');
    expect(closeBtn.getAttribute('aria-label')).toBe('关闭截断提示');
  });

  it('count=1 时不显示次数', () => {
    const bubble = createBubble();
    showTruncationNotice(bubble, 1);
    const notice = bubble.querySelector('.truncation-notice');
    expect(notice!.querySelector('.truncation-text')!.textContent).toBe('上下文已截断，部分历史已省略');
  });

  it('count>1 时应显示具体次数', () => {
    const bubble = createBubble();
    showTruncationNotice(bubble, 3);
    const notice = bubble.querySelector('.truncation-notice');
    expect(notice!.querySelector('.truncation-text')!.textContent).toBe('上下文已截断 3 次，部分历史已省略');
  });

  it('count=2 时应显示次数', () => {
    const bubble = createBubble();
    showTruncationNotice(bubble, 2);
    const notice = bubble.querySelector('.truncation-notice');
    expect(notice!.querySelector('.truncation-text')!.textContent).toContain('2 次');
  });

  it('复用已存在的 .truncation-notice 元素（仅更新文本，不重建关闭按钮）', () => {
    const bubble = createBubble();
    showTruncationNotice(bubble, 1);
    const first = bubble.querySelector('.truncation-notice');
    const firstCloseBtn = first!.querySelector('.truncation-close');
    showTruncationNotice(bubble, 5);
    const second = bubble.querySelector('.truncation-notice');
    expect(second).toBe(first);
    // 文本已更新
    expect(second!.querySelector('.truncation-text')!.textContent).toContain('5 次');
    // 关闭按钮未被重建（引用相同）
    expect(second!.querySelector('.truncation-close')).toBe(firstCloseBtn);
  });

  it('应插入到 bubble 顶部（第一个子元素）', () => {
    const bubble = createBubble();
    const existing = document.createElement('span');
    bubble.appendChild(existing);
    showTruncationNotice(bubble, 1);
    const notice = bubble.querySelector('.truncation-notice');
    expect(bubble.firstChild).toBe(notice);
  });

  it('多次调用应始终只有一个 .truncation-notice 元素', () => {
    const bubble = createBubble();
    showTruncationNotice(bubble, 1);
    showTruncationNotice(bubble, 2);
    showTruncationNotice(bubble, 3);
    const notices = bubble.querySelectorAll('.truncation-notice');
    expect(notices.length).toBe(1);
  });
});