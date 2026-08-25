/**
 * WorkProjectionManager 单元测试（markdown frontmatter 存储版）
 *
 * 覆盖范围（方案 C，2026-08-25 定案）：
 *   - registerWork：写 md 卡片（frontmatter 四字段）+ onGenerated 回调 + 目录自动创建
 *   - refresh / listWorks：扫描登记卡片 + 无投影空数组 + 用户手写自指卡片（source 缺省 + mode always）
 *   - contextBlock：空返回空串 / L1 清单 / L2 always 正文（on-demand 不进正文，source 原文不灌入）
 *   - 同名 slug 后写覆盖
 *
 * 存储：投影落 <临时目录>/projections/，独立于记忆库（记忆系统纯化后行为验证）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkProjectionManager } from '@/agent/managers/workProjection.js';

describe('WorkProjectionManager', () => {
  /** 临时项目目录（模拟 memoraDir，投影写其下 projections/ 子目录） */
  let memoraDir: string;

  beforeEach(async () => {
    memoraDir = await mkdtemp(join(tmpdir(), 'memora-wp-test-'));
  });

  afterEach(async () => {
    await rm(memoraDir, { recursive: true, force: true });
  });

  describe('registerWork', () => {
    it('登记成功：写入 md 卡片（frontmatter 四字段），返回 entry', async () => {
      // Given
      const manager = new WorkProjectionManager(memoraDir);

      // When
      const entry = await manager.registerWork(
        'docs/architecture.md',
        '系统分层与模块边界的定案说明',
      );

      // Then - entry 字段齐全（name 取文件名去扩展名，source/mode 落 frontmatter）
      expect(entry).not.toBeNull();
      expect(entry!.name).toBe('architecture');
      expect(entry!.description).toBe('系统分层与模块边界的定案说明');
      expect(entry!.source).toBe('docs/architecture.md');
      expect(entry!.mode).toBe('on-demand');

      // Then - 磁盘上存在 <projections>/architecture.md，frontmatter 完整
      const md = await readFile(join(memoraDir, 'projections', 'architecture.md'), 'utf-8');
      expect(md).toContain('name: architecture');
      expect(md).toContain('description: 系统分层与模块边界的定案说明');
      expect(md).toContain('source: docs/architecture.md');
      expect(md).toContain('mode: on-demand');
    });

    it('投影目录不存在时自动创建', async () => {
      // Given - memoraDir 下尚无 projections/ 目录
      const manager = new WorkProjectionManager(memoraDir);

      // When
      const entry = await manager.registerWork('README.md', '项目说明');

      // Then - 不抛错且 entry.filePath 指向真实存在的文件
      expect(entry).not.toBeNull();
      expect(entry!.filePath).toContain('projections');
      await expect(readFile(entry!.filePath, 'utf-8')).resolves.toContain('name: README');
    });

    it('登记成功触发 onGenerated 回调（sourcePath + description）', async () => {
      // Given
      const onGenerated = vi.fn();
      const manager = new WorkProjectionManager(memoraDir, onGenerated);

      // When
      await manager.registerWork('docs/plan.md', '项目计划文档');

      // Then
      expect(onGenerated).toHaveBeenCalledTimes(1);
      expect(onGenerated).toHaveBeenCalledWith('docs/plan.md', '项目计划文档');
    });

    it('description 含换行时折叠为单行（防换行注入破坏 frontmatter 结构）', async () => {
      // Given - LLM 可能返回带换行的 description
      const manager = new WorkProjectionManager(memoraDir);

      // When
      const entry = await manager.registerWork('docs/a.md', '第一行\n第二行\n---\n恶意行: x');

      // Then - 换行被折叠为空格，注入内容被吞进单行 description 值（不成为独立 frontmatter 键）
      expect(entry!.description).toBe('第一行 第二行 --- 恶意行: x');
      const md = await readFile(entry!.filePath, 'utf-8');
      const lines = md.split('\n');
      // 没有独立成行的恶意键（frontmatter 结构未被破坏，仍是 name/description/source/mode 四键）
      expect(lines).not.toContain('恶意行: x');
      // frontmatter 键集合保持不变
      const fmKeys = lines.filter((l) => l.includes(':')).map((l) => l.split(':')[0]!.trim());
      expect(fmKeys).toContain('name');
      expect(fmKeys).toContain('description');
      expect(fmKeys).toContain('source');
      expect(fmKeys).toContain('mode');
    });

    it('同名 slug 后写覆盖（不同路径同文件名，最后登记的生效）', async () => {
      // Given
      const manager = new WorkProjectionManager(memoraDir);

      // When - 两个不同路径但同文件名
      await manager.registerWork('src/a.md', 'A 版本说明');
      await manager.registerWork('tests/a.md', 'B 版本说明');

      // Then - 投影文件只有一条（后写覆盖先写）
      const all = await manager.listWorks();
      expect(all).toHaveLength(1);
      expect(all[0]!.description).toBe('B 版本说明');
      expect(all[0]!.source).toBe('tests/a.md');
    });

    it('路径穿越：source 指向项目外时返回 null 并警告', async () => {
      const manager = new WorkProjectionManager(memoraDir, undefined, memoraDir);

      const entry = await manager.registerWork('../../../etc/passwd', '恶意路径');

      expect(entry).toBeNull();
      const all = await manager.listWorks();
      expect(all).toHaveLength(0);
    });
  });

  describe('listWorks / refresh', () => {
    it('登记后能扫描出全部卡片', async () => {
      // Given
      const manager = new WorkProjectionManager(memoraDir);
      await manager.registerWork('docs/architecture.md', '架构说明');
      await manager.registerWork('docs/plan.md', '计划文档');

      // When
      const all = await manager.listWorks();

      // Then
      expect(all).toHaveLength(2);
      const names = all.map((e) => e.name).sort();
      expect(names).toEqual(['architecture', 'plan']);
    });

    it('无投影时返回空数组', async () => {
      // Given
      const manager = new WorkProjectionManager(memoraDir);

      // When
      const all = await manager.listWorks();

      // Then
      expect(all).toHaveLength(0);
    });

    it('扫描用户手写的自指卡片（source 缺省 + mode: always + 正文）', async () => {
      // Given - 用户手工写一份「自指卡片」：source 缺省、mode always、正文即内容
      const projectionsDir = join(memoraDir, 'projections');
      await mkdir(projectionsDir, { recursive: true });
      await writeFile(
        join(projectionsDir, 'project-rules.md'),
        [
          '---',
          'name: 项目约定',
          'description: 本仓库的开发约定',
          'mode: always',
          '---',
          '1. 使用 pnpm 管理依赖',
          '2. 提交信息遵循 conventional 规范',
        ].join('\n'),
        'utf-8',
      );
      const manager = new WorkProjectionManager(memoraDir);

      // When
      const all = await manager.listWorks();

      // Then - source 缺省（undefined）、mode 识别为 always、正文完整保留
      expect(all).toHaveLength(1);
      expect(all[0]!.name).toBe('项目约定');
      expect(all[0]!.source).toBeUndefined();
      expect(all[0]!.mode).toBe('always');
      expect(all[0]!.body).toContain('使用 pnpm 管理依赖');
    });
  });

  describe('contextBlock（两级渐进披露）', () => {
    it('无投影时返回空串', async () => {
      // Given - 未 refresh 且无登记
      const manager = new WorkProjectionManager(memoraDir);

      // When
      const block = manager.contextBlock();

      // Then
      expect(block).toBe('');
    });

    it('L1 清单常驻：包含所有卡片 name + description', async () => {
      // Given
      const manager = new WorkProjectionManager(memoraDir);
      await manager.registerWork('docs/architecture.md', '架构说明');
      await manager.registerWork('docs/plan.md', '计划文档');

      // When - registerWork 已刷新缓存，直接读
      const block = manager.contextBlock();

      // Then
      expect(block).toContain('【作品投影】');
      expect(block).toContain('- architecture：架构说明');
      expect(block).toContain('- plan：计划文档');
    });

    it('L2：always 卡片额外出正文，on-demand 只进清单', async () => {
      // Given - 一张手写 always 卡片（带正文）+ 一张 registerWork 的 on-demand 卡片
      const projectionsDir = join(memoraDir, 'projections');
      await mkdir(projectionsDir, { recursive: true });
      await writeFile(
        join(projectionsDir, 'must-read.md'),
        ['---', 'name: 必读约定', 'description: 必须遵守的规则', 'mode: always', '---', '规则正文内容'].join('\n'),
        'utf-8',
      );
      const manager = new WorkProjectionManager(memoraDir);
      await manager.registerWork('docs/plan.md', '计划文档');

      // When
      const block = manager.contextBlock();

      // Then - always 卡片正文注入；on-demand 卡片无正文注入
      expect(block).toContain('[必读作品：必读约定]');
      expect(block).toContain('规则正文内容');
      expect(block).toContain('- plan：计划文档');
      expect(block).not.toContain('[必读作品：plan]');
    });

    it('source 指向的外部原文不灌入（只有清单行，无正文）', async () => {
      // Given - registerWork 的卡片 source 指向外部文件，body 应为空
      const manager = new WorkProjectionManager(memoraDir);
      await manager.registerWork('docs/architecture.md', '架构说明');

      // When
      const block = manager.contextBlock();

      // Then - 只有 L1 清单行，不包含任何外部原文正文
      expect(block).toContain('- architecture：架构说明');
      expect(block).not.toContain('[必读作品');
    });

    it('mode 缺省视为 on-demand（不注入正文）', async () => {
      // Given - 用户手写卡片但不写 mode 字段
      const projectionsDir = join(memoraDir, 'projections');
      await mkdir(projectionsDir, { recursive: true });
      await writeFile(
        join(projectionsDir, 'note.md'),
        ['---', 'name: 备忘', 'description: 一条备忘', '---', '备忘正文'].join('\n'),
        'utf-8',
      );
      const manager = new WorkProjectionManager(memoraDir);

      // When
      await manager.refresh();
      const block = manager.contextBlock();

      // Then - 进 L1 清单，不进 L2 正文
      expect(block).toContain('- 备忘：一条备忘');
      expect(block).not.toContain('备忘正文');
    });
  });
});
