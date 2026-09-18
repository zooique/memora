/**
 * getToolDisplayName / getToolIcon 纯函数单测（阶段 A/B P2-1：纯逻辑抽为可测模块后的覆盖）
 *
 * 键集合对齐约束见 toolNameMap.ts 文件头：本测试顺带守卫「未知工具回退」语义，
 * 已知键逐一断言中文标签/图标，防幽灵键死灰复燃。
 */
import { describe, it, expect } from 'vitest';
import { getToolDisplayName, getToolIcon } from '../toolNameMap.js';

describe('getToolDisplayName', () => {
  it('映射已知工具为中文标签', () => {
    // 内置工具清单代表性抽查（read/write/记忆/追溯/会议/压缩），映射缺失会回退英文 → 此断言即漂移哨兵
    expect(getToolDisplayName('read_file')).toBe('读取文件');
    expect(getToolDisplayName('write_file')).toBe('写入文件');
    expect(getToolDisplayName('web_search')).toBe('网络搜索');
    expect(getToolDisplayName('search_memories')).toBe('搜索记忆');
    expect(getToolDisplayName('trace_summary')).toBe('追溯摘要');
    expect(getToolDisplayName('run_team_meeting')).toBe('团队会议');
    expect(getToolDisplayName('compress_context')).toBe('压缩上下文');
    expect(getToolDisplayName('ask_user')).toBe('询问用户');
    expect(getToolDisplayName('list_sessions')).toBe('列出会话');
    expect(getToolDisplayName('read_skill')).toBe('读取技能');
  });

  it('未知工具回退原值', () => {
    expect(getToolDisplayName('some_new_tool')).toBe('some_new_tool');
  });

  it('幽灵键不再返回旧映射（防死灰复燃）', () => {
    // 内核零存在的工具名应回退原值而非「看起来存在」的中文标签
    expect(getToolDisplayName('memory_search')).toBe('memory_search');
    expect(getToolDisplayName('create_skill')).toBe('create_skill');
    expect(getToolDisplayName('create_rule')).toBe('create_rule');
  });
});

describe('getToolIcon', () => {
  it('映射已知工具为 emoji 图标', () => {
    expect(getToolIcon('read_file')).toBe('📄');
    expect(getToolIcon('search_memories')).toBe('🔍');
    expect(getToolIcon('run_team_meeting')).toBe('👥');
    expect(getToolIcon('web_fetch')).toBe('🌍');
  });

  it('未知工具回退通用齿轮', () => {
    expect(getToolIcon('some_new_tool')).toBe('⚙️');
  });
});
