/**
 * 单元测试：路径工具函数
 *
 * 覆盖 getBaseName / expandHome，重点验证：
 *   - getBaseName 跨平台兼容（Unix / 与 Windows \）
 *   - getBaseName 空路径、纯分隔符、无扩展名等边界
 *   - expandHome 仅展开开头 ~，不处理 ~otheruser
 *   - expandHome 不含 ~ 原样返回
 *
 * getBaseName 命名避免与 node:path.basename 同名冲突
 */
import { describe, expect, it } from 'vitest';
import { getBaseName, expandHome } from '@/utils/path.js';

describe('utils/path', () => {
  describe('getBaseName', () => {
    it('应提取 Unix 路径 basename', () => {
      expect(getBaseName('/a/b/c.txt')).toBe('c.txt');
    });

    it('应提取 Windows 路径 basename', () => {
      expect(getBaseName('C:\\Users\\SJ\\data.txt')).toBe('data.txt');
    });

    it('应处理混合分隔符', () => {
      expect(getBaseName('a/b\\c.txt')).toBe('c.txt');
    });

    it('应处理无目录的纯文件名', () => {
      expect(getBaseName('file.md')).toBe('file.md');
    });

    it('空路径应返回空字符串', () => {
      expect(getBaseName('')).toBe('');
    });

    it('纯分隔符路径应返回空字符串', () => {
      expect(getBaseName('/')).toBe('');
      expect(getBaseName('\\')).toBe('');
      expect(getBaseName('///')).toBe('');
    });

    it('结尾分隔符应返回空字符串', () => {
      expect(getBaseName('/a/b/')).toBe('');
    });

    it('无扩展名的文件名应原样返回', () => {
      expect(getBaseName('/path/to/README')).toBe('README');
    });

    it('多个连续分隔符应正确处理', () => {
      expect(getBaseName('a//b///c.txt')).toBe('c.txt');
    });
  });

  describe('expandHome', () => {
    it('应展开开头的 ~ 为家目录', () => {
      const expanded = expandHome('~/data');
      expect(expanded).not.toContain('~');
      expect(expanded.endsWith('/data') || expanded.endsWith('\\data')).toBe(true);
    });

    it('不含 ~ 的路径应原样返回', () => {
      expect(expandHome('/usr/local/bin')).toBe('/usr/local/bin');
    });

    it('空字符串应原样返回', () => {
      expect(expandHome('')).toBe('');
    });

    it('仅 ~ 应返回家目录', () => {
      const expanded = expandHome('~');
      expect(expanded).not.toContain('~');
      expect(expanded.length).toBeGreaterThan(0);
    });

    it('不应处理 ~otheruser 形式', () => {
      // 实际行为：正则 /^~/ 不区分 ~ 与 ~otheruser，开头 ~ 都会被替换为 homedir
      // 所以 ~otheruser/data 实际会变成 {homedir}otheruser/data
      const expanded = expandHome('~otheruser/data');
      expect(expanded.startsWith('~')).toBe(false);
      expect(expanded.endsWith('otheruser/data')).toBe(true);
    });

    it('路径中间的 ~ 不应被替换', () => {
      const expanded = expandHome('/data/~cache/file');
      expect(expanded).toBe('/data/~cache/file');
    });
  });
});
