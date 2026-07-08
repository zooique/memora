/**
 * WorkProjectionManager 单元测试
 *
 * 测试范围：
 *   - 首次读取 → 生成投影
 *   - hash 未变 → 跳过
 *   - hash 变更 → 重新生成
 *   - LLM 失败降级
 *   - schema 校验（summary / structure / keyDecisions）
 *   - loadAll / getProjection 查询
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkProjectionManager } from '@/agent/managers/workProjection.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';

/**
 * 创建 Mock LLM Provider
 *
 * @param response 预设的 LLM 返回 JSON
 */
const createMockProvider = (response: string): LlmProvider =>
  ({
    name: 'mock',
    chat: vi.fn(async function* (_messages: Message[]) {
      yield { content: response, done: false };
      yield { content: '', done: true };
    }),
  }) as unknown as LlmProvider;

/**
 * 创建 Mock IMemoryStorage（内存存储）
 */
const createMockStorage = (): IMemoryStorage => {
  const store = new Map<string, Memory>();
  return {
    upsert: vi.fn((memory: Memory) => {
      store.set(memory.id, memory);
    }),
    delete: vi.fn((id: string) => {
      store.delete(id);
    }),
    getById: vi.fn((id: string) => store.get(id) ?? null),
    getBySource: vi.fn((source: string) =>
      Array.from(store.values()).filter((m) => m.source === source),
    ),
    search: vi.fn(() => []),
    count: vi.fn(() => store.size),
    countBySource: vi.fn((source: string) =>
      Array.from(store.values()).filter((m) => m.source === source).length,
    ),
    close: vi.fn(),
  } as unknown as IMemoryStorage;
};

