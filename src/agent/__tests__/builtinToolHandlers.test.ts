/**
 * BuiltinToolHandlers 单元测试 — 内置工具处理器
 *
 * 覆盖范围：
 *   - 路径安全：resolveSafePath（绝对/相对路径解析）+ guardPathOrThrow（白名单校验 + 错误包装）
 *   - readFile：参数校验 + 路径校验 + 读取成功 + ENOENT + 其他错误（作品投影自动链已斩断，不再登记）
 *   - writeFile：参数校验（path/content/mode/insert_line）+ 3 模式（overwrite/append/insert）+ 确认流程（extensions.onBeforeWrite + security 回退）+ 父目录创建 + 返回格式
 *   - listDir：路径校验 + recursive + maxDepth + 忽略列表 + 空目录 + ENOENT + 非目录
 *   - searchMemories：参数校验 + limit + mode（match/near）+ 空结果 + 格式化
 *
 * 测试范式：真实临时目录（mkdtemp）+ 真实 SecurityGuard + InMemoryStorage + 真实文件 I/O，
 * 避免 mock fs 导致测试与实现耦合。作品投影改为用户主动触发（register_work 工具），
 * BuiltinToolHandlers 不再持有投影管理器，read_file 不再自动登记。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BuiltinToolHandlers } from '@/agent/builtinToolHandlers.js';
import { SecurityGuard, type WriteConfirmationInfo } from '@/security/pathGuard.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { MemoraError, ToolErrorCode } from '@/utils/errors.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { Memory } from '@/memory/types.js';
import type { ISessionStore, SessionMeta } from '@/memory/sessionStore.js';

// ─── 测试夹具 ─────────────────────────────────────────────

/** 临时项目根目录（每个 it 重建） */
let projectPath: string;
/** 真实 SecurityGuard（projectPath 在白名单内） */
let security: SecurityGuard;
/** InMemoryStorage（searchMemories 数据源） */
let storage: InMemoryStorage;
/** 被测对象 */
let handlers: BuiltinToolHandlers;

beforeEach(async () => {
  // 创建临时项目目录
  projectPath = await mkdtemp(join(tmpdir(), 'memora-builtin-'));
  // 真实 SecurityGuard：projectPath 在白名单内，confirmWrites=false 自动确认
  security = new SecurityGuard(projectPath, projectPath);
  storage = new InMemoryStorage();
  // 注：作品投影改为用户主动触发（register_work 工具），read_file 不再自动登记——BuiltinToolHandlers 不再持有投影管理器
  handlers = new BuiltinToolHandlers(projectPath, security, storage);
});

afterEach(async () => {
  // 清理临时目录
  await rm(projectPath, { recursive: true, force: true });
});

/**
 * 构造 Memory 对象（默认 source=content, score=0.5）
 * @param overrides - 字段覆写
 * @returns 完整 Memory 对象
 */
function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:default',
    content: '默认内容',
    source: 'content',
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

  it('ENOENT 抛 FILE_NOT_FOUND', async () => {
    await expect(handlers.readFile('not-exist.txt')).rejects.toMatchObject({
      errorCode: ToolErrorCode.FILE_NOT_FOUND,
    });
  });

  it('路径指向目录（EISDIR 场景）→ 抛可执行指引错误，而非原生 EISDIR', async () => {
    // read_file 语义是读文件：目标是目录时给出明确指引（LLM 据此改用 list_dir）
    await expect(handlers.readFile('.')).rejects.toMatchObject({
      errorCode: ToolErrorCode.ARGUMENT_ERROR,
    });
    // 错误 message 明确指明"目标是目录"（区别于原生 EISDIR，语义可执行）
    await expect(handlers.readFile('.')).rejects.toThrow(/目标是目录/);
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
        id: 'content:1',
        content: 'TypeScript 是一门语言',
        name: 'ts-note',
        source: 'content',
        score: 0.8,
      }),
    );
    storage.upsert(
      createMemory({
        id: 'content:2',
        content: 'Python 也很流行',
        name: 'py-note',
        source: 'content',
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
    // "TypeScript 语言" 两个关键词，只有 content:1 同时命中
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
    expect(result).toContain('[content:ts-note]');
    expect(result).toContain('score=0.8');
    expect(result).toMatch(/1\.\s/);
  });

  it('preview 超 80 字符截断', async () => {
    const longContent = 'A'.repeat(100);
    storage.upsert(
      createMemory({
        id: 'content:long',
        content: longContent,
        name: 'long-note',
        source: 'content',
        score: 0.9,
      }),
    );
    const result = await handlers.searchMemories('A', '10', 'match');
    // preview 应为 80 字符 + …
    expect(result).toContain('A'.repeat(80) + '…');
  });
});

