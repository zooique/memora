/**
 * VscodeProjectSearchProvider 单元测试
 *
 * 覆盖：
 *   - searchFiles：mock vscode.workspace.findFiles（stable API），返回相对项目根 posix 路径
 *   - searchFiles：query 省略时默认列出项目全部文件
 *   - searchFiles：Windows 反斜杠统一为正斜杠
 *   - searchText：真实临时目录 fs 扫描（content 模式 = 宿主 Node fs 受限实现）
 *     · 按关键词命中 路径:行号:预览 / 大小写不敏感 / exclude 过滤 / 忽略标准目录 / mtime 缓存
 *     · 诚实化上报：截断与主因 / 已扫文件数 / 部分检索数 / 读取失败数 / 单文件上限精确判定
 *     · 精确优先 + 零命中回退：整串命中不放宽，整串零命中才用内核下发的 terms 放宽
 *     · 🔴 Canary：自埋唯一 token 必被搜到（仪器自检——"你从没见它非零过的零不是证据"）
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

// 模拟 OS 级「不可读」：本环境**造不出**真不可读文件（实测三条路全断——
// ① chmod 0o000 后 readFileSync 仍成功；② symlinkSync 在临时目录静默失败（existsSync=false、
// readdir 不列该项）；③ 在仓库目录则退化为空文件（stat 成功）。故对 stat/open 打桩抛 EACCES。
const { failStat, failOpen } = vi.hoisted(() => ({
  failStat: new Set<string>(),
  failOpen: new Set<string>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  type FsPromises = typeof import('node:fs/promises');
  const actual = await importOriginal<FsPromises>();
  const denied = (p: string) =>
    Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
  return {
    ...actual,
    stat: (p: Parameters<FsPromises['stat']>[0]) =>
      failStat.has(String(p)) ? Promise.reject(denied(String(p))) : actual.stat(p),
    open: (p: Parameters<FsPromises['open']>[0]) =>
      failOpen.has(String(p)) ? Promise.reject(denied(String(p))) : actual.open(p, 'r'),
  };
});

import { createVscodeProjectSearchProvider } from '../projectSearchProvider.js';

/** 建一个独立临时项目目录（调用方负责 finally 里 rmSync） */
function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'memora-search-'));
}

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
      // 默认排除 IGNORED_DIR_NAMES（含 .memora，防 LLM 搜到数据目录内任务表文件自我强化）
      expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
        '**/*.ts',
        '**/.git/**,**/node_modules/**,**/.memora/**,**/dist/**,**/coverage/**,**/.next/**',
        100,
      );
      expect(result.matches).toEqual([
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
      expect(result.matches).toEqual([{ path: 'src/index.ts' }]);
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

    it('裸词零命中且下发 terms：按名称子串 OR 放宽并回报 relaxed/termsUsed', async () => {
      const provider = createVscodeProjectSearchProvider(root);
      // 第一轮 query 原样 glob 零命中；第二轮才按词包 `**/*{term}*/` 子串命中
      vi.mocked(vscode.workspace.findFiles)
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([{ fsPath: 'C:/proj/product.md' }] as never);
      const result = await provider.searchFiles({ query: 'product', terms: ['product'] });
      expect(result.matches).toEqual([{ path: 'product.md' }]);
      expect(result.relaxed).toBe(true); // 放宽只发生在第二轮
      expect(result.termsUsed).toEqual(['product']); // 唯一真值 = 宿主回报
      // 放宽轮用名称子串 glob（相对路径、正斜杠语义一致）
      expect(vscode.workspace.findFiles).toHaveBeenLastCalledWith(
        '**/*product*/',
        '**/.git/**,**/node_modules/**,**/.memora/**,**/dist/**,**/coverage/**,**/.next/**',
        100,
      );
    });

    it('裸词零命中但未下发 terms：不进入放宽（可信零）', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([] as never);
      const provider = createVscodeProjectSearchProvider(root);
      const result = await provider.searchFiles({ query: 'product' });
      expect(result.matches).toEqual([]);
      expect(result.relaxed).toBeUndefined();
      expect(vscode.workspace.findFiles).toHaveBeenCalledTimes(1); // 仅精确一轮
    });

    it('query 含 glob 元字符零命中：不进入放宽（保 glob 语义）', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([] as never);
      const provider = createVscodeProjectSearchProvider(root);
      // 即使宿主收到 terms，"*.md" 含元字符 → 精确 glob 语义优先，不放宽
      const result = await provider.searchFiles({ query: '*.md', terms: ['md'] });
      expect(result.matches).toEqual([]);
      expect(result.relaxed).toBeUndefined();
      expect(vscode.workspace.findFiles).toHaveBeenCalledTimes(1);
    });

    it('首轮即命中时不进入放宽（保持精度）', async () => {
      vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([
        { fsPath: 'C:/proj/src/index.ts' },
      ] as never);
      const provider = createVscodeProjectSearchProvider(root);
      const result = await provider.searchFiles({ query: '**/*.ts', terms: ['ts'] });
      expect(result.matches).toEqual([{ path: 'src/index.ts' }]);
      expect(result.relaxed).toBeUndefined();
      expect(result.termsUsed).toBeUndefined();
      expect(vscode.workspace.findFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('searchText（按内容全文搜索，宿主 Node fs 受限实现）', () => {
    let tmp: string;

    beforeEach(() => {
      tmp = makeTmp();
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
      const paths = result.matches.map((m) => m.path);
      expect(paths).toContain('src/index.ts');
      expect(paths).toContain('src/utils.ts');
      expect(paths).toContain('README.md');
      expect(paths).not.toContain('node_modules/ignored.ts');
      // 行号 1 起 + 预览片段
      const indexHit = result.matches.find((m) => m.path === 'src/index.ts')!;
      expect(indexHit.line).toBe(2);
      expect(indexHit.preview).toContain('TODO');
    });

    it('scannedFiles = 实际参与匹配的文件数（不可读不计入；"部分检索"计入）', async () => {
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO' });
      // 语料 = README.md + src/index.ts + src/utils.ts（node_modules 整目录忽略）
      expect(result.scannedFiles).toBe(3);
      expect(result.truncated).toBe(false);
      expect(result.truncatedBy).toBeUndefined();
      // 反向守卫：无缺口时不得凭空报数（否则"诚实"沦为噪音，与"永远喊截断"同病）
      expect(result.partialReadFiles).toBeUndefined();
      expect(result.unreadableSkipped).toBeUndefined();
    });

    it('大小写不敏感匹配（对齐全局搜索缺省）', async () => {
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'todo' });
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it('exclude 路径段过滤（排除 docs 目录）', async () => {
      mkdirSync(join(tmp, 'docs'), { recursive: true });
      writeFileSync(join(tmp, 'docs/guide.md'), 'TODO guide\n', 'utf-8');
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO', exclude: 'docs' });
      const paths = result.matches.map((m) => m.path);
      expect(paths).not.toContain('docs/guide.md');
      expect(paths).toContain('README.md');
    });

    it('忽略 node_modules 目录（对齐内核 list_dir 忽略规则）', async () => {
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO' });
      expect(result.matches.some((m) => m.path.startsWith('node_modules'))).toBe(false);
    });

    it('默认忽略 + exclude 独立叠加：exclude 无法取消默认忽略（G5 合并语义）', async () => {
      // 即使显式用 exclude 试图"取消忽略" node_modules，默认忽略仍无条件生效（AND 叠加）
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO', exclude: '!node_modules' });
      expect(result.matches.some((m) => m.path.startsWith('node_modules'))).toBe(false);
      // 非默认忽略目录不受影响：docs 仍可通过 exclude 命中排除
      mkdirSync(join(tmp, 'docs'), { recursive: true });
      writeFileSync(join(tmp, 'docs/guide.md'), 'TODO guide\n', 'utf-8');
      const filtered = await provider.searchText({ pattern: 'TODO', exclude: 'docs' });
      expect(filtered.matches.some((m) => m.path.startsWith('docs'))).toBe(false);
    });

    it('无命中时返回空列表，且截断字段如实为 false（反向守卫：宿主不得"永远喊截断"）', async () => {
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: '绝不存在的关键词xyz' });
      expect(result.matches).toEqual([]);
      expect(result.truncated).toBe(false);
      expect(result.truncatedBy).toBeUndefined();
      expect(result.failed).toBeUndefined();
    });

    it('glob exclude 通配（**）跳过整棵子树', async () => {
      mkdirSync(join(tmp, 'src/sub'), { recursive: true });
      writeFileSync(join(tmp, 'src/sub/a.ts'), 'TODO in nested\n', 'utf-8');
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO', exclude: 'src/**' });
      const paths = result.matches.map((m) => m.path);
      // src 整棵子树被排除（含嵌套），README 仍命中
      expect(paths).not.toContain('src/index.ts');
      expect(paths).not.toContain('src/sub/a.ts');
      expect(paths).toContain('README.md');
    });

    it('达到结果上限时上报 truncated + truncatedBy="results"（截断诚实化）', async () => {
      // 造 5 个命中文件，请求上限 3 → 达上限提前停止并记录主因
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(tmp, `src/file${i}.ts`), `TODO item ${i}\n`, 'utf-8');
      }
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO', maxResults: 3 });
      expect(result.matches.length).toBe(3);
      expect(result.truncated).toBe(true);
      expect(result.truncatedBy).toBe('results');
    });

    it('单文件命中数上限（MAX_MATCHES_PER_FILE=3）+ perFileCapped 精确判定', async () => {
      writeFileSync(join(tmp, 'src/many.ts'), 'TODO a\nTODO b\nTODO c\nTODO d\nTODO e\n', 'utf-8');
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO' });
      expect(result.matches.filter((m) => m.path === 'src/many.ts').length).toBe(3);
      // 真有第 4 条命中 → 精确置位（不是"可能还有"的保守猜测）
      expect(result.perFileCapped).toBe(true);
    });

    it('恰好命中 3 条时不置 perFileCapped（精确判定的反向守卫）', async () => {
      writeFileSync(join(tmp, 'src/exact.ts'), 'TODO a\nTODO b\nTODO c\n', 'utf-8');
      const provider = createVscodeProjectSearchProvider(tmp);
      const result = await provider.searchText({ pattern: 'TODO' });
      expect(result.matches.filter((m) => m.path === 'src/exact.ts').length).toBe(3);
      expect(result.perFileCapped).toBeUndefined();
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
      expect(result.matches.some((m) => m.path === 'src/index.ts' && m.preview?.includes('NEW_FLAG'))).toBe(
        true,
      );
    });
  });

  describe('searchText · 诚实化上报与放宽', () => {
    it('🔴 Canary：自埋唯一 token 必被搜到（仪器自检）', async () => {
      // 依据："你从没见它非零过的零，不是证据"——先证仪器可用，再谈"没搜到"是否可信
      const tmp = makeTmp();
      try {
        const token = 'CANARY_TOKEN_9f3a1c';
        writeFileSync(join(tmp, 'canary.md'), `# 自埋标记\n${token}\n`, 'utf-8');
        const provider = createVscodeProjectSearchProvider(tmp);
        const result = await provider.searchText({ pattern: token });
        expect(result.matches.map((m) => m.path)).toContain('canary.md');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('大文件（>64KB）不再整文件跳过：前段 token 可命中 + 上报 partialReadFiles（F4-full）', async () => {
      const tmp = makeTmp();
      try {
        // token 在**前 64KB 内**（文件总长 70KB）→ S2 可搜到；S1 时该文件被整文件跳过、必然搜不到
        writeFileSync(join(tmp, 'big.md'), `needle_front\n${'x'.repeat(70 * 1024)}\n`, 'utf-8');
        const provider = createVscodeProjectSearchProvider(tmp);
        const result = await provider.searchText({ pattern: 'needle_front' });
        expect(result.matches.map((m) => m.path)).toEqual(['big.md']);
        expect(result.partialReadFiles).toBe(1); // 参与了检索，但只覆盖前一部分
        expect(result.scannedFiles).toBe(1); // 计入已扫（确实被搜过，不是被跳过）
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('大文件后半段的词仍搜不到，但覆盖缺口必须上报（F4-full 的诚实边界：搜不到 ≠ 不存在）', async () => {
      const tmp = makeTmp();
      try {
        // token 在 64KB **之后**（只搜前 64KB → 必然搜不到）
        writeFileSync(join(tmp, 'big.md'), `${'x'.repeat(70 * 1024)}\nneedle_tail\n`, 'utf-8');
        const provider = createVscodeProjectSearchProvider(tmp);
        const result = await provider.searchText({ pattern: 'needle_tail' });
        expect(result.matches).toEqual([]); // 搜不到是事实
        expect(result.partialReadFiles).toBe(1); // 但必须说明"没看全"，否则又是静默假阴性
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('部分读按 UTF-8 边界收口：横跨读取上限的不完整残行被整行丢弃（不留 U+FFFD 污染）', async () => {
      const tmp = makeTmp();
      try {
        // 对照组：同一个 token 也在小文件里 → 证明"big.md 没命中"是收口所致，而非压根没读它
        writeFileSync(join(tmp, 'small.md'), 'needle_boundary\n', 'utf-8');
        // big.md：65494 个 'a' + 换行 = 65495 字节；残行从边界**前**开始并**横跨** 64KB 上限，
        // 且无结尾换行 —— 未收口时残行会被读到并命中（变异验证：去掉换行回退 → 本断言变红）
        const head = `${'a'.repeat(65494)}\n`;
        writeFileSync(join(tmp, 'big.md'), head + 'needle_boundary中文'.repeat(20), 'utf-8');
        const provider = createVscodeProjectSearchProvider(tmp);
        const result = await provider.searchText({ pattern: 'needle_boundary' });
        expect(result.matches.map((m) => m.path)).toEqual(['small.md']); // 残行不产出命中
        expect(result.partialReadFiles).toBe(1);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('不可读文件（stat 抛 EACCES）计入 unreadableSkipped 而非静默跳过（修 P5）', async () => {
      const tmp = makeTmp();
      const locked = join(tmp, 'locked.md');
      try {
        writeFileSync(join(tmp, 'ok.md'), 'needle_ok\n', 'utf-8');
        writeFileSync(locked, 'needle_locked\n', 'utf-8');
        failStat.add(locked); // 模拟 OS 级不可读（真不可读在本环境造不出，见文件头注释）
        const provider = createVscodeProjectSearchProvider(tmp);
        const result = await provider.searchText({ pattern: 'needle_ok' });
        expect(result.matches.map((m) => m.path)).toEqual(['ok.md']);
        expect(result.unreadableSkipped).toBe(1);
        expect(result.scannedFiles).toBe(1); // 完全没读上的不计入已扫
      } finally {
        failStat.delete(locked);
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('open 失败与「部分检索」分别上报（修 P5 / F4-full：两者补救动作不同，不可混为一谈）', async () => {
      const tmp = makeTmp();
      const broken = join(tmp, 'broken-read.md');
      try {
        writeFileSync(join(tmp, 'big.md'), `needle_front\n${'x'.repeat(70 * 1024)}\n`, 'utf-8');
        writeFileSync(broken, 'needle_broken\n', 'utf-8');
        failOpen.add(broken); // stat 成功但读不了 —— 与「过大」完全是两回事
        const provider = createVscodeProjectSearchProvider(tmp);
        const result = await provider.searchText({ pattern: 'needle_front' });
        expect(result.matches.map((m) => m.path)).toEqual(['big.md']);
        expect(result.unreadableSkipped).toBe(1); // 读取失败：完全没参与检索
        expect(result.partialReadFiles).toBe(1); // 过大：参与了，但只覆盖前一部分
      } finally {
        failOpen.delete(broken);
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('整串零命中 → 用内核下发的 terms 放宽，并回填 relaxed/termsUsed（修 F1）', async () => {
      const tmp = makeTmp();
      try {
        writeFileSync(join(tmp, 'a.md'), '核心能力清单\n', 'utf-8');
        writeFileSync(join(tmp, 'b.md'), '愿景与实现\n', 'utf-8');
        const provider = createVscodeProjectSearchProvider(tmp);

        // ① 不给 terms：整串 `核心 愿景` 无此连续子串 → 零命中（现状行为）
        const strict = await provider.searchText({ pattern: '核心 愿景' });
        expect(strict.matches).toEqual([]);
        expect(strict.relaxed).toBeUndefined();

        // ② 给了 terms：放宽为 OR → 两个文件都命中，且如实标注"非精确命中"
        const relaxed = await provider.searchText({ pattern: '核心 愿景', terms: ['核心', '愿景'] });
        expect(relaxed.matches.map((m) => m.path)).toEqual(['a.md', 'b.md']);
        expect(relaxed.relaxed).toBe(true);
        expect(relaxed.termsUsed).toEqual(['核心', '愿景']);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('验收 §六.1：`核心|愿景` / `核心 愿景` / `核心/愿景` 三种写法放宽后命中条数相同且 > 0', async () => {
      const tmp = makeTmp();
      try {
        writeFileSync(join(tmp, 'a.md'), '核心能力清单\n', 'utf-8');
        writeFileSync(join(tmp, 'b.md'), '愿景与实现\n', 'utf-8');
        const provider = createVscodeProjectSearchProvider(tmp);
        const terms = ['核心', '愿景'];
        const counts: number[] = [];
        for (const pattern of ['核心|愿景', '核心 愿景', '核心/愿景']) {
          const r = await provider.searchText({ pattern, terms });
          counts.push(r.matches.length);
        }
        expect(counts).toEqual([2, 2, 2]);
        expect(counts.every((c) => c > 0)).toBe(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('整串命中时不再放宽（保持精度：不把精确命中变成"可能不是精确命中"）', async () => {
      const tmp = makeTmp();
      try {
        writeFileSync(join(tmp, 'a.md'), '核心 愿景 都在这行\n', 'utf-8');
        const provider = createVscodeProjectSearchProvider(tmp);
        const result = await provider.searchText({ pattern: '核心 愿景', terms: ['核心', '愿景'] });
        expect(result.matches.map((m) => m.path)).toEqual(['a.md']);
        expect(result.relaxed).toBeUndefined();
        expect(result.termsUsed).toBeUndefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // 本用例建 501 个真实文件并走满 500 次扫描（隔离态 ≈0.9s），默认 5s 上限在
    // 与其他测试套件并发 / 磁盘争用时会被 I/O 拖爆（非逻辑失败）→ 显式放宽上限。
    it('扫描达文件上限（500）时上报 truncatedBy="files"（F2：没搜完 ≠ 没搜到）', async () => {
      const tmp = makeTmp();
      try {
        const many = join(tmp, 'many');
        mkdirSync(many, { recursive: true });
        for (let i = 0; i < 501; i++) {
          writeFileSync(join(many, `f${String(i).padStart(4, '0')}.txt`), 'nothing here\n', 'utf-8');
        }
        const provider = createVscodeProjectSearchProvider(tmp);
        const result = await provider.searchText({ pattern: '绝不出现的词', maxResults: 20 });
        expect(result.matches).toEqual([]);
        expect(result.truncated).toBe(true);
        expect(result.truncatedBy).toBe('files');
        expect(result.scannedFiles).toBe(500);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
