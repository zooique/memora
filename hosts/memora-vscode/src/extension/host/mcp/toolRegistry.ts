/**
 * MCP 工具注册器 — 命名派生 + schema 映射 + 注册/注销
 *
 * 三件事（方案 §3 拍板 A / §8 豁口 2）：
 *   1. **命名**：`mcp__<server>__<tool>`（事实标准，S4）；非法字符清洗、超长截断、撞名加后缀，
 *      派生名 → 原始名的对照表是**派生缓存**（每次 tools/list 重建，不落盘、不当配置读）。
 *   2. **schema 映射**：MCP `inputSchema` 逐层映射进内核**窄类型**；映射不进去的结构约束
 *      （enum / 数值范围 / 正则 / 嵌套）**转述进该参数 description**；顶层 `anyOf`/`oneOf`
 *      ⇒ 剔除该工具并告警。全程零 `as`、零 `@ts-ignore`。
 *   3. **注册/注销**：注册时按 allowlist 计算 `confirmPolicy`（切片 2 三档，
 *      见 policy.ts）——方案 §11 风险 2 明写「忘记设置就静默不审批不审计」，
 *      故这里没有缺省路径，每个工具显式落 'always' 或 'audit'。
 *
 * 红线（D3）：审批意图只经 `ToolDefinition.confirmPolicy` 表达；本文件**不**直接调用内核
 * 安全方法自行拼判据（那会造出第二套审批实现）。
 */
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolHandler } from '@zooique/memora';
import { isPlainObject, type JsonSchema } from './json.js';
import { normalizeToolResult } from './resultNormalizer.js';
import { resolveConfirmPolicy, type McpToolAllowlist } from './policy.js';

/**
 * 注册面结构契约
 *
 * 只取内核 `ToolExecutor` 的注册/注销两个方法（该类类型未在 `src/index.ts` 导出，
 * 宿主经 `agent.tools` 拿到实例）。宿主只依赖这两个方法的形状，不依赖其实现。
 */
export interface ToolRegistrar {
  registerTool(definition: ToolDefinition, handler: ToolHandler): void;
  removeTool(name: string): void;
}

/** 工具名前缀（事实标准 `mcp__<server>__<tool>`，权限规则按此寻址） */
export const MCP_TOOL_NAME_PREFIX = 'mcp__';

/**
 * 工具名长度上限
 *
 * 部分 OpenAI 兼容 provider 对 function name 限 64 字符，超长直接拒请求 ⇒ 长名会被截断
 * （截断后附 8 位哈希保唯一）。
 */
const MAX_TOOL_NAME_LENGTH = 64;

/** 注册进内核的一条工具（派生名 ↔ 原始名的绑定，即派生缓存的基本单元） */
export interface McpToolBinding {
  /** 注册进内核的工具名（`mcp__<server>__<tool>`，已清洗） */
  derivedName: string;
  /** server 侧的原始工具名（调用时原样回传，不参与寻址） */
  originalName: string;
  /** 映射后的内核工具定义 */
  definition: ToolDefinition;
}

/** 剔除工具的原因（宿主告警与可观测埋点共用一句话结论） */
export interface SkippedTool {
  /** server 侧原始工具名 */
  toolName: string;
  /** 剔除原因（人话，直接进日志） */
  reason: string;
}

/** 一个参数的紧凑 JSON 文本（用于把无法表达的结构塞进 description，截断防撑爆提示词） */
const MAX_INLINE_SCHEMA_LENGTH = 160;

/**
 * 紧凑序列化 schema（超长截断）
 *
 * @param value 任意 JSON 值
 */
function inlineJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? '';
  } catch {
    text = '';
  }
  return text.length > MAX_INLINE_SCHEMA_LENGTH
    ? `${text.slice(0, MAX_INLINE_SCHEMA_LENGTH)}…`
    : text;
}

/**
 * 把 schema 里「结构性约束」翻译成自然语言（拍板 A 的核心动作）
 *
 * 内核 `parameters` 只能表达 `type / description / items`，余下的约束**不丢**，
 * 而是降为描述文字让模型自己遵守。代价诚实登记：模型可能忽略（方案 §10 首行有观测项）。
 *
 * @param schema 参数 schema
 * @param depth 嵌套深度（≥1 时不再展开子字段，防递归撑爆）
 * @returns 约束描述（无约束返回空串）
 */
