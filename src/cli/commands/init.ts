/**
 * init 命令
 * 初始化项目：生成 .memora/ 运行时目录 + agent-config/ 领域配置（--domain 时）
 *
 * T-102 修复：使用 FileStore 抽象写入记忆（不再直接调 mkdir/writeFile）
 * T-104 修复：读取项目根 config.example.json 拷贝到 .memora/config.json
 * T-xxx 增强：memora init --domain <name> 一键生成领域配置 + agentBridge.js
 * 模式 2 增强：memora init --user 交互式生成用户级 agent-config/
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { logger } from '@/logging/logger.js';
import { FileStore } from '@/memory/store.js';
import { MemoryType, TYPE_TO_DIR_MAP } from '@/memory/types.js';
import type { MemoryTypeValue, Memory } from '@/memory/types.js';
import { configError } from '@/utils/errors.js';
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
    await mkdir(join(memoraDir, TYPE_TO_DIR_MAP[type]), { recursive: true });
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
 * 交互式问答：向用户提出一个问题，返回用户的输入
 *
 * @param question - 提示文本
 * @param defaultAnswer - 默认值（用户直接回车时使用）
 * @returns 用户输入或默认值
 */
async function promptUser(question: string, defaultAnswer?: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    const suffix = defaultAnswer ? ` (${defaultAnswer})` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      // 用户直接回车则使用默认值
      resolve(trimmed || defaultAnswer || '');
    });
  });
}

/**
 * 根据用途生成对应的规则内容
 *
 * @param purpose - 用户选择的主要用途
 * @returns 规则 Markdown 内容
 */
function buildPurposeRules(purpose: string): string {
  const purposeMap: Record<string, string> = {
    编程: `# 编程规则

- **代码优先**：回答编程问题时优先给出可运行的代码示例
- **类型安全**：优先使用 TypeScript strict 模式，避免 any 类型
- **最佳实践**：遵循当前语言/框架的社区最佳实践
- **解释清晰**：代码注释说明"为什么"而非"是什么"`,
    写作: `# 写作规则

- **文风一致**：保持全文风格统一，不随意切换语气
- **结构清晰**：长文使用标题层级，短文保持段落分明
- **细节真实**：虚构内容也要符合内在逻辑，避免自相矛盾
- **尊重设定**：遵守已有的世界观和角色设定`,
    日常对话: `# 对话规则

- **自然交流**：像朋友一样对话，不机械回答
- **简洁明了**：避免冗长，直击要点
- **主动建议**：发现用户可能有未表达的需求时，主动提出
- **尊重隐私**：不主动询问敏感信息`,
  };

  // 精确匹配优先，否则回退到通用规则
  return (
    purposeMap[purpose] ??
    `# 通用规则

- **诚实优先**：不知道就说不知道，不要编造
- **隐私保护**：不要向外部泄露用户的个人信息和文件内容
- **工具安全**：调用工具前确认路径在白名单内
- **可追溯**：所有写操作记录到日志`
  );
}

/**
 * 根据性格生成对应的身份描述
 *
 * @param name - Agent 名称
 * @param personality - 性格选择
 * @returns 身份 Markdown 内容
 */
function buildIdentityContent(name: string, personality: string): string {
  const personalityMap: Record<string, string> = {
    严谨: `你是${name}，一个严谨、精确的 AI 助手。
- 回答前先验证事实，不确定时明确标注
- 使用精确的术语，避免模糊表述
- 逻辑链条完整，不跳步`,
    幽默: `你是${name}，一个幽默、风趣的 AI 助手。
- 在准确回答的基础上，适当加入轻松的表达
- 用类比和比喻让复杂概念更易懂
- 幽默不等于不认真，关键问题依然严谨`,
    简洁: `你是${name}，一个简洁、高效的 AI 助手。
- 回答直击要点，不废话
- 能用一句话说清的不用一段话
- 列表优先于长段落`,
  };

  return (
    personalityMap[personality] ??
    `你是${name}，一个友好、注重事实的 AI 助手。
- 优先基于事实回答
- 不确定时明确说明
- 简洁清晰，避免冗余`
  );
}

/**
 * 模式 2：交互式生成用户级 agent-config/
 *
 * 在用户目录（~/.memora/agent-config/）下生成 identities/ + rules/，
 * 用户可随时手动编辑这些文件来自定义 Agent。
 *
 * 流程：3 个交互问题 → 生成配置文件 → 输出路径提示
 */
