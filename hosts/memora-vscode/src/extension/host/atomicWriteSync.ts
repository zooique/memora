/**
 * 同步原子写入工具 — 先写临时文件再 rename 覆盖
 *
 * 解决的问题：直写目标路径时若进程在写入中途崩溃/断电，目标文件会停留在
 * 被截断的半成品状态。对记忆/会话文件而言这等于数据永久损坏。
 * rename 在同一文件系统内是原子操作——目标要么是旧内容，要么是完整新内容。
 *
 * 与内核 atomicWriteFile（异步）对称，用于宿主同步存储场景。
 * 临时文件与目标同目录，确保 rename 不跨设备（跨设备 rename 会抛 EXDEV）。
 *
 * @module atomicWriteSync
 */
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 同步原子写入文本文件（UTF-8）
 *
 * 写入流程：
 *   1. 确保目标目录存在
 *   2. 写入同目录 .tmp 临时文件
 *   3. renameSync 原子覆盖目标文件
 *
 * @param filePath 目标文件绝对路径（其所在目录须已存在或可创建）
 * @param content 待写入的文本内容
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}
