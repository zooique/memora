/**
 * BuiltinToolHandlers 单元测试 — 内置工具处理器
 *
 * 覆盖范围：
 *   - 路径安全：resolveSafePath（绝对/相对路径解析）+ guardPathOrThrow（白名单校验 + 错误包装）
 *   - readFile：参数校验 + 路径校验 + 读取成功 + workProjection 触发 + ENOENT + 其他错误
 *   - writeFile：参数校验（path/content/mode/insert_line）+ 3 模式（overwrite/append/insert）+ 确认流程（extensions.onBeforeWrite + security 回退）+ 父目录创建 + 返回格式
 *   - listDir：路径校验 + recursive + maxDepth + 忽略列表 + 空目录 + ENOENT + 非目录
 *   - searchMemories：参数校验 + limit + mode（match/near）+ 空结果 + 格式化
 *
 * 测试范式：真实临时目录（mkdtemp）+ 真实 SecurityGuard + InMemoryStorage + 真实文件 I/O，
 * 避免 mock fs 导致测试与实现耦合。workProjection 用 mock 对象验证 fire-and-forget 调用。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BuiltinToolHandlers } from '@/agent/builtinToolHandlers.js';
import { SecurityGuard, type WriteConfirmationInfo } from '@/security/pathGuard.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { MemoraError, ToolErrorCode } from '@/utils/errors.js';
import type { Memory } from '@/memory/types.js';
import type { WorkProjectionManager } from '@/agent/managers/workProjection.js';

// ─── 测试夹具 ─────────────────────────────────────────────

/** 临时项目根目录（每个 it 重建） */
let projectPath: string;
/** 真实 SecurityGuard（projectPath 在白名单内） */
let security: SecurityGuard;
/** InMemoryStorage（searchMemories 数据源） */
let storage: InMemoryStorage;
/** mock workProjection（验证 fire-and-forget 调用） */
let workProjection: { ensureProjection: ReturnType<typeof vi.fn> };
/** 被测对象 */
let handlers: BuiltinToolHandlers;

beforeEach(async () => {
  // 创建临时项目目录
  projectPath = await mkdtemp(join(tmpdir(), 'memora-builtin-'));
  // 真实 SecurityGuard：projectPath 在白名单内，confirmWrites=false 自动确认
  security = new SecurityGuard(projectPath, projectPath);
  storage = new InMemoryStorage();
  // mock workProjection：ensureProjection 返回 resolved Promise（fire-and-forget）
  workProjection = { ensureProjection: vi.fn().mockResolvedValue(undefined) };
  handlers = new BuiltinToolHandlers(
    projectPath,
    security,
    storage,
    workProjection as unknown as WorkProjectionManager,
  );
});

afterEach(async () => {
  // 清理临时目录
  await rm(projectPath, { recursive: true, force: true });
});

/**
 * 构造 Memory 对象（默认 source=insight, score=0.5）
 * @param overrides - 字段覆写
 * @returns 完整 Memory 对象
 */
function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:default',
    content: '默认内容',
    source: 'insight',
    name: 'default',
    createdAt: '2026-06-27T10:00:00.000Z',
    accessedAt: '2026-06-27T10:00:00.000Z',
    score: 0.5,
    ...overrides,
  };
}

/**
 * 在临时项目目录内创建文件并写入内容
 * @param relPath - 相对项目根的路径
 * @param content - 文件内容
 */
