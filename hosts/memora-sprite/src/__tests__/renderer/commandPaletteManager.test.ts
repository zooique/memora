/**
 * 命令面板管理器单元测试
 *
 * 覆盖范围：
 * - searchCommands 搜索算法（模糊匹配、得分排序、空输入）
 * - 命令列表结构（分组、ID 唯一性、必填字段）
 * - 边界情况（空查询、无匹配、特殊字符）
 */

import { describe, it, expect } from 'vitest';
import { searchCommands, type Command } from '../../electron/renderer/panels/commandPaletteManager.js';

// ─── 测试用命令列表 ──────────────────────────────────────────

/** 模拟简化的命令列表，覆盖多种搜索场景 */
function createTestCommands(): Command[] {
  return [
    {
      id: 'nav-chat',
      label: '切换到对话面板',
      keywords: '对话 聊天 chat 消息',
      section: '导航',
      action: () => {},
    },
    {
      id: 'nav-memories',
      label: '切换到记忆面板',
      keywords: '记忆 memories 知识',
      section: '导航',
      action: () => {},
    },
    {
      id: 'mem-add',
      label: '添加记忆',
      keywords: '添加 新增 创建 记忆',
      section: '记忆',
      action: () => {},
    },
    {
      id: 'mem-search',
      label: '搜索记忆',
      keywords: '搜索 查找 记忆 检索',
      section: '记忆',
      action: () => {},
    },
    {
      id: 'settings-llm',
      label: '打开 LLM 设置',
      keywords: '大模型 模型 API 配置',
      section: '设置',
      action: () => {},
    },
    {
      id: 'action-theme',
      label: '切换主题（浅色/深色）',
      keywords: '主题 浅色 深色 暗色 theme',
      section: '动作',
      action: () => {},
    },
  ];
}

// ─── searchCommands 测试 ─────────────────────────────────────

describe('searchCommands', () => {
  const commands = createTestCommands();

  describe('空输入', () => {
    it('应返回全部命令（按 score 0 排序）', () => {
      const results = searchCommands(commands, '');
      expect(results).toHaveLength(6);
      expect(results.every((r) => r.score === 0)).toBe(true);
    });

    it('纯空格输入应视为空输入', () => {
      const results = searchCommands(commands, '   ');
      expect(results).toHaveLength(6);
    });
  });

  describe('精确 label 匹配', () => {
    it('应匹配 label 中包含关键词的命令', () => {
      const results = searchCommands(commands, '对话');
      expect(results).toHaveLength(1);
      expect(results[0].command.id).toBe('nav-chat');
    });

    it('label 匹配得分应高于 keywords 匹配', () => {
      const results = searchCommands(commands, '记忆');
      // "切换到记忆面板" (label 匹配) 和 "搜索记忆" (keywords 匹配) 都应出现
      expect(results.length).toBeGreaterThanOrEqual(2);
      // label 匹配的排第一
      const navIndex = results.findIndex((r) => r.command.id === 'nav-memories');
      const searchIndex = results.findIndex((r) => r.command.id === 'mem-search');
      expect(navIndex).toBeLessThan(searchIndex);
    });
  });

  describe('keywords 匹配', () => {
    it('应通过 keywords 匹配命令', () => {
      const results = searchCommands(commands, 'chat');
      expect(results).toHaveLength(1);
      expect(results[0].command.id).toBe('nav-chat');
    });

    it('英文 keywords 应不区分大小写', () => {
      const results = searchCommands(commands, 'CHAT');
      expect(results).toHaveLength(1);
      expect(results[0].command.id).toBe('nav-chat');
    });
  });

  describe('section 匹配', () => {
    it('应通过 section 名称匹配命令', () => {
      const results = searchCommands(commands, '导航');
      // "导航" section 包含 2 个命令
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((r) => r.command.section === '导航')).toBe(true);
    });
  });

  describe('多词搜索', () => {
    it('应同时匹配所有词（AND 逻辑）', () => {
      const results = searchCommands(commands, '记忆 搜索');
      // "搜索记忆" 同时匹配 "记忆" 和 "搜索"
      expect(results).toHaveLength(1);
      expect(results[0].command.id).toBe('mem-search');
    });

    it('任一词不匹配应排除该命令', () => {
      const results = searchCommands(commands, '对话 不存在');
      // "对话" 匹配 nav-chat，但 "不存在" 不匹配任何命令
      expect(results).toHaveLength(0);
    });
  });

  describe('得分排序', () => {
    it('多词匹配应得分更高', () => {
      const results = searchCommands(commands, '记忆 面板');
      // "切换到记忆面板" 匹配两个词，应排第一
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].command.id).toBe('nav-memories');
    });

    it('label + keywords 都匹配应得分最高', () => {
      const results = searchCommands(commands, '切换 主题');
      // "切换主题" 的 label 匹配 "切换" 和 "主题"
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].command.id).toBe('action-theme');
    });
  });

  describe('无匹配', () => {
    it('应返回空数组', () => {
      const results = searchCommands(commands, 'xyz不存在的命令');
      expect(results).toHaveLength(0);
    });
  });

  describe('特殊字符', () => {
    it('含括号的关键词应能匹配', () => {
      const results = searchCommands(commands, '浅色');
      expect(results).toHaveLength(1);
      expect(results[0].command.id).toBe('action-theme');
    });

    it('正则特殊字符应被正确转义', () => {
      const results = searchCommands(commands, '()');
      // 括号应被转义，不会导致正则错误，但也不会匹配任何命令
      expect(results).toHaveLength(0);
    });
  });
});

// ─── 命令结构测试 ────────────────────────────────────────────

describe('命令列表结构', () => {
  const commands = createTestCommands();

  it('所有命令 ID 应唯一', () => {
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('所有命令应有必填字段', () => {
    for (const cmd of commands) {
      expect(cmd.id).toBeTruthy();
      expect(cmd.label).toBeTruthy();
      expect(cmd.section).toBeTruthy();
      expect(typeof cmd.action).toBe('function');
    }
  });

  it('应至少包含 4 个分组', () => {
    const sections = new Set(commands.map((c) => c.section));
    expect(sections.size).toBeGreaterThanOrEqual(4);
  });
});

// ─── 搜索结果结构测试 ────────────────────────────────────────

describe('搜索结果结构', () => {
  const commands = createTestCommands();

  it('每个结果应包含 command 和 score', () => {
    const results = searchCommands(commands, '记忆');
    for (const r of results) {
      expect(r.command).toBeDefined();
      expect(typeof r.score).toBe('number');
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('score 应为非负整数', () => {
    const results = searchCommands(commands, '设置');
    for (const r of results) {
      expect(Number.isInteger(r.score)).toBe(true);
    }
  });
});