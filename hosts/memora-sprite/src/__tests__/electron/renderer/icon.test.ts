/**
 * SVG sprite 图标 helper 测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - setIcon：基础图标注入、sizeClass 修饰、动态 iconId、innerHTML 清空旧内容
 * - setIconWithLabel：图标 + span label 组合、label textContent 转义（防 XSS）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setIcon, setIconWithLabel, type IconSizeClass } from '../../../electron/renderer/helpers/icon.js';

describe('setIcon', () => {
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement('button');
  });

  it('应注入 sprite 引用 SVG（含 .icon 基类 + #iconId 引用）', () => {
    setIcon(el, 'icon-send');
    // 应生成 <svg class="icon"><use href="#icon-send"/></svg>
    const svg = el.querySelector('svg.icon');
    expect(svg).toBeTruthy();
    const use = svg?.querySelector('use');
    expect(use?.getAttribute('href')).toBe('#icon-send');
  });

  it('无 sizeClass 时 class 应为 "icon"（仅基类）', () => {
    setIcon(el, 'icon-copy');
    const svg = el.querySelector('svg');
    expect(svg?.className.baseVal).toBe('icon');
  });

  it('sizeClass="icon-sm" 时 class 应为 "icon icon-sm"', () => {
    setIcon(el, 'icon-eye', 'icon-sm');
    const svg = el.querySelector('svg');
    expect(svg?.className.baseVal).toBe('icon icon-sm');
  });

  it('sizeClass="icon-xs" 时 class 应为 "icon icon-xs"', () => {
    setIcon(el, 'icon-tools', 'icon-xs');
    const svg = el.querySelector('svg');
    expect(svg?.className.baseVal).toBe('icon icon-xs');
  });

  it('应支持动态 iconId（运行时拼接 # 前缀）', () => {
    const dynamicIconId = 'icon-maximize';
    setIcon(el, dynamicIconId);
    const use = el.querySelector('use');
    expect(use?.getAttribute('href')).toBe('#icon-maximize');
  });

  it('应清空元素原有内容后注入新图标', () => {
    // 预填充旧内容
    el.innerHTML = '<span>旧内容</span>';
    expect(el.children.length).toBe(1);
    // 注入新图标
    setIcon(el, 'icon-close');
    // 旧 span 应被清空，仅剩 svg
    expect(el.children.length).toBe(1);
    expect(el.querySelector('span')).toBeNull();
    expect(el.querySelector('svg')).toBeTruthy();
  });

  it('应满足 IconSizeClass 类型约束（编译期校验）', () => {
    // 类型层面的约束：IconSizeClass 仅接受 'icon-sm' | 'icon-xs'
    const validSize: IconSizeClass = 'icon-sm';
    setIcon(el, 'icon-check', validSize);
    expect(el.querySelector('svg')?.className.baseVal).toContain('icon-sm');
  });
});

describe('setIconWithLabel', () => {
  let el: HTMLElement;

  beforeEach(() => {
    el = document.createElement('div');
  });

  it('应注入图标 + span label（label 在 svg 之后）', () => {
    setIconWithLabel(el, 'icon-gear', '正在思考...');
    // 结构：<svg class="icon">...</svg><span>正在思考...</span>
    const svg = el.querySelector('svg.icon');
    const span = el.querySelector('span');
    expect(svg).toBeTruthy();
    expect(span).toBeTruthy();
    expect(span?.textContent).toBe('正在思考...');
  });

  it('label 应使用 textContent 赋值（HTML 特殊字符应被转义，防 XSS）', () => {
    const maliciousLabel = '<img src=x onerror=alert(1)>';
    setIconWithLabel(el, 'icon-warning', maliciousLabel);
    // span.textContent 应为原始字符串（未解析为 HTML）
    const span = el.querySelector('span');
    expect(span?.textContent).toBe(maliciousLabel);
    // 不应生成 img 元素（XSS 未触发）
    expect(el.querySelector('img')).toBeNull();
  });

  it('label 含 & < > " 字符时应被转义', () => {
    const label = 'a & b < c > d " e';
    setIconWithLabel(el, 'icon-info', label);
    const span = el.querySelector('span');
    expect(span?.textContent).toBe(label);
  });

  it('应清空元素原有内容后注入图标 + label', () => {
    el.innerHTML = '<div>旧内容</div>';
    setIconWithLabel(el, 'icon-gear', '新标签');
    // 旧 div 应被清空，仅剩 svg + span
    expect(el.querySelector('div')).toBeNull();
    expect(el.querySelector('svg')).toBeTruthy();
    expect(el.querySelector('span')?.textContent).toBe('新标签');
  });

  it('空 label 应生成空 span', () => {
    setIconWithLabel(el, 'icon-gear', '');
    const span = el.querySelector('span');
    expect(span).toBeTruthy();
    expect(span?.textContent).toBe('');
  });
});
