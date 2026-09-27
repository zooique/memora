/**
 * 项目注册表 — 多项目注册信息持久化（从 ProjectManager 拆出）。
 * 专职读写 projects.json：注册/注销条目（Windows 大小写不敏感去重）、从路径推断名称、
 * 不可信磁盘 JSON 运行时类型校验（替代 as 断言）。无锁（锁归 LockManager）；同步 I/O（list getter 契约）。
 * 损坏语义：文件不存在=首次启动返回空；文件损坏抛 ProjectRegistryCorruptError 让调用方决策（防空数据覆盖）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { logger } from '@/logging/logger.js';
import { MemoraError } from '@/utils/errors.js';
import { nowIso } from '@/utils/time.js';
import { isPlainObject } from '@/utils/objects.js';

// ─── 类型 ────────────────────────────────────────────────

/** 项目注册表条目 */
export interface ProjectEntry {
  /** 项目根目录的绝对路径 */
  path: string;
  /** 项目名称（用户自定义或目录名） */
  name: string;
  /** 最后打开时间 */
  lastOpened: string;
}

/**
 * 注册表损坏错误：projects.json 存在但无法解析（JSON 语法/结构不符）时抛出。
 * 与"文件不存在"（首次正常）区分；register/unregister 必须向上传播防空覆盖，
 * list getter 可捕获降级返回空数组（只读不破坏数据）。保留 registryPath 供备份/排查。
 */
export class ProjectRegistryCorruptError extends MemoraError {
  /** 损坏文件的绝对路径，便于备份/排查 */
  readonly registryPath: string;

  constructor(registryPath: string, cause?: unknown) {
    // cause 归一化为 Error 类型，符合 MemoraError.cause 契约
    const causeError =
      cause instanceof Error ? cause : cause !== undefined ? new Error(String(cause)) : undefined;
    super({
      title: `项目注册表损坏：${registryPath}`,
      detail: causeError?.message,
      suggestions: [
        '检查文件是否被外部程序修改',
        '从备份恢复 projects.json',
        '或删除该文件让精灵重建（会丢失历史项目记录）',
      ],
      category: 'config',
      cause: causeError,
    });
    this.name = 'ProjectRegistryCorruptError';
    this.registryPath = registryPath;
  }
}

// ─── 类型守卫（对不可信磁盘 JSON 运行时校验） ───────────

/** 判断值是否为 ProjectEntry */
function isProjectEntry(value: unknown): value is ProjectEntry {
  if (!isPlainObject(value)) return false;
  return (
    typeof value['path'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['lastOpened'] === 'string'
  );
}

/** 顶层必须为数组否则视为损坏（抛错防空数据覆盖）；数组内单条不合法仅过滤保留（容错） */
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
 * 项目注册表：管理 projects.json 读写与条目维护；Windows 不区分大小写，路径不同大小写视为同一项目。
 */
export class ProjectRegistry {
  /** @param registryPath 注册表文件绝对路径（projects.json） */
  constructor(private readonly registryPath: string) {}

  /**
   * 列出已注册项目（同步 getter 契约）。只读：损坏时降级返回空数组（不破坏数据），
   * 与 register/unregister 写入路径须抛错不同。
   */
  get list(): ProjectEntry[] {
    try {
      return this.read();
    } catch (err) {
      if (err instanceof ProjectRegistryCorruptError) {
        logger.warn(
          { path: err.registryPath, cause: err.cause },
          '项目注册表损坏，list getter 降级返回空列表（只读，不破坏数据）',
        );
        return [];
      }
      // 非注册表损坏的意外错误仍向上抛出
      throw err;
    }
  }

  /** 注册项目：路径大小写不敏感，视为同一项目（更新而非新增） */
  register(projectPath: string, name: string): void {
    const registry = this.read();
    // Windows 不区分大小写，大小写不同视为同一项目
    const existing = registry.findIndex((e) => e.path.toLowerCase() === projectPath.toLowerCase());

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

  /** 移除项目（路径大小写不敏感匹配） */
  unregister(projectPath: string): void {
    const registry = this.read();
    const filtered = registry.filter((e) => e.path.toLowerCase() !== projectPath.toLowerCase());
    this.write(filtered);
  }

  /** 从路径推断项目名称（取最后一段目录名，无法推断返回 'unnamed'） */
  static inferProjectName(projectPath: string): string {
    const parts = projectPath.replace(/[/\\]+$/, '').split(/[/\\]/);
    return parts[parts.length - 1] || 'unnamed';
  }

  /**
   * 同步读取注册表（list getter 契约）。语义：文件不存在=空数组（首次启动）；
   * 解析失败或顶层非数组=抛 ProjectRegistryCorruptError；单条不合法仅过滤。
   */
  private read(): ProjectEntry[] {
    // 文件不存在=首次启动，返回空数组
    if (!existsSync(this.registryPath)) {
      return [];
    }

    let raw: string;
    try {
      raw = readFileSync(this.registryPath, 'utf-8');
    } catch (err) {
      // 读取失败（权限/磁盘故障）视为损坏
      throw new ProjectRegistryCorruptError(this.registryPath, err);
    }

    let parsed: unknown;
    try {
      // 类型守卫校验 JSON.parse 结果，替代 as 断言
      parsed = JSON.parse(raw);
    } catch (err) {
      // JSON 语法错误=整体损坏，抛错让调用方决策
      throw new ProjectRegistryCorruptError(this.registryPath, err);
    }

    // 顶层非数组视为损坏；单条不合法仅过滤保留合法条目
    const entries = asProjectEntryArray(parsed, this.registryPath);
    if (entries.length === 0 && Array.isArray(parsed) && parsed.length > 0) {
      logger.warn(
        { path: this.registryPath, totalEntries: parsed.length },
        '项目注册表所有条目结构不合法，返回空列表',
      );
    }
    return entries;
  }

  /** 写入注册表 */
  private write(entries: ProjectEntry[]): void {
    // 确保目录存在
    const dir = this.registryPath.replace(/[/\\][^/\\]+$/, '');
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.registryPath, JSON.stringify(entries, null, 2), 'utf-8');
  }
}
