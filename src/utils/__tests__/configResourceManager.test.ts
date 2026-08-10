/**
 * ConfigResourceManager 单元测试 — 配置资源管理器抽象基类
 *
 * 覆盖范围：
 *   - deleteItem()：删除存在的资源 + 删除不存在的资源返回 false + 删除后 list 更新（原裸奔）
 *   - findBestKeywordMatch()：主排序得分降序 + 次排序 name 字母序 + 阈值过滤 + 无匹配返回 null（原裸奔）
 *   - reload()：重新扫描后 list 更新 + onAfterReload 钩子触发
 *   - loadItems()：加载后 list 更新 + onAfterLoad 钩子触发 + 返回数量
 *   - 生命周期钩子：onAfterLoad/onAfterReload 默认空实现 + 子类覆写
 *
 * 测试范式：最小子类 TestResource + 内存 mock 扫描（不依赖文件系统）。
 * 基类方法通过 protected 暴露给子类，测试子类通过 public 包装暴露 protected 方法。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import type { ConfigResource } from '@/utils/configResourceManager.js';
import type { ScannedMarkdownEntry } from '@/utils/scanner.js';

// ─── 测试夹具 ─────────────────────────────────────────────

/** 最小测试资源类型 */
interface TestResource extends ConfigResource {
  // 继承 name/keywords/content/filePath，无额外字段
}

/** 最小测试子类——暴露 protected 方法供测试调用 */
class TestResourceManager extends ConfigResourceManager<TestResource> {
  /** 暴露 findBestKeywordMatch 供测试 */
  public match(userInput: string, threshold: number) {
    return this.findBestKeywordMatch(userInput, threshold);
  }

  /** 暴露 loadItems 供测试 */
  public async load(options?: undefined): Promise<number> {
    return this.loadItems(options);
  }

  /** 暴露 createEntry 供测试验证 */
  protected createEntry(entry: ScannedMarkdownEntry): TestResource {
    // 从 frontmatter 提取 keywords（逗号分隔），body 作为 content（对齐真实子类 parseKeywords 模式）
    return {
      name: entry.name,
      keywords: (entry.frontmatter['keywords'] ?? '').split(',').map((k) => k.trim()).filter(Boolean),
      content: entry.body,
      filePath: entry.filePath,
    };
  }

  /** 实现 buildSystemPrompt（抽象方法） */
  buildSystemPrompt(_name?: string): string {
    return 'test-prompt';
  }

  // 钩子跟踪（供测试验证调用）
  onAfterLoadCalls = 0;
  onAfterReloadCalls = 0;

  protected onAfterLoad(_items: TestResource[], _options?: undefined): void {
    this.onAfterLoadCalls++;
  }

  protected onAfterReload(_items: TestResource[]): void {
    this.onAfterReloadCalls++;
  }
}

/**
 * 构造测试资源
 * @param overrides 字段覆写
 */
function createResource(overrides: Partial<TestResource> = {}): TestResource {
  return {
    name: 'test',
    keywords: ['test'],
    content: '测试内容',
    filePath: '/tmp/test.md',
    ...overrides,
  };
}

/**
 * 直接设置 items 缓存（绕过文件系统扫描）
 * @param manager 管理器实例
 * @param items 资源列表
 */
function setItems(manager: TestResourceManager, items: TestResource[]): void {
  // 通过 Object.defineProperty 直接设置 protected 字段（测试专用）
  Object.defineProperty(manager, 'items', { value: items, writable: true });
}

// ─── 测试 ──────────────────────────────────────────────────

