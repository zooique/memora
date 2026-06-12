/**
 * Memora Demo - 小说创作助手
 *
 * 演示 Memora Agent 门面类的"宿主项目接入"路径。
 * 这是 Memora 移植指南的"活样本"——任何想接入 Memora 的开发者，
 * 都可以 cat 这个文件，看到核心接入代码 + 工具注册。
 *
 * 双形态：
 * - CLI: npm run cli （面向开发者，5 分钟上手）
 * - Web: npm run web （面向最终用户，UI 配置 + 聊天）
 *
 * R-507：注册 4 个小说领域工具
 * - create_chapter：创建新章节（委托 write_file）
 * - append_to_chapter：追加内容到章节（委托 read_file + write_file）
 * - list_chapters：列出所有章节（委托 list_dir）
 * - update_character：更新角色档案（委托 write_file）
 */
import { Agent } from 'memora';
import type { Config, ToolDefinition, ToolHandler } from 'memora';

// ─── 小说工具定义 ─────────────────────────────────────

/** 创建新章节 */
const CREATE_CHAPTER_DEF: ToolDefinition = {
  name: 'create_chapter',
  description: '创建小说新章节。章节文件保存在 chapters/ 目录下，文件名格式为 "第N章-标题.md"。',
  parameters: {
    type: 'object',
    properties: {
      number: { type: 'string', description: '章节序号（如 "1"、"2"）' },
      title: { type: 'string', description: '章节标题' },
      content: { type: 'string', description: '章节正文内容' },
    },
    required: ['number', 'title', 'content'],
  },
};

/** 追加内容到章节 */
const APPEND_TO_CHAPTER_DEF: ToolDefinition = {
  name: 'append_to_chapter',
  description: '在已有章节末尾追加内容。自动读取现有内容并拼接后写回。',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: '章节文件名（如 "第1章-起源.md"）' },
      content: { type: 'string', description: '要追加的内容' },
    },
    required: ['filename', 'content'],
  },
};

/** 列出所有章节 */
const LIST_CHAPTERS_DEF: ToolDefinition = {
  name: 'list_chapters',
  description: '列出 chapters/ 目录下的所有章节文件。返回文件名列表。',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/** 更新角色档案 */
const UPDATE_CHARACTER_DEF: ToolDefinition = {
  name: 'update_character',
  description: '创建或更新角色档案。角色文件保存在 characters/ 目录下，文件名格式为 "角色名.md"。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '角色名称' },
      profile: { type: 'string', description: '角色档案内容（外貌、性格、背景等）' },
    },
    required: ['name', 'profile'],
  },
};

// ─── 小说工具 handler ─────────────────────────────────

/**
 * 创建章节的 handler
 *
 * 委托 write_file 写入 chapters/第N章-标题.md，
 * 复用安全层（路径白名单 + 写入确认）。
 */
function createCreateChapterHandler(agent: Agent): ToolHandler {
  return async (args) => {
    const number = args['number'] as string;
    const title = args['title'] as string;
    const content = args['content'] as string;
    // 构造章节文件路径
    const filename = `第${number}章-${title}.md`;
    const path = `chapters/${filename}`;
    // 章节内容格式：标题 + 正文
    const fullContent = `# 第${number}章 ${title}\n\n${content}`;
    return agent.executeTool('write_file', JSON.stringify({ path, content: fullContent }));
  };
}

/**
 * 追加内容到章节的 handler
 *
 * 先委托 read_file 读取现有内容，再委托 write_file 写回拼接后的内容。
 */
function createAppendToChapterHandler(agent: Agent): ToolHandler {
  return async (args) => {
    const filename = args['filename'] as string;
    const content = args['content'] as string;
    const path = `chapters/${filename}`;
    // 读取现有内容
    let existing = '';
    try {
      existing = await agent.executeTool('read_file', JSON.stringify({ path }));
    } catch (err) {
      // 只有"文件不存在"才从空内容开始；其他错误（权限/路径越界）必须抛出
      const msg = (err as Error).message ?? '';
      if (!msg.includes('ENOENT') && !msg.includes('不存在') && !msg.includes('读取失败')) {
        throw err;
      }
    }
    // 拼接后写回
    const newContent = existing + '\n\n' + content;
    return agent.executeTool('write_file', JSON.stringify({ path, content: newContent }));
  };
}

/**
 * 列出章节的 handler
 *
 * 委托 list_dir 列出 chapters/ 目录。
 */
function createListChaptersHandler(agent: Agent): ToolHandler {
  return async (_args) => {
    return agent.executeTool('list_dir', JSON.stringify({ path: 'chapters' }));
  };
}

/**
 * 更新角色档案的 handler
 *
 * 委托 write_file 写入 characters/角色名.md。
 */
function createUpdateCharacterHandler(agent: Agent): ToolHandler {
  return async (args) => {
    const name = args['name'] as string;
    const profile = args['profile'] as string;
    const path = `characters/${name}.md`;
    // 角色档案格式
    const fullContent = `# ${name}\n\n${profile}`;
    return agent.executeTool('write_file', JSON.stringify({ path, content: fullContent }));
  };
}

// ─── 核心接入代码 ─────────────────────────────────────

export async function createNovelAgent(config: {
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  configDir: string; // 宿主项目的人格/规则/技能目录
  projectPath: string; // .memora/ 所在目录
}) {
  // Memora 完整配置（llm + memory + security 子配置）
  // 注意：llmApiKey 为空时切到 'mock' provider，让 demo 在没配 Key 时也能跑
  // （mock 模式仍走完整 Agent 链路 → topic-*.md 持久化 + signal 检测 + lazy 扫描都生效）
  const hasRealLlm = !!config.llmApiKey;
  const memoraConfig: Config = {
    llm: hasRealLlm
      ? {
          provider: 'openaiCompatible',
          apiKey: config.llmApiKey,
          baseUrl: config.llmBaseUrl,
          model: config.llmModel,
          temperature: 0.7, // 小说创作建议略高温度，激发创造性
        }
      : {
          provider: 'mock',
          model: 'mock-novel-writer',
          temperature: 0.7,
        },
    memory: {
      dataDir: '.memora',
      maxContextTokens: 8000,
    },
    security: {
      permission: 'owner',
      confirmWrites: true,
    },
    allowedPaths: ['.'],
  };

  const agent = new Agent({
    config: memoraConfig,
    configDir: config.configDir,
    projectPath: config.projectPath,
  });
  await agent.init();

  // ─── 注册小说领域工具 ─────────────────────────────
  // 通过 agent.registerTool() 注册，handler 委托内置工具（复用安全层）
  agent.registerTool(CREATE_CHAPTER_DEF, createCreateChapterHandler(agent));
  agent.registerTool(APPEND_TO_CHAPTER_DEF, createAppendToChapterHandler(agent));
  agent.registerTool(LIST_CHAPTERS_DEF, createListChaptersHandler(agent));
  agent.registerTool(UPDATE_CHARACTER_DEF, createUpdateCharacterHandler(agent));

  return agent;
}
