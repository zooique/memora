/**
 * 记忆面板控制器纯函数测试
 *
 * 覆盖范围：
 * - formatTokenCount：token 数格式化（< 1000 直显 / >= 1000 显示为 "X.Xk"）
 *
 * 仅测试从 createMemoryController 闭包提取到模块顶层的纯函数。
 * createMemoryController 工厂函数重度依赖 uiManager + electronAPI + DOM，
 * 整体测试需完整 mock，留待后续按需补充。
 *
 * 纯逻辑测试，无 JSDOM 依赖。
 */
import { describe, it, expect } from 'vitest';
import { formatTokenCount } from '../../electron/renderer/controllers/memoryPanelController.js';

describe('formatTokenCount', () => {
  it('0 应返回 "0"', () => {
    expect(formatTokenCount(0)).toBe('0');
  });

  it('1 应返回 "1"', () => {
    expect(formatTokenCount(1)).toBe('1');
  });

  it('999 应返回 "999"（边界，< 1000 直显）', () => {
    expect(formatTokenCount(999)).toBe('999');
  });

  it('1000 应返回 "1.0k"（边界，>= 1000 走 k 格式）', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
  });

  it('1234 应返回 "1.2k"（toFixed(1) 截断）', () => {
    expect(formatTokenCount(1234)).toBe('1.2k');
  });

  it('1500 应返回 "1.5k"', () => {
    expect(formatTokenCount(1500)).toBe('1.5k');
  });

  it('9999 应返回 "10.0k"', () => {
    expect(formatTokenCount(9999)).toBe('10.0k');
  });

  it('12345 应返回 "12.3k"（万级数字格式化）', () => {
    expect(formatTokenCount(12345)).toBe('12.3k');
  });
});
