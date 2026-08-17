/**
 * cardList 纯函数单测（SSOT 收敛 2026-08-17：configView / rolesView 共享的列表级 DOM 构建）
 *
 * createGroupTitle / createEmptyState 均以 jsdom document 注入调用，
 * 断言 DOM 结构与 textContent 文案（textContent 赋值防注入，不拼 innerHTML）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyState, createGroupTitle } from '../cardList.js';

describe('createGroupTitle', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('构建 group-title 分区标题，文本经 textContent 赋值', () => {
    const el = createGroupTitle(document, '当前角色');
    document.body.appendChild(el);
    expect(el.className).toBe('group-title');
    expect(el.textContent).toBe('当前角色');
    // textContent 赋值防注入：HTML 字符串按原文显示而非解析为节点
    const inject = createGroupTitle(document, '<b>x</b>');
    expect(inject.textContent).toBe('<b>x</b>');
    expect(inject.querySelector('b')).toBeNull();
  });
});

describe('createEmptyState', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('构建 empty-state > empty-title + empty-hint 两层结构', () => {
    const el = createEmptyState(document, { title: '暂无角色包', hint: '请先打开一个工作区' });
    document.body.appendChild(el);
    expect(el.className).toBe('empty-state');
    expect(el.querySelector('.empty-title')?.textContent).toBe('暂无角色包');
    expect(el.querySelector('.empty-hint')?.textContent).toBe('请先打开一个工作区');
  });
});
