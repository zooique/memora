/**
 * 隐含前提机判：`_chatBusy = true` 在生产源码中**恰好 1 处写点**，且位于
 * `ChatLockManager.acquire()`（生产唯一入口 = `Agent.acquireChatLock`）。
 *
 * 为什么要机判：
 * 门控与 token 协议的前提是「只有 acquire 会置 true」。若未来在别处新增 `_chatBusy = true`
 * （如某路径绕开 acquire 直接占位），token 递增顺序就被破坏 ⇒ 超时/finally 的
 * 「是否仍是持有者」校验失效，会静默误清别人的资源。故用源码扫描把前提钉死。
 *
 * ⚠ 2026-11-06：本文件原为 E1「owner 记录不漂移」而设，`_lockOwner` 组已作为零生产消费的
 * 僵尸一并删除；但「唯一写点」前提本身仍有效（守护 token 协议），故保留扫描器、只改由头。
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
