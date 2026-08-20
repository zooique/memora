/**
 * WorkProjectionManager 单元测试（文件存储版）
 *
 * 覆盖范围：
 *   - 首次读取 → 生成投影并写入项目目录文件
 *   - hash 未变 → 跳过（不重复调 LLM）
 *   - hash 变更 → 重新生成（同文件原子覆盖）
 *   - LLM 失败降级
 *   - schema 校验（summary / structure / keyDecisions）
 *   - loadAll / getProjection 查询（真实文件系统）
 *   - 内容截断边界 / JSON 字段缺失降级
 *   - inflight 并发缓存 / awaitInflight
 *   - fileName 推导 / slug 冲突
 *
 * 存储：投影落 <临时目录>/projections/，独立于记忆库（记忆系统纯化后行为验证）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import type { LlmProvider, Message } from '@/llm/provider.js';

/** 创建 Mock LLM Provider（预设返回 JSON） */
const createMockProvider = (response: string): LlmProvider =>
  ({
    name: 'mock',
    chat: vi.fn(async function* (_messages: Message[]) {
      yield { content: response, done: false };
      yield { content: '', done: true };
    }),
  }) as unknown as LlmProvider;

describe('WorkProjectionManager', () => {
  /** 临时项目目录（模拟 memoraDir，投影写其下 projections/ 子目录） */
  let memoraDir: string;

  beforeEach(async () => {
    memoraDir = await mkdtemp(join(tmpdir(), 'memora-wp-test-'));
  });

  afterEach(async () => {
    await rm(memoraDir, { recursive: true, force: true });
  });

  describe('ensureProjection', () => {
    it('应该在首次读取时生成投影并写入项目目录', async () => {
      // Given
      const mockResponse = JSON.stringify({
        summary: '一个关于成长与选择的故事',
        structure: ['第一章 起源', '第二章 抉择', '第三章 归宿'],
        keyDecisions: ['萧然选择救人而非复仇'],
      });

      const provider = createMockProvider(mockResponse);
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When
      const result = await manager.ensureProjection(
        '/project/novel/chapter-001.md',
        '# 第一章\n\n萧然站在悬崖边...',
        'chapter-001.md',
      );

      // Then
      expect(result).not.toBeNull();
      expect(result!.summary).toContain('成长与选择');
      expect(result!.structure).toHaveLength(3);
      expect(result!.keyDecisions).toHaveLength(1);
    });

    it('应该在 hash 未变时跳过生成', async () => {
      // Given
      const mockResponse = JSON.stringify({
        summary: '一个故事',
        structure: ['第一章'],
        keyDecisions: [],
      });

      const provider = createMockProvider(mockResponse);
      const manager = new WorkProjectionManager(memoraDir, provider);
      const content = '# 第一章\n\n内容...';

      // 首次生成
      await manager.ensureProjection('/project/novel/chapter-001.md', content, 'chapter-001.md');

      // When - 相同内容再次读取
      const result = await manager.ensureProjection(
        '/project/novel/chapter-001.md',
        content,
        'chapter-001.md',
      );

      // Then - 应该返回已有投影，不再调用 LLM
      expect(result).not.toBeNull();
      expect(provider.chat).toHaveBeenCalledTimes(1); // 只调用了一次 LLM
    });

    it('应该在 hash 变更时重新生成（覆盖旧投影文件）', async () => {
      // Given
      const mockResponse1 = JSON.stringify({
        summary: '旧版本的故事',
        structure: ['第一章'],
        keyDecisions: [],
      });
      const mockResponse2 = JSON.stringify({
        summary: '新版本的故事',
        structure: ['第一章', '第二章'],
        keyDecisions: ['新增决策'],
      });

      let callCount = 0;
      const provider = {
        name: 'mock-multi',
        chat: vi.fn(async function* (_messages: Message[]) {
          callCount++;
          yield { content: callCount === 1 ? mockResponse1 : mockResponse2, done: false };
          yield { content: '', done: true };
        }),
      } as unknown as LlmProvider;
      const manager = new WorkProjectionManager(memoraDir, provider);

      // 首次生成
      await manager.ensureProjection('/project/novel/chapter-001.md', '# 旧版本', 'chapter-001.md');

      // When - 内容变更
      const result = await manager.ensureProjection(
        '/project/novel/chapter-001.md',
        '# 新版本',
        'chapter-001.md',
      );

      // Then
      expect(result).not.toBeNull();
      expect(result!.summary).toContain('新版本');
      expect(provider.chat).toHaveBeenCalledTimes(2); // 调用了两次 LLM
    });

    it('应该在 LLM 失败时降级返回 null', async () => {
      // Given
      const provider = {
        name: 'mock-error',
        chat: vi.fn(async function* () {
          throw new Error('LLM 调用失败');
        }),
      } as unknown as LlmProvider;
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When
      const result = await manager.ensureProjection(
        '/project/novel/chapter-001.md',
        '内容',
        'chapter-001.md',
      );

      // Then
      expect(result).toBeNull();
    });
  });

  describe('getProjection', () => {
    it('应该返回已有的投影', async () => {
      // Given
      const mockResponse = JSON.stringify({
        summary: '一个故事',
        structure: ['第一章'],
        keyDecisions: [],
      });

      const provider = createMockProvider(mockResponse);
      const manager = new WorkProjectionManager(memoraDir, provider);
      await manager.ensureProjection('/project/novel/chapter-001.md', '内容', 'chapter-001.md');

      // When
      const result = await manager.getProjection('/project/novel/chapter-001.md');

      // Then
      expect(result).not.toBeNull();
      expect(result!.summary).toContain('一个故事');
    });

    it('应该在无投影时返回 null', async () => {
      // Given
      const provider = createMockProvider('');
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When
      const result = await manager.getProjection('/project/novel/nonexistent.md');

      // Then
      expect(result).toBeNull();
    });
  });

  describe('loadAll', () => {
    it('应该加载项目目录下所有作品投影', async () => {
      // Given
      const mockResponse = JSON.stringify({
        summary: '一个故事',
        structure: ['第一章'],
        keyDecisions: [],
      });

      const provider = createMockProvider(mockResponse);
      const manager = new WorkProjectionManager(memoraDir, provider);
      await manager.ensureProjection('/project/novel/chapter-001.md', '内容1', 'chapter-001.md');
      await manager.ensureProjection('/project/novel/chapter-002.md', '内容2', 'chapter-002.md');

      // When
      const all = await manager.loadAll();

      // Then
      expect(all).toHaveLength(2);
    });

    it('应该在无投影时返回空数组', async () => {
      // Given
      const provider = createMockProvider('');
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When
      const all = await manager.loadAll();

      // Then
      expect(all).toHaveLength(0);
    });
  });

  describe('LLM 响应解析', () => {
    it('应该在 JSON 解析失败时降级', async () => {
      // Given - LLM 返回非法 JSON
      const provider = createMockProvider('这不是一个合法的 JSON');
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When
      const result = await manager.ensureProjection(
        '/project/novel/chapter-001.md',
        '内容',
        'chapter-001.md',
      );

      // Then - 应该降级但不崩溃
      expect(result).not.toBeNull();
      expect(result!.summary).toBeTruthy();
    });
  });
});

