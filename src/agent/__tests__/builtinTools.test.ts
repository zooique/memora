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
import {
  BUILTIN_TOOLS,
  BUILTIN_TOOL_IDEMPOTENCY,
  shouldSkipForIdempotency,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  RUN_CODE_TOOL,
  type ToolDefinition,
} from '@/agent/builtinTools.js';
import type { IdempotencyLevel, ToolExecutionRecord } from '@/agent/types.js';

describe('builtinTools · BUILTIN_TOOLS', () => {
  // ─── 数量与名称 ────────────────────────────────────────────

  it('应包含 12 个内置工具', () => {
    expect(BUILTIN_TOOLS).toHaveLength(12);
  });

  it('应包含 read_file / write_file / list_dir / search_memories / trace_summary', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_dir');
    expect(names).toContain('search_memories');
    expect(names).toContain('trace_summary');
  });

  it('应包含 L2/L3 渐进披露工具（read_skill / read_resource / run_skill_script / list_resources / list_skills）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('read_skill');
    expect(names).toContain('read_resource');
    expect(names).toContain('run_skill_script');
    expect(names).toContain('list_resources');
    expect(names).toContain('list_skills');
  });

  it('read_skill 应注册为内置工具且标记幂等（渐进披露 L2）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('read_skill');
    expect(BUILTIN_TOOL_IDEMPOTENCY.read_skill).toBe('idempotent');
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

describe('builtinTools · WEB_FETCH_TOOL（搜索→抓取闭环第二段）', () => {
  it('应定义 web_fetch 工具', () => {
    expect(WEB_FETCH_TOOL).toBeDefined();
    expect(WEB_FETCH_TOOL.name).toBe('web_fetch');
  });

  it('应标记为只读工具（readonly=true，抓取读正文）', () => {
    expect(WEB_FETCH_TOOL.readonly).toBe(true);
  });

  it('应有非空 description 且提及搜索→抓取闭环', () => {
    expect(WEB_FETCH_TOOL.description).toBeTruthy();
    expect(WEB_FETCH_TOOL.description.length).toBeGreaterThan(10);
    expect(WEB_FETCH_TOOL.description).toContain('web_search');
  });

  it('parameters.type 应为 "object"', () => {
    expect(WEB_FETCH_TOOL.parameters.type).toBe('object');
  });

  it('应定义 url 和 limit 参数', () => {
    expect(WEB_FETCH_TOOL.parameters.properties.url).toBeDefined();
    expect(WEB_FETCH_TOOL.parameters.properties.url!.type).toBe('string');
    expect(WEB_FETCH_TOOL.parameters.properties.limit).toBeDefined();
    expect(WEB_FETCH_TOOL.parameters.properties.limit!.type).toBe('string');
  });

  it('url 应为必填参数，limit 可选', () => {
    expect(WEB_FETCH_TOOL.parameters.required).toContain('url');
    expect(WEB_FETCH_TOOL.parameters.required).not.toContain('limit');
  });

  it('应符合 ToolDefinition 类型约束', () => {
    const isValid: ToolDefinition = {
      name: WEB_FETCH_TOOL.name,
      description: WEB_FETCH_TOOL.description,
      readonly: WEB_FETCH_TOOL.readonly,
      parameters: {
        type: WEB_FETCH_TOOL.parameters.type,
        properties: WEB_FETCH_TOOL.parameters.properties,
        required: WEB_FETCH_TOOL.parameters.required,
      },
    };
    expect(isValid.name).toBe(WEB_FETCH_TOOL.name);
  });
});

describe('builtinTools · RUN_CODE_TOOL（通用计算/验证底座）', () => {
  it('应定义 run_code 工具', () => {
    expect(RUN_CODE_TOOL).toBeDefined();
    expect(RUN_CODE_TOOL.name).toBe('run_code');
  });

  it('应有非空 description 且说明源码不进上下文', () => {
    expect(RUN_CODE_TOOL.description).toBeTruthy();
    expect(RUN_CODE_TOOL.description.length).toBeGreaterThan(10);
    expect(RUN_CODE_TOOL.description).toContain('源码不进入上下文');
  });

  it('parameters.type 应为 "object"', () => {
    expect(RUN_CODE_TOOL.parameters.type).toBe('object');
  });

  it('应定义 language 和 code 参数', () => {
    expect(RUN_CODE_TOOL.parameters.properties.language).toBeDefined();
    expect(RUN_CODE_TOOL.parameters.properties.language!.type).toBe('string');
    expect(RUN_CODE_TOOL.parameters.properties.code).toBeDefined();
    expect(RUN_CODE_TOOL.parameters.properties.code!.type).toBe('string');
  });

  it('language 和 code 均应为必填参数', () => {
    expect(RUN_CODE_TOOL.parameters.required).toContain('language');
    expect(RUN_CODE_TOOL.parameters.required).toContain('code');
  });

  it('应符合 ToolDefinition 类型约束', () => {
    const isValid: ToolDefinition = {
      name: RUN_CODE_TOOL.name,
      description: RUN_CODE_TOOL.description,
      parameters: {
        type: RUN_CODE_TOOL.parameters.type,
        properties: RUN_CODE_TOOL.parameters.properties,
        required: RUN_CODE_TOOL.parameters.required,
      },
    };
    expect(isValid.name).toBe(RUN_CODE_TOOL.name);
  });
});

describe('builtinTools · BUILTIN_TOOL_IDEMPOTENCY', () => {
  it('task_table_write 应如实标记为 non-idempotent（追加语义，重复执行不幂等）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.task_table_write).toBe('non-idempotent');
  });

  it('task_table_update 应保持 idempotent（全量替换，真幂等）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.task_table_update).toBe('idempotent');
  });

  it('web_fetch 应标记为 idempotent（读操作，天然幂等）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.web_fetch).toBe('idempotent');
  });

  it('run_code 应标记为 non-idempotent（任意代码执行有副作用）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.run_code).toBe('non-idempotent');
  });
});

