/**
 * 锁文件管理器（LockManager）独立单元测试
 *
 * 覆盖目标（1.0 质量审查补缺）：
 *   - 锁的获取（acquire）：首次获取 / 目录自动创建 / 锁文件结构
 *   - 锁的释放（release）：释放后可再次获取 / 未持锁时为 no-op
 *   - 残留锁处理：进程已死 → 自动清理 / 进程存活 → 警告并覆盖
 *   - 损坏锁文件：非法 JSON → 清理重建 / 非 LockInfo 结构 → 清理后重新获取锁
 *   - 跨实例与多目录：基于文件系统的持久化语义 / acquire 不自动释放旧锁
 *
 * 设计原则：
 *   - 以代码实际行为为准（characterization test），疑似 bug 在注释 + 报告中标注
 *   - 使用 mkdtempSync 创建隔离临时目录，afterEach 强制清理
 *   - 零 @ts-ignore / as any，遵循镜像原则
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { LockManager } from '@/memory/lockManager.js';
import { logger } from '@/logging/logger.js';

/**
 * 构造一份合法的 LockInfo 锁文件内容（用于写入残留锁场景）
 *
 * @param pid - 持有锁的进程 PID（默认用一个几乎不可能存活的大 PID）
 * @returns 可序列化为锁文件的 JSON 字符串
 */
function makeLockContent(pid: number = 99999999): string {
  return JSON.stringify({
    pid,
    acquiredAt: new Date().toISOString(),
    hostname: hostname(),
  });
}

describe('LockManager · currentPath 初始状态', () => {
  it('未获取锁时 currentPath 应为 null', () => {
    // 新实例不应持有任何锁
    const lm = new LockManager();
    expect(lm.currentPath).toBeNull();
  });
});

describe('LockManager · acquire 获取锁', () => {
  /** 每个用例隔离的临时项目根目录 */
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-lm-acq-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('首次获取锁应创建 .lock 文件并设置 currentPath', async () => {
    const memoraDir = join(tmpDir, '.memora');
    const lm = new LockManager();

    await lm.acquire(memoraDir);

    const lockPath = join(memoraDir, '.lock');
    expect(existsSync(lockPath)).toBe(true);
    expect(lm.currentPath).toBe(lockPath);
  });

  it('锁文件应包含当前进程 PID / ISO 时间戳 / 主机名', async () => {
    const memoraDir = join(tmpDir, '.memora');
    const lm = new LockManager();

    await lm.acquire(memoraDir);

    const lockPath = join(memoraDir, '.lock');
    // 锁文件内容是 JSON，结构受 isLockInfo 类型守卫约束
    const lockContent = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lockContent.pid).toBe(process.pid);
    expect(typeof lockContent.acquiredAt).toBe('string');
    expect(lockContent.acquiredAt.length).toBeGreaterThan(0);
    expect(lockContent.hostname).toBe(hostname());
  });

  it('memoraDir 不存在时应自动创建目录', async () => {
    // 嵌套不存在的目录路径
    const memoraDir = join(tmpDir, 'deep', 'nested', '.memora');
    const lm = new LockManager();

    await lm.acquire(memoraDir);

    // acquire 内部通过 mkdir(recursive: true) 自动创建
    expect(existsSync(memoraDir)).toBe(true);
    expect(existsSync(join(memoraDir, '.lock'))).toBe(true);
  });
});