// ─── listSessions 测试（会话路标，2026-08-30） ─────────────

describe('BuiltinToolHandlers.listSessions', () => {
  /** 构造会话存储桩：listSessions 只依赖 listSessions / getSessionMeta */
  function storeStub(
    metas: SessionMeta[],
    opts: { brokenId?: string } = {},
  ): ISessionStore {
    return {
      loadMessages: () => [],
      listSessions: () => metas.map((m) => m.sessionId),
      getRoundIds: () => [],
      setRoundIds: () => {},
      appendRoundId: () => {},
      appendRoundIds: () => {},
      createSession: () => {},
      deleteSession: () => {},
      getSessionMeta: (id) => {
        // 单个会话 meta 损坏：仅该条抛错，用于验证降级跳过而非整体失败
        if (opts.brokenId && id === opts.brokenId) throw new Error('meta 读取失败');
        return metas.find((m) => m.sessionId === id);
      },
      updateSessionMeta: () => {},
      listSessionMetas: () => [],
    };
  }

  const META_A: SessionMeta = {
    sessionId: '2026-08-01-older',
    autoName: '早期的会话',
    summary: '讨论 memora 的角色包设计',
    keyTopics: ['角色包', '架构'],
    updatedAt: '2026-08-01T10:00:00.000Z',
    messageCount: 8,
  };
  const META_B: SessionMeta = {
    sessionId: '2026-08-29-newer',
    displayName: '我改过的名字',
    summary: '排查小组会议上限问题',
    updatedAt: '2026-08-29T10:00:00.000Z',
    messageCount: 12,
  };

  it('列出会话路标：显示名 + 主题 + 摘要，按最近活跃降序', async () => {
    const h = new BuiltinToolHandlers(projectPath, security, storage, storeStub([META_A, META_B]));
    const result = await h.listSessions();
    // 新的在前
    expect(result.indexOf('2026-08-29-newer')).toBeLessThan(result.indexOf('2026-08-01-older'));
    expect(result).toContain('我改过的名字'); // displayName 优先
    expect(result).toContain('排查小组会议上限问题');
    expect(result).toContain('早期的会话'); // 无 displayName 回落 autoName
    expect(result).toContain('角色包 / 架构'); // keyTopics
    // 引导 LLM 下钻
    expect(result).toContain('trace_summary');
  });

  it('limit 生效：只显示最近 1 个并提示总数', async () => {
    const h = new BuiltinToolHandlers(projectPath, security, storage, storeStub([META_A, META_B]));
    const result = await h.listSessions('1');
    expect(result).toContain('2026-08-29-newer');
    expect(result).not.toContain('2026-08-01-older');
    expect(result).toContain('共 2 个会话');
  });

  it('limit 非法/越界回退默认值与上限', async () => {
    const h = new BuiltinToolHandlers(projectPath, security, storage, storeStub([META_A, META_B]));
    // 非法 → 默认 10（两个都列出）
    expect(await h.listSessions('abc')).toContain('2026-08-01-older');
    // 越界 → 限 30（仍全部列出，不报错）
    expect(await h.listSessions('999')).toContain('2026-08-01-older');
  });

  it('无 sessionStore 注入 → 降级说明文本，不抛错', async () => {
    // handlers 夹具未注入 sessionStore（与 traceSummary 的降级哲学一致）
    await expect(handlers.listSessions()).resolves.toContain('未配置会话存储');
  });

  it('空会话列表 → 暂无历史会话', async () => {
    const h = new BuiltinToolHandlers(projectPath, security, storage, storeStub([]));
    await expect(h.listSessions()).resolves.toContain('暂无历史会话');
  });

  it('单个会话 meta 损坏 → 跳过该条，其余照常列出（降级优先）', async () => {
    const h = new BuiltinToolHandlers(
      projectPath,
      security,
      storage,
      storeStub([META_A, META_B], { brokenId: '2026-08-29-newer' }),
    );
    const result = await h.listSessions();
    expect(result).toContain('2026-08-01-older');
    expect(result).not.toContain('2026-08-29-newer');
  });

  it('路标文本过 sanitize：控制字符被移除（防注入）', async () => {
    const dirty: SessionMeta = { ...META_A, summary: '摘要带\x1b[2J转义控制字符' };
    const h = new BuiltinToolHandlers(projectPath, security, storage, storeStub([dirty]));
    const result = await h.listSessions();
    expect(result).not.toContain('\x1b');
  });
});

