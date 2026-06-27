/**
 * 作品投影 IPC 处理器
 *
 * 职责：
 *   1. 列出所有作品投影（WORK_PROJECTION_LIST）
 *   2. 查看单个作品投影详情（WORK_PROJECTION_SHOW）
 *
 * 投影由 Agent 读取文件时自动生成（read_file 工具内置 ensureProjection 调用），
 * 此通道仅提供查看能力，不触发生成。
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from './channels.js';
import type { WorkProjectionPayload } from './channels.js';
import { safeHandle } from './types.js';
import type { IpcContext } from './types.js';
import { isValidFilePath } from './inputValidation.js';

/**
 * 注册作品投影 IPC 处理器
 *
 * @param ctx IPC 上下文
 */
export function registerWorkProjectionHandlers(ctx: IpcContext): void {
  /**
   * 列出所有作品投影
   */
  ipcMain.handle(IPC_CHANNELS.WORK_PROJECTION_LIST, async () => {
    return safeHandle(
      'WORK_PROJECTION_LIST',
      [] as WorkProjectionPayload[],
      async () => {
        const works = ctx.agent.works;
        if (!works) return [];
        const entries = await works.loadAll();
        // 映射为 IPC 传输形态（与 WorkProjectionEntry 对齐）
        return entries.map((e) => ({
          id: e.id,
          sourcePath: e.sourcePath,
          fileHash: e.fileHash,
          summary: e.summary,
          structure: e.structure,
          keyDecisions: e.keyDecisions,
          updatedAt: e.updatedAt,
        }));
      },
    );
  });

  /**
   * 查看单个作品投影详情
   *
   * 通过文件路径查询已有投影，不触发生成（如需生成需先通过 Agent 读取文件）。
   */
  ipcMain.handle(IPC_CHANNELS.WORK_PROJECTION_SHOW, async (_event, filePath: string) => {
    return safeHandle(
      'WORK_PROJECTION_SHOW',
      null as WorkProjectionPayload | null,
      async () => {
        // FOUNDATION-SEAL Phase 3 轮3：filePath 类型 + 长度校验，
        // 防止非字符串或超长值进入内核 works.getProjection
        if (!isValidFilePath(filePath)) {
          return null;
        }
        const works = ctx.agent.works;
        if (!works) return null;
        const entry = await works.getProjection(filePath);
        if (!entry) return null;
        return {
          id: entry.id,
          sourcePath: entry.sourcePath,
          fileHash: entry.fileHash,
          summary: entry.summary,
          structure: entry.structure,
          keyDecisions: entry.keyDecisions,
          updatedAt: entry.updatedAt,
        };
      },
    );
  });
}
