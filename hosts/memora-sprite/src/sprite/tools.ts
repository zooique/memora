/**
 * 宿主自定义工具注册（领域工具化）
 *
 * 背景：
 *   内核 ToolExecutor 提供了 registerTool() 机制，但 sprite 之前未注册任何
 *   自定义工具——LLM 只能调用 4 个内置工具（read_file/write_file/list_dir/search_memories），
 *   无法主动打开浏览器或检索精灵记忆。
 *
 *   本文件把 `/web` CLI 命令的浏览器打开逻辑提取为 webSearchTool，
 *   包装 searchMemories 为 memorySearchTool，让 LLM 在对话中自然调用。
 *
 * 设计原则：
 *   - 工具定义 + handler 同文件聚合，便于一次性注册
 *   - handler 复用 `index.ts` 现有的 execFile 跨平台逻辑
 *   - memorySearchTool 委托内核 searchMemories，避免重复实现
 *   - 节流/审计交给工具系统自然触发（每次调用走 SecurityGuard 审计日志）
 */
import { execFile } from 'node:child_process';
import { logger, toError } from 'memora';
import type { ToolDefinition, ToolHandler, ToolContext, ConfigSuggestion } from 'memora';

/**
 * Agent 引用（由 index.ts 在 initAgentFromConfig 中注入）
 *
 * 用于工具处理器中调用 config.confirmConfigSuggestion 和 agent.reloadConfig。
 * 采用延迟注入模式，避免循环依赖。
 */
type AgentRef = {
  config: {
    confirmConfigSuggestion: (suggestion: ConfigSuggestion) => Promise<void>;
  };
  reloadConfig: (source?: string) => Promise<{ skill: number; persona: number }>;
};
let agentRef: AgentRef | null = null;

/** 注入 Agent 引用（在 Agent 初始化完成后调用） */
export function setAgentRef(agent: AgentRef): void {
  agentRef = agent;
}

/** 获取当前 Agent 引用（handler 调用时使用） */
function getAgentRef(): AgentRef | null {
  return agentRef;
}

/**
 * 构建跨平台"打开浏览器搜索"命令
 *
 * 提取自 index.ts 原 /web 命令实现：使用 execFile 而非 exec，
 * 直接调用可执行文件，不经过 shell，消除命令注入风险。
 */
function buildBrowserOpenCommand(url: string): { cmd: string; args: string[] } {
  const platform = process.platform;
  if (platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: [url] };
  }
  return { cmd: 'xdg-open', args: [url] };
}

/** web_search 工具定义（供 LLM 工具调用发现） */
export const WEB_SEARCH_TOOL: ToolDefinition = {
  name: 'web_search',
  description: '使用系统默认浏览器打开 Google 搜索关键词。当用户询问实时信息、'
    + '技术文档、新闻或任何需要联网的知识时调用。返回用户已打开浏览器的提示。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词，例如 "React 19 新特性"、"上海天气"',
      },
    },
    required: ['query'],
  },
};

/**
 * 执行浏览器搜索（纯函数，CLI 与工具共享）
 *
 * 提取自 index.ts 原 `/web` 命令：同一 execFile 逻辑供"用户敲 /web"和
 * "LLM 调用 web_search 工具"两个入口复用，避免两处实现漂移。
 */
export function webSearch(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) {
    return Promise.resolve('错误：搜索关键词不能为空');
  }
  const url = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  const { cmd, args: cmdArgs } = buildBrowserOpenCommand(url);

  return new Promise<string>((resolve) => {
    execFile(cmd, cmdArgs, (err) => {
      if (err) {
        resolve(`错误：无法打开浏览器（${err.message}）。请用户手动访问：${url}`);
        return;
      }
      resolve(`已在系统默认浏览器中搜索："${trimmed}"。请用户查看浏览器窗口。`);
    });
  });
}

/** web_search 工具处理器 */
export const webSearchHandler: ToolHandler = async (args: Record<string, unknown>, _ctx: ToolContext) => {
  return webSearch(String(args.query ?? ''));
};

