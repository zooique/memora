/**
 * 工具执行器单元测试
 *
 * 覆盖：
 *   - read_file：成功 / 路径越界 / 黑名单
 *   - write_file：成功（owner+confirmWrites=false 自动批准）/ 父目录自动创建 / 路径越界 / 黑名单
 *   - list_dir：默认项目根 / 递归 / 深度限制 / 忽略 node_modules / 黑名单
 *   - search_memories：match 模式 / near 模式 / 空查询 / 注入限制
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolExecutor, BUILTIN_TOOLS } from '@/agent/toolExecutor.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { MemoraError, toolError } from '@/utils/errors.js';

describe('工具执行器（6 个工具）', () => {
  let tmpProject: string;
  let tmpData: string;
  let index: IMemoryStorage;
  let security: SecurityGuard;
  let executor: ToolExecutor;

  beforeAll(async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-tool-proj-'));
    tmpData = mkdtempSync(join(tmpdir(), 'memora-tool-data-'));

    // 创建项目结构
    mkdirSync(join(tmpProject, 'src'), { recursive: true });
    mkdirSync(join(tmpProject, 'node_modules'), { recursive: true });
    mkdirSync(join(tmpProject, '.git'), { recursive: true });
    writeFileSync(join(tmpProject, 'src/index.ts'), 'export const x = 1;\n', 'utf-8');
    writeFileSync(join(tmpProject, 'src/utils.ts'), 'export const y = 2;\n', 'utf-8');
    writeFileSync(join(tmpProject, 'README.md'), '# Test Project\n', 'utf-8');
    writeFileSync(join(tmpProject, 'node_modules/should-be-ignored.ts'), 'ignore me\n', 'utf-8');
    writeFileSync(join(tmpProject, '.git/config'), 'ignore me too\n', 'utf-8');

    // SecurityGuard：owner + confirmWrites=false（自动批准）
    security = new SecurityGuard(tmpProject, tmpData, [], false, 'owner');

    // InMemoryStorage（纯内存实现，无需 better-sqlite3）
    index = new InMemoryStorage();

    // 插入一些测试记忆
    await index.upsert({
      id: 'mem-1',
      content: 'Memora 万物皆记忆，记忆统一为类型 + 永久性',
      source: 'rule',
      name: 'core-rule',
      createdAt: '2026-06-01T00:00:00Z',
      accessedAt: '2026-06-01T00:00:00Z',
      score: 0.9,
    });
    await index.upsert({
      id: 'mem-2',
      content: 'TypeScript strict 模式下禁止 any 隐式转换',
      source: 'skill',
      name: 'typescript-skill',
      createdAt: '2026-06-01T00:00:00Z',
      accessedAt: '2026-06-01T00:00:00Z',
      score: 0.7,
    });

    executor = new ToolExecutor(tmpProject, security, index);
  });

  afterAll(async () => {
    await index.close?.();
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  describe('BUILTIN_TOOLS 注册表', () => {
    it('应注册 12 个工具', () => {
      const names = BUILTIN_TOOLS.map((t) => t.name);
      expect(names.length).toBe(12);
    });

    it('每个工具应有 name + description + parameters（含 required 数组）', () => {
      for (const tool of BUILTIN_TOOLS) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters.type).toBe('object');
        expect(Array.isArray(tool.parameters.required)).toBe(true);
      }
    });
  });

  describe('read_skill（渐进披露 L2）', () => {
    it('未注入 readSkill 回调时返回不可用提示', async () => {
      const result = await executor.execute('read_skill', JSON.stringify({ name: 'write' }));
      expect(result).toContain('read_skill 不可用');
    });

    it('注入 readSkill 回调后返回技能正文', async () => {
      executor.readSkill = async (name) => (name === 'write' ? '## 写作技能\n1. 起草\n2. 润色' : null);
      const result = await executor.execute('read_skill', JSON.stringify({ name: 'write' }));
      expect(result).toContain('起草');
      expect(result).toContain('润色');
    });

    it('技能不存在时返回 SKILL_NOT_FOUND', async () => {
      executor.readSkill = async () => null;
      const result = await executor.execute('read_skill', JSON.stringify({ name: 'nope' }));
      expect(result).toContain('SKILL_NOT_FOUND');
    });

    it('缺少 name 参数时应抛 MemoraError（必填参数校验）', async () => {
      await expect(executor.execute('read_skill', JSON.stringify({}))).rejects.toThrow(
        '工具参数缺失',
      );
    });
  });

  describe('web_search（未注入提供者）', () => {
    it('list 不应包含 web_search 工具', () => {
      const names = executor.list.map((t) => t.name);
      expect(names).not.toContain('web_search');
    });

    it('执行 web_search 应返回不可用提示', async () => {
      const result = await executor.execute('web_search', JSON.stringify({ query: 'test' }));
      expect(result).toContain('网络搜索功能未配置');
    });
  });

  describe('read_file', () => {
    it('应能读取项目内文件', async () => {
      const result = await executor.execute('read_file', JSON.stringify({ path: 'src/index.ts' }));
      expect(result).toBe('export const x = 1;\n');
    });

    it('相对项目根的路径不在白名单时应抛 MemoraError（tool 类）', async () => {
      try {
        await executor.execute('read_file', JSON.stringify({ path: '../outside.txt' }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).category).toBe('tool');
      }
    });

    it('黑名单路径（.ssh）应抛 MemoraError', async () => {
      try {
        await executor.execute('read_file', JSON.stringify({ path: '.ssh/id_rsa' }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).detail).toMatch(/黑名单/);
      }
    });

    it('缺少 path 参数应抛 MemoraError', async () => {
      try {
        await executor.execute('read_file', JSON.stringify({}));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        // validateAndCoerceArgs 的 title 是 '工具参数缺失'，detail 包含具体参数名
        expect((err as MemoraError).detail).toContain('path');
      }
    });
  });

  describe('write_file', () => {
    const testFile = 'src/new-file.ts';

    it('应能写入新文件（owner + confirmWrites=false 自动批准）', async () => {
      const content = 'export const newFile = true;\n';
      const result = await executor.execute(
        'write_file',
        JSON.stringify({ path: testFile, content }),
      );
      expect(result).toContain('已写入');
      expect(result).toContain(`${content.length} 字符`);
      expect(readFileSync(join(tmpProject, testFile), 'utf-8')).toBe(content);
    });

    it('应自动创建不存在的父目录', async () => {
      const deepPath = 'src/deep/nested/file.ts';
      const content = 'export const deep = true;\n';
      await executor.execute('write_file', JSON.stringify({ path: deepPath, content }));
      expect(readFileSync(join(tmpProject, deepPath), 'utf-8')).toBe(content);
    });

    it('应能覆盖已有文件', async () => {
      const content = 'export const overwritten = true;\n';
      await executor.execute('write_file', JSON.stringify({ path: testFile, content }));
      expect(readFileSync(join(tmpProject, testFile), 'utf-8')).toBe(content);
    });

    it('黑名单路径应抛 MemoraError', async () => {
      try {
        await executor.execute(
          'write_file',
          JSON.stringify({ path: '.env', content: 'SECRET=leaked' }),
        );
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).detail).toMatch(/黑名单/);
      }
    });

    it('路径越界应抛 MemoraError', async () => {
      try {
        await executor.execute(
          'write_file',
          JSON.stringify({ path: '../escape.txt', content: 'x' }),
        );
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).message).toMatch(/不在白名单/);
      }
    });

    it('缺少 content 参数应抛 MemoraError', async () => {
      try {
        await executor.execute('write_file', JSON.stringify({ path: testFile }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        // validateAndCoerceArgs 的 title 是 '工具参数缺失'，detail 包含具体参数名
        expect((err as MemoraError).detail).toContain('content');
      }
    });
  });

  describe('list_dir', () => {
    it('默认应列出项目根的非忽略条目', async () => {
      const result = await executor.execute('list_dir', JSON.stringify({}));
      expect(result).toContain('src/');
      expect(result).toContain('README.md');
      // 应忽略 node_modules / .git
      expect(result).not.toContain('node_modules');
      expect(result).not.toContain('.git');
    });

    it('递归模式应展开子目录', async () => {
      const result = await executor.execute(
        'list_dir',
        JSON.stringify({ recursive: 'true', maxDepth: '2' }),
      );
      expect(result).toContain('src/');
      expect(result).toContain('index.ts');
    });

    it('maxDepth=1 应不递归子目录文件', async () => {
      const result = await executor.execute(
        'list_dir',
        JSON.stringify({ recursive: 'true', maxDepth: '1' }),
      );
      expect(result).toContain('src/');
      expect(result).not.toContain('index.ts');
    });

    it('maxDepth=10 应被限制为 3', async () => {
      // maxDepth 强校验：> 3 时降为 3
      const result = await executor.execute(
        'list_dir',
        JSON.stringify({ recursive: 'true', maxDepth: '10' }),
      );
      // 项目结构只有 2 层，maxDepth=3 也能完整列出
      expect(result).toContain('src/');
    });

    it('路径不存在应抛 MemoraError', async () => {
      try {
        await executor.execute('list_dir', JSON.stringify({ path: 'non-existent' }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).title).toContain('不存在');
      }
    });

    it('文件路径（不是目录）应抛 MemoraError', async () => {
      try {
        await executor.execute('list_dir', JSON.stringify({ path: 'README.md' }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).title).toContain('不是目录');
      }
    });

    it('黑名单路径应抛 MemoraError', async () => {
      try {
        await executor.execute('list_dir', JSON.stringify({ path: '.ssh' }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).detail).toMatch(/黑名单/);
      }
    });
  });

  describe('search_memories', () => {
    it('match 模式：单 token 应能匹配', async () => {
      const result = await executor.execute('search_memories', JSON.stringify({ query: 'Memora' }));
      expect(result).toContain('core-rule');
      expect(result).toContain('找到');
    });

    it('match 模式：多 token 用 OR（任一命中即可）', async () => {
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'Memora TypeScript' }),
      );
      expect(result).toContain('找到');
      // match 模式两个 token 至少有一个命中
      expect(result.length).toBeGreaterThan(20);
    });

    it('near 模式：所有 token 必须同时出现', async () => {
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'Memora 万物', mode: 'near' }),
      );
      expect(result).toContain('找到');
    });

    it('near 模式：部分 token 不命中时该结果应被过滤', async () => {
      // mem-1 包含 "Memora" 但不包含 "TypeScript"；near 模式要求全部命中
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'Memora TypeScript', mode: 'near' }),
      );
      // 两条记忆都不同时包含两个关键词，应返回未找到
      expect(result).toContain('未找到');
      expect(result).toContain('near 模式');
    });

    it('near 模式：单 token 等同于 match 模式', async () => {
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'Memora', mode: 'near' }),
      );
      expect(result).toContain('找到');
    });

    it('match 模式：结果应包含模式标注', async () => {
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'Memora', mode: 'match' }),
      );
      expect(result).toContain('match 模式');
    });

    it('空查询应返回兜底（按 weight 排序）', async () => {
      // Intl.Segmenter 切出空 tokens → 走 getByWeight
      const result = await executor.execute('search_memories', JSON.stringify({ query: '，。' }));
      expect(result).toContain('core-rule');
    });

    it('limit 限制返回数量', async () => {
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'memora', limit: '1' }),
      );
      expect(result).toContain('找到 1 条');
    });

    it('limit 超过 50 应被限制为 50', async () => {
      // 仅 2 条记忆，验证参数限制逻辑（不会实际返回 50 条）
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'memora', limit: '1000' }),
      );
      expect(result).toContain('找到');
    });

    it('缺少 query 参数应抛 MemoraError', async () => {
      try {
        await executor.execute('search_memories', JSON.stringify({}));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        // validateAndCoerceArgs 的 title 是 '工具参数缺失'，detail 包含具体参数名
        expect((err as MemoraError).detail).toContain('query');
      }
    });
  });

  describe('错误处理', () => {
    it('未知工具应抛 MemoraError', async () => {
      try {
        await executor.execute('nonexistent_tool', '{}');
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).title).toContain('未知工具');
      }
    });

    it('args JSON 无效应抛 MemoraError', async () => {
      try {
        await executor.execute('read_file', '{ not json');
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).title).toContain('解析失败');
      }
    });
  });

  describe('自定义工具注册', () => {
    /** 测试用自定义工具定义 */
    const customDef = {
      name: 'echo_tool',
      description: '回显输入参数',
      parameters: {
        type: 'object' as const,
        properties: {
          message: { type: 'string', description: '要回显的消息' },
        },
        required: ['message'],
      },
    };

    it('registerTool 应成功注册自定义工具', () => {
      executor.registerTool(customDef, async (args) => `Echo: ${args['message']}`);
      // 不抛错即成功
    });

    it('list 应包含内置 + 自定义工具', () => {
      const defs = executor.list;
      const names = defs.map((t) => t.name);
      // 内置 4 个 + 自定义 1 个
      expect(names).toContain('read_file');
      expect(names).toContain('echo_tool');
      expect(defs.length).toBe(BUILTIN_TOOLS.length + 1);
    });

    it('execute 应路由到自定义工具 handler', async () => {
      const result = await executor.execute('echo_tool', JSON.stringify({ message: 'hello' }));
      expect(result).toBe('Echo: hello');
    });

    it('注册同名内置工具应抛错', () => {
      const builtinClone = {
        name: 'read_file',
        description: '试图覆盖内置工具',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      expect(() => executor.registerTool(builtinClone, async () => '')).toThrow(/不能覆盖内置工具/);
    });

    it('重复注册同名自定义工具应抛错', () => {
      expect(() => executor.registerTool(customDef, async () => '')).toThrow(/工具已注册/);
    });

    it('registerTool 应触发 onToolsChanged 回调', () => {
      let callCount = 0;
      executor.setOnToolsChanged(() => { callCount++; });
      const newDef = {
        name: 'callback_test_tool',
        description: '测试回调触发',
        parameters: {
          type: 'object' as const,
          properties: { msg: { type: 'string', description: '消息' } },
          required: ['msg'],
        },
      };
      executor.registerTool(newDef, async () => 'ok');
      expect(callCount).toBe(1);
    });

    it('setOnToolsChanged(undefined) 后 registerTool 不触发回调', () => {
      let callCount = 0;
      executor.setOnToolsChanged(() => { callCount++; });
      executor.setOnToolsChanged(undefined);
      const newDef = {
        name: 'no_callback_tool',
        description: '测试清除回调',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      executor.registerTool(newDef, async () => 'ok');
      expect(callCount).toBe(0);
    });

    it('未知工具错误信息应包含自定义工具名', async () => {
      try {
        await executor.execute('truly_unknown', '{}');
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        // suggestions 数组应列出所有已注册工具（含自定义）
        const suggestions = (err as MemoraError).suggestions ?? [];
        const allSuggestions = suggestions.join(' ');
        expect(allSuggestions).toContain('echo_tool');
      }
    });

    it('自定义 handler 抛异常应包装为 MemoraError', async () => {
      // 注册一个会抛错的工具
      const failDef = {
        name: 'fail_tool',
        description: '测试异常包装',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      executor.registerTool(failDef, async () => {
        throw new Error('handler 内部错误');
      });
      try {
        await executor.execute('fail_tool', '{}');
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).title).toContain('自定义工具执行失败');
        expect((err as MemoraError).detail).toContain('fail_tool');
      }
    });

    it('自定义 handler 抛 MemoraError 应原样透传', async () => {
      // 注册一个抛 MemoraError 的工具
      const memErrDef = {
        name: 'memerr_tool',
        description: '测试 MemoraError 透传',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      executor.registerTool(memErrDef, async () => {
        throw toolError('业务错误', 'handler 抛出的 MemoraError', []);
      });
      try {
        await executor.execute('memerr_tool', '{}');
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        // 应保留原始 title，不被包装为"自定义工具执行失败"
        expect((err as MemoraError).title).toBe('业务错误');
      }
    });

    it('未注入 webSearchProvider 时，宿主可注册 web_search 工具', () => {
      const webSearchDef = {
        name: 'web_search',
        description: '宿主自定义 web_search（打开浏览器模式）',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      expect(() => executor.registerTool(webSearchDef, async () => '')).not.toThrow();
      // 清理：移除已注册的工具，避免影响后续测试
      executor.removeTool('web_search');
    });

    it('注入 webSearchProvider 后，注册 web_search 应抛错', () => {
      const mockProvider = { search: async () => [] };
      const executorWithProvider = new ToolExecutor(tmpProject, security, index, mockProvider);
      const webSearchDef = {
        name: 'web_search',
        description: '试图覆盖内核 web_search',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      expect(() => executorWithProvider.registerTool(webSearchDef, async () => '')).toThrow(/不能覆盖内置工具/);
    });
  });
});
