/**
 * MCP 工具层 —— 把只读记忆库的能力映射成 MCP tools
 *
 * ## 工具集（只读切片，4 个）
 * | 工具 | 作用 |
 * |---|---|
 * | `search_memories` | 关键词检索 → 返回**摘要视图**（含内容预览） |
 * | `get_memory_by_id` | 按 id 取**全文** |
 * | `get_memories_by_source` | 按来源标签批量取摘要 |
 * | `list_memory_sources` | 列出可用来源及条目数（让 agent 知道「能按什么维度查」） |
 *
 * 为什么是 4 个而不是 1 个：检索返回全文会在命中多条时一次灌爆上下文，
 * 故拆成「先列表定位 → 再按 id 取全文」两步，模仿 `search` + `read` 的常识形态。
 *
 * ## 为什么没有写类工具
 * 本切片**刻意只读**。写路径需要内核先补齐「脱离回合的受治理写 API」（见设计文档缺口 G1），
 * 且裸 `storage.upsert` 会绕开 3-track-1-port 治理（去重/冲突/取代）。宁缺勿烂。
 *
 * ## 为什么不做 touch（刷新 accessedAt）
 * `touch` 语义是「被想起即刷新」——但本 Store 是纯内存容器、**不落盘**，
 * 刷了也随进程退出消失，属于制造「已记录使用轨迹」的假象。故不调用。
 */
import type { Memory } from '@zooique/memora';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ReadOnlyFileStore } from './readOnlyFileStore.js';

/**
 * 工具返回体与工具定义**直接复用协议自带类型**，不自拟等价 interface。
 * `CallToolResult` / `Tool` 是 MCP 协议对该形状的真源；手写一份同名结构会形成
 * 第二份真理源，协议升级（如 1.32 引入 task 增强结果变体）即静默漂移——
 * 典型「并列而非嫁接」。首次接真 SDK 时即由此炸出 TS2345，故彻底引協議类型。
 */

/** 内容预览长度：够 agent 判断是否值得深挖，又不灌爆上下文 */
const PREVIEW_LEN = 200;
/** 单次返回条数硬上限：防止一次拉爆上下文 */
const MAX_LIMIT = 50;
/** 默认返回条数 */
const DEFAULT_LIMIT = 10;

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'search_memories',
    description:
      '在本地 memora 记忆库中按关键词检索摘要记忆，返回命中清单（id / 名称 / 来源 / 内容预览）。支持多关键词（空格分隔，任一命中即可）。先用它定位，再用 get_memory_by_id 取全文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词。传空字符串则按最近使用（accessedAt 降序）返回。',
        },
        limit: {
          type: 'integer',
          description: `返回条数上限，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}。`,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_memory_by_id',
    description:
      '按记忆 id 取回完整内容（Markdown 全文）。id 来自 search_memories / get_memories_by_source 的返回结果。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            "记忆唯一标识，格式通常为 'source:name'，如 'round-summary:2026-10-15-session1:r3'。",
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_memories_by_source',
    description:
      '按来源标签批量取摘要记忆（如 round-summary 轮次摘要、work-projection 作品概要）。不确定有哪些来源时先调用 list_memory_sources。',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: '来源标签，如 round-summary。可用值见 list_memory_sources。',
        },
        limit: {
          type: 'integer',
          description: `返回条数上限，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}。`,
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'list_memory_sources',
    description:
      '列出记忆库中所有来源标签及各自的当前条目数。用于了解「这份记忆库里都有哪类记忆」，是检索前的推荐第一步。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

/** 取必填字符串参数：存在、类型为 string、且 trim 后非空 */
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数 ${key} 必填且不能为空字符串`);
  }
  return value.trim();
}

/**
 * 取 query 参数（唯一允许空串的参数）。
 *
 * 空串语义 = 不限定关键词、按最近使用返回——这是对外 JSON Schema 写明的契约，
 * 故此处**不可**复用 `requireString`（它会把空串判为非法 ⇒ 实现与对外文档矛盾）。
 */
function readQuery(args: Record<string, unknown>): string {
  const value = args['query'];
  if (typeof value !== 'string') {
    throw new Error('参数 query 必填且必须是字符串（可传空串表示不限定关键词、按最近使用返回）');
  }
  return value.trim();
}

/** 归一化 limit：非法值直接抛错（早失败优于静默兜底成一个奇怪的数字） */
function normalizeLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`limit 必须是正整数，收到：${String(raw)}`);
  }
  return Math.min(n, MAX_LIMIT);
}

/** 摘要视图：给 agent 判断「要不要展开全文」用 */
function toBrief(m: Memory): Record<string, unknown> {
  const flat = m.content.replace(/\s+/g, ' ').trim();
  return {
    id: m.id,
    name: m.name,
    source: m.source,
    summaryType: m.summaryType,
    accessedAt: m.accessedAt,
    preview: flat.length <= PREVIEW_LEN ? flat : `${flat.slice(0, PREVIEW_LEN)}…`,
  };
}

/** 全文视图：按 id 精取时才用 */
function toFull(m: Memory): Record<string, unknown> {
  return {
    id: m.id,
    name: m.name,
    source: m.source,
    summaryType: m.summaryType,
    sessionName: m.sessionName,
    roundId: m.roundId,
    createdAt: m.createdAt,
    accessedAt: m.accessedAt,
    content: m.content,
  };
}

function text(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * 分发工具调用。
 *
 * 错误约定：参数非法 → 抛错（MCP SDK 映射为 JSON-RPC error，agent 可见具体原因）；
 * 「查不到」→ 正常返回带 `found: false` 的结果体（查不到是合法答案，不是错误）。
 */
export async function callTool(
  store: ReadOnlyFileStore,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  switch (name) {
    case 'search_memories': {
      const query = readQuery(args);
      const limit = normalizeLimit(args['limit']);
      const hits = store.search(query, limit);
      return text({
        query,
        requestedLimit: limit,
        // 诚实命名：这是「本返回了多少条」，不是「总命中数」——后者受 limit 截断，报出来会是谎报
        returned: hits.length,
        results: hits.map(toBrief),
      });
    }

    case 'get_memory_by_id': {
      const id = requireString(args, 'id');
      const found = store.getById(id);
      if (!found) {
        return text({
          found: false,
          id,
          // 三种原因无法从只读面区分，一并列出而不猜某一个（猜错就是谎报）
          reason: '未命中：该 id 不存在、已被软删除，或已被更新的摘要取代',
        });
      }
      return text({ found: true, memory: toFull(found) });
    }

    case 'get_memories_by_source': {
      const source = requireString(args, 'source');
      const limit = normalizeLimit(args['limit']);
      const all = store.getBySource(source);
      return text({
        source,
        requestedLimit: limit,
        totalForSource: all.length,
        results: all.slice(0, limit).map(toBrief),
      });
    }

    case 'list_memory_sources': {
      const sources = store.listSources();
      return text({ totalCurrent: store.count(), sources });
    }

    default:
      throw new Error(`未知工具：${name}`);
  }
}