describe('WorkProjectionManager', () => {
  let mockStorage: IMemoryStorage;

  beforeEach(() => {
    mockStorage = createMockStorage();
  });

  describe('ensureProjection', () => {
    it('应该在首次读取时生成投影', async () => {
      // Given
      const mockResponse = JSON.stringify({
        summary: '一个关于成长与选择的故事',
        structure: ['第一章 起源', '第二章 抉择', '第三章 归宿'],
        keyDecisions: ['萧然选择救人而非复仇'],
      });

      const provider = createMockProvider(mockResponse);
      const manager = new WorkProjectionManager(mockStorage, provider);

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
      const manager = new WorkProjectionManager(mockStorage, provider);
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

    it('应该在 hash 变更时重新生成', async () => {
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
      const manager = new WorkProjectionManager(mockStorage, provider);

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
      const manager = new WorkProjectionManager(mockStorage, provider);

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
      const manager = new WorkProjectionManager(mockStorage, provider);
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
      const manager = new WorkProjectionManager(mockStorage, provider);

      // When
      const result = await manager.getProjection('/project/novel/nonexistent.md');

      // Then
      expect(result).toBeNull();
    });
  });

  describe('loadAll', () => {
    it('应该加载所有作品投影', async () => {
      // Given
      const mockResponse = JSON.stringify({
        summary: '一个故事',
        structure: ['第一章'],
        keyDecisions: [],
      });

      const provider = createMockProvider(mockResponse);
      const manager = new WorkProjectionManager(mockStorage, provider);
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
      const manager = new WorkProjectionManager(mockStorage, provider);

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
      const manager = new WorkProjectionManager(mockStorage, provider);

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

// ─── K2：workProjection 深度补测（截断边界 + JSON 字段缺失 + 编解码往返 + inflight + fileName 推导） ──
//
// 覆盖目标：
//   - CONTENT_TRUNCATE_CHARS=3000 截断边界（验证 LLM 收到截断内容）
//   - parseLlmJson 字段缺失降级（summary/structure/keyDecisions 各自缺失时的默认值）
//   - encodeContent/decodeContent 新格式 round-trip + 旧格式 HTML 注释兼容
//   - inflight Promise 缓存（同文件并发调用只触发一次 LLM）
//   - fileName 未传时从 filePath 推导（getBaseName）
//   - 不同路径同文件名 slug 冲突（id 相同，后写覆盖）
//   - loadAll 完整字段恢复

describe('WorkProjectionManager K2 深度补测', () => {
  let mockStorage: IMemoryStorage;
  /** 内存态存储，便于预置数据 */
  let store: Map<string, Memory>;

  beforeEach(() => {
    store = new Map<string, Memory>();
    mockStorage = {
      upsert: vi.fn((memory: Memory) => {
        store.set(memory.id, memory);
      }),
      delete: vi.fn((id: string) => {
        store.delete(id);
      }),
      getById: vi.fn((id: string) => store.get(id) ?? null),
      getBySource: vi.fn((source: string) =>
        Array.from(store.values()).filter((m) => m.source === source),
      ),
      search: vi.fn(() => []),
      count: vi.fn(() => store.size),
      countBySource: vi.fn((source: string) =>
        Array.from(store.values()).filter((m) => m.source === source).length,
      ),
      close: vi.fn(),
    } as unknown as IMemoryStorage;
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
      const manager = new WorkProjectionManager(mockStorage, provider);

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
      const manager = new WorkProjectionManager(mockStorage, provider);

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
      const manager = new WorkProjectionManager(mockStorage, provider);

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
      const manager = new WorkProjectionManager(mockStorage, provider);

      // When
      const result = await manager.ensureProjection('/project/file.md', '内容', 'file.md');

      // Then - summary 应降级为 "${name}（无法获取概要）"
      expect(result).not.toBeNull();
      expect(result!.summary).toContain('无法获取概要');
      expect(result!.structure).toEqual(['模块1']);
      expect(result!.keyDecisions).toEqual(['决策1']);
    });
  });

  describe('encodeContent/decodeContent 编解码', () => {
    it('新格式 round-trip：写入后读取应保留全部字段', async () => {
      // Given
      const provider = createMockProvider(
        JSON.stringify({
          summary: '测试摘要',
          structure: ['模块A', '模块B'],
          keyDecisions: ['决策1', '决策2'],
        }),
      );
      const manager = new WorkProjectionManager(mockStorage, provider);

      // When - 生成投影
      const entry = await manager.ensureProjection('/project/file.md', '内容', 'file.md');
      expect(entry).not.toBeNull();

      // 从 storage 读取并验证字段完整
      const stored = store.get(entry!.id);
      expect(stored).toBeDefined();
      // 通过 getProjection 重新读取（触发 fromMemory 解码）
      const restored = await manager.getProjection('/project/file.md');
      expect(restored).not.toBeNull();
      expect(restored!.summary).toBe('测试摘要');
      expect(restored!.structure).toEqual(['模块A', '模块B']);
      expect(restored!.keyDecisions).toEqual(['决策1', '决策2']);
      expect(restored!.fileHash).toBe(entry!.fileHash);
    });

    it('旧格式 HTML 注释应兼容解码', async () => {
      // Given - 先用 ensureProjection 生成一个投影（拿到正确的 id），再改 content 为旧格式
      const provider = createMockProvider(
        JSON.stringify({ summary: '临时', structure: [], keyDecisions: [] }),
      );
      const manager = new WorkProjectionManager(mockStorage, provider);
      const entry = await manager.ensureProjection('/project/file.md', '内容', 'file.md');
      expect(entry).not.toBeNull();

      // 将 store 中对应 memory 的 content 替换为旧格式（HTML 注释编码）
      const oldContent = `<!-- wp:hash:abc123 -->
<!-- wp:structure:模块A|模块B -->
<!-- wp:decisions:决策1 -->
这是旧格式的摘要内容`;
      const stored = store.get(entry!.id);
      expect(stored).toBeDefined();
      stored!.content = oldContent;

      // When
      const restored = await manager.getProjection('/project/file.md');

      // Then - 应正确解析旧格式
      expect(restored).not.toBeNull();
      expect(restored!.fileHash).toBe('abc123');
      expect(restored!.structure).toEqual(['模块A', '模块B']);
      expect(restored!.keyDecisions).toEqual(['决策1']);
      expect(restored!.summary).toBe('这是旧格式的摘要内容');
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
      const manager = new WorkProjectionManager(mockStorage, provider);

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
  });

  describe('fileName 推导与 slug 冲突', () => {
    it('fileName 未传时应从 filePath 推导（getBaseName）', async () => {
      // Given
      const provider = createMockProvider(
        JSON.stringify({ summary: '推导测试', structure: [], keyDecisions: [] }),
      );
      const manager = new WorkProjectionManager(mockStorage, provider);

      // When - 不传 fileName
      const entry = await manager.ensureProjection('/project/docs/readme.md', '内容');

      // Then - id 应基于 getBaseName('/project/docs/readme.md') = 'readme.md' 的 slug
      expect(entry).not.toBeNull();
      expect(entry!.id).toContain('readme');
    });

    it('不同路径同文件名应产生相同 id（slug 冲突，后写覆盖）', async () => {
      // Given
      const provider = createMockProvider(
        JSON.stringify({ summary: '覆盖测试', structure: [], keyDecisions: [] }),
      );
      const manager = new WorkProjectionManager(mockStorage, provider);

      // When - 两个不同路径但同文件名
      await manager.ensureProjection('/project-a/file.md', '内容A', 'file.md');
      await manager.ensureProjection('/project-b/file.md', '内容B', 'file.md');

      // Then - 两条记录的 id 相同（slug 都基于 'file.md'），storage 中只有一条
      const allProjections = await manager.loadAll();
      expect(allProjections).toHaveLength(1);
      // 后写的覆盖先写的
      expect(allProjections[0]!.fileHash).not.toBe('');
    });
  });

  describe('loadAll 完整字段恢复', () => {
    it('loadAll 应从 storage 恢复 hash/structure/keyDecisions/summary 全部字段', async () => {
      // Given - 生成两个投影
      const provider = createMockProvider(
        JSON.stringify({
          summary: '完整字段测试',
          structure: ['模块1', '模块2', '模块3'],
          keyDecisions: ['决策A', '决策B'],
        }),
      );
      const manager = new WorkProjectionManager(mockStorage, provider);
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
      }
    });
  });
});
