/**
 * sourcePaths 单元测试（T-A1 SSOT 单一化）
 *
 * 守护语义：
 *   - SOURCE_TO_DIR 映射正确（persona/rule/skill → personas/rules/skills）
 *   - 未知 source 透传作目录名（开放字符串，store.test.ts:127 同语义）
 *   - source 非法（`..` 等）抛 configError（validateSource 校验）
 *   - name 注入 `../` 逃逸子目录被目录内纵深防御拦截（宿主 resolveTargetPath startsWith 防护）
 *
 * 变异验证点：中和 resolveSourceFilePath 的 startsWith 防御 → 逃逸用例转红。
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SOURCE_TO_DIR, sourceToDir, resolveSourceFilePath } from '@/memory/sourcePaths.js';
import { SOURCE_LABELS } from '@/memory/types.js';

// 纯路径计算，不触碰文件系统；tmpdir 保证跨平台分隔符一致
const BASE = join(tmpdir(), 'memora-sourcepaths-base');

describe('sourcePaths · source → 目录映射与路径构造（T-A1 单一真理源）', () => {
  describe('SOURCE_TO_DIR', () => {
    it('应映射三类配置 source 到标准子目录', () => {
      expect(SOURCE_TO_DIR[SOURCE_LABELS.PERSONA]).toBe('personas');
      expect(SOURCE_TO_DIR[SOURCE_LABELS.RULE]).toBe('rules');
      expect(SOURCE_TO_DIR[SOURCE_LABELS.SKILL]).toBe('skills');
    });
  });

  describe('sourceToDir', () => {
    it('已知 source 返回映射目录', () => {
      expect(sourceToDir(SOURCE_LABELS.RULE)).toBe('rules');
    });

    it('未知 source 透传作目录名（开放字符串）', () => {
      expect(sourceToDir('custom')).toBe('custom');
    });

    it('非法 source（路径遍历）应抛 configError', () => {
      expect(() => sourceToDir('..')).toThrow(/source 校验失败/);
      expect(() => sourceToDir('a/b')).toThrow(/source 校验失败/);
    });
  });

  describe('resolveSourceFilePath', () => {
    it('应构造 {baseDir}/{sourceDir}/{name}.md 路径', () => {
      expect(resolveSourceFilePath(BASE, SOURCE_LABELS.RULE, 'my-rule')).toBe(
        join(BASE, 'rules', 'my-rule.md'),
      );
    });

    it('未知 source 透传目录（开放语义）', () => {
      expect(resolveSourceFilePath(BASE, 'custom', 'deep-tool')).toBe(
        join(BASE, 'custom', 'deep-tool.md'),
      );
    });

    it('name 注入 ../ 逃逸子目录应被目录内纵深防御拦截', () => {
      // join(BASE, 'rules', '../evil.md') resolve 后 = BASE/evil.md，逃出 rules/
      expect(() => resolveSourceFilePath(BASE, SOURCE_LABELS.RULE, '../evil')).toThrow(
        /目标路径越界/,
      );
    });

    it('name 含反斜杠路径段逃逸应被拦截（Windows 分隔符）', () => {
      // 平台语义（第一性原理：路径遍历判别是平台相关的）：
      //   - win32：\ 是路径分隔符，`..\evil.md` 被 resolve 弹出 skills/ → 真逃逸 → 纵深防御必须拦截
      //   - POSIX：\ 是合法文件名字符，`..\evil.md` 是字面单段（不构成遍历），路径仍留在 skills/ 内
      //     → 不抛是正确行为（拦截反而是过度收紧，会拒绝合法文件名）
      // 跨平台遍历样本（`../`，/ 两平台都是分隔符）由上方「name 注入 ../」用例守护。
      if (process.platform === 'win32') {
        expect(() => resolveSourceFilePath(BASE, SOURCE_LABELS.SKILL, '..\\evil')).toThrow(
          /目标路径越界/,
        );
      } else {
        expect(resolveSourceFilePath(BASE, SOURCE_LABELS.SKILL, '..\\evil')).toBe(
          join(BASE, 'skills', '..\\evil.md'),
        );
      }
    });

    it('非法 source 应抛 configError（validateSource 前置校验）', () => {
      expect(() => resolveSourceFilePath(BASE, 'a/b', 'x')).toThrow(/source 校验失败/);
    });
  });
});