async function createFileInProject(relPath: string, content: string): Promise<void> {
  const abs = join(projectPath, relPath);
  const dir = resolve(abs, '..');
  await mkdir(dir, { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

// ─── 路径安全：resolveSafePath ────────────────────────────

describe('BuiltinToolHandlers.resolveSafePath', () => {
  it('绝对路径原样返回', () => {
    const abs = resolve(projectPath, 'subdir');
    expect(handlers.resolveSafePath(abs)).toBe(abs);
  });

  it('相对路径基于 projectPath 解析', () => {
    expect(handlers.resolveSafePath('foo/bar')).toBe(resolve(projectPath, 'foo/bar'));
  });

  it('"." 解析为 projectPath', () => {
    expect(handlers.resolveSafePath('.')).toBe(resolve(projectPath, '.'));
  });
});

// ─── 路径安全：guardPathOrThrow ───────────────────────────

describe('BuiltinToolHandlers.guardPathOrThrow', () => {
  it('白名单内路径不抛错', () => {
    const abs = join(projectPath, 'file.txt');
    expect(() => handlers.guardPathOrThrow(abs, 'read_file')).not.toThrow();
  });

  it('白名单外路径抛 MemoraError', () => {
    const outside = resolve(tmpdir(), 'memora-outside-' + Date.now());
    expect(() => handlers.guardPathOrThrow(outside, 'read_file')).toThrow(MemoraError);
  });

  it('错误码为 PATH_NOT_ALLOWED', () => {
    const outside = resolve(tmpdir(), 'memora-outside-' + Date.now());
    try {
      handlers.guardPathOrThrow(outside, 'read_file');
    } catch (err) {
      expect(err).toBeInstanceOf(MemoraError);
      expect((err as MemoraError).errorCode).toBe(ToolErrorCode.PATH_NOT_ALLOWED);
    }
  });
});

// ─── readFile ────────────────────────────────────────────

describe('BuiltinToolHandlers.readFile', () => {
  it('空 path 抛 ARGUMENT_ERROR', async () => {
    await expect(handlers.readFile('')).rejects.toMatchObject({
      errorCode: ToolErrorCode.ARGUMENT_ERROR,
    });
  });

  it('读取成功返回文件内容', async () => {
    await createFileInProject('test.txt', 'hello world');
    const result = await handlers.readFile('test.txt');
    expect(result).toBe('hello world');
  });

  it('读取成功触发 workProjection.ensureProjection', async () => {
    await createFileInProject('novel.md', '第一章内容');
    await handlers.readFile('novel.md');
    expect(workProjection.ensureProjection).toHaveBeenCalledTimes(1);
    // 验证参数：absolutePath, content, relativePath
    const callArgs = workProjection.ensureProjection.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs![1]).toBe('第一章内容');
    expect(callArgs![2]).toBe('novel.md');
  });

  it('ENOENT 抛 FILE_NOT_FOUND', async () => {
    await expect(handlers.readFile('not-exist.txt')).rejects.toMatchObject({
      errorCode: ToolErrorCode.FILE_NOT_FOUND,
    });
  });

  it('无 workProjection 时不抛错', async () => {
    // 构造无 workProjection 的 handler
    const handlerNoProj = new BuiltinToolHandlers(projectPath, security, storage);
    await createFileInProject('no-proj.txt', '内容');
    const result = await handlerNoProj.readFile('no-proj.txt');
    expect(result).toBe('内容');
  });
});

// ─── writeFile ───────────────────────────────────────────

describe('BuiltinToolHandlers.writeFile', () => {
  describe('参数校验', () => {
    it('空 path 抛 ARGUMENT_ERROR', async () => {
      await expect(handlers.writeFile('', '内容')).rejects.toMatchObject({
        errorCode: ToolErrorCode.ARGUMENT_ERROR,
      });
    });

    it('非 string content 抛 ARGUMENT_ERROR', async () => {
      await expect(
        handlers.writeFile('test.txt', 123 as unknown as string),
      ).rejects.toMatchObject({ errorCode: ToolErrorCode.ARGUMENT_ERROR });
    });

    it('无效 mode 抛 ARGUMENT_ERROR', async () => {
      await expect(
        handlers.writeFile('test.txt', '内容', undefined, 'invalid-mode'),
      ).rejects.toMatchObject({ errorCode: ToolErrorCode.ARGUMENT_ERROR });
    });

    it('insert 模式缺 insertLine 抛 ARGUMENT_ERROR', async () => {
      await expect(
        handlers.writeFile('test.txt', '内容', undefined, 'insert'),
      ).rejects.toMatchObject({ errorCode: ToolErrorCode.ARGUMENT_ERROR });
    });
  });

  describe('overwrite 模式', () => {
    it('新文件写入成功', async () => {
      const result = await handlers.writeFile('new.txt', '新内容');
      expect(result).toContain('已写入');
      expect(result).toContain('新文件');
      // 验证文件实际写入
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(projectPath, 'new.txt'), 'utf-8');
      expect(content).toBe('新内容');
    });

    it('旧文件覆盖', async () => {
      await createFileInProject('exist.txt', '旧内容');
      const result = await handlers.writeFile('exist.txt', '新内容');
      expect(result).toContain('旧文件');
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(projectPath, 'exist.txt'), 'utf-8');
      expect(content).toBe('新内容');
    });
  });

  describe('append 模式', () => {
    it('新文件等同 overwrite', async () => {
      const result = await handlers.writeFile('new.txt', '内容', undefined, 'append');
      expect(result).toContain('新文件');
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(projectPath, 'new.txt'), 'utf-8');
      expect(content).toBe('内容');
    });

    it('旧文件追加', async () => {
      await createFileInProject('exist.txt', '旧内容');
      await handlers.writeFile('exist.txt', '+追加', undefined, 'append');
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(projectPath, 'exist.txt'), 'utf-8');
      expect(content).toBe('旧内容+追加');
    });
  });

  describe('insert 模式', () => {
    it('新文件等同 overwrite', async () => {
      const result = await handlers.writeFile(
        'new.txt',
        '内容',
        undefined,
        'insert',
        '1',
      );
      expect(result).toContain('新文件');
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(projectPath, 'new.txt'), 'utf-8');
      expect(content).toBe('内容');
    });

    it('旧行号前插入', async () => {
      await createFileInProject('exist.txt', 'line1\nline2\nline3');
      await handlers.writeFile('exist.txt', 'INSERTED', undefined, 'insert', '2');
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(projectPath, 'exist.txt'), 'utf-8');
      expect(content).toBe('line1\nINSERTED\nline2\nline3');
    });

    it('行号超出范围追加到末尾', async () => {
      await createFileInProject('exist.txt', 'line1\nline2');
      await handlers.writeFile('exist.txt', 'END', undefined, 'insert', '100');
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(projectPath, 'exist.txt'), 'utf-8');
      expect(content).toBe('line1\nline2\nEND');
    });

    it('insertLine 非正整数抛 ARGUMENT_ERROR', async () => {
      await createFileInProject('exist.txt', 'line1');
      await expect(
        handlers.writeFile('exist.txt', '内容', undefined, 'insert', '0'),
      ).rejects.toMatchObject({ errorCode: ToolErrorCode.ARGUMENT_ERROR });
    });
  });

  describe('写入确认流程', () => {
    it('extensions.onBeforeWrite ok=true 写入成功', async () => {
      const extensions = { onBeforeWrite: vi.fn().mockResolvedValue(true) };
      await handlers.writeFile('test.txt', '内容', extensions);
      expect(extensions.onBeforeWrite).toHaveBeenCalledTimes(1);
    });

    it('extensions.onBeforeWrite ok=false 抛 WRITE_REJECTED', async () => {
      const extensions = { onBeforeWrite: vi.fn().mockResolvedValue(false) };
      await expect(handlers.writeFile('test.txt', '内容', extensions)).rejects.toMatchObject({
        errorCode: ToolErrorCode.WRITE_REJECTED,
      });
    });

    it('extensions.onBeforeWrite 抛错 → 包装为 UNKNOWN', async () => {
      const extensions = { onBeforeWrite: vi.fn().mockRejectedValue(new Error('回调崩溃')) };
      await expect(handlers.writeFile('test.txt', '内容', extensions)).rejects.toMatchObject({
        errorCode: ToolErrorCode.UNKNOWN,
      });
    });

    it('无 extensions 回退 security.requestWriteConfirmation（confirmWrites=false 自动通过）', async () => {
      // 默认 security confirmWrites=false，requestWriteConfirmation 返回 true
      const result = await handlers.writeFile('test.txt', '内容');
      expect(result).toContain('已写入');
    });

    // ─── beforeContent/afterContent diff 透传 ──────────

    it('writeFile 应将 beforeContent/afterContent 透传给 requestWriteConfirmation', async () => {
      // 创建 confirmWrites=true 的 SecurityGuard，捕获 confirmationHandler 收到的 info
      const confirmGuard = new SecurityGuard(projectPath, projectPath, [], true, 'owner');
      const received: WriteConfirmationInfo[] = [];
      confirmGuard.onWriteConfirmation(async (info) => {
        received.push(info);
        return true;
      });
      const confirmHandlers = new BuiltinToolHandlers(
        projectPath,
        confirmGuard,
        storage,
        workProjection as unknown as WorkProjectionManager,
      );

      // 先创建已有文件（beforeContent 非 null）
      await createFileInProject('exist.txt', '旧内容');

      // 写入新内容
      await confirmHandlers.writeFile('exist.txt', '新内容');

      // 验证 confirmationHandler 收到了正确的 beforeContent/afterContent
      expect(received).toHaveLength(1);
      expect(received[0]!.beforeContent).toBe('旧内容');
      expect(received[0]!.afterContent).toBe('新内容');
    });

    it('writeFile 新文件时 beforeContent 应为 null', async () => {
      const confirmGuard = new SecurityGuard(projectPath, projectPath, [], true, 'owner');
      const received: WriteConfirmationInfo[] = [];
      confirmGuard.onWriteConfirmation(async (info) => {
        received.push(info);
        return true;
      });
      const confirmHandlers = new BuiltinToolHandlers(
        projectPath,
        confirmGuard,
        storage,
        workProjection as unknown as WorkProjectionManager,
      );

      // 写入新文件（不存在 → beforeContent = null）
      await confirmHandlers.writeFile('new.txt', '新文件内容');

      expect(received).toHaveLength(1);
      expect(received[0]!.beforeContent).toBeNull();
      expect(received[0]!.afterContent).toBe('新文件内容');
    });
  });

  describe('父目录自动创建', () => {
    it('父目录不存在时自动创建', async () => {
      await handlers.writeFile('sub1/sub2/deep.txt', '深层文件');
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(projectPath, 'sub1/sub2/deep.txt'), 'utf-8');
      expect(content).toBe('深层文件');
    });
  });

  describe('返回格式', () => {
    it('overwrite 返回格式包含模式标签 + 字符数 + 行数', async () => {
      const result = await handlers.writeFile('test.txt', 'line1\nline2');
      expect(result).toContain('覆盖');
      expect(result).toContain('11 字符');
      expect(result).toContain('2 行');
      expect(result).toContain('新文件');
    });

    it('append 返回格式包含追加标签 + 旧行数', async () => {
      await createFileInProject('exist.txt', 'line1');
      const result = await handlers.writeFile('exist.txt', 'line2', undefined, 'append');
      expect(result).toContain('追加');
      expect(result).toContain('旧文件');
      expect(result).toContain('1 行'); // 旧行数
    });
  });
});

