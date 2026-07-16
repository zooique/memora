/**
 * UI 初始化失败错误卡片测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - renderInitFailureToBody：Error 实例消息提取、非 Error 的 String 转换
 * - DOM 结构验证：卡片 id、标题文案、错误消息、排查建议
 * - inline style 注入（避免依赖 CSS 文件加载状态）
 * - 重复调用清理旧卡片（避免重复挂载）
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API（document.createElement / document.body）
 * - 无需 mock 任何模块（纯 DOM 操作函数）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderInitFailureToBody } from '../../../electron/renderer/helpers/initFailureCard.js';

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

// ─── 1. 错误信息提取 ─────────────────────────────────────

describe('错误信息提取', () => {
  it('Error 实例应提取 message 字段', () => {
    const err = new Error('核心元素 #chat-messages 不存在');
    renderInitFailureToBody(err);
    const card = document.getElementById('ui-init-failure-card');
    expect(card).toBeTruthy();
    // 错误消息渲染在第二个 p 元素（msg）
    const msgEl = card?.querySelector('p:nth-of-type(1)');
    expect(msgEl?.textContent).toBe('核心元素 #chat-messages 不存在');
  });

  it('SpriteError（继承 Error）应提取 message', () => {
    // 模拟 SpriteError 结构（继承 Error，有 message 字段）
    const err = new Error('INITIALIZATION_FAILED: 预检失败');
    err.name = 'SpriteError';
    renderInitFailureToBody(err);
    const card = document.getElementById('ui-init-failure-card');
    const msgEl = card?.querySelector('p');
    expect(msgEl?.textContent).toBe('INITIALIZATION_FAILED: 预检失败');
  });

  it('非 Error 的字符串应通过 String() 转换', () => {
    renderInitFailureToBody('字符串错误信息');
    const card = document.getElementById('ui-init-failure-card');
    const msgEl = card?.querySelector('p');
    expect(msgEl?.textContent).toBe('字符串错误信息');
  });

  it('非 Error 的数字应通过 String() 转换', () => {
    renderInitFailureToBody(404);
    const card = document.getElementById('ui-init-failure-card');
    const msgEl = card?.querySelector('p');
    expect(msgEl?.textContent).toBe('404');
  });

  it('null 应降级为 "null" 字符串', () => {
    renderInitFailureToBody(null);
    const card = document.getElementById('ui-init-failure-card');
    const msgEl = card?.querySelector('p');
    expect(msgEl?.textContent).toBe('null');
  });

  it('undefined 应降级为 "undefined" 字符串', () => {
    renderInitFailureToBody(undefined);
    const card = document.getElementById('ui-init-failure-card');
    const msgEl = card?.querySelector('p');
    expect(msgEl?.textContent).toBe('undefined');
  });

  it('对象应通过 String() 转换为 [object Object]', () => {
    renderInitFailureToBody({ code: 500 });
    const card = document.getElementById('ui-init-failure-card');
    const msgEl = card?.querySelector('p');
    expect(msgEl?.textContent).toBe('[object Object]');
  });
});

// ─── 2. DOM 结构验证 ────────────────────────────────────

describe('DOM 结构验证', () => {
  it('应在 document.body 挂载卡片元素', () => {
    renderInitFailureToBody(new Error('test'));
    const card = document.getElementById('ui-init-failure-card');
    expect(card).toBeTruthy();
    expect(card?.parentElement).toBe(document.body);
  });

  it('卡片应为 div 元素并设置 id=ui-init-failure-card', () => {
    renderInitFailureToBody(new Error('test'));
    const card = document.getElementById('ui-init-failure-card');
    expect(card?.tagName).toBe('DIV');
  });

  it('卡片应通过 className 应用样式（CSP style-src self 合规，不使用 inline style）', () => {
    renderInitFailureToBody(new Error('test'));
    const card = document.getElementById('ui-init-failure-card') as HTMLElement;
    // UI-0713-B2：样式由 base.css 中 .ui-init-failure-card 类提供，不使用 inline style
    // 测试只验证 className 已正确应用，具体样式由 CSS 文件保证
    expect(card.classList.contains('ui-init-failure-card')).toBe(true);
    // inline style 应为空（CSP style-src 'self' 禁止 inline style）
    expect(card.style.cssText).toBe('');
  });

  it('卡片应为样式类预留主题适配（CSS 类内 var() + fallback 由 base.css 提供）', () => {
    renderInitFailureToBody(new Error('test'));
    const card = document.getElementById('ui-init-failure-card') as HTMLElement;
    // UI-0713-B2：颜色 var(--token, fallback) 写在 base.css 的 .ui-init-failure-card 类中
    // 测试只验证 className 已应用，主题适配由 CSS 文件保证（JSDOM 不解析 CSS）
    expect(card.classList.contains('ui-init-failure-card')).toBe(true);
  });

  it('应包含 h2 标题"UI 初始化失败"', () => {
    renderInitFailureToBody(new Error('test'));
    const card = document.getElementById('ui-init-failure-card');
    const title = card?.querySelector('h2');
    expect(title).toBeTruthy();
    expect(title?.textContent).toBe('UI 初始化失败');
    // UI-0713-B2：标题色由 .ui-init-failure-title 类提供，不使用 inline style
    expect(title?.classList.contains('ui-init-failure-title')).toBe(true);
  });

  it('应包含排查建议（可能原因 + 3 条建议）', () => {
    renderInitFailureToBody(new Error('test'));
    const card = document.getElementById('ui-init-failure-card');
    // 排查建议是第二个 p 元素（hints）
    const hintsList = card?.querySelectorAll('p');
    expect(hintsList?.length).toBeGreaterThanOrEqual(2);
    const hints = hintsList?.[hintsList.length - 1];
    // innerHTML 包含 strong 标签 + 3 条建议
    expect(hints?.innerHTML).toContain('<strong>可能原因：</strong>');
    expect(hints?.innerHTML).toContain('HTML 元素 ID 缺失');
    expect(hints?.innerHTML).toContain('构建产物未刷新');
    expect(hints?.innerHTML).toContain('index.html 与 ui.ts 不同步');
  });
});

// ─── 3. 重复调用清理旧卡片 ─────────────────────────────

describe('重复调用清理旧卡片', () => {
  it('重复调用应移除旧卡片再挂载新卡片（不重复）', () => {
    renderInitFailureToBody(new Error('第一次错误'));
    renderInitFailureToBody(new Error('第二次错误'));
    // document.body 应只有一个 #ui-init-failure-card
    const cards = document.querySelectorAll('#ui-init-failure-card');
    expect(cards.length).toBe(1);
    // 新卡片应显示第二次错误信息
    const msgEl = cards[0]?.querySelector('p');
    expect(msgEl?.textContent).toBe('第二次错误');
  });

  it('三次连续调用应仅保留最后一次', () => {
    renderInitFailureToBody(new Error('A'));
    renderInitFailureToBody(new Error('B'));
    renderInitFailureToBody(new Error('C'));
    const cards = document.querySelectorAll('#ui-init-failure-card');
    expect(cards.length).toBe(1);
    const msgEl = cards[0]?.querySelector('p');
    expect(msgEl?.textContent).toBe('C');
  });

  it('已存在旧卡片时新卡片应正确挂载到 body', () => {
    renderInitFailureToBody(new Error('旧'));
    const oldCard = document.getElementById('ui-init-failure-card');
    expect(oldCard).toBeTruthy();
    renderInitFailureToBody(new Error('新'));
    const newCard = document.getElementById('ui-init-failure-card');
    expect(newCard).toBeTruthy();
    expect(newCard?.parentElement).toBe(document.body);
    // 旧卡片应已被移除（不在 DOM 中）
    expect(newCard).not.toBe(oldCard);
  });
});
