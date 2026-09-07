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
      // 默认排除 IGNORED_DIR_NAMES（含 .memora，2026-09-07 伪建表根治：防 LLM 搜到数据目录内任务表文件自我强化）
      expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
        '**/*.ts',
        '**/.git/**,**/node_modules/**,**/.memora/**,**/dist/**,**/coverage/**,**/.next/**',
        100,
      );
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
      expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
        '**/*',
        '**/.git/**,**/node_modules/**,**/.memora/**,**/dist/**,**/coverage/**,**/.next/**',
        100,
      );
    });

    it('Windows 反斜杠统一为正斜杠（与 read_file 相对路径语义对齐）', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
        { fsPath: 'C:\\proj\\src\\index.ts' },
      ] as never);
      const provider = createVscodeProjectSearchProvider('C:\\proj');
      const result = await provider.searchFiles({});
      expect(result).toEqual([{ path: 'src/index.ts' }]);
    });

    it('用户 exclude 与默认忽略目录合并后传给 findFiles', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([] as never);
      const provider = createVscodeProjectSearchProvider(root);
      await provider.searchFiles({ query: '**/*.ts', exclude: 'docs/**' });
      expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
        '**/*.ts',
        '**/.git/**,**/node_modules/**,**/.memora/**,**/dist/**,**/coverage/**,**/.next/**,docs/**',
        100,
      );
    });

    it('maxResults 限制在 100 内（防结果刷屏）', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([] as never);
      const provider = createVscodeProjectSearchProvider(root);
      await provider.searchFiles({ maxResults: 999 });
      expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
        '**/*',
        '**/.git/**,**/node_modules/**,**/.memora/**,**/dist/**,**/coverage/**,**/.next/**',
        100,
      );
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

    it('默认忽略 + exclude 独立叠加：exclude 无法取消默认忽略（G5 合并语义）', async () => {
      // 即使显式用 exclude 试图"取消忽略" node_modules，默认忽略仍无条件生效（AND 叠加）
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO', exclude: '!node_modules' });
      expect(result.some((m) => m.path.startsWith('node_modules'))).toBe(false);
      // 非默认忽略目录不受影响：docs 仍可通过 exclude 命中排除
      mkdirSync(join(tmp, 'docs'), { recursive: true });
      writeFileSync(join(tmp, 'docs/guide.md'), 'TODO guide\n', 'utf-8');
      const filtered = await provider.searchText({ pattern: 'TODO', exclude: 'docs' });
      expect(filtered.some((m) => m.path.startsWith('docs'))).toBe(false);
    });

    it('无命中时返回空数组', async () => {
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: '绝不存在的关键词xyz' });
      expect(result).toEqual([]);
    });

    it('glob exclude 通配（**）跳过整棵子树', async () => {
      mkdirSync(join(tmp, 'src/sub'), { recursive: true });
      writeFileSync(join(tmp, 'src/sub/a.ts'), 'TODO in nested\n', 'utf-8');
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO', exclude: 'src/**' });
      const paths = result.map((m) => m.path);
      // src 整棵子树被排除（含嵌套），README 仍命中
      expect(paths).not.toContain('src/index.ts');
      expect(paths).not.toContain('src/sub/a.ts');
      expect(paths).toContain('README.md');
    });

    it('达到结果上限时携带 truncated 标记（截断诚实化）', async () => {
      // 造 5 个命中文件，请求上限 3 → 达上限提前停止并置 truncated
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(tmp, `src/file${i}.ts`), `TODO item ${i}\n`, 'utf-8');
      }
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO', maxResults: 3 });
      expect(result.length).toBe(3);
      // 每条结果携带全局截断标记，供内核提示 LLM 勿误判「项目仅此这些」
      expect(result.every((m) => m.truncated)).toBe(true);
    });

    it('单文件命中数上限（MAX_MATCHES_PER_FILE=3，防单文件刷屏）', async () => {
      const many = 'TODO a\nTODO b\nTODO c\nTODO d\nTODO e\n';
      writeFileSync(join(tmp, 'src/many.ts'), many, 'utf-8');
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO' });
      const manyHits = result.filter((m) => m.path === 'src/many.ts');
      expect(manyHits.length).toBe(3);
    });

    it('mtime 快照缓存：文件修改后重新搜索返回新内容（缓存按 mtime 失效）', async () => {
      const provider = createVscodeProjectSearchProvider(tmp);
      // 首次扫描：填充缓存（当前内容无 NEW_FLAG）
      await provider.searchText({ pattern: '缓存前' });
      // 修改文件内容后再次搜索：mtime 变化使缓存失效，应读到新内容
      writeFileSync(join(tmp, 'src/index.ts'), 'export const NEW_FLAG = 1;\n', 'utf-8');
      // 等待 mtime 变化（同毫秒写入可能 mtimeMs 相同导致缓存漏检）
      await new Promise((r) => setTimeout(r, 20));
      const result = await provider.searchText({ pattern: 'NEW_FLAG' });
      expect(result.some((m) => m.path === 'src/index.ts' && m.preview?.includes('NEW_FLAG'))).toBe(true);
    });
  });
});
