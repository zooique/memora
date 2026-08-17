/**
 * 单元测试：记忆加载器
 * 验证文件 → 索引同步、frontmatter 解析、启动加载流程
 *
 * 设计收敛（ADR-025 · memory-role-pack-boundary）：
 * 设定记忆（persona/rule/skill）唯一归角色包内容层，guardrail 空转链已摘除，
 * loader 不再扫描任何配置类记忆（STARTUP_SCAN_SOURCES 为空）。
 * 记忆系统只剩 round-summary（由 RoundSummaryGenerator 直接写入，不经 loader 扫描）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { FileStore } from '@/memory/store.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { MemoryLoader } from '@/memory/loader.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('MemoryLoader · 设定记忆不再扫描（ADR-025）', () => {
  let dataDir: string;
  let fileStore: FileStore;
  let index: IMemoryStorage;
  let loader: MemoryLoader;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memora-loader-'));
    // 创建记忆目录结构（存量目录，loader 不应再扫描）
    mkdirSync(join(dataDir, 'personas'), { recursive: true });
    mkdirSync(join(dataDir, 'rules'), { recursive: true });
    mkdirSync(join(dataDir, 'skills'), { recursive: true });

    fileStore = new FileStore(dataDir);
    index = new InMemoryStorage();
    loader = new MemoryLoader(fileStore, index);
  });

  afterEach(async () => {
    await index.close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('不应扫描任何配置类记忆（persona/rule/skill 均不进索引）', async () => {
    // 写入存量配置文件——loader 不应把它们加载进索引
    writeFileSync(
      join(dataDir, 'personas/default.md'),
      `---
source: persona
name: default
score: 1.0
createdAt: 2026-06-02T00:00:00.000Z
accessedAt: 2026-06-02T00:00:00.000Z
---

# 默认人格
诚实、简洁。
`,
      'utf-8',
    );
    writeFileSync(
      join(dataDir, 'rules/core.md'),
      `---
source: rule
name: core
score: 1.0
createdAt: 2026-06-02T00:00:00.000Z
accessedAt: 2026-06-02T00:00:00.000Z
---

# 核心规则
- 诚实
`,
      'utf-8',
    );

    const result = await loader.loadAllToIndex();
    // STARTUP_SCAN_SOURCES 为空——设定记忆不再扫描进索引
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('扫描空 source 列表时跳过所有目录（不抛错）', async () => {
    const result = await loader.loadAllToIndex();
    // 所有目录都不扫描 → loaded = 0
    expect(result.loaded).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('bootstrap 应返回空记忆数组（设定记忆不再经 loader 注入）', async () => {
    // 写入存量配置文件——bootstrap 不应返回它们
    writeFileSync(
      join(dataDir, 'rules/coding-style.md'),
      `---
source: rule
name: coding-style
score: 0.8
createdAt: 2026-06-02T00:00:00.000Z
accessedAt: 2026-06-02T00:00:00.000Z
---

# 编码规范
- 命名清晰
`,
      'utf-8',
    );
    writeFileSync(
      join(dataDir, 'skills/writing.md'),
      `---
source: skill
name: writing
score: 0.7
createdAt: 2026-06-02T00:00:00.000Z
accessedAt: 2026-06-02T00:00:00.000Z
---

# 写作技能
- 清晰表达
`,
      'utf-8',
    );

    const { memories, loadResult } = await loader.bootstrap();
    expect(loadResult.loaded).toBe(0); // 设定记忆不进索引
    expect(memories).toHaveLength(0); // bootstrap 返回空——设定记忆由角色包路径接管
  });

  it('list 不存在的类型目录时应跳过（不抛错）', async () => {
    // skills 目录不存在，list 应返回 []（通过 existsSync 检查）
    rmSync(join(dataDir, 'skills'), { recursive: true, force: true });

    const result = await loader.loadAllToIndex();
    expect(result.loaded).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
