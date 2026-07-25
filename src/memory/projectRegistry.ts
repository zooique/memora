/**
 * 项目注册表 — 多项目注册信息持久化
 *
 * 从 ProjectManager 拆分出来，专职管理 projects.json 注册表：
 *   - 读写项目注册表（~/.memora/projects.json 或宿主指定 registryDir）
 *   - 注册/注销项目条目（Windows 大小写不敏感去重）
 *   - 从路径推断项目名称
 *   - 不可信磁盘 JSON 的运行时类型校验（QC-24，替代 `as` 类型断言）
 *
 * 设计原则：
 *   - 纯文件系统操作，无锁机制（锁由 LockManager 负责）
 *   - 同步 I/O（list getter 契约要求同步返回；注册表操作低频，影响可控）
 *   - 损坏语义区分（FIX-P0-3）：文件不存在 = 首次启动返回空列表；文件损坏 = 抛出
 *     ProjectRegistryCorruptError 让调用方决策。list getter 只读降级返回空，
 *     register/unregister 写入路径必须抛错传播，防止用空数据覆盖原文件导致数据丢失
 *
 * 与 ProjectManager 的分工（1.0 接口稳定化）：
 *   - ProjectRegistry：注册表读写 + 条目管理 + 名称推断
 *   - ProjectManager：项目生命周期编排（加锁 + 资源加载 + 上下文构建）
 *
 * 详见 ADR-008 · 目录结构按"职责分层"
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { logger } from '@/logging/logger.js';
import { nowIso } from '@/utils/time.js';
import { isPlainObject } from '@/utils/objects.js';

// ─── 类型 ────────────────────────────────────────────────

/**
 * 项目注册表条目
 */
export interface ProjectEntry {
  /** 项目根目录的绝对路径 */
  path: string;
  /** 项目名称（用户自定义或目录名） */
  name: string;
  /** 最后打开时间 */
  lastOpened: string;
}

/**
 * 项目注册表损坏错误
 *
 * FIX-P0-3：当磁盘上的 projects.json 存在但内容无法解析（JSON 语法错误或结构
 * 不符合 ProjectEntry[] 契约）时抛出。与"文件不存在"语义区分——后者是首次启动
 * 的正常情况，前者意味着数据可能丢失，需要调用方决策（备份/重建/中止）。
 *
 * 设计意图：
 *   - register/unregister 路径必须让此错误向上传播，避免用空数据覆盖损坏文件
 *   - list getter 可捕获此错误降级返回空数组（只读操作，不破坏数据）
 */
export class ProjectRegistryCorruptError extends Error {
  /** 损坏文件的绝对路径，便于备份/排查 */
  readonly registryPath: string;
  /** 底层错误（JSON 解析错误或类型校验错误），可能为 undefined */
  readonly cause?: unknown;

  constructor(registryPath: string, cause?: unknown) {
    super(`项目注册表损坏：${registryPath}`);
    this.name = 'ProjectRegistryCorruptError';
    this.registryPath = registryPath;
    this.cause = cause;
  }
}

// ─── 类型守卫（QC-24，对不可信磁盘 JSON 运行时校验） ─────

/**
 * 判断值是否为 ProjectEntry（项目注册表条目）
 *
 * @param value 待校验的值
 * @returns true 表示符合 ProjectEntry 结构
 */
