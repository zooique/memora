/**
 * getToolDisplayName 纯函数单测（阶段 A P2-1：字符串脚本逻辑抽为可测模块后的第一层覆盖）
 */
import { describe, it, expect } from 'vitest';
import { getToolDisplayName, toolNameMapScript } from '../toolNameMap.js';

describe('getToolDisplayName', () => {
  it('映射已知工具为中文标签', () => {
    expect(getToolDisplayName('read_file')).toBe('读取文件');
    expect(getToolDisplayName('write_file')).toBe('写入文件');
    expect(getToolDisplayName('web_search')).toBe('网络搜索');
    expect(getToolDisplayName('create_skill')).toBe('创建技能');
  });

  it('未知工具回退原值', () => {
    expect(getToolDisplayName('some_new_tool')).toBe('some_new_tool');
  });

  it('注入脚本由纯函数源码序列化（单一真源）', () => {
    expect(toolNameMapScript).toContain('function getToolDisplayName');
  });
});
