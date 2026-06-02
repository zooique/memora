/**
 * init 命令
 * 初始化项目：生成 personality.md / rules/ / .memora/ 目录结构
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../logging/logger.js';

const DEFAULT_PERSONALITY = `---
type: personality
permanence: always
name: default
tags: personality, default
weight: 1.0
createdAt: 2026-06-02T00:00:00.000Z
updatedAt: 2026-06-02T00:00:00.000Z
---

# 默认人格

你是一个友好、严谨、注重事实的 AI 助手。
- 优先基于事实回答
- 不确定时明确说明
- 简洁清晰，避免冗余
- 遵守用户给出的规则
`;

const DEFAULT_RULE = `---
type: rule
permanence: always
name: core
tags: rule, core
weight: 1.0
createdAt: 2026-06-02T00:00:00.000Z
updatedAt: 2026-06-02T00:00:00.000Z
---

# 核心规则

- **诚实优先**：不知道就说不知道，不要编造
- **隐私保护**：不要向外部泄露用户的个人信息和文件内容
- **工具安全**：调用工具前确认路径在白名单内
- **可追溯**：所有写操作记录到日志
`;

export async function initCommand(options: { project?: string }): Promise<void> {
  const projectPath = options.project ?? process.cwd();
  const memoraDir = join(projectPath, '.memora');

  logger.info({ projectPath }, '初始化 Memora 项目');

  // 创建目录结构
  await mkdir(join(memoraDir, 'personality'), { recursive: true });
  await mkdir(join(memoraDir, 'rules'), { recursive: true });
  await mkdir(join(memoraDir, 'skills'), { recursive: true });
  await mkdir(join(memoraDir, 'tools'), { recursive: true });
  await mkdir(join(memoraDir, 'topics'), { recursive: true });
  await mkdir(join(memoraDir, 'archive'), { recursive: true });
  await mkdir(join(memoraDir, 'logs'), { recursive: true });

  // 默认配置
  const config = {
    llm: {
      provider: 'mock',
      model: 'mock-model',
      temperature: 0.7,
    },
    memory: {
      dataDir: '~/.memora',
      maxContextTokens: 120000,
    },
    security: {
      permission: 'owner',
      confirmWrites: false,
    },
    allowedPaths: [],
  };
  await writeFile(join(memoraDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');

  // 默认人格
  await writeFile(join(memoraDir, 'personality', 'default.md'), DEFAULT_PERSONALITY, 'utf-8');

  // 默认规则
  await writeFile(join(memoraDir, 'rules', 'core.md'), DEFAULT_RULE, 'utf-8');

  console.log(`✅ Memora 项目初始化完成：${projectPath}`);
  console.log('\n下一步：');
  console.log('  1. 编辑 .memora/config.json 配置你的 LLM');
  console.log('  2. 编辑 .memora/personality/default.md 自定义人格');
  console.log('  3. 运行 `memora` 开始对话');
}