describe('LockManager · release 释放锁', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-lm-rel-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('释放锁应删除锁文件并重置 currentPath', async () => {
    const memoraDir = join(tmpDir, '.memora');
    const lm = new LockManager();
    await lm.acquire(memoraDir);
    const lockPath = join(memoraDir, '.lock');

    expect(existsSync(lockPath)).toBe(true);

    await lm.release();

    expect(existsSync(lockPath)).toBe(false);
    expect(lm.currentPath).toBeNull();
  });

  it('未持锁时 release 应为 no-op 且不抛错', async () => {
    const lm = new LockManager();
    // 连续 release 不应抛出异常
    await expect(lm.release()).resolves.toBeUndefined();
    await expect(lm.release()).resolves.toBeUndefined();
    expect(lm.currentPath).toBeNull();
  });

  it('释放后应能再次获取锁', async () => {
    const memoraDir = join(tmpDir, '.memora');
    const lm = new LockManager();
    const lockPath = join(memoraDir, '.lock');

    await lm.acquire(memoraDir);
    await lm.release();
    // 重新获取——锁文件应被重新创建
    await lm.acquire(memoraDir);

    expect(existsSync(lockPath)).toBe(true);
    expect(lm.currentPath).toBe(lockPath);
  });

  // release 前校验 PID 归属，锁被其他进程覆盖时不删除他人锁
  it('锁文件被其他进程覆盖时 release 不删除他人锁', async () => {
    const memoraDir = join(tmpDir, '.memora');
    const lm = new LockManager();
    await lm.acquire(memoraDir);
    const lockPath = join(memoraDir, '.lock');

    // 模拟锁文件被其他进程覆盖（写入不同 PID）
    writeFileSync(lockPath, makeLockContent(99999999), 'utf-8');

    await lm.release();

    // 锁文件不应被删除（保护他人锁），但 currentPath 重置（本进程不再持有引用）
    expect(existsSync(lockPath)).toBe(true);
    expect(lm.currentPath).toBeNull();
  });

  // 锁文件不存在时 release 视为已释放，不抛错
  it('锁文件已被外部删除时 release 视为已释放不抛错', async () => {
    const memoraDir = join(tmpDir, '.memora');
    const lm = new LockManager();
    await lm.acquire(memoraDir);
    const lockPath = join(memoraDir, '.lock');

    // 模拟锁文件已被外部删除（如手动清理）
    rmSync(lockPath, { force: true });

    await lm.release();

    // 不抛错，currentPath 重置
    expect(lm.currentPath).toBeNull();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('LockManager · 残留锁处理', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-lm-stale-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('残留锁（进程存活=当前进程）应仅警告但仍覆盖写入新锁', async () => {
    const memoraDir = join(tmpDir, '.memora');
    mkdirSync(memoraDir, { recursive: true });

    // 写入"当前进程 PID"的残留锁——isProcessAlive(process.pid) 返回 true
    writeFileSync(join(memoraDir, '.lock'), makeLockContent(process.pid), 'utf-8');

    const lm = new LockManager();
    // 设计上不强制阻止并发，仅警告；acquire 应正常完成
    await lm.acquire(memoraDir);

    const lockPath = join(memoraDir, '.lock');
    expect(existsSync(lockPath)).toBe(true);
    expect(lm.currentPath).toBe(lockPath);
    // 锁文件应被当前进程覆盖
    const lockContent = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lockContent.pid).toBe(process.pid);
  });

  it('残留锁（pid 指向已死进程）确实走到清理分支：logger.info 记录清理', async () => {
    const memoraDir = join(tmpDir, '.memora');
    mkdirSync(memoraDir, { recursive: true });

    // 构造合法残留锁，其 pid 由下方 process.kill spy 判定为"已死"
    const deadPid = 99999999;
    const lockPath = join(memoraDir, '.lock');
    writeFileSync(lockPath, makeLockContent(deadPid), 'utf-8');

    // 让 isProcessAlive(deadPid) 必为 false：process.kill 抛 ESRCH，与真实死进程一致
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    // 绑定「进程已死 → 清理残留锁」分支的唯一可观测效果（logger.info）；
    // 仅断言锁文件被重写无法区分该分支与"进程存活仅警告"分支（两者最终都写入当前 pid），
    // 故必须断言清理日志本身——把 isProcessAlive 的 return false 改成 true 时此断言变红
    const infoSpy = vi.spyOn(logger, 'info');

    try {
      const lm = new LockManager();
      await lm.acquire(memoraDir);

      expect(infoSpy).toHaveBeenCalledWith({ pid: deadPid }, '清理残留锁文件（进程已退出）');
      // 清理后以当前进程身份重新获取锁
      expect(lm.currentPath).toBe(lockPath);
      expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    } finally {
      infoSpy.mockRestore();
      killSpy.mockRestore();
    }
  });
});

describe('LockManager · 损坏锁文件处理', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-lm-corrupt-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('锁文件为非法 JSON 时应清理并重新获取新锁', async () => {
    const memoraDir = join(tmpDir, '.memora');
    mkdirSync(memoraDir, { recursive: true });

    // 写入无法 JSON.parse 的内容
    writeFileSync(join(memoraDir, '.lock'), 'not valid json{{{', 'utf-8');

    const lm = new LockManager();
    await lm.acquire(memoraDir);

    const lockPath = join(memoraDir, '.lock');
    expect(existsSync(lockPath)).toBe(true);
    expect(lm.currentPath).toBe(lockPath);
    // 新锁文件应为合法结构
    const lockContent = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lockContent.pid).toBe(process.pid);
  });

  it('锁文件为合法 JSON 但非 LockInfo 结构时应清理并重新获取锁', async () => {
    const memoraDir = join(tmpDir, '.memora');
    mkdirSync(memoraDir, { recursive: true });

    // 写入合法 JSON 但缺少 pid/acquiredAt/hostname 字段
    writeFileSync(join(memoraDir, '.lock'), JSON.stringify({ foo: 'bar' }), 'utf-8');

    const lm = new LockManager();
    await lm.acquire(memoraDir);

    // 清理损坏锁后 fall through 到写入新锁，currentPath 指向新锁文件
    const lockPath = join(memoraDir, '.lock');
    expect(existsSync(lockPath)).toBe(true);
    expect(lm.currentPath).toBe(lockPath);

    // 验证新锁文件结构合法（含 pid/acquiredAt/hostname）
    const lockContent = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lockContent.pid).toBe(process.pid);
    expect(lockContent.acquiredAt).toBeTruthy();
    expect(lockContent.hostname).toBeTruthy();
  });
});

