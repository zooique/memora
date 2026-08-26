/**
 * 作品投影管理器测试（JSON 单文件极简版）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkProjectionManager } from '../workProjection.js';
import { logger } from '@/logging/logger.js';

describe('WorkProjectionManager (JSON 单文件)', () => {
  let memoraDir: string;
  let projectDir: string;
  let manager: WorkProjectionManager;

  beforeEach(async () => {
    // 创建临时目录作为 memoraDir
    memoraDir = await mkdtemp(join(tmpdir(), 'memora-test-'));
    projectDir = await mkdtemp(join(tmpdir(), 'project-test-'));
  });

  afterEach(async () => {
    // 恢复 mock（如 logger.warn spy）
    vi.restoreAllMocks();
    // 清理临时目录
    if (memoraDir) await rm(memoraDir, { recursive: true, force: true });
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  describe('registerWork', () => {
    it('成功登记作品索引', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const result = await manager.registerWork('docs/architecture.md', '系统分层设计');
      
      expect(result).not.toBeNull();
      expect(result!.name).toBe('architecture');
      expect(result!.description).toBe('系统分层设计');
      expect(result!.source).toBe('docs/architecture.md');
    });

    it('登记后触发 onGenerated 回调', async () => {
      let callbackCalled = false;
      let callbackSource = '';
      let callbackDesc = '';
      
      manager = new WorkProjectionManager(memoraDir, (src, desc) => {
        callbackCalled = true;
        callbackSource = src;
        callbackDesc = desc;
      }, projectDir);
      
      await manager.registerWork('src/index.ts', '入口文件');
      
      expect(callbackCalled).toBe(true);
      expect(callbackSource).toBe('src/index.ts');
      expect(callbackDesc).toBe('入口文件');
    });

    it('同一 source 再次登记时覆盖旧记录', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      await manager.registerWork('docs/api.md', '旧描述');
      await manager.registerWork('docs/api.md', '新描述');
      
      const list = await manager.listWorks();
      expect(list).toHaveLength(1);
      expect(list[0]!.description).toBe('新描述');
    });

    it('描述中的换行被清理', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const result = await manager.registerWork('test.md', '第一行\n第二行');
      
      expect(result!.description).toBe('第一行 第二行');
    });

    it('过长描述被截断到上限并加省略号（防 system prompt 膨胀）', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const longDesc = '关'.repeat(150); // 远超 100 字上限
      const result = await manager.registerWork('long.md', longDesc);

      expect(result!.description.length).toBe(101); // 100 字 + '…'
      expect(result!.description.endsWith('…')).toBe(true);
      // 截断后不应再包含超长原文尾部特征
      expect(result!.description).not.toBe(longDesc);
    });
  });

  describe('路径穿越防御', () => {
    it('source 指向项目外时返回 null', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const result = await manager.registerWork('../../../etc/passwd', '恶意路径');
      
      expect(result).toBeNull();
      
      // 验证没有被保存
      const list = await manager.listWorks();
      expect(list).toHaveLength(0);
    });
  });

  describe('refresh & listWorks', () => {
    it('加载空文件时返回空数组', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const list = await manager.listWorks();
      expect(list).toHaveLength(0);
    });

    it('加载已登记的作品', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      await manager.registerWork('doc1.md', '文档一');
      await manager.registerWork('doc2.md', '文档二');
      
      // 重新创建 manager 模拟重启
      const newManager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const list = await newManager.listWorks();
      
      expect(list).toHaveLength(2);
      expect(list.map(e => e.source).sort()).toEqual(['doc1.md', 'doc2.md']);
    });

    it('过滤无效条目（缺少必要字段）', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      await manager.registerWork('valid.md', '有效');
      
      // 手动写入一个无效条目
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');
      const invalidData = [
        { name: '有效文档', description: '测试', source: 'valid.md' },
        { name: '无效文档' }, // 缺少 source
      ];
      await fs.writeFile(filePath, JSON.stringify(invalidData));
      
      const list = await manager.listWorks();
      expect(list).toHaveLength(1);
      expect(list[0]!.source).toBe('valid.md');
    });

    it('非数组根（如 {"entries":[...]} 错形态）被忽略并告警，不静默吞入', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');
      // 模拟照旧文档手写出的错形态
      await fs.writeFile(filePath, JSON.stringify({ entries: [{ name: 'x', description: 'y', source: 'z.md' }] }));

      const warnSpy = vi.spyOn(logger, 'warn');
      const list = await manager.listWorks();

      expect(list).toHaveLength(0); // 错形态不被当作有效索引
      expect(warnSpy).toHaveBeenCalled(); // 且显式告警，而非静默清空（防覆盖丢数据）
    });
  });

  describe('contextBlock', () => {
    it('无作品时返回空字符串', async () => {
      manager = new WorkProjectionManager(memoraDir);
      const block = manager.contextBlock();
      expect(block).toBe('');
    });

    it('返回格式化的索引清单', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      await manager.registerWork('docs/arch.md', '架构说明');
      
      const block = manager.contextBlock();
      
      expect(block).toContain('【项目索引】');
      expect(block).toContain('架构说明');
      expect(block).toContain('docs/arch.md');
      expect(block).toContain('read_file');
    });
  });

  describe('registerWork 写路径容错（防覆盖丢失）', () => {
    it('预存 {"entries":[...]} 错形态时 registerWork 不覆盖原文件且返回 null', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');
      const original = { entries: [{ name: 'x', description: 'y', source: 'z.md' }] };
      await fs.writeFile(filePath, JSON.stringify(original));

      const warnSpy = vi.spyOn(logger, 'warn');
      const result = await manager.registerWork('new.md', '新描述');

      expect(result).toBeNull(); // fail-safe 中止，不写盘
      expect(warnSpy).toHaveBeenCalled();
      // 原文件未被覆盖
      const after = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(after).toEqual(original);
    });

    it('预存损坏 JSON 时 registerWork 同样不覆盖原文件', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');
      const original = '{ this is not valid json';
      await fs.writeFile(filePath, original);

      const result = await manager.registerWork('new.md', '新描述');

      expect(result).toBeNull();
      const after = await fs.readFile(filePath, 'utf-8');
      expect(after).toBe(original); // 原损坏内容保留，不擅自改写
    });
  });
});