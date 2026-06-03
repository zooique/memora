/**
 * init 命令
 * 初始化项目：生成 .memora/ 运行时目录 + agent-config/ 领域配置（--domain 时）
 *
 * T-102 修复：使用 FileStore 抽象写入记忆（不再直接调 mkdir/writeFile）
 * T-104 修复：读取项目根 config.example.json 拷贝到 .memora/config.json
 * T-xxx 增强：memora init --domain <name> 一键生成领域配置 + agentBridge.js
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@/logging/logger.js';
import { FileStore } from '@/memory/store.js';
import { MemoryType, type Memory, type MemoryTypeValue } from '@/memory/types.js';
import { getTemplate, getTemplateIds, type DomainTemplate } from './templates/domain-templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// src/cli/commands/init.ts → 项目根（向上 3 级）
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CONFIG_EXAMPLE_PATH = join(PROJECT_ROOT, 'config.example.json');

/**
 * 需要预创建的子目录（不存放记忆文件，但需要存在）
 */
const EXTRA_DIRS: string[] = ['topics', 'archive', 'logs'];

/**
 * 类型到子目录的映射
 * 必须与 FileStore.typeToDir() 保持一致
 */
const TYPE_TO_DIR: Record<MemoryTypeValue, string> = {
  personality: 'personality',
  rule: 'rules',
  skill: 'skills',
  tool: 'tools',
  topic: 'topics',
  archive: 'archive',
};

// ─── 辅助函数 ─────────────────────────────────────────

/**
 * 构造一个默认记忆对象
 */
function makeDefaultMemory(
  type: MemoryTypeValue,
  name: string,
  content: string,
  permanence: 'always' | 'domain' = 'always',
): Memory {
  return {
    id: `${type}:${name}`,
    type,
    permanence,
    name,
    content,
    tags: [type, name],
    weight: 1.0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filePath: '', // 写入时由 FileStore 自动填
  };
}

/**
 * 生成默认的 .memora/ 目录结构（无领域模板行为）
 */
async function generateDefaultMemora(projectPath: string): Promise<void> {
  const memoraDir = join(projectPath, '.memora');

  // 1. 创建记忆子目录
  for (const type of Object.values(MemoryType) as MemoryTypeValue[]) {
    await mkdir(join(memoraDir, TYPE_TO_DIR[type]), { recursive: true });
  }
  for (const dir of EXTRA_DIRS) {
    await mkdir(join(memoraDir, dir), { recursive: true });
  }

  // 2. 写默认人格
  const fileStore = new FileStore(memoraDir);
  const defaultPersonality = makeDefaultMemory(
    'personality',
    'default',
    `# 默认人格

你是一个友好、严谨、注重事实的 AI 助手。
- 优先基于事实回答
- 不确定时明确说明
- 简洁清晰，避免冗余
- 遵守用户给出的规则`,
  );
  await fileStore.write(defaultPersonality);

  // 3. 写默认规则
  const coreRule = makeDefaultMemory(
    'rule',
    'core',
    `# 核心规则

- **诚实优先**：不知道就说不知道，不要编造
- **隐私保护**：不要向外部泄露用户的个人信息和文件内容
- **工具安全**：调用工具前确认路径在白名单内
- **可追溯**：所有写操作记录到日志`,
  );
  await fileStore.write(coreRule);
}

/**
 * 拷贝 config.example.json 到 .memora/config.json，失败时兜底
 */
async function copyConfigExample(memoraDir: string): Promise<void> {
  try {
    const exampleConfig = await readFile(CONFIG_EXAMPLE_PATH, 'utf-8');
    await writeFile(join(memoraDir, 'config.json'), exampleConfig, 'utf-8');
  } catch (err) {
    logger.warn({ err }, '未找到 config.example.json，使用最小默认配置');
    const minimalConfig = {
      llm: { provider: 'mock' },
      memory: { dataDir: '~/.memora' },
      security: { permission: 'owner', confirmWrites: false },
      allowedPaths: [],
    };
    await writeFile(
      join(memoraDir, 'config.json'),
      JSON.stringify(minimalConfig, null, 2),
      'utf-8',
    );
  }
}

/**
 * 生成 agent-config/ 目录（领域模板模式）
 * 使用 FileStore 写入记忆文件，保持与运行时一致的 frontmatter 格式
 */
async function generateAgentConfig(projectPath: string, domainId: string): Promise<DomainTemplate> {
  const template = getTemplate(domainId);
  if (!template) {
    const available = getTemplateIds().join(', ');
    throw new Error(`未知领域 "${domainId}"，可用: ${available}`);
  }

  const configDir = join(projectPath, 'agent-config');
  // 创建子目录
  await mkdir(join(configDir, 'personality'), { recursive: true });
  await mkdir(join(configDir, 'rules'), { recursive: true });
  await mkdir(join(configDir, 'skills'), { recursive: true });
  await mkdir(join(configDir, 'tools'), { recursive: true });

  const fileStore = new FileStore(configDir);

  // 写人格
  const personalityMemory = makeDefaultMemory('personality', template.id, template.personality);
  await fileStore.write(personalityMemory);

  // 写规则
  for (const rule of template.rules) {
    const m = makeDefaultMemory(rule.type, rule.name, rule.content, rule.permanence);
    await fileStore.write(m);
  }

  // 写技能
  for (const skill of template.skills) {
    const m = makeDefaultMemory(skill.type, skill.name, skill.content, skill.permanence);
    await fileStore.write(m);
  }

  // 写工具
  for (const tool of template.tools) {
    const m = makeDefaultMemory(tool.type, tool.name, tool.content, tool.permanence);
    await fileStore.write(m);
  }

  return template;
}