describe('LockManager · 跨实例与多目录', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-lm-cross-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('锁基于文件系统：新实例能检测到前一个实例写入的锁（同 PID 存活）', async () => {
    const memoraDir = join(tmpDir, '.memora');
    mkdirSync(memoraDir, { recursive: true });

    // 实例 A 获取锁
    const lmA = new LockManager();
    await lmA.acquire(memoraDir);

    // 实例 B 在同目录获取锁——读到 A 写入的锁（PID=当前进程，存活）
    const lmB = new LockManager();
    await lmB.acquire(memoraDir);

    // 锁文件应存在且被覆盖；两个实例互不影响内存状态
    const lockPath = join(memoraDir, '.lock');
    expect(existsSync(lockPath)).toBe(true);
    expect(lmB.currentPath).toBe(lockPath);
    expect(lmA.currentPath).toBe(lockPath);
  });

  it('acquire 不同目录不自动释放旧锁（刻画实际行为）', async () => {
    const memoraDir1 = join(tmpDir, 'proj-a', '.memora');
    const memoraDir2 = join(tmpDir, 'proj-b', '.memora');
    const lm = new LockManager();

    // 第一次 acquire
    await lm.acquire(memoraDir1);
    const lockPath1 = join(memoraDir1, '.lock');
    expect(existsSync(lockPath1)).toBe(true);
    expect(lm.currentPath).toBe(lockPath1);

    // 第二次 acquire 不同目录——不主动释放前一个锁
    // NOTE: LockManager.acquire 不内部调用 release()，
    //       currentLockPath 被直接覆盖为 dir2 的锁路径。
    //       ProjectManager 通过先调用 closeProject()（含 release）规避此行为。
    await lm.acquire(memoraDir2);
    const lockPath2 = join(memoraDir2, '.lock');
    expect(existsSync(lockPath2)).toBe(true);
    expect(lm.currentPath).toBe(lockPath2);
    // dir1 的锁文件仍残留在磁盘（内存状态已丢失对其引用）
    expect(existsSync(lockPath1)).toBe(true);

    // release 只释放当前持有的锁（dir2）
    await lm.release();
    expect(existsSync(lockPath2)).toBe(false);
    expect(lm.currentPath).toBeNull();
  });
});
