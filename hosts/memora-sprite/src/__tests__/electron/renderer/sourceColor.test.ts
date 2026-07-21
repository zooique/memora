/**
 * 记忆来源颜色映射纯函数测试
 *
 * 覆盖范围：
 * - getSourceColorClass：source 字符串到 CSS 颜色类名的映射
 *
 * 从 memoryPanelManager.test.ts 迁入（函数已从 memoryPanelManager 提取到
 * helpers/sourceColor.ts，消除 helpers→panels 循环依赖，测试同步迁移）。
 *
 * 纯逻辑测试，无 JSDOM 依赖。
 */
import { describe, it, expect } from 'vitest';
import { getSourceColorClass } from '../../../electron/renderer/helpers/sourceColor.js';

describe('getSourceColorClass', () => {
  // ─── 已知 source 映射 ──────────────────────────────────

  it('profile 应映射到 profile（绿色，用户画像）', () => {
    expect(getSourceColorClass('profile')).toBe('profile');
  });

  it('insight 应映射到 insight（蓝色，洞察）', () => {
    expect(getSourceColorClass('insight')).toBe('insight');
  });

  it('guardrail 应映射到 guardrail（粉色，护栏）', () => {
    expect(getSourceColorClass('guardrail')).toBe('guardrail');
  });

  it('skill 应映射到 skill（黄色，技能）', () => {
    expect(getSourceColorClass('skill')).toBe('skill');
  });

  it('rule 应映射到 rule（紫色，规则）', () => {
    expect(getSourceColorClass('rule')).toBe('rule');
  });

  it('persona 应映射到 persona（青色，角色）', () => {
    expect(getSourceColorClass('persona')).toBe('persona');
  });

  it('session 应映射到 session（橙色，会话）', () => {
    expect(getSourceColorClass('session')).toBe('session');
  });

  // ─── 大小写与空格容错 ──────────────────────────────────

  it('大写 source 应转为小写后映射（Profile → profile）', () => {
    expect(getSourceColorClass('Profile')).toBe('profile');
  });

  it('混合大小写应转为小写后映射（INSIGHT → insight）', () => {
    expect(getSourceColorClass('INSIGHT')).toBe('insight');
  });

  it('前后空格应 trim 后映射（"  rule  " → rule）', () => {
    expect(getSourceColorClass('  rule  ')).toBe('rule');
  });

  // ─── 未知 source 降级 ──────────────────────────────────

  it('未知 source 应返回 default（灰色降级）', () => {
    expect(getSourceColorClass('unknown')).toBe('default');
  });

  it('空字符串应返回 default', () => {
    expect(getSourceColorClass('')).toBe('default');
  });

  it('自定义 source（如 chat）应返回 default', () => {
    // 注意：'chat' 已在 SOURCE_LABELS 中（chat: '对话'），
    // 方案 1 后 KNOWN_SOURCES 派生自 SOURCE_LABELS，故 'chat' 现在是已知 source 返回 'chat'
    expect(getSourceColorClass('chat')).toBe('chat');
  });

  it('真正未知的 source 应返回 default', () => {
    expect(getSourceColorClass('nonexistent-source')).toBe('default');
  });

  it('纯空格应 trim 后为空，返回 default', () => {
    expect(getSourceColorClass('   ')).toBe('default');
  });
});
