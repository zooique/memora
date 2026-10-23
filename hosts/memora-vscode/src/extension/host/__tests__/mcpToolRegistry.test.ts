/**
 * MCP 工具注册器测试 — 命名派生 / schema 映射 / 注册注销
 *
 * 判据来源：方案-MCP工具接入 §3.3（映射形态）、§8 豁口 2（命名与撞名）、§9 切片 1。
 * 纯函数为主，不拉起子进程（真实连接见 mcpConnectionManager.test.ts）。
 */
import { describe, it, expect } from 'vitest';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolHandler } from '@zooique/memora';
import {
  buildToolBindings,
  deriveToolName,
  registerServerTools,
  sanitizeSegment,
  toToolDefinition,
  unregisterServerTools,
  type ToolRegistrar,
} from '../mcp/toolRegistry.js';

/**
 * 造一个最小 MCP 工具声明（只填本测试关心的字段）
 *
 * ⚠️ `inputSchema` 在 SDK 类型上是强约束的 object schema，而本测试要**故意喂非法形态**
 * （顶层 anyOf / 非 object）来验证宿主剔除逻辑 —— 故这里是全测试唯一的越契约断言。
 * 生产映射代码（toolRegistry.toToolDefinition）零 `as`、零 `@ts-ignore`。
 *
 * @param name 原始工具名
 * @param inputSchema inputSchema（缺省 = 无参数工具）
 */
function makeTool(
  name: string,
  inputSchema: Record<string, unknown> = { type: 'object', properties: {} },
): McpTool {
  return {
    name,
    description: `${name} 的说明`,
    inputSchema: inputSchema as unknown as McpTool['inputSchema'],
  };
}

/**
 * 内存版注册面（记录定义与 handler，供断言注册/注销效果）
 *
 * @returns 注册面实例 + 内部记录表
 */
function createRegistrar(): {
  registrar: ToolRegistrar;
  definitions: Map<string, ToolDefinition>;
  handlers: Map<string, ToolHandler>;
} {
  const definitions = new Map<string, ToolDefinition>();
  const handlers = new Map<string, ToolHandler>();
  return {
    registrar: {
      registerTool(definition, handler) {
        if (definitions.has(definition.name)) throw new Error(`工具已注册：${definition.name}`);
        definitions.set(definition.name, definition);
        handlers.set(definition.name, handler);
      },
      removeTool(name) {
        definitions.delete(name);
        handlers.delete(name);
      },
    },
    definitions,
    handlers,
  };
}

describe('命名派生（mcp__<server>__<tool>）', () => {
  it('清洗非法字符并保证首字符合法', () => {
    expect(sanitizeSegment('my-server')).toBe('my_server');
    expect(sanitizeSegment('a.b/c')).toBe('a_b_c');
    expect(sanitizeSegment('9lives')).toBe('_9lives');
  });

  it('派生名带 mcp__ 前缀，且 server 与 tool 各自清洗', () => {
    expect(deriveToolName('my-server', 'read-file', new Set())).toBe('mcp__my_server__read_file');
  });

  it('撞名加序号后缀（同 server 内清洗后同名）', () => {
    const used = new Set<string>();
    expect(deriveToolName('s', 'a-b', used)).toBe('mcp__s__a_b');
    expect(deriveToolName('s', 'a.b', used)).toBe('mcp__s__a_b_2');
    expect(deriveToolName('s', 'a b', used)).toBe('mcp__s__a_b_3');
  });

  it('超长截断到 64 字符以内且保留哈希后缀（provider 名长限制）', () => {
    const derived = deriveToolName('s', 'x'.repeat(120), new Set());
    expect(derived.length).toBeLessThanOrEqual(64);
    expect(derived).toMatch(/_[0-9a-f]{8}$/);
  });
});

