/**
 * project-search 模块单元测试
 *
 * 覆盖 safeSearchProjectFiles / safeSearchProjectText：
 *   - 成功透传结果
 *   - 失败降级为空数组（不抛异常，不中断对话）
 *   - 超时降级为空数组（防宿主实现卡死 Agent 主循环）
 */
import { describe, it, expect, vi } from 'vitest';
import type { IProjectSearchProvider } from '@/project-search/types.js';
import { safeSearchProjectFiles, safeSearchProjectText } from '@/project-search/projectSearchProvider.js';

describe('safeSearchProjectFiles', () => {
  it('成功时透传提供者返回的文件列表', async () => {
    const provider: IProjectSearchProvider = {
      async searchFiles() {
        return [{ path: 'src/index.ts' }, { path: 'src/utils.ts' }];
      },
      async searchText() {
        return [];
      },
    };
    const result = await safeSearchProjectFiles(provider, { query: '**/*.ts' });
    expect(result).toEqual([{ path: 'src/index.ts' }, { path: 'src/utils.ts' }]);
  });

  it('提供者抛错时降级为空数组（不抛异常）', async () => {
    const provider: IProjectSearchProvider = {
      async searchFiles() {
        throw new Error('搜索服务异常');
      },
      async searchText() {
        return [];
      },
    };
    const result = await safeSearchProjectFiles(provider, {});
    expect(result).toEqual([]);
  });

  it('提供者超时（30s）时降级为空数组（fake timers 触发真实超时分支）', async () => {
    vi.useFakeTimers();
    try {
      const provider: IProjectSearchProvider = {
        async searchFiles() {
          // 永不 resolve，触发 Promise.race 的超时分支
          return new Promise(() => {});
        },
        async searchText() {
          return [];
        },
      };
      const promise = safeSearchProjectFiles(provider, {});
      // 推进到内部超时点（30s），触发 setTimeout reject → race 走 catch 降级
      vi.advanceTimersByTime(30_000);
      await expect(promise).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('safeSearchProjectText', () => {
  it('成功时透传提供者返回的内容匹配结果', async () => {
    const provider: IProjectSearchProvider = {
      async searchFiles() {
        return [];
      },
      async searchText() {
        return [{ path: 'src/index.ts', line: 1, preview: 'export const x = 1;' }];
      },
    };
    const result = await safeSearchProjectText(provider, { pattern: 'export' });
    expect(result).toEqual([{ path: 'src/index.ts', line: 1, preview: 'export const x = 1;' }]);
  });

  it('提供者抛错时降级为空数组（不抛异常）', async () => {
    const provider: IProjectSearchProvider = {
      async searchFiles() {
        return [];
      },
      async searchText() {
        throw new Error('内容搜索异常');
      },
    };
    const result = await safeSearchProjectText(provider, { pattern: 'x' });
    expect(result).toEqual([]);
  });
});
