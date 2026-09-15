/**
 * project-search 模块单元测试
 *
 * 覆盖 safeSearchProjectFiles / safeSearchProjectText：
 *   - 成功透传结果
 *   - 失败**不再降级为空数组**：上报 `failed` 位（SEARCH-1 · F3 —— 失败与"真零命中"必须可区分）
 *   - 超时同样上报 `failed`（防宿主实现卡死 Agent 主循环）
 */
import { describe, it, expect, vi } from 'vitest';
import type { IProjectSearchProvider } from '@/project-search/types.js';
import { safeSearchProjectFiles, safeSearchProjectText } from '@/project-search/projectSearchProvider.js';

/** 只关心 searchText 行为的提供者（searchFiles 恒空） */
function providerWithText(searchText: IProjectSearchProvider['searchText']): IProjectSearchProvider {
  return {
    async searchFiles() {
      return [];
    },
    searchText,
  };
}

describe('safeSearchProjectFiles', () => {
  it('成功时透传提供者返回的文件列表', async () => {
    const provider: IProjectSearchProvider = {
      async searchFiles() {
        return [{ path: 'src/index.ts' }, { path: 'src/utils.ts' }];
      },
      async searchText() {
        return { matches: [], truncated: false };
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
        return { matches: [], truncated: false };
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
          return { matches: [], truncated: false };
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
  it('成功时透传提供者返回的结果对象（含本次检索的元信息）', async () => {
    const provider = providerWithText(async () => ({
      matches: [{ path: 'src/index.ts', line: 1, preview: 'export const x = 1;' }],
      truncated: true,
      truncatedBy: 'files' as const,
      scannedFiles: 500,
    }));
    const result = await safeSearchProjectText(provider, { pattern: 'export' });
    expect(result).toEqual({
      matches: [{ path: 'src/index.ts', line: 1, preview: 'export const x = 1;' }],
      truncated: true,
      truncatedBy: 'files',
      scannedFiles: 500,
    });
  });

  it('提供者抛错时上报 failed 位，且**不**伪装成可信的零命中（修 F3）', async () => {
    const provider = providerWithText(async () => {
      throw new Error('内容搜索异常');
    });
    const result = await safeSearchProjectText(provider, { pattern: 'x' });
    // 关键：不得是 `[]`（那与"真零命中"逐字同形）；必须是可分流的结果对象
    expect(result).toEqual({ matches: [], truncated: false, failed: true });
  });

  it('提供者超时（30s）时同样上报 failed 位（fake timers 触发真实超时分支）', async () => {
    vi.useFakeTimers();
    try {
      const provider = providerWithText(() => new Promise(() => {}));
      const promise = safeSearchProjectText(provider, { pattern: 'x' });
      vi.advanceTimersByTime(30_000);
      await expect(promise).resolves.toEqual({ matches: [], truncated: false, failed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('真零命中不得置 failed（零命中 ≠ 失败：对齐 "no results is not an error"）', async () => {
    const provider = providerWithText(async () => ({
      matches: [],
      truncated: false,
      scannedFiles: 12,
    }));
    const result = await safeSearchProjectText(provider, { pattern: '不存在的词' });
    expect(result.failed).toBeUndefined();
    expect(result.matches).toEqual([]);
    expect(result.scannedFiles).toBe(12);
  });
});