function isProjectEntry(value: unknown): value is ProjectEntry {
  if (!isPlainObject(value)) return false;
  return (
    typeof value['path'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['lastOpened'] === 'string'
  );
}

/**
 * 判断值是否为 ProjectEntry 数组
 *
 * 顶层必须为数组，否则视为注册表结构损坏（抛错让调用方决策）。
 * 数组内个别条目不合法时仅过滤保留合法条目（容错：单条损坏不毁全部）。
 *
 * FIX-P0-3：顶层非数组不再静默返回空，而是抛 ProjectRegistryCorruptError，
 * 避免 register 用空数据覆盖原文件导致全部项目记录永久丢失。
 *
 * @param value 待校验的值
 * @param registryPath 注册表路径（用于错误信息）
 * @returns 解析后的合法条目数组
 * @throws {ProjectRegistryCorruptError} 顶层非数组时抛出
 */
function asProjectEntryArray(value: unknown, registryPath: string): ProjectEntry[] {
  if (!Array.isArray(value)) {
    throw new ProjectRegistryCorruptError(
      registryPath,
      new Error(`注册表顶层应为数组，实际类型：${typeof value}`),
    );
  }
  return value.filter(isProjectEntry);
}

// ─── 类 ──────────────────────────────────────────────────

/**
 * 项目注册表
 *
 * 管理 projects.json 文件的读写和条目维护。
 * Windows 文件系统不区分大小写，路径大小写不同视为同一项目。
 */
export class ProjectRegistry {
  /**
   * @param registryPath - 注册表文件绝对路径（projects.json）
   */
  constructor(private readonly registryPath: string) {}

  /**
   * 列出已注册的项目（同步读取，契约要求 getter 风格）
   *
   * FIX-P0-3：list 是只读操作，损坏时降级返回空数组（UI 显示空列表）。
   * 与 register/unregister 不同——只读不会用空数据覆盖原文件，降级是安全的。
   * 损坏错误记录 warn 日志便于排查，但不向上抛出避免 UI 崩溃。
   */
  get list(): ProjectEntry[] {
    try {
      return this.read();
    } catch (err) {
      // 只读降级：损坏时返回空列表，UI 显示"无项目"，但不会破坏磁盘数据
      if (err instanceof ProjectRegistryCorruptError) {
        logger.warn(
          { path: err.registryPath, cause: err.cause },
          '项目注册表损坏，list getter 降级返回空列表（只读，不破坏数据）',
        );
        return [];
      }
      // 非 ProjectRegistryCorruptError 的意外错误仍向上抛出
      throw err;
    }
  }

  /**
   * 注册项目到注册表
   *
   * Windows 文件系统不区分大小写，路径大小写不同视为同一项目（更新而非新增）。
   *
   * @param projectPath - 项目根目录绝对路径
   * @param name - 项目名称
   */
  register(projectPath: string, name: string): void {
    const registry = this.read();
    // Windows 文件系统不区分大小写，路径大小写不同视为同一项目
    const existing = registry.findIndex(
      (e) => e.path.toLowerCase() === projectPath.toLowerCase(),
    );

    const entry: ProjectEntry = {
      path: projectPath,
      name,
      lastOpened: nowIso(),
    };

    if (existing >= 0) {
      registry[existing] = entry;
    } else {
      registry.push(entry);
    }

    this.write(registry);
  }

  /**
   * 从注册表移除项目
   *
   * @param projectPath - 项目根目录绝对路径
   */
  unregister(projectPath: string): void {
    const registry = this.read();
    // Windows 文件系统不区分大小写，大小写不同视为同一项目
    const filtered = registry.filter(
      (e) => e.path.toLowerCase() !== projectPath.toLowerCase(),
    );
    this.write(filtered);
  }

  /**
   * 从项目路径推断项目名称（取路径最后一段目录名）
   *
   * @param projectPath - 项目根目录绝对路径
   * @returns 项目名称（目录名，无法推断时返回 'unnamed'）
   */
  static inferProjectName(projectPath: string): string {
    const parts = projectPath.replace(/[/\\]+$/, '').split(/[/\\]/);
    return parts[parts.length - 1] || 'unnamed';
  }

  /**
   * 读取项目注册表
   *
   * 同步读取：list getter 契约要求同步返回，注册表操作低频，同步 I/O 影响可控。
   *
   * FIX-P0-3：语义区分——
   *   - 文件不存在：返回空数组（首次启动的正常情况）
   *   - 文件损坏（JSON 解析失败或顶层非数组）：抛出 ProjectRegistryCorruptError
   *     让调用方决策。register/unregister 不捕获此错误，避免用空数据覆盖原文件。
   *   - 数组内个别条目不合法：仅过滤保留合法条目（容错，不抛错）
   *
   * @returns 项目注册表条目数组
   * @throws {ProjectRegistryCorruptError} 文件存在但内容损坏时抛出
   */
  private read(): ProjectEntry[] {
    // 文件不存在 = 首次启动，返回空数组（正常情况，不抛错）
    if (!existsSync(this.registryPath)) {
      return [];
    }

    let raw: string;
    try {
      raw = readFileSync(this.registryPath, 'utf-8');
    } catch (err) {
      // 文件存在但读取失败（权限/磁盘故障），视为损坏
      throw new ProjectRegistryCorruptError(this.registryPath, err);
    }

    let parsed: unknown;
    try {
      // QC-24 使用类型守卫校验 JSON.parse 结果，替代 `as ProjectEntry[]` 类型断言
      parsed = JSON.parse(raw);
    } catch (err) {
      // JSON 语法错误 = 文件整体损坏，抛错让调用方决策（备份/重建/中止）
      throw new ProjectRegistryCorruptError(this.registryPath, err);
    }

    // 顶层非数组也视为损坏（asProjectEntryArray 内部抛 ProjectRegistryCorruptError）
    // 数组内个别条目不合法时仅过滤保留合法条目（容错：单条损坏不毁全部）
    const entries = asProjectEntryArray(parsed, this.registryPath);
    if (entries.length === 0 && Array.isArray(parsed) && parsed.length > 0) {
      // 数组存在但所有条目都不合法，记录警告（仍返回空，因为是单条容错的极端情况）
      logger.warn(
        { path: this.registryPath, totalEntries: parsed.length },
        '项目注册表所有条目结构不合法，返回空列表',
      );
    }
    return entries;
  }

  /**
   * 写入项目注册表
   */
  private write(entries: ProjectEntry[]): void {
    // 确保目录存在
    const dir = this.registryPath.replace(/[/\\][^/\\]+$/, '');
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.registryPath, JSON.stringify(entries, null, 2), 'utf-8');
  }
}