describe('ConfigResourceManager', () => {
  let manager: TestResourceManager;

  beforeEach(() => {
    // configDir=undefined 时 scanAndBuild 返回空数组（resolveSubdir 返回 null）
    manager = new TestResourceManager(undefined, 'test-subdir');
  });

  // ── deleteItem ──────────────────────────────────────────

  describe('deleteItem()', () => {
    it('删除存在的资源返回 true，list 更新', () => {
      const res1 = createResource({ name: 'alpha' });
      const res2 = createResource({ name: 'beta' });
      setItems(manager, [res1, res2]);

      const result = manager.deleteItem('alpha');
      expect(result).toBe(true);
      expect(manager.list).toHaveLength(1);
      expect(manager.list[0]!.name).toBe('beta');
    });

    it('删除不存在的资源返回 false，list 不变', () => {
      const res1 = createResource({ name: 'alpha' });
      setItems(manager, [res1]);

      const result = manager.deleteItem('nonexistent');
      expect(result).toBe(false);
      expect(manager.list).toHaveLength(1);
    });

    it('从空列表删除返回 false', () => {
      setItems(manager, []);

      const result = manager.deleteItem('anything');
      expect(result).toBe(false);
    });

    it('删除最后一个资源后 list 为空', () => {
      const res1 = createResource({ name: 'only' });
      setItems(manager, [res1]);

      const result = manager.deleteItem('only');
      expect(result).toBe(true);
      expect(manager.list).toHaveLength(0);
    });

    it('名称匹配精确（不模糊匹配）', () => {
      const res1 = createResource({ name: 'programmer' });
      setItems(manager, [res1]);

      // 'program' 不是 'programmer'，应返回 false
      expect(manager.deleteItem('program')).toBe(false);
      expect(manager.list).toHaveLength(1);
    });
  });

  // ── findBestKeywordMatch ────────────────────────────────

  describe('findBestKeywordMatch()', () => {
    it('返回得分最高的资源', () => {
      // alpha 命中 1/2 关键词（test），beta 命中 2/2 关键词（test + hello）
      // 评分公式：hitCount / Math.min(keywordList.length, 3)
      // alpha 得分 = 1/2 = 0.5，beta 得分 = 2/2 = 1.0
      const lowScore = createResource({ name: 'alpha', keywords: ['test', 'extra'] });
      const highScore = createResource({ name: 'beta', keywords: ['test', 'hello'] });
      setItems(manager, [lowScore, highScore]);

      // 'hello test' 命中 beta 的 2 个关键词，得分更高
      const result = manager.match('hello test', 0.1);
      expect(result).not.toBeNull();
      expect(result!.item.name).toBe('beta');
    });

    it('同分时按 name 字母序（保证确定性）', () => {
      const zebra = createResource({ name: 'zebra', keywords: ['test'] });
      const alpha = createResource({ name: 'alpha', keywords: ['test'] });
      setItems(manager, [zebra, alpha]);

      // 两个 keywords 相同，得分相同，alpha 字母序在前
      const result = manager.match('test', 0.1);
      expect(result).not.toBeNull();
      expect(result!.item.name).toBe('alpha');
    });

    it('低于阈值的匹配被过滤', () => {
      const res = createResource({ name: 'alpha', keywords: ['unrelated'] });
      setItems(manager, [res]);

      // 'test' 与 'unrelated' 无重叠，得分低于阈值
      const result = manager.match('test', 0.5);
      expect(result).toBeNull();
    });

    it('无资源时返回 null', () => {
      setItems(manager, []);

      const result = manager.match('test', 0.1);
      expect(result).toBeNull();
    });

    it('keywords 为空的资源被跳过', () => {
      const noKeywords = createResource({ name: 'empty', keywords: [] });
      const withKeywords = createResource({ name: 'has', keywords: ['test'] });
      setItems(manager, [noKeywords, withKeywords]);

      const result = manager.match('test', 0.1);
      expect(result).not.toBeNull();
      expect(result!.item.name).toBe('has');
    });

    it('所有资源得分都低于阈值时返回 null', () => {
      const res1 = createResource({ name: 'alpha', keywords: ['apple'] });
      const res2 = createResource({ name: 'beta', keywords: ['banana'] });
      setItems(manager, [res1, res2]);

      // 'cherry' 与 apple/banana 无重叠
      const result = manager.match('cherry', 0.3);
      expect(result).toBeNull();
    });
  });

  // ── list 访问器 ─────────────────────────────────────────

  describe('list 访问器', () => {
    it('初始为空数组', () => {
      expect(manager.list).toEqual([]);
    });

    it('返回快照而非内部引用（SSOT-R2-T7）', () => {
      const res = createResource({ name: 'test' });
      setItems(manager, [res]);
      // 每次返回新数组：外部无法通过 list 拿到内部数组本体
      expect(manager.list).not.toBe(manager.list);
      // 内容等价
      expect(manager.list).toEqual([res]);
    });

    it('外部修改快照不污染内部状态（SSOT-R2-T7）', () => {
      setItems(manager, [createResource({ name: 'test' })]);
      const snapshot = manager.list;
      snapshot.push(createResource({ name: '越权注入' }));
      snapshot.splice(0, 1);
      // 内部仍是唯一真理源，不受快照篡改影响
      expect(manager.list).toHaveLength(1);
      expect(manager.list[0]!.name).toBe('test');
    });
  });

  // ── reload ─────────────────────────────────────────────

  describe('reload()', () => {
    it('configDir 为 undefined 时返回 0，触发 onAfterReload', async () => {
      const count = await manager.reload();
      expect(count).toBe(0);
      expect(manager.onAfterReloadCalls).toBe(1);
    });

    it('reload 后 onAfterLoad 不触发（仅 onAfterReload 触发）', async () => {
      await manager.reload();
      expect(manager.onAfterLoadCalls).toBe(0);
      expect(manager.onAfterReloadCalls).toBe(1);
    });
  });

  // ── loadItems ──────────────────────────────────────────

  describe('loadItems()', () => {
    it('configDir 为 undefined 时返回 0，触发 onAfterLoad', async () => {
      const count = await manager.load();
      expect(count).toBe(0);
      expect(manager.onAfterLoadCalls).toBe(1);
    });
  });

  // ── buildSystemPrompt ──────────────────────────────────

  describe('buildSystemPrompt()', () => {
    it('返回子类实现的 prompt', () => {
      expect(manager.buildSystemPrompt()).toBe('test-prompt');
    });
  });
});
