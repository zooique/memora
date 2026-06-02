/**
 * CLI 格式化工具单元测试（M-205）
 *
 * 覆盖：
 *   - formatToolResult：box-drawing + 颜色
 *   - formatToolStart / formatToolEnd：开始/结束标记
 *   - formatWelcome：欢迎横幅 7 个字段
 *   - formatHelp：6 个命令
 *   - formatToolsList / formatMemoriesList / formatTopicsList：列表
 *   - formatSuccess / formatError / formatWarning：消息
 */
import { describe, it, expect } from 'vitest';
import {
  formatToolResult,
  formatToolStart,
  formatToolEnd,
  formatWelcome,
  formatHelp,
  formatToolsList,
  formatMemoriesList,
  formatTopicsList,
  formatSuccess,
  formatError,
  formatWarning,
} from '../format.js';

describe('M-205 · CLI 格式化工具', () => {
  describe('formatToolResult', () => {
    it('应包含工具名称 + box-drawing 边框', () => {
      const result = formatToolResult('read_file', 'export const x = 1;\n');
      expect(result).toContain('read_file');
      expect(result).toContain('┌');
      expect(result).toContain('┐');
      expect(result).toContain('└');
      expect(result).toContain('┘');
      expect(result).toContain('│');
    });

    it('应包含 ANSI 颜色码（cyan 边框）', () => {
      const result = formatToolResult('read_file', 'content');
      // picocolors 的 cyan 输出 \x1b[36m（开启） + 内容 + \x1b[39m（关闭）
      expect(result).toContain('\x1b[36m');
      expect(result).toContain('\x1b[39m');
    });

    it('多行结果应每行都展示', () => {
      const result = formatToolResult('list_dir', 'a.txt\nb.txt\nc.txt');
      expect(result).toContain('a.txt');
      expect(result).toContain('b.txt');
      expect(result).toContain('c.txt');
    });
  });

  describe('formatToolStart', () => {
    it('应包含工具名称和"正在调用"标记', () => {
      const result = formatToolStart('write_file');
      expect(result).toContain('write_file');
      expect(result).toContain('正在调用');
    });

    it('应使用 cyan 颜色（强调）', () => {
      const result = formatToolStart('search_memories');
      expect(result).toContain('\x1b[36m');
    });
  });

  describe('formatToolEnd', () => {
    it('成功时应使用 ✅ 和绿色', () => {
      const result = formatToolEnd('read_file', true);
      expect(result).toContain('✅');
      expect(result).toContain('read_file');
      expect(result).toContain('\x1b[32m'); // green
    });

    it('失败时应使用 ❌ 和红色', () => {
      const result = formatToolEnd('write_file', false);
      expect(result).toContain('❌');
      expect(result).toContain('write_file');
      expect(result).toContain('\x1b[31m'); // red
    });
  });

  describe('formatWelcome', () => {
    it('应包含版本/项目路径/模型/数据库/记忆统计/当前话题', () => {
      const result = formatWelcome({
        version: '0.1.0',
        projectPath: '/test/project',
        modelName: 'mimo',
        dbPath: '/tmp/memora.db',
        loadedCount: 7,
        bootstrapCount: 3,
        skippedCount: 0,
        currentTopic: 'default',
      });
      expect(result).toContain('Memora Agent');
      expect(result).toContain('0.1.0');
      expect(result).toContain('/test/project');
      expect(result).toContain('mimo');
      expect(result).toContain('/tmp/memora.db');
      expect(result).toContain('7 条');
      expect(result).toContain('default');
    });

    it('有跳过时应在 welcome 中显示警告', () => {
      const result = formatWelcome({
        version: '0.1.0',
        projectPath: '/p',
        modelName: 'm',
        dbPath: '/d',
        loadedCount: 5,
        bootstrapCount: 3,
        skippedCount: 2,
        currentTopic: 't',
      });
      expect(result).toContain('跳过');
      expect(result).toContain('2');
      expect(result).toContain('\x1b[33m'); // yellow
    });

    it('无跳过时不应显示警告', () => {
      const result = formatWelcome({
        version: '0.1.0',
        projectPath: '/p',
        modelName: 'm',
        dbPath: '/d',
        loadedCount: 7,
        bootstrapCount: 3,
        skippedCount: 0,
        currentTopic: 't',
      });
      expect(result).not.toContain('跳过');
    });
  });

  describe('formatHelp', () => {
    it('应包含 6 个命令（/exit /help /tools /memories /topic /topics）', () => {
      const result = formatHelp();
      expect(result).toContain('/exit');
      expect(result).toContain('/help');
      expect(result).toContain('/tools');
      expect(result).toContain('/memories');
      expect(result).toContain('/topic');
      expect(result).toContain('/topics');
    });

    it('应使用蓝色标题', () => {
      const result = formatHelp();
      expect(result).toContain('\x1b[34m'); // blue
    });
  });

  describe('formatToolsList', () => {
    it('应包含工具名称和描述', () => {
      const result = formatToolsList([
        { name: 'read_file', description: '读取文件' },
        { name: 'write_file', description: '写入文件' },
      ]);
      expect(result).toContain('read_file');
      expect(result).toContain('write_file');
      expect(result).toContain('读取文件');
      expect(result).toContain('写入文件');
      expect(result).toContain('共 2 个');
    });

    it('空列表时显示 "0 个"', () => {
      const result = formatToolsList([]);
      expect(result).toContain('共 0 个');
    });
  });

  describe('formatMemoriesList', () => {
    it('应包含 permanence/type/name', () => {
      const result = formatMemoriesList([
        { permanence: 'always', type: 'personality', name: 'core-personality' },
        { permanence: 'domain', type: 'rule', name: 'core-rule' },
      ]);
      expect(result).toContain('always');
      expect(result).toContain('personality');
      expect(result).toContain('core-personality');
      expect(result).toContain('domain');
      expect(result).toContain('core-rule');
    });

    it('空列表时显示 "已加载 0 条必召记忆："（与 e2e 期望一致）', () => {
      const result = formatMemoriesList([]);
      expect(result).toContain('已加载 0 条必召记忆');
    });
  });

  describe('formatTopicsList', () => {
    it('应包含话题文件名', () => {
      const result = formatTopicsList(['default.md', 'dev.md']);
      expect(result).toContain('default.md');
      expect(result).toContain('dev.md');
      expect(result).toContain('共 2 个');
    });

    it('空列表时显示"暂无话题"', () => {
      const result = formatTopicsList([]);
      expect(result).toContain('暂无话题');
    });
  });

  describe('formatSuccess / formatError / formatWarning', () => {
    it('formatSuccess 应包含 ✅ 和绿色', () => {
      const result = formatSuccess('已切换话题');
      expect(result).toContain('✅');
      expect(result).toContain('已切换话题');
      expect(result).toContain('\x1b[32m');
    });

    it('formatError 应包含 ❌ + title + 红色', () => {
      const result = formatError('工具调用失败', 'write_file 不存在');
      expect(result).toContain('❌');
      expect(result).toContain('工具调用失败');
      expect(result).toContain('write_file 不存在');
      expect(result).toContain('\x1b[31m');
    });

    it('formatError 不带 detail 时应只显示 title', () => {
      const result = formatError('错误');
      expect(result).toContain('❌');
      expect(result).toContain('错误');
    });

    it('formatWarning 应包含 ⚠️ 和黄色', () => {
      const result = formatWarning('部分文件加载失败');
      expect(result).toContain('⚠️');
      expect(result).toContain('部分文件加载失败');
      expect(result).toContain('\x1b[33m');
    });
  });
});
