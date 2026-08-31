/**
 * VscodeProjectSearchProvider 单元测试
 *
 * 覆盖：
 *   - searchFiles：mock vscode.workspace.findFiles（stable API），返回相对项目根 posix 路径
 *   - searchFiles：query 省略时默认列出项目全部文件
 *   - searchFiles：Windows 反斜杠统一为正斜杠
 *   - searchText：真实临时目录 fs 扫描（content 模式 = 宿主 Node fs 受限实现）
 *     · 按关键词命中 路径:行号:预览
 *     · 忽略标准目录（node_modules 等，对齐内核 list_dir）
 *     · exclude 路径段过滤
 *     · 大小写不敏感
 *     · 无命中返回空数组
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as vscode from 'vscode';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 宿主模块可能间接依赖 vscode，mock 之（不引入真实 VS Code 运行时）
vi.mock('vscode', () => ({
  workspace: {
    findFiles: vi.fn(),
  },
}));

import { createVscodeProjectSearchProvider } from '../projectSearchProvider.js';

describe('VscodeProjectSearchProvider', () => {
  const root = 'C:/proj';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('searchFiles（按文件名 glob，workspace.findFiles）', () => {
    it('调用 workspace.findFiles 并返回相对项目根的 posix 路径', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
        { fsPath: 'C:/proj/src/index.ts' },
        { fsPath: 'C:/proj/README.md' },
      ] as never);
      const provider = createVscodeProjectSearchProvider(root);
      const result = await provider.searchFiles({ query: '**/*.ts' });
      expect(vscode.workspace.findFiles).toHaveBeenCalledWith('**/*.ts', null, 100);
      expect(result).toEqual([
        { path: 'src/index.ts' },
        { path: 'README.md' },
      ]);
    });

    it('query 省略时默认列出项目全部文件', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
        { fsPath: 'C:/proj/src/index.ts' },
      ] as never);
      const provider = createVscodeProjectSearchProvider(root);
      await provider.searchFiles({});
      expect(vscode.workspace.findFiles).toHaveBeenCalledWith('**/*', null, 100);
    });

    it('Windows 反斜杠统一为正斜杠（与 read_file 相对路径语义对齐）', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
        { fsPath: 'C:\\proj\\src\\index.ts' },
      ] as never);
      const provider = createVscodeProjectSearchProvider('C:\\proj');
      const result = await provider.searchFiles({});
      expect(result).toEqual([{ path: 'src/index.ts' }]);
    });

    it('exclude 透传给 findFiles（排除 node_modules 等）', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([] as never);
      const provider = createVscodeProjectSearchProvider(root);
      await provider.searchFiles({ query: '**/*.ts', exclude: '**/node_modules/**' });
      expect(vscode.workspace.findFiles).toHaveBeenCalledWith('**/*.ts', '**/node_modules/**', 100);
    });

    it('maxResults 限制在 100 内（防结果刷屏）', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([] as never);
      const provider = createVscodeProjectSearchProvider(root);
      await provider.searchFiles({ maxResults: 999 });
      expect(vscode.workspace.findFiles).toHaveBeenCalledWith('**/*', null, 100);
    });
  });

  describe('searchText（按内容全文搜索，宿主 Node fs 受限实现）', () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'memora-search-'));
      mkdirSync(join(tmp, 'src'), { recursive: true });
      mkdirSync(join(tmp, 'node_modules'), { recursive: true });
      writeFileSync(join(tmp, 'src/index.ts'), 'export const x = 1;\nconst TODO = "fix me";\n', 'utf-8');
      writeFileSync(join(tmp, 'src/utils.ts'), 'export const y = 2;\n// TODO: optimize\n', 'utf-8');
      writeFileSync(join(tmp, 'README.md'), '# Project\nTODO list here\n', 'utf-8');
      writeFileSync(join(tmp, 'node_modules/ignored.ts'), 'export const TODO = "should be ignored";\n', 'utf-8');
    });

    afterAll(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    it('按关键词命中返回 路径:行号:预览', async () => {
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO' });
      // 命中 3 个文件（node_modules 被忽略）
      const paths = result.map((m) => m.path);
      expect(paths).toContain('src/index.ts');
      expect(paths).toContain('src/utils.ts');
      expect(paths).toContain('README.md');
      expect(paths).not.toContain('node_modules/ignored.ts');
      // 行号 1 起 + 预览片段
      const indexHit = result.find((m) => m.path === 'src/index.ts')!;
      expect(indexHit.line).toBe(2);
      expect(indexHit.preview).toContain('TODO');
    });

    it('大小写不敏感匹配（对齐全局搜索缺省）', async () => {
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'todo' });
      expect(result.length).toBeGreaterThan(0);
    });

    it('exclude 路径段过滤（排除 docs 目录）', async () => {
      mkdirSync(join(tmp, 'docs'), { recursive: true });
      writeFileSync(join(tmp, 'docs/guide.md'), 'TODO guide\n', 'utf-8');
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO', exclude: 'docs' });
      const paths = result.map((m) => m.path);
      expect(paths).not.toContain('docs/guide.md');
      expect(paths).toContain('README.md');
    });

    it('忽略 node_modules 目录（对齐内核 list_dir 忽略规则）', async () => {
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO' });
      expect(result.some((m) => m.path.startsWith('node_modules'))).toBe(false);
    });

    it('无命中时返回空数组', async () => {
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: '绝不存在的关键词xyz' });
      expect(result).toEqual([]);
    });
  });
});
