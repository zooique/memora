/**
 * 工具调用卡片渲染器模块测试（QC-TEST-EXTRACTED）
 *
 * 覆盖范围：
 * - showToolStart：创建工具调用开始卡片 DOM
 * - updateToolResult：更新工具调用结果（成功/失败/摘要）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  showToolStart,
  updateToolResult,
} from '../../../electron/renderer/helpers/toolCallCard.js';

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

beforeEach(() => {
  document.body.innerHTML = '';
});

// ─── showToolStart ────────────────────────────────────────

describe('showToolStart', () => {
  it('应创建 .tool-call-running 卡片', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'read_file');
    const card = bubble.querySelector('.tool-call-card');
    expect(card).not.toBeNull();
    expect(card!.classList.contains('tool-call-running')).toBe(true);
  });

  it('应设置 data-tool-call-id 属性', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-123', 'search');
    const card = bubble.querySelector('.tool-call-card');
    expect(card!.getAttribute('data-tool-call-id')).toBe('tc-123');
  });

  it('应设置 data-tool-name 属性', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'read_file');
    const card = bubble.querySelector('.tool-call-card');
    expect(card!.getAttribute('data-tool-name')).toBe('read_file');
  });

  it('应包含表头（chevron + icon + name + spinner + status）', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'write_file');
    const header = bubble.querySelector('.tool-call-header');
    expect(header).not.toBeNull();
    // chevron
    expect(header!.querySelector('.tool-call-chevron')!.innerHTML).toContain('icon-chevron');
    // icon
    expect(header!.querySelector('span:nth-child(2)')!.innerHTML).toContain('icon-tools');
    // name
    expect(header!.querySelector('.tool-call-name')!.textContent).toBe('write_file');
    // spinner
    expect(header!.querySelector('.tool-call-spinner')).not.toBeNull();
    // status
    expect(header!.querySelector('.tool-call-status')!.textContent).toBe('执行中...');
  });

  it('表头应设置 data-action="toggle-collapse" 用于事件委托', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    const header = bubble.querySelector('.tool-call-header') as HTMLElement;
    expect(header.dataset.action).toBe('toggle-collapse');
  });

  it('有 args 参数时应创建 .tool-call-args 元素', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search', '{"query": "test"}');
    const argsDiv = bubble.querySelector('.tool-call-args');
    expect(argsDiv).not.toBeNull();
    expect(argsDiv!.textContent).toBe('{"query": "test"}');
  });

  it('无 args 参数时不应创建 .tool-call-args 元素', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    const argsDiv = bubble.querySelector('.tool-call-args');
    expect(argsDiv).toBeNull();
  });

  it('光标存在时卡片应插入到光标之前', () => {
    const bubble = createBubbleWithCursor();
    showToolStart(bubble, 'tc-1', 'search');
    const card = bubble.querySelector('.tool-call-card');
    const cursor = bubble.querySelector('.cursor');
    expect(card!.nextSibling).toBe(cursor);
  });

  it('无光标时应追加到 bubble 末尾', () => {
    const bubble = createBubble();
    bubble.appendChild(document.createElement('span'));
    showToolStart(bubble, 'tc-1', 'search');
    const card = bubble.querySelector('.tool-call-card');
    expect(bubble.lastChild).toBe(card);
  });

  it('多个工具调用卡片应共存', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'read_file');
    showToolStart(bubble, 'tc-2', 'write_file');
    const cards = bubble.querySelectorAll('.tool-call-card');
    expect(cards.length).toBe(2);
    expect(cards[0].getAttribute('data-tool-call-id')).toBe('tc-1');
    expect(cards[1].getAttribute('data-tool-call-id')).toBe('tc-2');
  });
});

// ─── updateToolResult ─────────────────────────────────────

describe('updateToolResult', () => {
  it('成功时应移除 running 类并添加 success 类', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    updateToolResult(bubble, 'tc-1', 'search', true);
    const card = bubble.querySelector('.tool-call-card');
    expect(card!.classList.contains('tool-call-running')).toBe(false);
    expect(card!.classList.contains('tool-call-success')).toBe(true);
  });

  it('失败时应移除 running 类并添加 failed 类', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    updateToolResult(bubble, 'tc-1', 'search', false);
    const card = bubble.querySelector('.tool-call-card');
    expect(card!.classList.contains('tool-call-running')).toBe(false);
    expect(card!.classList.contains('tool-call-failed')).toBe(true);
  });

  it('成功时应更新状态为 SVG 图标 + 成功文本', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    updateToolResult(bubble, 'tc-1', 'search', true);
    const status = bubble.querySelector('.tool-call-status');
    expect(status!.innerHTML).toContain('icon-check');
    expect(status!.textContent).toContain('成功');
  });

  it('失败时应更新状态为 SVG 图标 + 失败文本', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    updateToolResult(bubble, 'tc-1', 'search', false);
    const status = bubble.querySelector('.tool-call-status');
    expect(status!.innerHTML).toContain('icon-close');
    expect(status!.textContent).toContain('失败');
  });

  it('完成后应移除 spinner 元素', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    updateToolResult(bubble, 'tc-1', 'search', true);
    const spinner = bubble.querySelector('.tool-call-spinner');
    expect(spinner).toBeNull();
  });

  it('有摘要时应创建 .tool-call-result 元素', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    updateToolResult(bubble, 'tc-1', 'search', true, '找到 3 条结果');
    const result = bubble.querySelector('.tool-call-result');
    expect(result).not.toBeNull();
    expect(result!.textContent).toBe('找到 3 条结果');
  });

  it('无摘要时不应创建 .tool-call-result 元素', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    updateToolResult(bubble, 'tc-1', 'search', true);
    const result = bubble.querySelector('.tool-call-result');
    expect(result).toBeNull();
  });

  it('完成后应自动折叠（添加 collapsed 类）', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    updateToolResult(bubble, 'tc-1', 'search', true);
    const card = bubble.querySelector('.tool-call-card');
    expect(card!.classList.contains('collapsed')).toBe(true);
  });

  it('按 toolCallId 精确定位对应卡片', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-A', 'search');
    showToolStart(bubble, 'tc-B', 'read');
    // 更新 tc-A
    updateToolResult(bubble, 'tc-A', 'search', true);
    // tc-A 应已更新
    const cardA = bubble.querySelector('[data-tool-call-id="tc-A"]')!;
    expect(cardA.classList.contains('tool-call-success')).toBe(true);
    // tc-B 应仍为 running
    const cardB = bubble.querySelector('[data-tool-call-id="tc-B"]')!;
    expect(cardB.classList.contains('tool-call-running')).toBe(true);
  });

  it('toolCallId 精确匹配失败时应降级按 name 匹配', () => {
    const bubble = createBubble();
    showToolStart(bubble, 'tc-1', 'search');
    // 用不存在的 toolCallId 但匹配的 name 调用
    updateToolResult(bubble, 'tc-nonexistent', 'search', true);
    const card = bubble.querySelector('.tool-call-card');
    expect(card!.classList.contains('tool-call-success')).toBe(true);
  });

  it('降级匹配应只匹配 running 状态的卡片', () => {
    const bubble = createBubble();
    // 插入两个同名工具调用，第一个已完成
    showToolStart(bubble, 'tc-1', 'search');
    updateToolResult(bubble, 'tc-1', 'search', true);
    // 第二个正在运行
    showToolStart(bubble, 'tc-2', 'search');
    // 降级匹配应更新 running 的那个（tc-2）
    updateToolResult(bubble, 'tc-nonexistent', 'search', false);
    const card1 = bubble.querySelector('[data-tool-call-id="tc-1"]')!;
    const card2 = bubble.querySelector('[data-tool-call-id="tc-2"]')!;
    // tc-1 仍为 success
    expect(card1.classList.contains('tool-call-success')).toBe(true);
    // tc-2 已变为 failed
    expect(card2.classList.contains('tool-call-failed')).toBe(true);
  });

  it('找不到匹配卡片时应静默返回（不抛错）', () => {
    const bubble = createBubble();
    // 没有任何工具调用卡片时更新
    expect(() => {
      updateToolResult(bubble, 'tc-1', 'search', true);
    }).not.toThrow();
  });
});