/**
 * E1 隐含前提机判：`_chatBusy = true` 在生产源码中**恰好 1 处写点**，且位于
 * `ChatLockManager.acquire()`（生产唯一入口 = `Agent.acquireChatLock`）。
 *
 * 为什么要机判：
 * `_lockOwner`（纯记录）与 `_chatBusy`（门控真源）不漂移的前提是「只有 acquire 会置 true」。
 * 若未来在别处新增 `_chatBusy = true` 而忘了同步 `_lockOwner`，两套记录会静默分叉，
 * 且**没有任何运行期测试会红**（门控照旧工作，只是 owner 诊断失真）。故用源码扫描把前提钉死。
 *
 * 口径：
 * - 只扫 `src/**` 下 `.ts`，排除 `__tests__`（测试需要直接置 `_chatBusy` 造 busy 态）
 * - 判据是赋值 `_chatBusy = true`；比较 `_chatBusy === true` 之类不计
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 仓库根（本文件位于 src/agent/managers/__tests__） */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
/** 内核源码根 */
const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * 列出目录下全部 `.ts` 文件（递归）
 *
 * @param dir 起始目录
 */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 统计源码里 `_chatBusy = true` 赋值点数量
 *
 * 🔴 先剥离注释再计数：字段注释里会**用字面量**说明这条前提（「唯一写 `_chatBusy = true` 点」），
 * 若不剥离，注释自己会被当成第二处写点 ⇒ 守卫永久假红。行注释同理按行首剥离。
 *
 * @param source 源码文本
 */
function countBusyTrueWrites(source: string): number {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSDoc）
    .replace(/^\s*\/\/.*$/gm, ''); // 整行注释
  return [...code.matchAll(/_chatBusy\s*=\s*true\b/g)].length;
}

describe('E1 隐含前提 · `_chatBusy = true` 唯一写点', () => {
  it('扫描器自检：两处赋值计 2，条件比较不计，注释里的字面量不计', () => {
    expect(countBusyTrueWrites('a; this._chatBusy = true; b;')).toBe(1);
    expect(countBusyTrueWrites('this._chatBusy = true;\nthis._chatBusy = true;')).toBe(2);
    // `===` 是比较不是赋值，不得误计
    expect(countBusyTrueWrites('if (this._chatBusy === true) {}')).toBe(0);
    // 注释里的说明文字不是写点（否则守卫会被自己的文档打成假红）
    expect(countBusyTrueWrites('/** 唯一写 `_chatBusy = true` 点 */')).toBe(0);
    expect(countBusyTrueWrites('// this._chatBusy = true')).toBe(0);
  });

  it('生产源码：写 true 点恰好 1 处，且位于 ChatLockManager', () => {
    const hits = listTsFiles(SRC_ROOT)
      .filter((file) => !file.split(sep).includes('__tests__'))
      .map((file) => ({
        file: relative(REPO_ROOT, file).split(sep).join('/'),
        count: countBusyTrueWrites(readFileSync(file, 'utf8')),
      }))
      .filter((hit) => hit.count > 0);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.count).toBe(1);
    expect(hits[0]!.file).toBe('src/agent/managers/chatLockManager.ts');
  });
});