// ─── K2：workProjection 深度补测（截断边界 + JSON 字段缺失 + inflight + fileName 推导 + slug 冲突 + 完整字段恢复） ──
describe('WorkProjectionManager K2 深度补测', () => {
  /** 临时项目目录 */
  let memoraDir: string;

  beforeEach(async () => {
    memoraDir = await mkdtemp(join(tmpdir(), 'memora-wp-test-k2-'));
  });

  afterEach(async () => {
    await rm(memoraDir, { recursive: true, force: true });
  });

  describe('内容截断边界', () => {
    it('内容超过 3000 字符时应截断（LLM 收到截断内容）', async () => {
      // Given - 记录 LLM 收到的实际内容
      let receivedContent = '';
      const provider = {
        name: 'mock-truncate',
        chat: vi.fn(async function* (messages: Message[]) {
          // user message 是 messages[1].content
          receivedContent = messages[1]!.content as string;
          yield {
            content: JSON.stringify({ summary: '截断测试', structure: [], keyDecisions: [] }),
            done: false,
          };
          yield { content: '', done: true };
        }),
      } as unknown as LlmProvider;
      const manager = new WorkProjectionManager(memoraDir, provider);

      // 构造 5000 字符的内容
      const longContent = '# 标题\n\n' + 'A'.repeat(5000);

      // When
      await manager.ensureProjection('/project/file.md', longContent, 'file.md');

      // Then - LLM 收到的内容应被截断（< 5000 字符）
      expect(receivedContent.length).toBeLessThan(longContent.length);
      // 截断后内容应包含文件名前缀 + 截断后的正文（约 3000 + 文件名前缀长度）
      expect(receivedContent).toContain('# file.md');
    });

    it('内容正好 3000 字符时不应额外截断（边界值）', async () => {
      // Given
      let receivedContent = '';
      const provider = {
        name: 'mock-boundary',
        chat: vi.fn(async function* (messages: Message[]) {
          receivedContent = messages[1]!.content as string;
          yield {
            content: JSON.stringify({ summary: '边界测试', structure: [], keyDecisions: [] }),
            done: false,
          };
          yield { content: '', done: true };
        }),
      } as unknown as LlmProvider;
      const manager = new WorkProjectionManager(memoraDir, provider);

      // 构造正好 3000 字符的正文
      const exactContent = 'B'.repeat(3000);

      // When
      await manager.ensureProjection('/project/file.md', exactContent, 'file.md');

      // Then - 正文应完整保留（slice(0, 3000) 对 3000 字符不截断）
      // receivedContent 格式: "# file.md\n\n" + 正文
      expect(receivedContent).toContain('B'.repeat(3000));
    });
  });

  describe('LLM JSON 字段缺失降级', () => {
    it('LLM 返回 JSON 缺少 structure 时应降级为空数组', async () => {
      // Given - JSON 只含 summary，缺 structure/keyDecisions
      const provider = createMockProvider(JSON.stringify({ summary: '只有摘要' }));
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When
      const result = await manager.ensureProjection('/project/file.md', '内容', 'file.md');

      // Then
      expect(result).not.toBeNull();
      expect(result!.summary).toBe('只有摘要');
      expect(result!.structure).toEqual([]);
      expect(result!.keyDecisions).toEqual([]);
    });

    it('LLM 返回 JSON 缺少 summary 时应降级为默认文案', async () => {
      // Given - JSON 只含 structure，缺 summary
      const provider = createMockProvider(
        JSON.stringify({ structure: ['模块1'], keyDecisions: ['决策1'] }),
      );
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When
      const result = await manager.ensureProjection('/project/file.md', '内容', 'file.md');

      // Then - summary 应降级为 "${name}（无法获取概要）"
      expect(result).not.toBeNull();
      expect(result!.summary).toContain('无法获取概要');
      expect(result!.structure).toEqual(['模块1']);
      expect(result!.keyDecisions).toEqual(['决策1']);
    });
  });

  describe('inflight Promise 缓存', () => {
    it('同文件并发调用应复用 inflight Promise（LLM 只调用一次）', async () => {
      // Given - LLM 调用计数
      let callCount = 0;
      const provider = {
        name: 'mock-concurrent',
        chat: vi.fn(async function* () {
          callCount++;
          // 模拟 LLM 延迟，让并发调用有机会进入
          await new Promise((resolve) => setTimeout(resolve, 10));
          yield {
            content: JSON.stringify({ summary: '并发测试', structure: [], keyDecisions: [] }),
            done: false,
          };
          yield { content: '', done: true };
        }),
      } as unknown as LlmProvider;
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When - 同文件并发调用两次
      const [result1, result2] = await Promise.all([
        manager.ensureProjection('/project/file.md', '内容', 'file.md'),
        manager.ensureProjection('/project/file.md', '内容', 'file.md'),
      ]);

      // Then - LLM 只调用一次，两次返回相同结果
      expect(callCount).toBe(1);
      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result1!.summary).toBe(result2!.summary);
    });

    it('awaitInflight 应等待正在进行的 LLM 生成完成', async () => {
      // Given - LLM 调用有延迟，让 ensureProjection 进入 inflight
      let llmResolved = false;
      const provider = {
        name: 'mock-await-inflight',
        chat: vi.fn(async function* () {
          // 模拟 LLM 延迟，让 awaitInflight 调用时 inflight 仍存在
          await new Promise((resolve) => setTimeout(resolve, 50));
          llmResolved = true;
          yield {
            content: JSON.stringify({ summary: 'awaitInflight 测试', structure: [], keyDecisions: [] }),
            done: false,
          };
          yield { content: '', done: true };
        }),
      } as unknown as LlmProvider;
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When - 启动 ensureProjection（不 await），立即调用 awaitInflight
      const projectionPromise = manager.ensureProjection('/project/file.md', '内容', 'file.md');
      // 此时 inflight 应已注册（同步阶段已进入 doEnsureProjection）
      await manager.awaitInflight();
      // awaitInflight 完成后，LLM 应已 resolve
      expect(llmResolved).toBe(true);
      // 原 ensureProjection 也应能正常返回
      const result = await projectionPromise;
      expect(result).not.toBeNull();
      expect(result!.summary).toBe('awaitInflight 测试');
    });

    it('无 inflight 时 awaitInflight 应立即 resolve', async () => {
      const provider = createMockProvider(
        JSON.stringify({ summary: '无 inflight', structure: [], keyDecisions: [] }),
      );
      const manager = new WorkProjectionManager(memoraDir, provider);

      // 无 inflight 时 awaitInflight 应立即返回
      await manager.awaitInflight();
      // 能到达此行即表示立即 resolve
    });

    it('多文件并发 inflight 时 awaitInflight 应等待全部完成', async () => {
      let pendingCount = 0;
      const provider = {
        name: 'mock-multi-inflight',
        chat: vi.fn(async function* () {
          pendingCount++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          pendingCount--;
          yield {
            content: JSON.stringify({ summary: '多文件', structure: [], keyDecisions: [] }),
            done: false,
          };
          yield { content: '', done: true };
        }),
      } as unknown as LlmProvider;
      const manager = new WorkProjectionManager(memoraDir, provider);

      // 启动 3 个不同文件的并发生成
      const promises = [
        manager.ensureProjection('/project/file1.md', '内容1', 'file1.md'),
        manager.ensureProjection('/project/file2.md', '内容2', 'file2.md'),
        manager.ensureProjection('/project/file3.md', '内容3', 'file3.md'),
      ];

      // awaitInflight 应等待全部 inflight 完成
      await manager.awaitInflight();
      // 全部 LLM 调用应已完成
      expect(pendingCount).toBe(0);
      // 原 promises 也应能正常返回
      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);
      expect(results.every((r) => r !== null)).toBe(true);
    });
  });

  describe('fileName 推导与 slug 冲突', () => {
    it('fileName 未传时应从 filePath 推导（getBaseName）', async () => {
      // Given
      const provider = createMockProvider(
        JSON.stringify({ summary: '推导测试', structure: [], keyDecisions: [] }),
      );
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When - 不传 fileName
      const entry = await manager.ensureProjection('/project/docs/readme.md', '内容');

      // Then - id 应基于 getBaseName('/project/docs/readme.md') = 'readme.md' 的 slug
      expect(entry).not.toBeNull();
      expect(entry!.id).toContain('readme');
    });

    it('不同路径同文件名应落到同一投影文件（slug 冲突，后写覆盖）', async () => {
      // Given
      const provider = createMockProvider(
        JSON.stringify({ summary: '覆盖测试', structure: [], keyDecisions: [] }),
      );
      const manager = new WorkProjectionManager(memoraDir, provider);

      // When - 两个不同路径但同文件名
      await manager.ensureProjection('/project-a/file.md', '内容A', 'file.md');
      await manager.ensureProjection('/project-b/file.md', '内容B', 'file.md');

      // Then - 投影文件只有一条（后写覆盖先写），loadAll 返回 1 条
      const allProjections = await manager.loadAll();
      expect(allProjections).toHaveLength(1);
      // 后写覆盖先写（内容 B 触发生成）
      expect(allProjections[0]!.summary).toBe('覆盖测试');
    });
  });

  describe('loadAll 完整字段恢复', () => {
    it('loadAll 应从投影文件恢复 hash/structure/keyDecisions/summary 全部字段', async () => {
      // Given - 生成两个投影
      const provider = createMockProvider(
        JSON.stringify({
          summary: '完整字段测试',
          structure: ['模块1', '模块2', '模块3'],
          keyDecisions: ['决策A', '决策B'],
        }),
      );
      const manager = new WorkProjectionManager(memoraDir, provider);
      await manager.ensureProjection('/project/file1.md', '内容1', 'file1.md');
      await manager.ensureProjection('/project/file2.md', '内容2', 'file2.md');

      // When
      const all = await manager.loadAll();

      // Then - 每条都应完整恢复 4 个字段
      expect(all).toHaveLength(2);
      for (const proj of all) {
        expect(proj.summary).toBe('完整字段测试');
        expect(proj.structure).toEqual(['模块1', '模块2', '模块3']);
        expect(proj.keyDecisions).toEqual(['决策A', '决策B']);
        expect(proj.fileHash).toBeTruthy(); // hash 应为 64 位 SHA-256 hex
        expect(proj.fileHash.length).toBe(64);
        // 文件级感知：sourcePath 经 JSON 文件往返不丢
        expect(proj.sourcePath).toBeTruthy();
      }
    });
  });
});