/** memory_search 工具定义 */
export const MEMORY_SEARCH_TOOL: ToolDefinition = {
  name: 'memory_search',
  description: '在精灵记忆库中搜索关键词，返回最相关的若干条记忆及其来源。'
    + '当用户询问"我之前说过什么"、"我们之前讨论过 XXX 吗"或需要历史上下文时调用。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词或自然语言查询',
      },
      limit: {
        type: 'string',
        description: '返回结果数量上限（1-10），默认 5',
      },
    },
    required: ['query'],
  },
};

/** memory_search 工具处理器 */
export const memorySearchHandler: ToolHandler = async (args: Record<string, unknown>, _ctx: ToolContext) => {
  const query = String(args.query ?? '').trim();
  if (!query) {
    return '错误：query 参数不能为空';
  }
  // limit 参数容错：解析失败时回退到默认 5
  const limitRaw = Number(args.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 10) : 5;

  // 委托给注册时绑定的 searcher，避免循环依赖
  const searcher = getMemorySearcher();
  if (!searcher) {
    return '错误：记忆搜索器未初始化';
  }

  try {
    const hits = await searcher(query, limit);
    if (hits.length === 0) {
      return `未找到与 "${query}" 相关的记忆`;
    }
    const lines = hits.map((h) => `- [${h.name}] ${h.contentPreview} (score: ${h.score.toFixed(2)})`);
    return `找到 ${hits.length} 条相关记忆：\n${lines.join('\n')}`;
  } catch (err) {
    // 记忆搜索失败时返回错误信息给 LLM，同时记录警告便于排查
    logger.warn({ err: toError(err).message, query }, '记忆搜索失败');
    return `错误：记忆搜索失败：${toError(err).message}`;
  }
};

/** 记忆搜索器引用（由 index.ts 在 initAgentFromConfig 中注入） */
type MemorySearcher = (query: string, limit: number) => Promise<Array<{ name: string; contentPreview: string; score: number }>>;
let memorySearcher: MemorySearcher | null = null;

/** 注入记忆搜索器（在 Agent 初始化完成后调用） */
export function setMemorySearcher(searcher: MemorySearcher): void {
  memorySearcher = searcher;
}

/** 获取当前搜索器引用（handler 调用时使用） */
function getMemorySearcher(): MemorySearcher | null {
  return memorySearcher;
}

// ─── 创建角色和技能工具 ─────────────────────────────────────────

/**
 * 创建角色/技能/规则的公共处理器工厂
 *
 * createPersonaHandler / createSkillHandler / createRuleHandler 的公共逻辑提取：
 * 参数提取 → 校验 → 内容拼接 → confirmConfigSuggestion → reloadConfig。
 * 仅 type 和消息文本不同，由参数区分。
 *
 * @param type 类型标识（'persona' | 'skill' | 'rule'）
 * @param label 中文标签（用于消息文本）
 */
