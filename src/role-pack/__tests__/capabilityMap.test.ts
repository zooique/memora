/**
 * capabilities → 工具映射测试（M2.1：换角色 → 工具集切换）
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCapabilityTools,
  isToolInCapabilities,
} from '@/role-pack/capabilityMap.js';

describe('resolveCapabilityTools（中立能力 → memora 工具白名单）', () => {
  it('映射项目总监角色包：file + web + llm 能力 → 工具白名单', () => {
    const caps = [
      { capability: 'file:read' },
      { capability: 'file:write' },
      { capability: 'web:search' },
      { capability: 'llm:summarize' },
    ];
    const tools = resolveCapabilityTools(caps);
    expect(tools).toContain('read_file');
    expect(tools).toContain('write_file');
    expect(tools).toContain('web_search');
    // llm:summarize 是内核内部能力，无工具映射
    expect(tools).not.toContain('summarize');
    // 去重
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('映射技术文档工程师角色包：仅 llm:summarize → 空工具集', () => {
    const tools = resolveCapabilityTools([{ capability: 'llm:summarize' }]);
    expect(tools).toEqual([]);
  });

  it('翻译助手（toolMode=block，无 capabilities）→ 空白名单', () => {
    expect(resolveCapabilityTools([])).toEqual([]);
    expect(resolveCapabilityTools(undefined)).toEqual([]);
  });

  it('未知能力跳过不阻塞（spec §四）', () => {
    const tools = resolveCapabilityTools([
      { capability: 'file:read' },
      { capability: 'unknown:xyz' },
      { capability: 'file:list' },
    ]);
    expect(tools).toEqual(['read_file', 'list_dir']);
  });

  it('isToolInCapabilities：白名单内为 true，外为 false', () => {
    const caps = [{ capability: 'file:write' }];
    expect(isToolInCapabilities('write_file', caps)).toBe(true);
    expect(isToolInCapabilities('read_file', caps)).toBe(false);
    // 无能力声明时全部暴露 → 视为在白名单外（由 list() null 分支控制）
    expect(isToolInCapabilities('read_file', undefined)).toBe(false);
  });

  it('task:plan 映射到任务表工具', () => {
    const tools = resolveCapabilityTools([{ capability: 'task:plan' }]);
    expect(tools).toEqual(['task_table_write', 'task_table_update']);
  });
});
