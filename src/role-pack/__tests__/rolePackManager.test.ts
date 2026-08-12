/**
 * RolePackManager 端到端测试（M2.1：嵌套 YAML + 双形态扫描 + 合规字段）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolePackManager } from '@/role-pack/rolePackManager.js';

/** 单文件最小形态（新格式：嵌套 YAML + camelCase + 合规字段） */
const SINGLE_FILE_PACK = `---
name: 翻译助手
formatVersion: 1.0.0
description: 中英互译
keywords: [翻译, 英译中]
author: memora
interactionType: tool_assistant
aiIdentityDisclosure: true
strategy:
  act:
    toolMode: block
    temperature: 0.1
---
## Persona

你是一位专业翻译。

## Rules

- 保持原文语义
`;

/** 文件夹包完整形态 */
const FOLDER_PACK = `---
name: 技术文档工程师
formatVersion: 1.0.0
description: 技术文档写作
keywords: [文档, API]
author: memora
interactionType: tool_assistant
strategy:
  prepare:
    contextAssembly: fixed
  reflect:
    handoff: wait
skills:
  - capability: llm:summarize
    description: 提炼要点
---
## Persona

你是一位技术文档工程师。
`;

/** 旧格式点号命名法（兼容降级） */
const LEGACY_PACK = `---
name: 项目总监
description: 项目管理
keywords: [项目, 进度]
strategy.act.tool_calls: allow
strategy.prepare.context_assembly: hybrid
---
## Persona

你是一位项目总监。
`;

describe('RolePackManager（M2.1 嵌套 YAML + 双形态）', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rolepack-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('扫描单文件最小形态：解析嵌套 strategy + 合规字段默认值', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writeFile(join(packsDir, '翻译助手.md'), SINGLE_FILE_PACK, 'utf-8');

    const manager = new RolePackManager(dir);
    const count = await manager.load();

    expect(count).toBe(1);
    const active = manager.getActive();
    expect(active).not.toBeNull();
    expect(active!.meta.name).toBe('翻译助手');
    expect(active!.meta.formatVersion).toBe('1.0.0');
    // 合规字段默认值
    expect(active!.meta.interactionType).toBe('tool_assistant');
    expect(active!.meta.aiIdentityDisclosure).toBe(true);
    expect(active!.meta.minorProtection).toBe('required');
    // 嵌套 strategy
    const act = active!.strategy.act as Record<string, unknown>;
    expect(act['toolMode']).toBe('block');
    expect(act['temperature']).toBe(0.1);
    // L1 内容
    expect(active!.personaPrompt).toContain('专业翻译');
    expect(active!.personaPrompt).toContain('保持原文语义');
    expect(active!.capabilities).toEqual([]);
  });

  it('扫描文件夹包完整形态：role-pack.md 入口 + capabilities 解析', async () => {
    const packDir = join(dir, 'role-packs', '技术文档工程师');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'role-pack.md'), FOLDER_PACK, 'utf-8');

    const manager = new RolePackManager(dir);
    const count = await manager.load();

    expect(count).toBe(1);
    const active = manager.getActive();
    expect(active!.meta.name).toBe('技术文档工程师');
    // capabilities 从 frontmatter.skills 解析
    expect(active!.capabilities).toEqual([
      { capability: 'llm:summarize', description: '提炼要点' },
    ]);
    // 嵌套 strategy（prepare.contextAssembly）
    const prepare = active!.strategy.prepare as Record<string, unknown>;
    expect(prepare['contextAssembly']).toBe('fixed');
  });

  it('文件夹包内非 role-pack.md 文件不误扫', async () => {
    const packDir = join(dir, 'role-packs', '技术文档工程师');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'role-pack.md'), FOLDER_PACK, 'utf-8');
    await writeFile(join(packDir, 'notes.md'), '## 内部笔记\n', 'utf-8');

    const manager = new RolePackManager(dir);
    expect(await manager.load()).toBe(1);
  });

  it('兼容旧格式点号命名法（warn 降级）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writeFile(join(packsDir, '项目总监.md'), LEGACY_PACK, 'utf-8');

    const manager = new RolePackManager(dir);
    const count = await manager.load();

    expect(count).toBe(1);
    const active = manager.getActive();
    // 点号 → camelCase 转换
    const act = active!.strategy.act as Record<string, unknown>;
    expect(act['toolCalls']).toBe('allow');
    const prepare = active!.strategy.prepare as Record<string, unknown>;
    expect(prepare['contextAssembly']).toBe('hybrid');
    // 旧格式无 formatVersion → 默认 1.0.0
    expect(active!.meta.formatVersion).toBe('1.0.0');
  });

  it('双形态混合加载：单文件 + 文件夹包共存', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writeFile(join(packsDir, '翻译助手.md'), SINGLE_FILE_PACK, 'utf-8');
    const packDir = join(packsDir, '技术文档工程师');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'role-pack.md'), FOLDER_PACK, 'utf-8');

    const manager = new RolePackManager(dir);
    const count = await manager.load();
    expect(count).toBe(2);

    const names = manager.listMeta().map((m) => m.name).sort();
    expect(names).toEqual(['技术文档工程师', '翻译助手']);
  });

  it('reload 保持激活态', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writeFile(join(packsDir, '翻译助手.md'), SINGLE_FILE_PACK, 'utf-8');
    await writeFile(join(packsDir, '项目总监.md'), LEGACY_PACK, 'utf-8');

    const manager = new RolePackManager(dir);
    await manager.load();
    manager.activate('项目总监');
    expect(manager.activeName).toBe('项目总监');

    await manager.reload();
    expect(manager.activeName).toBe('项目总监');
    expect(manager.getActive()!.meta.name).toBe('项目总监');
  });
});