describe('schema 映射（内核窄类型）', () => {
  it('标量参数原样映射，工具描述带 server 名，confirmPolicy 显式 always', () => {
    const result = toToolDefinition(
      'srv',
      makeTool('t', {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词' },
          limit: { type: 'number' },
          deep: { type: 'boolean' },
        },
        required: ['query'],
      }),
    );
    if ('skipped' in result) throw new Error('不应被剔除');
    expect(result.definition.description).toContain('srv');
    expect(result.definition.confirmPolicy).toBe('always');
    expect(result.definition.parameters.required).toEqual(['query']);
    expect(result.definition.parameters.properties['query']).toEqual({
      type: 'string',
      description: '检索词',
    });
    expect(result.definition.parameters.properties['limit']?.type).toBe('number');
  });

  it('required 缺失时兜底为空数组（否则内核校验抛 TypeError）', () => {
    const result = toToolDefinition('srv', makeTool('t'));
    if ('skipped' in result) throw new Error('不应被剔除');
    expect(result.definition.parameters.required).toEqual([]);
  });

  it('required 里不在 properties 的键被丢弃（模型看不到该字段，留着必报参数缺失）', () => {
    const result = toToolDefinition(
      'srv',
      makeTool('t', {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a', 'ghost'],
      }),
    );
    if ('skipped' in result) throw new Error('不应被剔除');
    expect(result.definition.parameters.required).toEqual(['a']);
  });

  it('enum / 数值范围降级为描述文字（约束不丢，只是形态变）', () => {
    const result = toToolDefinition(
      'srv',
      makeTool('t', {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['fast', 'safe'] },
          limit: { type: 'number', minimum: 1, maximum: 50 },
        },
      }),
    );
    if ('skipped' in result) throw new Error('不应被剔除');
    expect(result.definition.parameters.properties['mode']?.description).toContain('fast');
    expect(result.definition.parameters.properties['limit']?.description).toContain('1');
    expect(result.definition.parameters.properties['limit']?.description).toContain('50');
  });

  it('标量元素数组：items 带空 properties（内核 items 形状要求）', () => {
    const result = toToolDefinition(
      'srv',
      makeTool('t', {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
      }),
    );
    if ('skipped' in result) throw new Error('不应被剔除');
    expect(result.definition.parameters.properties['tags']?.items).toEqual({
      type: 'string',
      properties: {},
      required: [],
    });
  });

  it('对象元素数组：item 属性拍平为一层，required 过滤到存在的键', () => {
    const result = toToolDefinition(
      'srv',
      makeTool('t', {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: '相对路径' },
                depth: { type: 'number' },
              },
              required: ['path', 'missing'],
            },
          },
        },
      }),
    );
    if ('skipped' in result) throw new Error('不应被剔除');
    const items = result.definition.parameters.properties['items']?.items;
    expect(items?.type).toBe('object');
    expect(items?.required).toEqual(['path']);
    expect(items?.properties['path']).toEqual({ type: 'string', description: '相对路径' });
  });

  it('顶层 anyOf / oneOf 剔除并给出原因', () => {
    for (const key of ['anyOf', 'oneOf'] as const) {
      const result = toToolDefinition('srv', makeTool('t', { [key]: [{ type: 'object' }] }));
      expect('skipped' in result).toBe(true);
      if ('skipped' in result) expect(result.skipped.reason).toContain(key);
    }
  });

  it('顶层非 object 剔除', () => {
    const result = toToolDefinition('srv', makeTool('t', { type: 'string' }));
    expect('skipped' in result).toBe(true);
  });
});

describe('注册与注销', () => {
  it('buildToolBindings 剔除不可映射工具，其余按序派生唯一名', () => {
    const { bindings, skipped } = buildToolBindings('srv', [
      makeTool('ok-1'),
      makeTool('bad', { anyOf: [{ type: 'object' }] }),
      makeTool('ok-2'),
    ]);
    expect(bindings.map((b) => b.derivedName)).toEqual(['mcp__srv__ok_1', 'mcp__srv__ok_2']);
    expect(bindings.map((b) => b.originalName)).toEqual(['ok-1', 'ok-2']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.toolName).toBe('bad');
  });

  it('registerServerTools 用原始工具名转发调用；unregisterServerTools 逐个注销', async () => {
    const { registrar, definitions, handlers } = createRegistrar();
    const { bindings } = buildToolBindings('srv', [makeTool('echo')]);
    const calls: { name: string; args: Record<string, unknown> }[] = [];

    registerServerTools(registrar, bindings, async (originalName, args) => {
      calls.push({ name: originalName, args });
      return { content: [{ type: 'text', text: 'pong' }] };
    });

    expect([...definitions.keys()]).toEqual(['mcp__srv__echo']);
    const text = await handlers.get('mcp__srv__echo')?.({ message: 'hi' }, { guardPath: () => {} });
    expect(text).toBe('pong');
    // 关键：转发用的是 server 原始名（派生名只用于宿主寻址/展示）
    expect(calls).toEqual([{ name: 'echo', args: { message: 'hi' } }]);

    unregisterServerTools(registrar, bindings);
    expect(definitions.size).toBe(0);
    expect(handlers.size).toBe(0);
  });
});
