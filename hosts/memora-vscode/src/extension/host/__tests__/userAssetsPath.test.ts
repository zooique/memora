/**
 * 用户资产名字净化 / 路径逃逸断言回归测试
 *
 * 被测不变量：
 *   1. 名字净化拒绝三类输入——`..` 上跳、路径分隔符、空白（含首尾空格）；
 *   2. 即便名字净化被绕过，`resolveInsideDir` 仍须把「最终路径逃出用户目录」拦下
 *      （两道防线独立生效，任一道都不是装饰）。
 *
 * 为什么钉死：这条判据是所有「写入用户目录」入口的前置（压缩包导入 / 对话写入的安装窄口），
 * 写错任一条都能把文件写到 globalStorage 之外（且不会有任何测试之外的报警）。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolve, sep, join } from 'node:path';
import { USER_ASSET_NAME_RE, resolveInsideDir, sanitizeAssetName } from '../userAssets/path.js';

/** 测试用用户目录根（绝对路径；与真实 globalStorage 无关） */
const ROOT = resolve(process.cwd(), 'user-assets-root');

describe('sanitizeAssetName（名字净化）', () => {
  it.each(['../x', '..', 'a/b', 'a\\b', '/abs', 'C:\\abs', '.hidden', ''])(
    '拒绝路径形态或空白输入：%j',
    (raw) => {
      const result = sanitizeAssetName(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    },
  );

  it('拒绝首尾空格（不静默 trim 后放行，避免「名字含空格但落盘不同名」的隐式改写）', () => {
    expect(sanitizeAssetName(' doc ').ok).toBe(false);
  });

  it('拒绝全空白名字', () => {
    expect(sanitizeAssetName('   ').ok).toBe(false);
  });

  it('接受中文 / 字母 / 数字 / 下划线 / 连字符的合法名字', () => {
    for (const name of ['资料整理', 'writer', 'writer_2', 'writer-2']) {
      expect(sanitizeAssetName(name)).toEqual({ ok: true, name });
    }
  });

  it('正则不含点号 —— 这是 `..` 与盘符被拒的结构性原因（非额外分支）', () => {
    expect(USER_ASSET_NAME_RE.test('..')).toBe(false);
    expect(USER_ASSET_NAME_RE.test('a.b')).toBe(false);
  });
});

describe('resolveInsideDir（最终路径逃逸断言）', () => {
  it('合法子路径落在根目录之内', () => {
    const result = resolveInsideDir(ROOT, 'ok.md');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(join(resolve(ROOT), 'ok.md'));
      expect(result.path.startsWith(resolve(ROOT) + sep)).toBe(true);
    }
  });

  it.each(['../escape.md', '../../escape.md', '/abs/escape.md'])(
    '拒绝逃出根目录的片段：%j',
    (segment) => {
      const result = resolveInsideDir(ROOT, segment);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // 断言逃逸判定不是靠「恰好等于 root」而是 startsWith(root + sep)
        expect(result.reason).toContain('越出用户目录');
      }
    },
  );
});
