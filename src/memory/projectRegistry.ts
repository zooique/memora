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
 *   - 损坏降级：解析失败返回空列表 + 警告日志，不抛异常
 *
 * 与 ProjectManager 的分工（1.0 接口稳定化）：
 *   - ProjectRegistry：注册表读写 + 条目管理 + 名称推断
 *   - ProjectManager：项目生命周期编排（加锁 + 资源加载 + 上下文构建）
 *
 * 详见 ADR-008 · 目录结构按"职责分层"
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { logger } from '@/logging/logger.js';
import { toError } from '@/utils/toError.js';
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
 * 过滤掉不符合结构的条目，仅保留合法条目
 *
 * @param value 待校验的值
 * @returns 解析后的合法条目数组（损坏时返回空数组）
 */
function asProjectEntryArray(value: unknown): ProjectEntry[] {
  if (!Array.isArray(value)) return [];
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
   */
  get list(): ProjectEntry[] {
    return this.read();
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
   * 损坏时返回空数组并记录警告日志，避免静默吞错掩盖磁盘故障。
   */
  private read(): ProjectEntry[] {
    if (!existsSync(this.registryPath)) {
      return [];
    }

    try {
      const raw = readFileSync(this.registryPath, 'utf-8');
      // QC-24 使用类型守卫校验 JSON.parse 结果，替代 `as ProjectEntry[]` 类型断言
      // 过滤掉不符合结构的条目，仅保留合法条目
      const parsed: unknown = JSON.parse(raw);
      const entries = asProjectEntryArray(parsed);
      if (entries.length === 0 && Array.isArray(parsed) && parsed.length > 0) {
        // 数组存在但所有条目都不合法，记录警告
        logger.warn(
          { path: this.registryPath, totalEntries: parsed.length },
          '项目注册表所有条目结构不合法，返回空列表',
        );
      }
      return entries;
    } catch (err) {
      // 注册表损坏：记录警告日志便于排查（不存在属正常首次启动，损坏需排查）
      logger.warn(
        { path: this.registryPath, err: toError(err).message },
        '项目注册表解析失败，返回空列表',
      );
      return [];
    }
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
