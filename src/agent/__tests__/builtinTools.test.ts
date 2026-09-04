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
  SEARCH_PROJECT_TOOL,
  type ToolDefinition,
} from '@/agent/builtinTools.js';
import type { IdempotencyLevel, ToolExecutionRecord } from '@/agent/types.js';

describe('builtinTools · BUILTIN_TOOLS', () => {
  // ─── 数量与名称 ────────────────────────────────────────────

  it('应包含 17 个内置工具', () => {
    expect(BUILTIN_TOOLS).toHaveLength(17);
  });

  it('应包含 read_file / write_file / delete_file / list_dir / search_memories / trace_summary / list_sessions', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('delete_file');
    expect(names).toContain('list_dir');
    expect(names).toContain('search_memories');
    expect(names).toContain('trace_summary');
    expect(names).toContain('list_sessions');
  });

  it('应包含第二级压缩工具 compress_context（LLM 主动触发兜底）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('compress_context');
  });

  it('应包含 L2/L3 渐进披露工具（read_skill / read_resource / run_skill_script / list_resources / list_skills）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('read_skill');
    expect(names).toContain('read_resource');
    expect(names).toContain('run_skill_script');
    expect(names).toContain('list_resources');
    expect(names).toContain('list_skills');
  });

  it('应包含作品投影登记工具 register_work（用户主动触发登记索引卡片）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('register_work');
    expect(BUILTIN_TOOL_IDEMPOTENCY.register_work).toBe('idempotent-key');
  });

  it('delete_file 应注册为内置工具且禁止幂等跳过（临时脚本闭环收尾：清理一次性脚本不留痕）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('delete_file');
    // 归类 non-idempotent 是「禁止跳过」而非「重跑有害」：重跑由 deleteFile 内部 ENOENT 兜底，无害。
    // 禁止跳过的原因：删除的目标态可被 write_file 重建，而幂等键只有 name+args、不含文件状态，
    // 标幂等会让同会话内第二次「写 → 执行 → 删」闭环被静默跳过 → 脚本残留且 LLM 收到假的「已删除」。
    expect(BUILTIN_TOOL_IDEMPOTENCY.delete_file).toBe('non-idempotent');
    const def = BUILTIN_TOOLS.find((t) => t.name === 'delete_file')!;
    expect(def.parameters.required).toContain('path');
  });

  it('read_skill 应注册为内置工具且标记 read-only（读操作，永不跳过）', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('read_skill');
    expect(BUILTIN_TOOL_IDEMPOTENCY.read_skill).toBe('read-only');
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

  it('search_memories 描述含多步任务按需召回的引导（档案2 步序列记忆策略 (b)）', () => {
    const searchMemories = BUILTIN_TOOLS.find((t) => t.name === 'search_memories');
    // 引导：多步任务中需要历史决策/既有记忆时主动调用（回答前仅注入一次、运行中不自动补充）
    expect(searchMemories!.description).toContain('多步任务');
    expect(searchMemories!.description).toContain('主动调用本工具按需召回');
    expect(searchMemories!.description).toContain('不自动补充');
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

  it('应定义 script_path 参数且无全量必填（code 与 script_path 两模式二选一）', () => {
    // code 模式（language+code）与 script_path 模式互斥，故无单参数可标全量必填
    expect(RUN_CODE_TOOL.parameters.properties.script_path).toBeDefined();
    expect(RUN_CODE_TOOL.parameters.properties.script_path!.type).toBe('string');
    expect(RUN_CODE_TOOL.parameters.required).toHaveLength(0);
    // description 引导「临时脚本」闭环（写 → 执行 → 删除，不留痕）
    expect(RUN_CODE_TOOL.description).toContain('script_path');
    expect(RUN_CODE_TOOL.description).toContain('delete_file');
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

describe('builtinTools · SEARCH_PROJECT_TOOL（项目内搜索，等价 IDE 全局搜索）', () => {
  it('应定义 search_project 工具', () => {
    expect(SEARCH_PROJECT_TOOL).toBeDefined();
    expect(SEARCH_PROJECT_TOOL.name).toBe('search_project');
  });

  it('应标记为只读工具（readonly=true，只读搜索不修改文件）', () => {
    expect(SEARCH_PROJECT_TOOL.readonly).toBe(true);
  });

  it('应有非空 description 且提及项目/搜索语义', () => {
    expect(SEARCH_PROJECT_TOOL.description).toBeTruthy();
    expect(SEARCH_PROJECT_TOOL.description.length).toBeGreaterThan(10);
    expect(SEARCH_PROJECT_TOOL.description).toContain('搜索');
    expect(SEARCH_PROJECT_TOOL.description).toContain('read_file');
  });

  it('parameters.type 应为 "object"', () => {
    expect(SEARCH_PROJECT_TOOL.parameters.type).toBe('object');
  });

  it('应定义 query/mode/exclude/maxResults 参数', () => {
    const props = SEARCH_PROJECT_TOOL.parameters.properties;
    expect(props.query).toBeDefined();
    expect(props.mode).toBeDefined();
    expect(props.exclude).toBeDefined();
    expect(props.maxResults).toBeDefined();
    expect(props.query!.type).toBe('string');
    expect(props.mode!.type).toBe('string');
  });

  it('所有参数均应可选（不在 required 中，query 省略时列出项目文件清单）', () => {
    expect(SEARCH_PROJECT_TOOL.parameters.required).toHaveLength(0);
  });

  it('search_project 应为 read-only（只读搜索，永不跳过）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.search_project).toBe('read-only');
  });

  it('应符合 ToolDefinition 类型约束', () => {
    const isValid: ToolDefinition = {
      name: SEARCH_PROJECT_TOOL.name,
      description: SEARCH_PROJECT_TOOL.description,
      readonly: SEARCH_PROJECT_TOOL.readonly,
      parameters: {
        type: SEARCH_PROJECT_TOOL.parameters.type,
        properties: SEARCH_PROJECT_TOOL.parameters.properties,
        required: SEARCH_PROJECT_TOOL.parameters.required,
      },
    };
    expect(isValid.name).toBe(SEARCH_PROJECT_TOOL.name);
  });
});

describe('builtinTools · BUILTIN_TOOL_IDEMPOTENCY', () => {
  it('task_table_write 应如实标记为 non-idempotent（追加语义，重复执行不幂等）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.task_table_write).toBe('non-idempotent');
  });

  it('task_table_update 应保持 idempotent（全量替换，真幂等）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.task_table_update).toBe('idempotent');
  });

  it('web_fetch 应标记为 read-only（读操作，永不跳过）', () => {
    expect(BUILTIN_TOOL_IDEMPOTENCY.web_fetch).toBe('read-only');
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

  it('delete_file 上次删除成功后仍不跳过——目标态可被 write_file 重建，跳过会让二次闭环残留脚本', () => {
    // 用真实映射值判定（禁用硬编码 'non-idempotent'）：归类一旦回退为幂等，本例即红
    const level = BUILTIN_TOOL_IDEMPOTENCY.delete_file!;
    const args = '{"path":"tmp_analyze.cjs"}';
    const records = [rec('delete_file', args, true, level, '✅ 已删除')];
    expect(shouldSkipForIdempotency(records, 'delete_file', args, level)).toEqual({ skip: false });
  });

  it('read-only 工具即使上次成功也永不跳过——目标态可被写工具/时间改动，回喂陈旧结果误导 LLM（IDM-1）', () => {
    // 用真实映射值判定（禁用硬编码 'read-only'）：归类一旦回退为幂等/可跳过，本例即红
    const level = BUILTIN_TOOL_IDEMPOTENCY.read_file!;
    const args = '{"path":"a.ts"}';
    const records = [rec('read_file', args, true, level, '旧内容（已过时）')];
    expect(shouldSkipForIdempotency(records, 'read_file', args, level)).toEqual({ skip: false });
  });
});