function describeConstraints(schema: JsonSchema, depth = 0): string {
  const notes: string[] = [];

  // 枚举：结构约束里最容易让模型踩空的一种，逐值列出
  if (Array.isArray(schema['enum'])) {
    notes.push(`取值必须为 ${schema['enum'].map((v) => JSON.stringify(v)).join(' / ')} 之一`);
  }
  // const：单值约束等价于一个枚举
  if (schema['const'] !== undefined) {
    notes.push(`取值固定为 ${JSON.stringify(schema['const'])}`);
  }
  // 数值范围
  if (typeof schema['minimum'] === 'number' && typeof schema['maximum'] === 'number') {
    notes.push(`取值范围 ${schema['minimum']} ~ ${schema['maximum']}`);
  } else if (typeof schema['minimum'] === 'number') {
    notes.push(`不得小于 ${schema['minimum']}`);
  } else if (typeof schema['maximum'] === 'number') {
    notes.push(`不得大于 ${schema['maximum']}`);
  }
  // 字符串长度
  if (typeof schema['minLength'] === 'number' || typeof schema['maxLength'] === 'number') {
    notes.push(
      `长度 ${typeof schema['minLength'] === 'number' ? schema['minLength'] : 0} ~ ${
        typeof schema['maxLength'] === 'number' ? schema['maxLength'] : '不限'
      }`,
    );
  }
  // 正则 / 格式（原样转述：模型对常见格式词理解良好，正则留给它自己匹配）
  if (typeof schema['pattern'] === 'string') {
    notes.push(`须匹配正则 ${schema['pattern']}`);
  }
  if (typeof schema['format'] === 'string') {
    notes.push(`格式：${schema['format']}`);
  }
  // 缺省值：模型据此决定省略参数是否安全
  if (schema['default'] !== undefined) {
    notes.push(`缺省 ${inlineJson(schema['default'])}`);
  }
  // 混合结构（参数级 oneOf/anyOf/allOf）：内核无法表达，原文塞进描述
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(schema[combinator])) {
      notes.push(`结构约束（${combinator}）：${inlineJson(schema[combinator])}`);
    }
  }
  // 嵌套对象：展开一层子字段（必填标注），再深就交给 JSON 原文
  if (isPlainObject(schema['properties']) && depth < 1) {
    notes.push(`子字段：${describeObjectFields(schema)}`);
  }
  if (schema['additionalProperties'] === false) {
    notes.push('不接受额外字段');
  }

  return notes.join('；');
}

/**
 * 渲染对象子字段清单（一层）
 *
 * 形态如「query (string，必填)：检索词；limit (number)：条数，取值范围 1 ~ 50」
 *
 * @param schema 含 properties 的对象 schema
 */
function describeObjectFields(schema: JsonSchema): string {
  const properties = schema['properties'];
  if (!isPlainObject(properties)) return '';
  const required = Array.isArray(schema['required']) ? schema['required'].map(String) : [];

  return Object.entries(properties)
    .map(([field, raw]) => {
      const child: JsonSchema = isPlainObject(raw) ? raw : {};
      const type = typeof child['type'] === 'string' ? child['type'] : 'any';
      const flag = required.includes(field) ? '必填' : '可选';
      const desc = typeof child['description'] === 'string' ? child['description'] : '';
      const extra = describeConstraints(child, 1);
      const detail = [desc, extra].filter((s) => s.length > 0).join('，');
      return `${field} (${type}，${flag})${detail ? `：${detail}` : ''}`;
    })
    .join('；');
}

/**
 * 单参数映射（内核窄类型 ← MCP schema）
 *
 * 支持：string / number / boolean / array（元素为标量或对象，对象仅展开一层）。
 * 不支持：顶层 object 之外的复合结构（其约束一律进 description，不丢）。
 *
 * @param raw MCP 参数 schema
 */
