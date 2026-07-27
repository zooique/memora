/**
 * 角色名显示映射单元测试
 *
 * @vitest-environment node
 *
 * 覆盖范围：
 * - 已知内部名映射（ai_agent_role / default / assistant）
 * - 蛇形命名转换（snake_case → "Snake Case"）
 * - 中文/已友好名称保持不变
 * - 空字符串边界
 */
import { describe, it, expect } from 'vitest';
import { formatPersonaDisplayName } from '../../../electron/renderer/helpers/personaLabel.js';

describe('formatPersonaDisplayName', () => {
  it('已知内部名 ai_agent_role → 精灵', () => {
    expect(formatPersonaDisplayName('ai_agent_role')).toBe('精灵');
  });

  it('已知内部名 default → 精灵', () => {
    expect(formatPersonaDisplayName('default')).toBe('精灵');
  });

  it('已知内部名 assistant → 助手', () => {
    expect(formatPersonaDisplayName('assistant')).toBe('助手');
  });

  it('蛇形命名转换为空格大写格式', () => {
    expect(formatPersonaDisplayName('code_reviewer')).toBe('Code Reviewer');
  });

  it('蛇形命名带数字', () => {
    expect(formatPersonaDisplayName('agent_v2')).toBe('Agent V2');
  });

  it('中文名称保持不变', () => {
    expect(formatPersonaDisplayName('程序员')).toBe('程序员');
  });

  it('已是友好格式的名称保持不变', () => {
    expect(formatPersonaDisplayName('Code Reviewer')).toBe('Code Reviewer');
  });

  it('空字符串返回空字符串', () => {
    expect(formatPersonaDisplayName('')).toBe('');
  });
});