describe('builtinTools · shouldSkipForIdempotency（仅一次语义）', () => {
  const rec = (
    name: string,
    args: string,
    ok: boolean,
    idempotent: IdempotencyLevel,
    resultSummary = 'ok',
  ): ToolExecutionRecord => ({
    name,
    argsSignature: args,
    executedAt: 0,
    resultSummary,
    ok,
    idempotent,
  });

  it('non-idempotent 工具永不跳过（失败可原样重试）', () => {
    const records = [rec('task_table_write', '{"x":1}', false, 'non-idempotent')];
    expect(shouldSkipForIdempotency(records, 'task_table_write', '{"x":1}', 'non-idempotent')).toEqual({
      skip: false,
    });
  });

  it('幂等工具无历史记录时不跳过', () => {
    expect(shouldSkipForIdempotency([], 'read_file', '{"path":"a.ts"}', 'idempotent')).toEqual({ skip: false });
    expect(shouldSkipForIdempotency(undefined, 'read_file', '{"path":"a.ts"}', 'idempotent')).toEqual({
      skip: false,
    });
  });

  it('幂等工具上次执行成功（ok=true）时跳过并返回上次结果', () => {
    const records = [rec('read_file', '{"path":"a.ts"}', true, 'idempotent', '文件内容')];
    const result = shouldSkipForIdempotency(records, 'read_file', '{"path":"a.ts"}', 'idempotent');
    expect(result.skip).toBe(true);
    expect(result.previousResult).toContain('文件内容');
  });

  it('幂等工具上次执行失败（ok=false）时不跳过——失败可重试', () => {
    const records = [rec('write_file', '{"path":"a.ts"}', false, 'idempotent-key')];
    expect(shouldSkipForIdempotency(records, 'write_file', '{"path":"a.ts"}', 'idempotent-key')).toEqual({
      skip: false,
    });
  });

  it('幂等工具成功但无 resultSummary 时跳过且 previousResult 为空', () => {
    const records = [rec('read_file', '{"path":"a.ts"}', true, 'idempotent', '')];
    const result = shouldSkipForIdempotency(records, 'read_file', '{"path":"a.ts"}', 'idempotent');
    expect(result.skip).toBe(true);
    expect(result.previousResult).toBeUndefined();
  });
});
