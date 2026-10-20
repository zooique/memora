/**
 * refProbe 单测：发送前引用文件存在性核实（HOST-CTX-9 发送侧）
 *
 * 用注入式 `stat` 桩（不触真实 FS）覆盖：存在 / 不存在 / 目录忽略 / 解析失败计入（越界）/
 * 空 root / 多引用并发。SSOT 复用 refPath.resolveUnderPrimaryRoot —— 本套件同时锁定
 * 「解析不出绝对路径 = 失效」这一并轨判据（与引用行降级同源）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatRef } from '../../../shared/protocol.js';
import { collectMissingFileRefPaths } from '../refProbe.js';

/** 构造引用（默认文件） */
const ref = (path: string, kind: 'file' | 'folder' = 'file'): ChatRef => ({ path, kind });

describe('collectMissingFileRefPaths（发送前存在性核实）', () => {
  const ROOT = '/ws';

  it('存在的文件引用 → 不在失效集合', async () => {
    const missing = await collectMissingFileRefPaths([ref('src/ok.ts')], ROOT, async () => ({}));
    expect(missing.size).toBe(0);
  });

  it('不存在的文件引用 → 计入失效集合（stat 抛错即失效）', async () => {
    const missing = await collectMissingFileRefPaths([ref('src/gone.ts')], ROOT, async () => {
      throw new Error('ENOENT');
    });
    expect(missing.has('src/gone.ts')).toBe(true);
    expect(missing.size).toBe(1);
  });

  it('目录引用不检测（kind=folder 直接跳过，不调 stat）', async () => {
    const stat = vi.fn(async () => ({}));
    const missing = await collectMissingFileRefPaths([ref('src/utils', 'folder')], ROOT, stat);
    expect(missing.size).toBe(0);
    expect(stat).not.toHaveBeenCalled();
  });

  it('解析失败（越界 / 绝对路径 / 非规范形）→ 计入失效集合，且不调 stat', async () => {
    const stat = vi.fn(async () => ({}));
    const missing = await collectMissingFileRefPaths(
      [ref('../outside.md'), ref('/abs/x.md'), ref('docs//x.md')],
      ROOT,
      stat,
    );
    expect(missing.has('../outside.md')).toBe(true);
    expect(missing.has('/abs/x.md')).toBe(true);
    expect(missing.has('docs//x.md')).toBe(true);
    expect(stat).not.toHaveBeenCalled();
  });

  it('空 root（未打开工作区）→ 空集合，不调 stat', async () => {
    const stat = vi.fn(async () => ({}));
    const undefinedRoot = await collectMissingFileRefPaths([ref('src/ok.ts')], undefined, stat);
    expect(undefinedRoot.size).toBe(0);
    const emptyRoot = await collectMissingFileRefPaths([ref('src/ok.ts')], '', stat);
    expect(emptyRoot.size).toBe(0);
    expect(stat).not.toHaveBeenCalled();
  });

  it('混合多引用并发：只收集失效者，未失效者不受牵连', async () => {
    const missing = await collectMissingFileRefPaths(
      [ref('src/ok.ts'), ref('src/gone.ts'), ref('src/utils', 'folder')],
      ROOT,
      async (abs) => {
        if (abs.includes('gone')) throw new Error('ENOENT');
        return {};
      },
    );
    expect([...missing]).toEqual(['src/gone.ts']);
  });
});