// ─── listDir ─────────────────────────────────────────────

describe('BuiltinToolHandlers.listDir', () => {
  it('路径不存在抛 DIR_NOT_FOUND', async () => {
    await expect(handlers.listDir('not-exist', 'false', '2')).rejects.toMatchObject({
      errorCode: ToolErrorCode.DIR_NOT_FOUND,
    });
  });

  it('路径是文件非目录抛 DIR_NOT_FOUND', async () => {
    await createFileInProject('file.txt', '内容');
    await expect(handlers.listDir('file.txt', 'false', '2')).rejects.toMatchObject({
      errorCode: ToolErrorCode.DIR_NOT_FOUND,
    });
  });

  it('recursive=false 只列出当前目录', async () => {
    await createFileInProject('a.txt', 'a');
    await createFileInProject('b.txt', 'b');
    await mkdir(join(projectPath, 'subdir'));
    const result = await handlers.listDir('.', 'false', '2');
    expect(result).toContain('a.txt');
    expect(result).toContain('b.txt');
    expect(result).toContain('subdir');
  });

  it('recursive=true 递归列出子目录', async () => {
    await createFileInProject('top.txt', 't');
    await createFileInProject('sub/nested.txt', 'n');
    const result = await handlers.listDir('.', 'true', '3');
    expect(result).toContain('top.txt');
    expect(result).toContain('nested.txt');
  });

  it('maxDepth 超过 3 截断为 3', async () => {
    await createFileInProject('a/b/c/d/e/deep.txt', 'deep');
    // maxDepth=100 → 截断为 3，深层文件不列出
    const result = await handlers.listDir('.', 'true', '100');
    expect(result).not.toContain('deep.txt');
  });

  it('maxDepth 非数字降级为 2', async () => {
    await createFileInProject('top.txt', 't');
    const result = await handlers.listDir('.', 'false', 'invalid');
    expect(result).toContain('top.txt');
  });

  it('忽略 .git/node_modules 等目录', async () => {
    await createFileInProject('visible.txt', 'v');
    await mkdir(join(projectPath, '.git'));
    await mkdir(join(projectPath, 'node_modules'));
    const result = await handlers.listDir('.', 'false', '2');
    expect(result).toContain('visible.txt');
    expect(result).not.toContain('.git');
    expect(result).not.toContain('node_modules');
  });

  it('空目录返回提示信息', async () => {
    const result = await handlers.listDir('.', 'false', '2');
    expect(result).toContain('目录为空');
  });

  it('返回格式包含目录路径 + 条目数', async () => {
    await createFileInProject('a.txt', 'a');
    const result = await handlers.listDir('.', 'false', '2');
    expect(result).toContain(projectPath);
    expect(result).toContain('1 个条目');
  });
});

