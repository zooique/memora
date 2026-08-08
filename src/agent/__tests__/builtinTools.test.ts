/**
 * builtinTools.ts 单元测试
 *
 * 覆盖 BUILTIN_TOOLS 数组的结构完整性：
 *   - 工具数量与名称
 *   - 每个工具的 schema 结构（type/properties/required）
 *   - 必填参数正确性
 *   - 工具名唯一性
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_TOOLS, WEB_SEARCH_TOOL, type ToolDefinition } from '@/agent/builtinTools.js';

describe('builtinTools · BUILTIN_TOOLS', () => {
  // ─── 数量与名称 ────────────────────────────────────────────

  it('应包含 6 个内置工具', () => {
    expect(BUILTIN_TOOLS).toHaveLength(6);
  });

  it('应包含 read_file / write_file / list_dir / search_memories', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_dir');
    expect(names).toContain('search_memories');
  });

  it('工具名应唯一（无重复）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  // ─── schema 结构完整性 ────────────────────────────────────

  it('每个工具都应有非空 description', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('每个工具的 parameters.type 都应是 "object"', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.parameters.type).toBe('object');
    }
  });

  it('每个工具都应有 properties 字段（Record 类型）', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.parameters.properties).toBeDefined();
      expect(typeof tool.parameters.properties).toBe('object');
    }
  });

  it('每个工具都应有 required 数组（可为空）', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(Array.isArray(tool.parameters.required)).toBe(true);
    }
  });

  // ─── read_file 具体契约 ───────────────────────────────────

  it('read_file 应要求 path 参数', () => {
    const readFile = BUILTIN_TOOLS.find((t) => t.name === 'read_file');
    expect(readFile).toBeDefined();
    expect(readFile!.parameters.required).toContain('path');
    expect(readFile!.parameters.properties.path).toBeDefined();
    expect(readFile!.parameters.properties.path!.type).toBe('string');
  });

  // ─── write_file 具体契约 ──────────────────────────────────

  it('write_file 应要求 path 和 content 参数', () => {
    const writeFile = BUILTIN_TOOLS.find((t) => t.name === 'write_file');
    expect(writeFile).toBeDefined();
    expect(writeFile!.parameters.required).toContain('path');
    expect(writeFile!.parameters.required).toContain('content');
    // 可选参数：mode / insert_line
    expect(writeFile!.parameters.properties.mode).toBeDefined();
    expect(writeFile!.parameters.properties.insert_line).toBeDefined();
  });

  // ─── list_dir 具体契约 ────────────────────────────────────

  it('list_dir 不应有必填参数（path 可选，默认项目根）', () => {
    const listDir = BUILTIN_TOOLS.find((t) => t.name === 'list_dir');
    expect(listDir).toBeDefined();
    expect(listDir!.parameters.required).toEqual([]);
    // 可选参数：path / recursive / maxDepth
    expect(listDir!.parameters.properties.path).toBeDefined();
    expect(listDir!.parameters.properties.recursive).toBeDefined();
    expect(listDir!.parameters.properties.maxDepth).toBeDefined();
  });

  // ─── search_memories 具体契约 ─────────────────────────────

  it('search_memories 应要求 query 参数', () => {
    const searchMemories = BUILTIN_TOOLS.find((t) => t.name === 'search_memories');
    expect(searchMemories).toBeDefined();
    expect(searchMemories!.parameters.required).toContain('query');
    // 可选参数：limit / mode
    expect(searchMemories!.parameters.properties.limit).toBeDefined();
    expect(searchMemories!.parameters.properties.mode).toBeDefined();
  });

  // ─── ToolDefinition 类型守卫 ──────────────────────────────

  it('所有工具应符合 ToolDefinition 类型约束', () => {
    for (const tool of BUILTIN_TOOLS) {
      // 类型守卫：确保结构完整
      const isValid: ToolDefinition = {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: tool.parameters.type,
          properties: tool.parameters.properties,
          required: tool.parameters.required,
        },
      };
      expect(isValid.name).toBe(tool.name);
    }
  });
});

describe('builtinTools · WEB_SEARCH_TOOL', () => {
  it('应定义 web_search 工具', () => {
    expect(WEB_SEARCH_TOOL).toBeDefined();
    expect(WEB_SEARCH_TOOL.name).toBe('web_search');
  });

  it('应有非空 description', () => {
    expect(WEB_SEARCH_TOOL.description).toBeTruthy();
    expect(WEB_SEARCH_TOOL.description.length).toBeGreaterThan(10);
  });

  it('parameters.type 应为 "object"', () => {
    expect(WEB_SEARCH_TOOL.parameters.type).toBe('object');
  });

  it('应定义 query 和 limit 参数', () => {
    expect(WEB_SEARCH_TOOL.parameters.properties.query).toBeDefined();
    expect(WEB_SEARCH_TOOL.parameters.properties.query!.type).toBe('string');
    expect(WEB_SEARCH_TOOL.parameters.properties.limit).toBeDefined();
    expect(WEB_SEARCH_TOOL.parameters.properties.limit!.type).toBe('string');
  });

  it('query 应为必填参数', () => {
    expect(WEB_SEARCH_TOOL.parameters.required).toContain('query');
  });

  it('limit 应为可选参数（不在 required 中）', () => {
    expect(WEB_SEARCH_TOOL.parameters.required).not.toContain('limit');
  });

  it('应符合 ToolDefinition 类型约束', () => {
    const isValid: ToolDefinition = {
      name: WEB_SEARCH_TOOL.name,
      description: WEB_SEARCH_TOOL.description,
      parameters: {
        type: WEB_SEARCH_TOOL.parameters.type,
        properties: WEB_SEARCH_TOOL.parameters.properties,
        required: WEB_SEARCH_TOOL.parameters.required,
      },
    };
    expect(isValid.name).toBe(WEB_SEARCH_TOOL.name);
  });
});
