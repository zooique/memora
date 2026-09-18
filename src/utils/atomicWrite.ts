/**
 * 原子写文件 — 先写同目录临时文件，再 rename 覆盖目标
 *
 * 解决的问题：直写目标路径时若进程在写入中途崩溃/断电，目标文件会停留在
 * 被截断的半成品状态。对「唯一真理源」类文件而言这等于数据永久损坏。
 * rename 在同一文件系统内是原子操作——目标要么是旧内容，要么是完整新内容。
 *
 * 适用：内容为唯一真理源且损坏后不可重建的文件
 *   - 设定记忆 md（文件即真理源，SQLite 只是派生索引）
 *
 * 不适用（用了反而制造 Bug）：
 *   - 锁文件：语义要求排他创建，rename 会静默覆盖他人持有的锁
 *   - 面向用户的文件写工具：rename 更换 inode，破坏硬链接、符号链接目标、
 *     以及编辑器/监视器对该 inode 的订阅
 *
 * 临时文件与目标同目录，确保 rename 不跨设备（跨设备 rename 会抛 EXDEV）。
 * 调用方需自行保证目标目录已存在。
 */
import { writeFile, rename } from 'node:fs/promises';

/**
 * 原子写入文本文件（UTF-8）
 *
 * @param filePath - 目标文件绝对路径（其所在目录须已存在）
 * @param content - 待写入的文本内容
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}
