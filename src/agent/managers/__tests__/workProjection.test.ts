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

      manager = new WorkProjectionManager(
        memoraDir,
        (src, desc) => {
          callbackCalled = true;
          callbackSource = src;
          callbackDesc = desc;
        },
        projectDir,
      );

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

  describe('registerWork upsert（保留未知字段）', () => {
    it('命中同 source 时保留既有条目的未知字段，只覆盖 name/description', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');
      // 模拟另一写入方（如后续常驻层）已落盘的字段
      await fs.writeFile(
        filePath,
        JSON.stringify([
          {
            name: 'architecture',
            description: '旧描述',
            source: 'docs/architecture.md',
            resident: true, // 未知于当前接口的扩展字段（定稿里的 resident 标记）
            'x-extra': 'keep-me', // 任意未来字段：整条替换会静默丢弃它
          },
        ]),
      );

      const result = await manager.registerWork('docs/architecture.md', '新描述');
      expect(result).not.toBeNull();

      // 断言落盘真相（raw JSON），而非仅看内存对象
      const raw = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Array<
        Record<string, unknown>
      >;
      expect(raw).toHaveLength(1);
      expect(raw[0]).toMatchObject({
        name: 'architecture',
        description: '新描述',
        source: 'docs/architecture.md',
      });
      expect(raw[0]!.resident).toBe(true); // 既有扩展字段保留
      expect(raw[0]!['x-extra']).toBe('keep-me');
    });

    it('新增 source 时既有条目的未知字段同样不被动到', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');
      await fs.writeFile(
        filePath,
        JSON.stringify([{ name: 'a', description: 'A', source: 'a.md', resident: true }]),
      );

      await manager.registerWork('b.md', 'B');

      const raw = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Array<
        Record<string, unknown>
      >;
      expect(raw).toHaveLength(2);
      expect(raw.find((e) => e.source === 'a.md')!.resident).toBe(true);
    });
  });

  describe('registerWork 写路径串行化（进程内按绝对路径互斥）', () => {
    it('两个 manager 实例并发登记不同 source ⇒ 全部落盘，无读-改-写互相覆盖', async () => {
      // 同项目目录的两个会话实例（装配期各建一个）：实例级队列会失效，模块级队列才覆盖
      const managerA = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const managerB = new WorkProjectionManager(memoraDir, undefined, projectDir);

      await Promise.all([
        managerA.registerWork('a.md', 'A'),
        managerB.registerWork('b.md', 'B'),
        managerA.registerWork('c.md', 'C'),
        managerB.registerWork('d.md', 'D'),
      ]);

      const fs = await import('node:fs/promises');
      const raw = JSON.parse(
        await fs.readFile(join(memoraDir, 'work-projections.json'), 'utf-8'),
      ) as Array<{ source: string }>;
      expect(raw.map((e) => e.source).sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    });

    it('同一 source 并发登记 ⇒ 只出一条条目（upsert 幂等），未知字段不丢', async () => {
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');
      await fs.writeFile(
        filePath,
        JSON.stringify([{ name: 'doc', description: '初始', source: 'doc.md', resident: true }]),
      );

      const managerA = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const managerB = new WorkProjectionManager(memoraDir, undefined, projectDir);
      await Promise.all([
        managerA.registerWork('doc.md', '描述一'),
        managerB.registerWork('doc.md', '描述二'),
      ]);

      const raw = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Array<
        Record<string, unknown>
      >;
      expect(raw).toHaveLength(1);
      expect(raw[0]!.resident).toBe(true);
      // 最后一次落盘的描述胜出（两者之一），但条目唯一
      expect(['描述一', '描述二']).toContain(raw[0]!.description);
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
      expect(list.map((e) => e.source).sort()).toEqual(['doc1.md', 'doc2.md']);
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
      // 模拟错形态：{entries:[...]} 而非顶层数组
      await fs.writeFile(
        filePath,
        JSON.stringify({ entries: [{ name: 'x', description: 'y', source: 'z.md' }] }),
      );

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

  describe('isFileMalformed 状态暴露', () => {
    it('初始状态为 false（无文件/格式正常）', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      expect(manager.isFileMalformed).toBe(false);
    });

    it('文件格式错误时被设为 true，刷新恢复后回到 false', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');

      // 写入错形态
      await fs.writeFile(filePath, JSON.stringify({ entries: [{ x: 1 }] }));
      await manager.refresh();
      expect(manager.isFileMalformed).toBe(true);

      // 修正为合法数组
      await fs.writeFile(
        filePath,
        JSON.stringify([{ name: 'a', description: 'b', source: 'c.md' }]),
      );
      await manager.refresh();
      expect(manager.isFileMalformed).toBe(false);
    });

    it('损坏 JSON 被检出时 isFileMalformed 为 true', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');
      await fs.writeFile(filePath, '{ invalid json');
      await manager.refresh();
      expect(manager.isFileMalformed).toBe(true);
    });

    it('调用方可通过 isFileMalformed 区分「空项目」与「格式错误」', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');

      // 场景 1：空项目（无文件）
      const list1 = await manager.listWorks();
      expect(list1).toHaveLength(0);
      expect(manager.isFileMalformed).toBe(false); // 空项目，不是格式错误

      // 场景 2：格式错误文件
      await fs.writeFile(filePath, JSON.stringify({ wrong: 'shape' }));
      const list2 = await manager.listWorks();
      expect(list2).toHaveLength(0);
      expect(manager.isFileMalformed).toBe(true); // 格式错误被标记
    });
  });

  describe('loadAndGetContextBlock (SSOT 读取路径)', () => {
    it('刷新并返回装配块，等价于 refresh() + contextBlock()', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      await manager.registerWork('test.md', '测试文档');

      // 用 loadAndGetContextBlock 验证
      const block = await manager.loadAndGetContextBlock();
      expect(block).toContain('【项目索引】');
      expect(block).toContain('测试文档');
      expect(block).toContain('test.md');
    });

    it('外部修改文件后 loadAndGetContextBlock 能读到最新数据', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      // 先登记一条
      await manager.registerWork('old.md', '旧描述');

      // 外部直接写入新条目（模拟用户手改 JSON）
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');
      const externalData = [
        { name: 'old', description: '旧描述', source: 'old.md' },
        { name: 'new', description: '外部新增', source: 'new.md' },
      ];
      await fs.writeFile(filePath, JSON.stringify(externalData));

      // contextBlock() 此时可能仍返回旧缓存（取决于 registerWork 时序）
      // 但 loadAndGetContextBlock() 必须返回最新数据
      const block = await manager.loadAndGetContextBlock();
      expect(block).toContain('外部新增');
      expect(block).toContain('new.md');
    });

    it('文件不存在时返回空串且不抛异常', async () => {
      manager = new WorkProjectionManager(memoraDir);
      const block = await manager.loadAndGetContextBlock();
      expect(block).toBe('');
    });

    it('文件格式错误时返回空串且不抛异常（容错）', async () => {
      manager = new WorkProjectionManager(memoraDir, undefined, projectDir);
      const fs = await import('node:fs/promises');
      const filePath = join(memoraDir, 'work-projections.json');
      await fs.writeFile(filePath, '{ invalid json');

      // 不应抛出
      const block = await manager.loadAndGetContextBlock();
      expect(block).toBe('');
      expect(manager.isFileMalformed).toBe(true);
    });
  });
});