function createConfigHandler(
  type: 'persona' | 'skill' | 'rule',
  label: string,
): ToolHandler {
  return async (args: Record<string, unknown>, _ctx: ToolContext) => {
    const agent = getAgentRef();
    if (!agent) {
      return '错误：Agent 引用未初始化';
    }

    const name = String(args.name ?? '').trim();
    const description = String(args.description ?? '').trim();
    const content = String(args.content ?? '').trim();
    const keywords = String(args.keywords ?? '').trim();

    if (!name) {
      return `错误：${label}名称不能为空`;
    }
    if (!content) {
      return `错误：${label}内容不能为空`;
    }

    // description/keywords 通过 metadata 传递，写入 frontmatter 供 PersonaManager/SkillManager 解析
    // 不再拼接到 content 纯文本——避免 body 噪音，且 keywords 字段可被 parseKeywords 正确读取
    const metadata: Record<string, string> = {};
    if (description) {
      metadata.description = description;
    }
    if (keywords) {
      metadata.keywords = keywords;
    }

    // 阶段 1：写入配置文件（confirmConfigSuggestion 写 .md 文件 + 调用 reloadConfig 热重载）
    // 这一步失败属于真正的创建失败，返回错误
    try {
      await agent.config.confirmConfigSuggestion({
        type,
        name,
        content,
        confidence: 0.95,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    } catch (err) {
      logger.warn({ err: toError(err).message, name }, `创建${label}失败：配置文件写入异常`);
      return `错误：创建${label}失败：${toError(err).message}`;
    }

    // 阶段 2：热重载内存（reloadConfig）
    // 这一步在对话进行中会因 chatLock 冲突失败（"对话繁忙"），但文件已成功持久化，
    // 不应掩盖创建成功的事实——降级为提示"重启后生效"
    let reloadHint = '';
    try {
      await agent.reloadConfig(type);
    } catch (err) {
      const errMsg = toError(err).message;
      logger.info({ err: errMsg, name, type }, `${label}文件已写入，热重载推迟（对话进行中）`);
      reloadHint = '\n\n注意：当前对话进行中，新配置将在对话结束后自动加载，或重启后生效。';
    }

    return `${label} "${name}" 创建成功！已持久化到配置文件，重启后依然生效。${reloadHint}\n\n描述：${description || '无'}\n关键词：${keywords || '无'}`;
  };
}

/** create_persona 工具定义 */
export const CREATE_PERSONA_TOOL: ToolDefinition = {
  name: 'create_persona',
  description: '创建一个新的角色（Persona）。当用户要求创建/修改角色时，必须使用此工具。角色会持久化到配置文件，重启后依然生效。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '角色名称，简短描述（2-6字），例如"写作助手"、"代码专家"',
      },
      description: {
        type: 'string',
        description: '角色描述，说明这个角色的特点和用途',
      },
      content: {
        type: 'string',
        description: '角色的详细指令（system prompt），描述角色的行为方式、专业知识和对话风格',
      },
      keywords: {
        type: 'string',
        description: '关键词列表（逗号分隔），用于自动匹配该角色，例如"写作,文案,编辑"',
      },
    },
    required: ['name', 'content'],
  },
};

/** create_persona 工具处理器（由公共工厂 createConfigHandler 生成） */
export const createPersonaHandler: ToolHandler = createConfigHandler('persona', '角色');

/** create_skill 工具定义 */
export const CREATE_SKILL_TOOL: ToolDefinition = {
  name: 'create_skill',
  description: '创建一个新的技能（Skill）。当用户要求创建/修改技能时，必须使用此工具。技能会持久化到配置文件，重启后依然生效。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '技能名称，简短描述（2-6字），例如"去AI味"、"审视角"',
      },
      description: {
        type: 'string',
        description: '技能描述，说明这个技能的作用和使用场景',
      },
      content: {
        type: 'string',
        description: '技能的详细指令（system prompt），描述技能的执行方式和输出格式',
      },
      keywords: {
        type: 'string',
        description: '关键词列表（逗号分隔），用于自动匹配该技能，例如"优化,精简,去除"',
      },
    },
    required: ['name', 'content'],
  },
};

/** create_skill 工具处理器（由公共工厂 createConfigHandler 生成） */
export const createSkillHandler: ToolHandler = createConfigHandler('skill', '技能');

/** create_rule 工具定义 */
export const CREATE_RULE_TOOL: ToolDefinition = {
  name: 'create_rule',
  description: '创建一个新的项目规则（Rule）。当用户要求创建/修改规则时，必须使用此工具。'
    + '规则会持久化到配置文件并立即注入当前会话，重启后依然生效。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '规则名称，简短描述（2-6字），例如"代码风格"、"回复格式"',
      },
      description: {
        type: 'string',
        description: '规则描述，说明这个规则的作用和适用场景',
      },
      content: {
        type: 'string',
        description: '规则的详细内容，描述具体的规则条款和约束',
      },
      keywords: {
        type: 'string',
        description: '关键词列表（逗号分隔），预留字段，当前规则不靠关键词匹配',
      },
    },
    required: ['name', 'content'],
  },
};

/** create_rule 工具处理器（由公共工厂 createConfigHandler 生成） */
export const createRuleHandler: ToolHandler = createConfigHandler('rule', '规则');