/**
 * 生成 agentBridge.js — 宿主项目接入代码骨架
 * 放在 src/ 目录下（自动创建）
 */
async function generateAgentBridge(projectPath: string, domainId: string): Promise<void> {
  // 确保 src/ 目录存在
  const srcDir = join(projectPath, 'src');
  await mkdir(srcDir, { recursive: true });

  const bridgeContent = `// agentBridge.js — Memora Agent 接入代码
// 领域: ${domainId}
//
// 使用前请：
//   1. 填入你的 LLM API Key（第 18 行附近）
//   2. 确认 configDir 指向你的 agent-config/ 目录
//   3. 运行: node src/agentBridge.js

import { Agent } from 'memora';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const agent = new Agent({
    projectPath: resolve(__dirname, '..'),
    configDir: resolve(__dirname, '..', 'agent-config'),
    config: {
      llm: {
        // TODO: 替换为你的 LLM API Key
        // 方式 1: 直接填入（不推荐提交到 git）
        // apiKey: 'sk-xxxxxxxxxxxxxxxx',
        // 方式 2: 从环境变量读取（推荐）
        provider: 'deepseek',      // 'deepseek' | 'doubao' | 'openai' | 'mock'
        model: 'deepseek-chat',
        apiKey: process.env.LLM_API_KEY || 'YOUR_API_KEY_HERE',
      },
      memory: {
        dataDir: '~/.memora',
        maxContextTokens: 120000,
      },
      security: {
        permission: 'owner',
        confirmWrites: false,
      },
      allowedPaths: [resolve(__dirname, '..')],
    },
  });

  console.log('[AgentBridge] 正在初始化...');
  await agent.init();
  console.log('[AgentBridge] 初始化完成！输入你的消息，按 Ctrl+C 退出。\\n');

  // 简单的 REPL 循环（你也可以替换为自己的 UI）
  process.stdout.write('> ');
  process.stdin.on('data', async (chunk) => {
    const input = chunk.toString().trim();
    if (input === 'exit' || input === 'quit') {
      await agent.close();
      console.log('[AgentBridge] 已退出。');
      process.exit(0);
    }

    try {
      process.stdout.write('\\n');
      for await (const chunk of agent.chat(input)) {
        process.stdout.write(chunk);
      }
      process.stdout.write('\\n\\n> ');
    } catch (err) {
      console.error('出错:', err.message);
      process.stdout.write('> ');
    }
  });
}

main().catch((err) => {
  console.error('初始化失败:', err.message);
  process.exit(1);
});
`;

  await writeFile(join(srcDir, 'agentBridge.js'), bridgeContent, 'utf-8');
}

// ─── 命令入口 ─────────────────────────────────────────

/**
 * init 命令选项
 */
export interface InitOptions {
  /** 项目目录路径 */
  project?: string;
  /** 领域模板 ID（code / novel / ...） */
  domain?: string;
}

/**
 * 执行 init 命令
 *
 * 两种模式：
 *   1. 无 --domain：生成 .memora/ 运行时骨架（默认行为，保持兼容）
 *   2. --domain <name>：生成 agent-config/ + agentBridge.js + .memora/ 全套
 */
export async function initCommand(options: InitOptions): Promise<void> {
  const projectPath = options.project ?? process.cwd();
  const memoraDir = join(projectPath, '.memora');

  if (options.domain) {
    // ── 领域模板模式 ──────────────────────────────
    logger.info({ projectPath, domain: options.domain }, '使用领域模板初始化');

    // 1. 生成 agent-config/（领域配置）
    const template = await generateAgentConfig(projectPath, options.domain);

    // 2. 生成 agentBridge.js（接入代码骨架）
    await generateAgentBridge(projectPath, options.domain);

    // 3. 生成 .memora/（运行时目录）
    await mkdir(join(memoraDir), { recursive: true });
    for (const dir of EXTRA_DIRS) {
      await mkdir(join(memoraDir, dir), { recursive: true });
    }
    await copyConfigExample(memoraDir);

    // 输出成功信息
    console.log(`\n✅ ${template.name}项目初始化完成：${projectPath}`);
    console.log(`\n生成的目录结构：`);
    console.log(`  agent-config/`);
    console.log(`    personality/${template.id}.md    ← 人格设定（${template.name}）`);
    if (template.rules.length)
      console.log(`    rules/                         ← ${template.rules.length} 条规则`);
    if (template.skills.length)
      console.log(`    skills/                        ← ${template.skills.length} 个技能`);
    if (template.tools.length)
      console.log(`    tools/                         ← ${template.tools.length} 个工具`);
    console.log(`  src/`);
    console.log(`    agentBridge.js                 ← 接入代码骨架`);
    console.log(`  .memora/                         ← 运行时目录`);
    console.log(`\n下一步：`);
    console.log(`  1. 编辑 src/agentBridge.js 填入 LLM API Key`);
    console.log(`  2. 编辑 agent-config/personality/${template.id}.md 微调人格`);
    console.log(`  3. 运行 node src/agentBridge.js 开始对话`);
  } else {
    // ── 默认模式（保持兼容） ──────────────────────
    logger.info({ projectPath }, '初始化 Memora 项目');

    await generateDefaultMemora(projectPath);

    // 拷贝 config
    await copyConfigExample(memoraDir);

    console.log(`✅ Memora 项目初始化完成：${projectPath}`);
    console.log(`\n下一步：`);
    console.log(`  1. 编辑 .memora/config.json 配置你的 LLM`);
    console.log(`  2. 编辑 .memora/personality/default.md 自定义人格`);
    console.log(`  3. 运行 \`memora\` 开始对话`);
  }
}