function mapProperty(raw: unknown): ToolDefinition['parameters']['properties'][string] {
  const schema: JsonSchema = isPlainObject(raw) ? raw : {};
  const type = typeof schema['type'] === 'string' ? schema['type'] : 'string';

  // 描述 = 自带说明 + 转述的约束，两者拼接后模型看到的仍是单行事实
  const description = [
    typeof schema['description'] === 'string' ? schema['description'] : '',
    describeConstraints(schema),
  ]
    .filter((part) => part.length > 0)
    .join('；');

  if (type === 'array') {
    const rawItems: JsonSchema = isPlainObject(schema['items']) ? schema['items'] : {};
    const itemType = typeof rawItems['type'] === 'string' ? rawItems['type'] : 'string';
    const itemProperties = isPlainObject(rawItems['properties']) ? rawItems['properties'] : null;

    // 元素为对象：内核 items 形状只容一层属性（子属性不再有 items），故逐项拍平成 {type, description}
    if (itemType === 'object' && itemProperties) {
      const properties: NonNullable<
        ToolDefinition['parameters']['properties'][string]['items']
      >['properties'] = {};
      for (const [field, childRaw] of Object.entries(itemProperties)) {
        const child: JsonSchema = isPlainObject(childRaw) ? childRaw : {};
        const childType = typeof child['type'] === 'string' ? child['type'] : 'string';
        const childDesc = [
          typeof child['description'] === 'string' ? child['description'] : '',
          describeConstraints(child, 1),
        ]
          .filter((part) => part.length > 0)
          .join('；');
        properties[field] = { type: childType, description: childDesc };
      }
      // required 兜底 + 过滤：不在 properties 里的必填项模型看不到，留着只会必然报「参数缺失」
      const required = (
        Array.isArray(rawItems['required']) ? rawItems['required'].map(String) : []
      ).filter((field) => Object.prototype.hasOwnProperty.call(properties, field));

      return {
        type: 'array',
        description,
        items: { type: 'object', properties, required },
      };
    }

    // 元素为标量（或更深的数组/对象）：内核 items 必须带 properties，标量场景给空对象
    return {
      type: 'array',
      description,
      items: { type: itemType, properties: {}, required: [] },
    };
  }

  return { type, description };
}

/**
 * MCP 工具 → 内核工具定义
 *
 * @param serverName server 名（进描述，让模型知道工具来自哪台 server；同时是 allowlist 寻址键的一半）
 * @param tool MCP 工具声明
 * @param allowlist 免确认白名单（按 server/tool **原名**寻址；空集 = 全部逐次确认）
 * @returns 定义；该工具不可用（顶层组合子 / 顶层非 object）时返回剔除原因
 */
export function toToolDefinition(
  serverName: string,
  tool: McpTool,
  allowlist: McpToolAllowlist,
): { definition: ToolDefinition } | { skipped: SkippedTool } {
  const rawSchema: unknown = tool.inputSchema;
  const schema: JsonSchema = isPlainObject(rawSchema) ? rawSchema : {};

  // 顶层组合子（anyOf/oneOf）：内核 parameters 只有一个确定的 object 形状，
  // 硬塞会把「要么 A 要么 B」折叠成单一参数表 ⇒ 模型必答错。按方案剔除 + 告警。
  if (Array.isArray(schema['anyOf']) || Array.isArray(schema['oneOf'])) {
    return {
      skipped: {
        toolName: tool.name,
        reason: '顶层 anyOf/oneOf 无法映射进内核参数类型（本期不支持，已跳过该工具）',
      },
    };
  }
  if (schema['type'] !== undefined && schema['type'] !== 'object') {
    return {
      skipped: {
        toolName: tool.name,
        reason: `顶层 inputSchema.type=${String(schema['type'])}，内核只接受 object`,
      },
    };
  }

  const rawProperties = isPlainObject(schema['properties']) ? schema['properties'] : {};
  const properties: ToolDefinition['parameters']['properties'] = {};
  for (const [field, raw] of Object.entries(rawProperties)) {
    properties[field] = mapProperty(raw);
  }

  // required 兜底（方案 §3.3）：MCP 的 required 可选，缺了内核 validateAndCoerceArgs
  // 会在 `for (const req of required)` 上抛 TypeError ⇒ 必须给空数组；
  // 同时过滤掉 properties 里没有的键（模型看不到该字段，强留必报「参数缺失」）
  const required = (Array.isArray(schema['required']) ? schema['required'].map(String) : []).filter(
    (field) => Object.prototype.hasOwnProperty.call(properties, field),
  );

  const toolDesc = typeof tool.description === 'string' ? tool.description : '';
  return {
    definition: {
      name: '', // 由 deriveToolName 填充（命名需要全 server 上下文查撞名）
      description: `[MCP 服务器 ${serverName}] ${toolDesc}`.trimEnd(),
      parameters: { type: 'object', properties, required },
      // 审批意图显式声明（切片 2 三档）：命中 allowlist = 'audit' 免弹窗仍落审计，
      // 未命中 = 'always' 逐次确认。MCP 工具来源不可信，故无缺省路径（风险 2）。
      confirmPolicy: resolveConfirmPolicy(serverName, tool.name, allowlist),
    },
  };
}

