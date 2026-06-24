/**
 * IPC 处理器注册（聚合入口 re-export）
 *
 * 原单文件 823 行已按领域拆分到 ./ipc/ 目录：
 *   - types.ts              共享类型（IpcContext）+ 工具函数（safeHandle）
 *   - chatHandlers.ts       对话流式输出（USER_INPUT / CHAT_ABORT / handleUserInput）
 *   - sessionHandlers.ts    会话管理（SESSION_LOAD / SWITCH / DELETE / RENAME / NEW / LIST）
 *   - memoryHandlers.ts     记忆 CRUD（MEMORIES_*）
 *   - configHandlers.ts     配置 + 角色（CONFIG_* / PERSONA_*）
 *   - systemHandlers.ts     主动提示 + 项目 + 仪表盘 + 主题
 *   - suggestionHandlers.ts 配置建议 + 用户画像（H1 + H2）
 *   - workProjectionHandlers.ts 作品投影（H3）
 *   - index.ts              聚合注册 + 通道清理
 *
 * 此文件保留 re-export 以维持向后兼容（main.ts 和测试文件的 import 路径不变）。
 */

export { registerIpcHandlers } from './index.js';
export type { IpcContext } from './types.js';
