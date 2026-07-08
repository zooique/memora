/**
 * 锁文件管理器 — 项目级并发保护
 *
 * 从 ProjectManager 拆分出来（P1-4），专职管理 .memora/.lock 文件：
 *   - 获取锁（写入 PID + 时间戳 + 主机名）
 *   - 释放锁（删除锁文件）
 *   - 残留锁检测（进程存活判断 + 自动清理）
 *   - 锁文件结构校验（QC-24 类型守卫，替代 `as` 类型断言）
 *
 * 设计原则：
 *   - 跨平台兼容（process.kill(pid, 0) 在 POSIX + Windows 均有效）
 *   - 不强制阻止并发（CLI-first，检测到冲突仅警告，用户决定）
 *   - 安全降级（锁文件损坏/进程已死 → 清理残留 → 重新获取）
 *
 * 锁文件策略：
 *   - 打开项目时创建 .lock 文件（含 PID + 时间戳 + 主机名）
 *   - 关闭/切换项目时删除 .lock 文件
 *   - 检测到残留锁时：判断进程是否存活 → 存活则警告 / 已死则清理
 *
 * 与 ProjectManager 的分工（P1-4 拆分，1.0 接口稳定化）：
 *   - LockManager：锁文件获取/释放 + 残留锁检测/清理
 *   - ProjectManager：项目生命周期编排（注册 + 资源加载 + 上下文构建）
 *
 * 详见 ADR-008 · 目录结构按"职责分层" + 迭代文档 P1-4
 */
import { join } from 'node:path';
import { hostname } from 'node:os';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { logger } from '@/logging/logger.js';
import { toError } from '@/utils/toError.js';
import { nowIso } from '@/utils/time.js';

// ─── 类型 ────────────────────────────────────────────────

/**
 * 锁文件内容
 */
interface LockInfo {
  /** 持有锁的进程 PID */
  pid: number;
  /** 获取锁的时间 */
  acquiredAt: string;
  /** 主机名 */
  hostname: string;
}

// ─── 类型守卫（QC-24，对不可信磁盘 JSON 运行时校验） ─────

/**
 * 判断值是否为非数组对象（排除 null）
 *
 * @param value 待校验的值
 * @returns true 表示是普通对象
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 判断值是否为 LockInfo（锁文件结构）
 *
 * @param value 待校验的值
 * @returns true 表示符合 LockInfo 结构
 */
function isLockInfo(value: unknown): value is LockInfo {
  if (!isPlainObject(value)) return false;
  return (
    typeof value['pid'] === 'number' &&
    typeof value['acquiredAt'] === 'string' &&
    typeof value['hostname'] === 'string'
  );
}

// ─── 类 ──────────────────────────────────────────────────

/**
 * 锁文件管理器
 *
 * 管理项目级 .lock 文件的生命周期，防止同项目并发写入导致数据损坏。
 * 不强制阻止并发（CLI-first），检测到冲突仅警告。
 */
export class LockManager {
  /** 当前持有的锁文件路径 */
  private currentLockPath: string | null = null;

  /**
   * 获取当前锁文件路径（null 表示未持有锁）
   */
  get currentPath(): string | null {
    return this.currentLockPath;
  }

  /**
   * 获取锁文件
   *
   * 如果锁文件存在且进程存活，发出警告但不阻止。
   * 如果锁文件存在但进程已死，清理残留锁。
   * 如果锁文件损坏（结构不合法），清理后重新获取。
   *
   * @param memoraDir - 项目 .memora/ 目录（锁文件所在目录）
   */
  async acquire(memoraDir: string): Promise<void> {
    const lockPath = join(memoraDir, '.lock');

    try {
      // 尝试读取锁文件（存在时）
      const raw = await readFile(lockPath, 'utf-8');
      // QC-24 使用类型守卫校验 JSON.parse 结果，替代 `as LockInfo` 类型断言
      const parsed: unknown = JSON.parse(raw);
      if (isLockInfo(parsed)) {
        // 合法锁文件：检查进程是否存活
        const info = parsed;
        if (this.isProcessAlive(info.pid)) {
          logger.warn(
            { pid: info.pid, acquiredAt: info.acquiredAt, hostname: info.hostname },
            '项目已被其他进程打开（锁文件存在），继续操作可能导致数据冲突',
          );
        } else {
          // 残留锁，清理
          logger.info({ pid: info.pid }, '清理残留锁文件（进程已退出）');
          await this.safeUnlink(lockPath);
        }
      } else {
        // 锁文件结构损坏（合法 JSON 但非 LockInfo），清理后 fall through 到写入新锁
        logger.warn({ path: lockPath }, '锁文件结构损坏，清理残留');
        await this.safeUnlink(lockPath);
      }
    } catch (err) {
      // 锁文件不存在或损坏，清理：记录 debug 日志便于排查（不存在属正常首次启动）
      logger.debug({ path: lockPath, err: toError(err).message }, '锁文件读取失败，清理残留');
      await this.safeUnlink(lockPath);
    }

    // 写入新锁
    const lockInfo: LockInfo = {
      pid: process.pid,
      acquiredAt: nowIso(),
      hostname: hostname(),
    };

    await mkdir(memoraDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify(lockInfo, null, 2), 'utf-8');
    this.currentLockPath = lockPath;
  }

  /**
   * 释放锁文件
   *
   * 删除当前持有的锁文件，并重置内部状态。
   * 未持有锁时为 no-op。
   */
  async release(): Promise<void> {
    if (this.currentLockPath) {
      await this.safeUnlink(this.currentLockPath);
      this.currentLockPath = null;
    }
  }

  /**
   * 安全删除文件（忽略不存在的错误）
   *
   * @param filePath - 待删除文件路径
   */
  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (err) {
      logger.debug({ path: filePath, err: toError(err).message }, 'safeUnlink 忽略删除失败');
    }
  }

  /**
   * 检查进程是否存活
   *
   * 跨平台统一使用 process.kill(pid, 0) 探测进程存活
   * （Windows 上 process.kill(pid, 0) 同样有效）
   *
   * @param pid - 待检查的进程 ID
   * @returns true 表示进程存活
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // 发送信号 0 检查进程是否存在（POSIX 兼容）
      // Windows 上 process.kill(pid, 0) 也会抛出错误如果进程不存在
      process.kill(pid, 0);
      return true;
    } catch {
      logger.debug({ pid }, '进程不存在');
      return false;
    }
  }
}