// ─── searchMemories ──────────────────────────────────────

describe('BuiltinToolHandlers.searchMemories', () => {
  beforeEach(() => {
    // 灌入测试数据
    storage.upsert(
      createMemory({
        id: 'insight:1',
        content: 'TypeScript 是一门语言',
        name: 'ts-note',
        source: 'insight',
        score: 0.8,
      }),
    );
    storage.upsert(
      createMemory({
        id: 'insight:2',
        content: 'Python 也很流行',
        name: 'py-note',
        source: 'insight',
        score: 0.6,
      }),
    );
  });

  it('空 query 抛 ARGUMENT_ERROR', async () => {
    await expect(handlers.searchMemories('', '10', 'match')).rejects.toMatchObject({
      errorCode: ToolErrorCode.ARGUMENT_ERROR,
    });
  });

  it('match 模式：任一关键词命中', async () => {
    const result = await handlers.searchMemories('TypeScript', '10', 'match');
    expect(result).toContain('ts-note');
    expect(result).toContain('1 条');
  });

  it('near 模式：所有关键词必须命中', async () => {
    // "TypeScript 语言" 两个关键词，只有 insight:1 同时命中
    const result = await handlers.searchMemories('TypeScript 语言', '10', 'near');
    expect(result).toContain('ts-note');
    expect(result).not.toContain('py-note');
  });

  it('near 模式：单关键词等同于 match', async () => {
    const result = await handlers.searchMemories('Python', '10', 'near');
    expect(result).toContain('py-note');
  });

  it('limit 默认 10（NaN 降级）', async () => {
    const result = await handlers.searchMemories('语言', 'invalid', 'match');
    expect(result).toContain('找到');
  });

  it('limit 超过 50 截断为 50', async () => {
    // 验证不抛错即可（数据少，实际返回 2 条）
    const result = await handlers.searchMemories('语言', '100', 'match');
    expect(result).toContain('找到');
  });

  it('空结果返回提示信息', async () => {
    const result = await handlers.searchMemories('不存在的关键词', '10', 'match');
    expect(result).toContain('未找到');
  });

  it('返回格式包含序号 + source:name + score + preview', async () => {
    const result = await handlers.searchMemories('TypeScript', '10', 'match');
    expect(result).toContain('[insight:ts-note]');
    expect(result).toContain('score=0.8');
    expect(result).toMatch(/1\.\s/);
  });

  it('preview 超 80 字符截断', async () => {
    const longContent = 'A'.repeat(100);
    storage.upsert(
      createMemory({
        id: 'insight:long',
        content: longContent,
        name: 'long-note',
        source: 'insight',
        score: 0.9,
      }),
    );
    const result = await handlers.searchMemories('A', '10', 'match');
    // preview 应为 80 字符 + …
    expect(result).toContain('A'.repeat(80) + '…');
  });
});