/**
 * 清洗工具名片段为内核可接受形态
 *
 * 内核 `registerTool` 的正则是 `^[a-zA-Z_][a-zA-Z0-9_]*$`，而 MCP 名常含 `-` / `.` / `/`，
 * 故非法字符一律替换为 `_`；数字开头补 `_`（正则要求首字符为字母或下划线）。
 *
 * @param raw 原始片段（server 名或工具名）
 */
export function sanitizeSegment(raw: string): string {
  const replaced = raw.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z_]/.test(replaced) ? replaced : `_${replaced}`;
}

/**
 * 派生注册名（`mcp__<server>__<tool>`，超长截断 + 撞名加后缀）
 *
 * @param serverName server 名
 * @param toolName 原始工具名
 * @param used 本 server 已占用的派生名集合（调用方维护，冲突时原地登记）
 * @returns 唯一派生名
 */
export function deriveToolName(serverName: string, toolName: string, used: Set<string>): string {
  const base = `${MCP_TOOL_NAME_PREFIX}${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
  let candidate = base;

  // 超长：截断 + 哈希后缀（不截断则 provider 侧直接拒请求，比撞名更难排查）
  if (candidate.length > MAX_TOOL_NAME_LENGTH) {
    const suffix = shortHash(base);
    candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length - 1)}_${suffix}`;
  }

  // 撞名（同一 server 内两个原名清洗后相同，如 `a-b` 与 `a.b`）：加序号后缀，逐个试到不冲突
  let serial = 2;
  while (used.has(candidate)) {
    const suffix = `_${serial}`;
    candidate =
      base.length + suffix.length > MAX_TOOL_NAME_LENGTH
        ? `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`
        : `${base}${suffix}`;
    serial += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * 8 位稳定哈希（撞名/截断后缀用）
 *
 * 只求「同一输入稳定、不同输入大概率不同」，不承担安全职责，故用简单 FNV-1a 而非 crypto。
 *
 * @param text 输入文本
 */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 把一台 server 的工具清单映射为绑定列表
 *
 * @param serverName server 名
 * @param tools MCP 工具声明（已拉全分页）
 * @param allowlist 免确认白名单（原名寻址；空集 = 全部逐次确认）
 * @returns 可注册的绑定 + 被剔除的工具（调用方据此告警）
 */
export function buildToolBindings(
  serverName: string,
  tools: readonly McpTool[],
  allowlist: McpToolAllowlist,
): { bindings: McpToolBinding[]; skipped: SkippedTool[] } {
  const bindings: McpToolBinding[] = [];
  const skipped: SkippedTool[] = [];
  const used = new Set<string>();

  for (const tool of tools) {
    const mapped = toToolDefinition(serverName, tool, allowlist);
    if ('skipped' in mapped) {
      skipped.push(mapped.skipped);
      continue;
    }
    const derivedName = deriveToolName(serverName, tool.name, used);
    bindings.push({
      derivedName,
      originalName: tool.name,
      definition: { ...mapped.definition, name: derivedName },
    });
  }

  return { bindings, skipped };
}

/**
 * 注册一台 server 的全部工具
 *
 * `callTool` 由 runtime 注入（转发到该 server 的连接）；返回值即派生缓存，
 * 注销/断线时原样传回 unregisterServerTools。
 *
 * @param registrar 内核注册面（通常是 `agent.tools`）
 * @param bindings 绑定列表
 * @param callTool 调用转发函数（原始工具名 + 参数 → MCP 结果）
 */
export function registerServerTools(
  registrar: ToolRegistrar,
  bindings: readonly McpToolBinding[],
  callTool: (originalName: string, args: Record<string, unknown>) => Promise<unknown>,
): void {
  for (const binding of bindings) {
    registrar.registerTool(binding.definition, async (args) => {
      const result = await callTool(binding.originalName, args);
      return normalizeToolResult(result);
    });
  }
}

/**
 * 注销一台 server 的全部工具（停用 / 断线的唯一出口）
 *
 * 逐个 removeTool：内核按名删，缺失静默（幂等，重复注销无害）。
 *
 * @param registrar 内核注册面
 * @param bindings 注册时拿到的绑定列表
 */
export function unregisterServerTools(
  registrar: ToolRegistrar,
  bindings: readonly McpToolBinding[],
): void {
  for (const binding of bindings) {
    registrar.removeTool(binding.derivedName);
  }
}