// ─── traceSummary 测试 ──────────────────────────────────

describe('BuiltinToolHandlers.traceSummary', () => {
  const SESSION = '2026-08-13-main';
  const ROUND_A = 'round-1723456789000';
  const ROUND_B = 'round-1723456789001';

  beforeEach(() => {
    // 灌入轮次摘要数据到 storage
    storage.upsert(
      createMemory({
        id: `round-summary:${SESSION}:${ROUND_A}`,
        content: '用户询问 TypeScript 的用法，助手解释了接口和类型',
        source: SOURCE_LABELS.ROUND_SUMMARY,
        name: `轮次摘要 ${SESSION} ${ROUND_A}`,
        score: 0.5,
        summaryType: 'fact', sessionName: SESSION, roundId: ROUND_A,
      }),
    );
    storage.upsert(
      createMemory({
        id: `round-summary:${SESSION}:${ROUND_B}`,
        content: '用户表达了使用 React 的偏好，助手确认了技术选型方向',
        source: SOURCE_LABELS.ROUND_SUMMARY,
        name: `轮次摘要 ${SESSION} ${ROUND_B}`,
        score: 0.5,
        isModified: true,
        summaryType: 'preference', sessionName: SESSION, roundId: ROUND_B,
      }),
    );
  });

  it('空 sessionId 抛 ARGUMENT_ERROR', async () => {
    await expect(handlers.traceSummary('')).rejects.toMatchObject({
      errorCode: ToolErrorCode.ARGUMENT_ERROR,
    });
  });

  it('指定 roundId 返回精确匹配', async () => {
    const result = await handlers.traceSummary(SESSION, ROUND_A);
    expect(result).toContain(SESSION);
    expect(result).toContain(ROUND_A);
    expect(result).toContain('TypeScript');
    // 无 sessionStore（溯源失败降级）：标注"仅剩摘要"
    expect(result).toContain('仅剩摘要');
    // isModified 未设置，不应显示
    expect(result).not.toContain('已手动修改');
  });

  it('isModified 标记在输出中显示', async () => {
    const result = await handlers.traceSummary(SESSION, ROUND_B);
    expect(result).toContain('已手动修改');
    expect(result).toContain('preference');
  });

  it('不存在的 roundId 返回提示信息', async () => {
    const result = await handlers.traceSummary(SESSION, 'round-nonexistent');
    expect(result).toContain('未找到');
  });

  it('不指定 roundId 返回最近 N 条摘要', async () => {
    const result = await handlers.traceSummary(SESSION);
    expect(result).toContain(SESSION);
    expect(result).toContain('2 条');
    expect(result).toContain('TypeScript');
    expect(result).toContain('React');
  });

  it('limit 控制返回数量', async () => {
    const result = await handlers.traceSummary(SESSION, undefined, '1');
    expect(result).toContain('1 条');
    expect(result).not.toContain('React');
  });

  it('limit 最大 20', async () => {
    // 数据只有 2 条，验证不抛错即可
    const result = await handlers.traceSummary(SESSION, undefined, '100');
    expect(result).toContain(SESSION);
  });

  it('无摘要的会话返回提示信息', async () => {
    const result = await handlers.traceSummary('2026-01-01-other');
    expect(result).toContain('暂无轮次摘要');
  });

  // ── 溯源真实化：注入 sessionStore 后返回原始对话 ──

  it('sessionStore 可用时返回该轮次的原始对话', async () => {
    const store: ISessionStore = {
      loadMessages: () => [
        { role: 'user', content: '帮我解释 TypeScript 接口', timestamp: '2026-08-13T01:00:00Z', roundId: ROUND_A },
        { role: 'assistant', content: '接口用于定义对象的形状', timestamp: '2026-08-13T01:00:01Z', roundId: ROUND_A },
      ],
      listSessions: () => [SESSION],
      getRoundIds: () => [],
      setRoundIds: () => {},
      appendRoundId: () => {},
      appendRoundIds: () => {},
      createSession: () => {},
      deleteSession: () => {},
      getSessionMeta: () => undefined,
      updateSessionMeta: () => {},
      listSessionMetas: () => [],
    };
    const h = new BuiltinToolHandlers(projectPath, security, storage, store);
    const result = await h.traceSummary(SESSION, ROUND_A);
    // 返回原始对话消息，而非摘要文本
    expect(result).toContain('原始对话');
    expect(result).toContain('帮我解释 TypeScript 接口');
    expect(result).not.toContain('摘要：');
  });

  it('K4 原始对话返回前应净化控制字符（对齐 sanitizeExternalText）', async () => {
    // 用户历史含转义控制字符（ESC \x1b），trace_summary 拼入前必须净化，
    // 否则隐藏指令/终端注入序列直通 LLM 上下文（与 toolExecutor 主路径一致）
    const store: ISessionStore = {
      loadMessages: () => [
        { role: 'user', content: '正常问题', timestamp: '2026-08-13T01:00:00Z', roundId: ROUND_A },
        { role: 'assistant', content: '回答\x1b[2J带转义控制字符', timestamp: '2026-08-13T01:00:01Z', roundId: ROUND_A },
      ],
      listSessions: () => [SESSION],
      getRoundIds: () => [],
      setRoundIds: () => {},
      appendRoundId: () => {},
      appendRoundIds: () => {},
      createSession: () => {},
      deleteSession: () => {},
      getSessionMeta: () => undefined,
      updateSessionMeta: () => {},
      listSessionMetas: () => [],
    };
    const h = new BuiltinToolHandlers(projectPath, security, storage, store);
    const result = await h.traceSummary(SESSION, ROUND_A);
    expect(result).toContain('原始对话');
    // ESC 控制字符（\x1b）应被移除（sanitizeExternalText 去 \u0000-\u001F/\u007F）
    expect(result).not.toContain('\x1b');
  });

  it('sessionStore 未命中该轮次时回退为摘要文本（不报错）', async () => {
    // loadMessages 返回空 → loadRawRoundMessages 返回 null → 回退摘要
    const store: ISessionStore = {
      loadMessages: () => [],
      listSessions: () => [SESSION],
      getRoundIds: () => [],
      setRoundIds: () => {},
      appendRoundId: () => {},
      appendRoundIds: () => {},
      createSession: () => {},
      deleteSession: () => {},
      getSessionMeta: () => undefined,
      updateSessionMeta: () => {},
      listSessionMetas: () => [],
    };
    const h = new BuiltinToolHandlers(projectPath, security, storage, store);
    const result = await h.traceSummary(SESSION, ROUND_A);
    // 注入 sessionStore 可溯源到原文 → 输出原始对话
    expect(result).toContain('原始对话');
    expect(result).toContain('TypeScript');
  });
});