async function generateUserConfig(): Promise<void> {
  console.log('\n🧠 Memora 用户配置向导');
  console.log('将为你生成专属的 Agent 配置，存放在 ~/.memora/agent-config/\n');

  // 1. 交互式问答
  const agentName = await promptUser('你的 Agent 叫什么名字？', 'Memora');
  const purpose = await promptUser('它主要帮你做什么？', '日常对话');
  const personality = await promptUser('你希望它有什么性格？', '简洁');

  // 2. 确定目标目录：~/.memora/agent-config/
  const memoraHome = resolve(homedir(), '.memora');
  const configDir = join(memoraHome, 'agent-config');

  // 3. 创建目录结构
  await mkdir(join(configDir, 'identities'), { recursive: true });
  await mkdir(join(configDir, 'rules'), { recursive: true });
  await mkdir(join(configDir, 'skills'), { recursive: true });

  // 4. 使用 FileStore 写入身份文件
  const fileStore = new FileStore(configDir);

  // 写身份（identities/ 目录）
  const identityContent = buildIdentityContent(agentName, personality);
  const identityMemory = makeDefaultMemory('personality', agentName, identityContent);
  await fileStore.write(identityMemory);

  // 写规则（rules/ 目录）
  const purposeRules = buildPurposeRules(purpose);
  const purposeRuleMemory = makeDefaultMemory('rule', `${purpose}规则`, purposeRules, 'always');
  await fileStore.write(purposeRuleMemory);

  // 写核心安全规则（所有模式必备）
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

  // 5. 输出结果
  console.log(`\n✅ 用户配置生成完成！`);
  console.log(`\n配置目录：${configDir}`);
  console.log(`\n生成的文件：`);
  console.log(`  identities/${agentName}.md     ← 身份设定（${personality}风格）`);
  console.log(`  rules/${purpose}规则.md         ← ${purpose}相关规则`);
  console.log(`  rules/core.md                  ← 核心安全规则`);
  console.log(`  skills/                        ← 技能目录（可按需添加）`);
  console.log(`\n下一步：`);
  console.log(`  1. 编辑 ${configDir}/identities/${agentName}.md 微调身份`);
  console.log(`  2. 编辑 ${configDir}/rules/ 添加更多规则`);
  console.log(`  3. 使用以下代码启动 Agent：`);
  console.log(`
  import { Agent } from 'memora';
  const agent = new Agent({
    configDir: '${configDir.replace(/\\/g, '/')}',
    projectPath: process.cwd(),
    config: { llm: { ... }, memory: { dataDir: '~/.memora' } },
  });
  await agent.init();`);
}

/**
 * 生成 agent-config/ 目录（领域模板模式）
 * 使用 FileStore 写入记忆文件，保持与运行时一致的 frontmatter 格式
 */
async function generateAgentConfig(projectPath: string, domainId: string): Promise<DomainTemplate> {
  const template = getTemplate(domainId);
  if (!template) {
    const available = getTemplateIds().join(', ');
    throw configError(`未知领域 "${domainId}"`, `可用领域: ${available}`, [
      '使用 memora init --domain <name> 指定领域',
      '不指定 --domain 则只生成 .memora/ 骨架',
    ]);
  }

  const configDir = join(projectPath, 'agent-config');
  // 创建子目录（FileStore.write 会自动创建，这里预创建确保目录结构可见）
  await mkdir(join(configDir, 'identities'), { recursive: true });
  await mkdir(join(configDir, 'rules'), { recursive: true });
  await mkdir(join(configDir, 'skills'), { recursive: true });
  await mkdir(join(configDir, 'tools'), { recursive: true });

  const fileStore = new FileStore(configDir);

  // 写身份（personality 类型 → identities/ 目录，由 TYPE_TO_DIR_MAP 映射）
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
        if (chunk.type === 'text') {
          process.stdout.write(chunk.content);
        }
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
  /** 用户模式：在用户目录下生成交互式配置（模式 2） */
  user?: boolean;
}

/**
 * 执行 init 命令
 *
 * 三种模式：
 *   1. 无参数：生成 .memora/ 运行时骨架（默认行为，保持兼容）
 *   2. --domain <name>：生成 agent-config/ + agentBridge.js + .memora/ 全套（模式 1）
 *   3. --user：交互式生成用户级 agent-config/（模式 2）
 */
export async function initCommand(options: InitOptions): Promise<void> {
  const projectPath = options.project ?? process.cwd();
  const memoraDir = join(projectPath, '.memora');

  if (options.user) {
    // ── 模式 2：用户自定义 ──────────────────────
    logger.info('使用用户自定义模式初始化');
    await generateUserConfig();
  } else if (options.domain) {
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
    console.log(`    identities/${template.id}.md    ← 身份设定（${template.name}）`);
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
    console.log(`  2. 编辑 agent-config/identities/${template.id}.md 微调身份`);
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
    console.log(`  2. 编辑 .memora/identities/default.md 自定义身份`);
    console.log(`  3. 运行 \`memora\` 开始对话`);
  }
}
