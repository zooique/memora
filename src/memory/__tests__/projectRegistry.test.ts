/**
 * ProjectRegistry 单元测试
 *
 * 覆盖从 ProjectManager 拆分出的项目注册表模块：
 *   - register / unregister / list getter 基本契约
 *   - Windows 路径大小写不敏感去重
 *   - 跨实例持久化（构造函数加载已有注册表文件）
 *   - 不可信磁盘 JSON 的运行时类型校验与降级
 *   - inferProjectName 静态方法
 *
 * 测试风格对齐 projectManager.test.ts：mkdtempSync 临时目录 + afterEach 清理。
 *
 * 详见 ADR-007 · 测试策略 + ADR-008 · 目录结构（__tests__ 镜像 src/）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectRegistry, type ProjectEntry } from '@/memory/projectRegistry.js';

// ─── 测试夹具 ────────────────────────────────────────────

/**
 * 构造一个位于临时目录下的 projects.json 完整路径
 *
 * @param tmpDir 临时根目录
 * @returns 注册表文件的绝对路径
 */
function registryPathOf(tmpDir: string): string {
  return join(tmpDir, 'projects.json');
}

// ─── 测试用例 ────────────────────────────────────────────

describe('ProjectRegistry · register', () => {
  /** 临时目录（每个 it 独立） */
  let tmpDir: string;

  beforeEach(() => {
    // 每个用例使用独立临时目录，避免相互污染
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-pr-reg-'));
  });

  afterEach(() => {
    // 强制清理，忽略不存在的情况
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('注册项目后 list 应包含该条目', () => {
    // 准备：构造注册表实例
    const registry = new ProjectRegistry(registryPathOf(tmpDir));

    // 执行：注册一个项目
    registry.register('/path/to/project-a', 'project-a');

    // 断言：list 包含刚注册的条目
    const entries = registry.list;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('/path/to/project-a');
    expect(entries[0]!.name).toBe('project-a');
    // lastOpened 应为合法 ISO 时间戳
    expect(entries[0]!.lastOpened).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it('注册多个项目应按顺序追加', () => {
    const registry = new ProjectRegistry(registryPathOf(tmpDir));

    registry.register('/path/to/project-a', 'project-a');
    registry.register('/path/to/project-b', 'project-b');
    registry.register('/path/to/project-c', 'project-c');

    // 断言：按注册顺序返回
    const entries = registry.list;
    expect(entries).toHaveLength(3);
    expect(entries[0]!.name).toBe('project-a');
    expect(entries[1]!.name).toBe('project-b');
    expect(entries[2]!.name).toBe('project-c');
  });

  it('重复注册相同路径应更新而非新增（lastOpened 也更新）', async () => {
    const registry = new ProjectRegistry(registryPathOf(tmpDir));

    // 第一次注册
    registry.register('/path/to/project-a', 'project-a');
    const firstSnapshot = registry.list[0]!;
    // 记录首次注册的 lastOpened
    const firstLastOpened = firstSnapshot.lastOpened;

    // 等待 5ms 确保时间戳不同（ISO 时间戳精度为毫秒）
    await new Promise((resolve) => setTimeout(resolve, 5));

    // 第二次注册同一路径，更新名称
    registry.register('/path/to/project-a', 'project-a-renamed');
    const entries = registry.list;

    // 断言：条目数仍为 1，名称已更新
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('project-a-renamed');
    expect(entries[0]!.path).toBe('/path/to/project-a');
    // lastOpened 应被刷新（更晚或相等，但不应早于首次）
    expect(entries[0]!.lastOpened >= firstLastOpened).toBe(true);
  });

  it('Windows 路径大小写不同应视为同一项目（更新而非新增）', () => {
    const registry = new ProjectRegistry(registryPathOf(tmpDir));

    // 注册大小写不同的"同一"路径
    registry.register('/path/to/Project-A', 'project-a');
    registry.register('/path/to/project-a', 'project-a-renamed');

    // 断言：仅一条记录（去重），名称为最新值
    const entries = registry.list;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('project-a-renamed');
  });

  it('注册时应自动创建不存在的父目录', () => {
    // 嵌套目录路径，父目录尚不存在
    const nestedPath = join(tmpDir, 'deep', 'nested', 'dir', 'projects.json');

    // 构造实例并注册（write 内部会 mkdirSync recursive）
    const registry = new ProjectRegistry(nestedPath);
    registry.register('/path/to/project-a', 'project-a');

    // 断言：文件已创建在嵌套路径下
    expect(existsSync(nestedPath)).toBe(true);
    const entries = registry.list;
    expect(entries).toHaveLength(1);
  });
});

describe('ProjectRegistry · unregister', () => {
  /** 临时目录 */
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-pr-unreg-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('注销已注册项目后 list 不再包含该项目', () => {
    const registry = new ProjectRegistry(registryPathOf(tmpDir));

    // 准备两个项目
    registry.register('/path/to/project-a', 'project-a');
    registry.register('/path/to/project-b', 'project-b');

    // 执行：注销 project-a
    registry.unregister('/path/to/project-a');

    // 断言：仅剩 project-b
    const entries = registry.list;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('project-b');
  });

  it('注销不存在的项目应为 no-op（不抛异常，不影响其他条目）', () => {
    const registry = new ProjectRegistry(registryPathOf(tmpDir));

    // 准备一个已注册项目
    registry.register('/path/to/project-a', 'project-a');

    // 执行：注销一个未注册的路径（不应抛异常）
    expect(() => registry.unregister('/path/to/nonexistent')).not.toThrow();

    // 断言：原有条目不受影响
    const entries = registry.list;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('project-a');
  });

  it('Windows 路径大小写不同应能注销同一项目', () => {
    const registry = new ProjectRegistry(registryPathOf(tmpDir));

    // 注册时使用大写路径
    registry.register('/path/to/Project-A', 'project-a');

    // 执行：使用小写路径注销
    registry.unregister('/path/to/project-a');

    // 断言：list 为空
    expect(registry.list).toHaveLength(0);
  });

  it('在空注册表上注销应安全 no-op', () => {
    const registry = new ProjectRegistry(registryPathOf(tmpDir));

    // 执行：在尚未写入任何条目的注册表上注销
    expect(() => registry.unregister('/path/to/any')).not.toThrow();
    expect(registry.list).toHaveLength(0);
  });
});

describe('ProjectRegistry · list getter', () => {
  /** 临时目录 */
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-pr-list-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('注册表文件不存在时应返回空列表', () => {
    const registry = new ProjectRegistry(registryPathOf(tmpDir));

    // 断言：文件尚未创建，list 返回空数组（不抛异常）
    expect(registry.list).toEqual([]);
    // 文件本身不应被读取触发创建（list 是只读操作）
    expect(existsSync(registryPathOf(tmpDir))).toBe(false);
  });

  it('list 多次调用应返回一致结果（幂等只读）', () => {
    const registry = new ProjectRegistry(registryPathOf(tmpDir));
    registry.register('/path/to/project-a', 'project-a');

    // 多次读取应一致
    const first = registry.list;
    const second = registry.list;
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  it('list 返回的条目结构应符合 ProjectEntry 契约', () => {
    const registry = new ProjectRegistry(registryPathOf(tmpDir));
    registry.register('/path/to/project-a', 'project-a');

    const entry: ProjectEntry = registry.list[0]!;
    // 断言：三个必需字段均为 string 类型
    expect(typeof entry.path).toBe('string');
    expect(typeof entry.name).toBe('string');
    expect(typeof entry.lastOpened).toBe('string');
  });
});

describe('ProjectRegistry · 持久化（跨实例）', () => {
  /** 临时目录 */
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-pr-persist-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('新实例应加载已有注册表文件', () => {
    const path = registryPathOf(tmpDir);

    // 第一个实例写入数据
    const first = new ProjectRegistry(path);
    first.register('/path/to/project-a', 'project-a');
    first.register('/path/to/project-b', 'project-b');

    // 第二个实例（同一文件路径）应能读取到已有数据
    const second = new ProjectRegistry(path);
    const entries = second.list;
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.name === 'project-a')).toBeDefined();
    expect(entries.find((e) => e.name === 'project-b')).toBeDefined();
  });

  it('新实例写入应追加到已有条目之后', () => {
    const path = registryPathOf(tmpDir);

    // 第一个实例写入两条
    const first = new ProjectRegistry(path);
    first.register('/path/to/project-a', 'project-a');
    first.register('/path/to/project-b', 'project-b');

    // 第二个实例追加第三条
    const second = new ProjectRegistry(path);
    second.register('/path/to/project-c', 'project-c');

    // 断言：共 3 条，顺序为 a → b → c
    const entries = second.list;
    expect(entries).toHaveLength(3);
    expect(entries[0]!.name).toBe('project-a');
    expect(entries[1]!.name).toBe('project-b');
    expect(entries[2]!.name).toBe('project-c');
  });

  it('写入的文件应为 JSON 数组格式且可读', () => {
    const path = registryPathOf(tmpDir);
    const registry = new ProjectRegistry(path);
    registry.register('/path/to/project-a', 'project-a');

    // 直接读取磁盘文件内容
    const raw = readFileSync(path, 'utf-8');
    // 应为合法 JSON 数组
    const parsed = JSON.parse(raw) as unknown;
    expect(Array.isArray(parsed)).toBe(true);

    // 应为带缩进的可读 JSON（包含换行符）
    expect(raw).toContain('\n');
    expect(raw).toContain('"path"');
    expect(raw).toContain('"name"');
    expect(raw).toContain('"lastOpened"');
  });

  it('写入文件应使用 UTF-8 编码', () => {
    const path = registryPathOf(tmpDir);
    const registry = new ProjectRegistry(path);
    // 项目名包含非 ASCII 字符（中文），验证 UTF-8 写入
    registry.register('/path/to/中文项目', '我的项目');

    // 直接读取应能正确解码中文
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('我的项目');
    expect(raw).toContain('/path/to/中文项目');
  });

  it('写入后文件应确实存在于磁盘', () => {
    const path = registryPathOf(tmpDir);
    const registry = new ProjectRegistry(path);

    // 写入前文件不存在
    expect(existsSync(path)).toBe(false);

    registry.register('/path/to/project-a', 'project-a');

    // 写入后文件存在且为普通文件
    expect(existsSync(path)).toBe(true);
    const stat = statSync(path);
    expect(stat.isFile()).toBe(true);
    // 文件大小应大于 0
    expect(stat.size).toBeGreaterThan(0);
  });
});

describe('ProjectRegistry · 损坏降级', () => {
  /** 临时目录 */
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-pr-corrupt-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('注册表 JSON 解析失败时应降级为空列表（不抛异常）', () => {
    const path = registryPathOf(tmpDir);
    // 写入损坏的 JSON（语法错误）
    writeFileSync(path, 'not valid{{{', 'utf-8');

    const registry = new ProjectRegistry(path);

    // 断言：list 不抛异常，返回空数组
    expect(() => registry.list).not.toThrow();
    expect(registry.list).toEqual([]);
  });

  it('注册表为非数组 JSON 时应降级为空列表', () => {
    const path = registryPathOf(tmpDir);
    // 写入合法 JSON 但非数组（对象）
    writeFileSync(path, JSON.stringify({ not: 'an array' }), 'utf-8');

    const registry = new ProjectRegistry(path);
    expect(registry.list).toEqual([]);
  });

  it('注册表为原始类型 JSON 时应降级为空列表', () => {
    const path = registryPathOf(tmpDir);
    // 写入 JSON 字符串/数字
    writeFileSync(path, '"just a string"', 'utf-8');

    const registry = new ProjectRegistry(path);
    expect(registry.list).toEqual([]);
  });

  it('部分条目结构不合法时应仅保留合法条目（类型守卫过滤）', () => {
    const path = registryPathOf(tmpDir);
    // 混合：1 条合法 + 2 条不合法（缺字段 / 类型错误）
    const mixed = [
      { path: '/path/to/valid', name: 'valid', lastOpened: '2026-01-01T00:00:00.000Z' },
      { path: '/path/to/missing-field', lastOpened: '2026-01-01T00:00:00.000Z' }, // 缺 name
      { path: '/path/to/wrong-type', name: 123, lastOpened: '2026-01-01T00:00:00.000Z' }, // name 非 string
      { name: 'missing-path', lastOpened: '2026-01-01T00:00:00.000Z' }, // 缺 path
    ];
    writeFileSync(path, JSON.stringify(mixed), 'utf-8');

    const registry = new ProjectRegistry(path);
    const entries = registry.list;

    // 断言：仅保留 1 条合法条目
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('/path/to/valid');
    expect(entries[0]!.name).toBe('valid');
  });

  it('全部条目结构不合法时应降级为空列表', () => {
    const path = registryPathOf(tmpDir);
    // 全部条目都不合法
    const allInvalid = [
      { path: '/a', lastOpened: '2026-01-01T00:00:00.000Z' }, // 缺 name
      { name: 'b', lastOpened: '2026-01-01T00:00:00.000Z' }, // 缺 path
    ];
    writeFileSync(path, JSON.stringify(allInvalid), 'utf-8');

    const registry = new ProjectRegistry(path);
    expect(registry.list).toEqual([]);
  });

  it('损坏状态下注册新项目应能正常工作（自愈）', () => {
    const path = registryPathOf(tmpDir);
    // 写入损坏 JSON
    writeFileSync(path, 'not valid{{{', 'utf-8');

    const registry = new ProjectRegistry(path);
    // 读取时降级为空
    expect(registry.list).toEqual([]);

    // 注册新项目应能正常写入（覆盖损坏内容）
    registry.register('/path/to/project-a', 'project-a');
    expect(registry.list).toHaveLength(1);
    expect(registry.list[0]!.name).toBe('project-a');

    // 磁盘文件应已被合法 JSON 覆盖
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it('空数组 JSON 应返回空列表', () => {
    const path = registryPathOf(tmpDir);
    writeFileSync(path, '[]', 'utf-8');

    const registry = new ProjectRegistry(path);
    expect(registry.list).toEqual([]);
  });
});

describe('ProjectRegistry · inferProjectName（静态方法）', () => {
  it('应从 Unix 风格路径推断最后一段目录名', () => {
    expect(ProjectRegistry.inferProjectName('/home/user/my-project')).toBe(
      'my-project',
    );
  });

  it('应从 Windows 风格路径推断最后一段目录名', () => {
    expect(ProjectRegistry.inferProjectName('C:\\Users\\dev\\my-project')).toBe(
      'my-project',
    );
  });

  it('应去除尾部斜杠后再推断', () => {
    // Unix 尾部斜杠
    expect(ProjectRegistry.inferProjectName('/home/user/my-project/')).toBe(
      'my-project',
    );
    // Windows 尾部反斜杠
    expect(ProjectRegistry.inferProjectName('C:\\Users\\dev\\my-project\\')).toBe(
      'my-project',
    );
    // 多个尾部斜杠
    expect(ProjectRegistry.inferProjectName('/home/user/my-project//')).toBe(
      'my-project',
    );
  });

  it('空路径或仅分隔符时应返回 "unnamed"', () => {
    // 空字符串
    expect(ProjectRegistry.inferProjectName('')).toBe('unnamed');
    // 仅分隔符
    expect(ProjectRegistry.inferProjectName('/')).toBe('unnamed');
    expect(ProjectRegistry.inferProjectName('\\')).toBe('unnamed');
  });

  it('相对路径应取最后一段目录名', () => {
    expect(ProjectRegistry.inferProjectName('relative/path/to/project')).toBe(
      'project',
    );
  });

  it('单段路径（无分隔符）应原样返回', () => {
    expect(ProjectRegistry.inferProjectName('standalone')).toBe('standalone');
  });
});

describe('ProjectRegistry · 构造函数参数', () => {
  /** 临时目录 */
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-pr-ctor-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应使用传入的 registryPath 作为注册表文件位置', () => {
    // 自定义路径（非默认 projects.json 名）
    const customPath = join(tmpDir, 'custom-registry.json');
    const registry = new ProjectRegistry(customPath);

    registry.register('/path/to/project-a', 'project-a');

    // 断言：写入到自定义路径而非默认路径
    expect(existsSync(customPath)).toBe(true);
    expect(existsSync(join(tmpDir, 'projects.json'))).toBe(false);
  });

  it('不同 registryPath 应相互独立', () => {
    const path1 = join(tmpDir, 'registry-1.json');
    const path2 = join(tmpDir, 'registry-2.json');

    const registry1 = new ProjectRegistry(path1);
    const registry2 = new ProjectRegistry(path2);

    registry1.register('/path/to/project-a', 'project-a');
    registry2.register('/path/to/project-b', 'project-b');

    // 断言：两个注册表互不干扰
    expect(registry1.list).toHaveLength(1);
    expect(registry1.list[0]!.name).toBe('project-a');
    expect(registry2.list).toHaveLength(1);
    expect(registry2.list[0]!.name).toBe('project-b');
  });

  it('同一 registryPath 多个实例应共享数据', () => {
    const sharedPath = join(tmpDir, 'shared.json');

    // 实例 A 写入
    const registryA = new ProjectRegistry(sharedPath);
    registryA.register('/path/to/project-a', 'project-a');

    // 实例 B 读取同一文件
    const registryB = new ProjectRegistry(sharedPath);
    expect(registryB.list).toHaveLength(1);
    expect(registryB.list[0]!.name).toBe('project-a');

    // 实例 C 读取同一文件
    const registryC = new ProjectRegistry(sharedPath);
    expect(registryC.list).toHaveLength(1);
  });
});
