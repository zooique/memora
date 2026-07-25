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
import { throwingHandle, requireAgent } from './types.js';
import type { IpcContext } from './types.js';
import { isValidFilePath } from './inputValidation.js';
import { ErrorCode, SpriteError } from '../errorHandler.js';
// WorkProjectionEntry 类型从 memora 内核导出，用于 toWorkProjectionPayload 入参类型
import type { WorkProjectionEntry } from 'memora';

/**
 * 转换 WorkProjectionEntry 为 IPC 传输 payload
 *
 * 提取理由（ADR-017 枝叶层 2 次提取原则）：
 *   WORK_PROJECTION_LIST（列表）和 WORK_PROJECTION_SHOW（单条）两处映射逻辑完全一致，
 *   统一为单一函数避免字段增删时漏改。
 *
 * @param entry 内核返回的作品投影条目
 * @returns IPC 传输用的纯数据对象（无方法/内部状态）
 */
function toWorkProjectionPayload(entry: WorkProjectionEntry): {
  id: string;
  sourcePath: string;
  fileHash: string;
  summary: string;
  structure: string[];
  keyDecisions: string[];
  updatedAt: string;
} {
  return {
    id: entry.id,
    sourcePath: entry.sourcePath,
    fileHash: entry.fileHash,
    summary: entry.summary,
    structure: entry.structure,
    keyDecisions: entry.keyDecisions,
    updatedAt: entry.updatedAt,
  };
}

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
    return throwingHandle(
      '列出作品投影失败',
      async () => {
        const works = requireAgent(ctx).works;
        if (!works) return [];
        const entries = await works.loadAll();
        // 映射为 IPC 传输形态（委托 toWorkProjectionPayload 统一字段提取）
        return entries.map(toWorkProjectionPayload);
      },
    );
  });

  /**
   * 查看单个作品投影详情
   *
   * 通过文件路径查询已有投影，不触发生成（如需生成需先通过 Agent 读取文件）。
   */
  ipcMain.handle(IPC_CHANNELS.WORK_PROJECTION_SHOW, async (_event, filePath: string) => {
    return throwingHandle(
      '查看作品投影失败',
      async () => {
        // filePath 类型 + 长度校验，防止非字符串或超长值进入内核 works.getProjection
        if (!isValidFilePath(filePath)) {
          throw new SpriteError(ErrorCode.VALIDATION_ERROR, '非法文件路径');
        }
        const works = requireAgent(ctx).works;
        if (!works) return null;
        const entry = await works.getProjection(filePath);
        if (!entry) return null;
        return toWorkProjectionPayload(entry);
      },
    );
  });
}
