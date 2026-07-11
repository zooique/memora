/**
 * 表单校验工具模块测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - showFieldError：设置 aria-invalid + 填充错误文本 + 返回元素供聚焦
 * - clearFieldErrors：批量移除 aria-invalid + 隐藏错误文本
 * - 元素缺失降级：input 不存在时返回 body，errorEl 不存在时不抛错
 *
 * 测试策略：JSDOM 环境下动态创建 input + error 容器，调用后断言 DOM 状态。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { showFieldError, clearFieldErrors } from '../../../electron/renderer/helpers/formValidation.js';

beforeEach(() => {
  // 每个用例前清空 body，避免残留
  document.body.innerHTML = '';
});

// ─── showFieldError ────────────────────────────────────────

describe('showFieldError', () => {
  it('应设置 input 的 aria-invalid=true 并填充错误文本', () => {
    // 准备：input + 遵循 {id}-error 命名约定的错误容器
    const input = document.createElement('input');
    input.id = 'test-field';
    document.body.appendChild(input);

    const errorEl = document.createElement('p');
    errorEl.id = 'test-field-error';
    errorEl.classList.add('hidden');
    document.body.appendChild(errorEl);

    // 执行
    const result = showFieldError('test-field', '必填字段不能为空');

    // 断言：aria-invalid 已设置
    expect(input.getAttribute('aria-invalid')).toBe('true');
    // 断言：错误文本已填充，hidden 已移除
    expect(errorEl.textContent).toBe('必填字段不能为空');
    expect(errorEl.classList.contains('hidden')).toBe(false);
    // 断言：返回的元素是 input 本身（供调用方 focus）
    expect(result).toBe(input);
  });

  it('input 不存在时应降级返回 body，且不抛错', () => {
    // 仅创建 error 容器，不创建 input
    const errorEl = document.createElement('p');
    errorEl.id = 'missing-input-error';
    document.body.appendChild(errorEl);

    // 执行 + 断言：不抛错，返回 body
    const result = showFieldError('missing-input', '错误信息');
    expect(result).toBe(document.body);

    // 断言：error 容器仍被正确填充（解耦设计，error 独立于 input）
    expect(errorEl.textContent).toBe('错误信息');
    expect(errorEl.classList.contains('hidden')).toBe(false);
  });

  it('error 容器不存在时应仅设置 aria-invalid，不抛错', () => {
    const input = document.createElement('input');
    input.id = 'no-error-container';
    document.body.appendChild(input);

    // 执行 + 断言：不抛错
    const result = showFieldError('no-error-container', '错误信息');
    expect(result).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});

// ─── clearFieldErrors ──────────────────────────────────────

describe('clearFieldErrors', () => {
  it('应批量移除多个字段的 aria-invalid 并隐藏错误文本', () => {
    // 准备 3 个字段，全部处于错误状态
    const fieldIds = ['field-a', 'field-b', 'field-c'];
    for (const id of fieldIds) {
      const input = document.createElement('input');
      input.id = id;
      input.setAttribute('aria-invalid', 'true');
      document.body.appendChild(input);

      const errorEl = document.createElement('p');
      errorEl.id = `${id}-error`;
      errorEl.textContent = `${id} 错误`;
      errorEl.classList.remove('hidden');
      document.body.appendChild(errorEl);
    }

    // 执行
    clearFieldErrors(fieldIds);

    // 断言：所有字段的 aria-invalid 已移除
    for (const id of fieldIds) {
      const input = document.getElementById(id)!;
      expect(input.hasAttribute('aria-invalid')).toBe(false);

      const errorEl = document.getElementById(`${id}-error`)!;
      expect(errorEl.textContent).toBe('');
      expect(errorEl.classList.contains('hidden')).toBe(true);
    }
  });

  it('空数组时应无操作，不抛错', () => {
    expect(() => clearFieldErrors([])).not.toThrow();
  });

  it('字段不存在时应跳过，不抛错', () => {
    // 不创建任何元素，直接调用
    expect(() => clearFieldErrors(['nonexistent-field'])).not.toThrow();
  });

  it('字段存在但 error 容器不存在时应仅移除 aria-invalid', () => {
    const input = document.createElement('input');
    input.id = 'has-input-no-error';
    input.setAttribute('aria-invalid', 'true');
    document.body.appendChild(input);

    // 执行：不抛错，aria-invalid 被移除
    clearFieldErrors(['has-input-no-error']);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });
});
