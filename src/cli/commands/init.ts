/**
 * init 命令
 * 初始化项目：生成 personality.md / rules/ / .memora/ 目录结构
 *
 * T-102 修复：使用 FileStore 抽象写入记忆（不再直接调 mkdir/writeFile）
 * T-104 修复：读取项目根 config.example.json 拷贝到 .memora/config.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../logging/logger.js';
import { FileStore } from '../../memory/store.js';
import { MemoryType, type Memory, type MemoryTypeValue } from '../../memory/types.js';

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

export async function initCommand(options: { project?: string }): Promise<void> {
  const projectPath = options.project ?? process.cwd();
  const memoraDir = join(projectPath, '.memora');

  logger.info({ projectPath }, '初始化 Memora 项目');

  // 1. 创建记忆子目录（FileStore.write 会自动建，但 topics/archive 不会被 init 写入，需手动建）
  for (const type of Object.values(MemoryType) as MemoryTypeValue[]) {
    await mkdir(join(memoraDir, TYPE_TO_DIR[type]), { recursive: true });
  }
  for (const dir of EXTRA_DIRS) {
    await mkdir(join(memoraDir, dir), { recursive: true });
  }

  // 2. 用 FileStore 写默认人格（走抽象，规范化 frontmatter）
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

  // 3. 用 FileStore 写默认规则
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

  // 4. 拷贝 config.example.json 到 .memora/config.json
  // T-104：避免硬编码配置字段，两处维护风险
  try {
    const exampleConfig = await readFile(CONFIG_EXAMPLE_PATH, 'utf-8');
    await writeFile(join(memoraDir, 'config.json'), exampleConfig, 'utf-8');
  } catch (err) {
    // 兜底：找不到 config.example.json 时用最小默认配置
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

  console.log(`✅ Memora 项目初始化完成：${projectPath}`);
  console.log('\n下一步：');
  console.log('  1. 编辑 .memora/config.json 配置你的 LLM');
  console.log('  2. 编辑 .memora/personality/default.md 自定义人格');
  console.log('  3. 运行 `memora` 开始对话');
}
