/**
 * 配置建议与用户画像 IPC 处理器
 *
 * 职责：
 *   1. H1 配置建议闭环（AutoConfigRefiner 产出 → 用户确认/拒绝 → 持久化）
 *   2. H2 用户画像闭环（提取 → 待确认 → 确认/拒绝 → 持久化）
 *
 * 配置建议持久化路径：
 *   - rule → projectPath/.memora/rules/{name}.md
 *   - persona → projectPath/.memora/personas/{name}.md
 *   - skill → projectPath/.memora/skills/{name}.md
 * 下次启动时由 MemoryLoader 自动扫描加载到 SQLite。
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../ipcChannels.js';
import { safeHandle } from './types.js';
import { isValidConfigName, isValidContent } from './inputValidation.js';
import type { IpcContext } from './types.js';

/**
 * 注册配置建议与用户画像 IPC 处理器
 *
 * @param ctx IPC 上下文
 */
export function registerSuggestionHandlers(ctx: IpcContext): void {
  // ─── H1：配置建议（AutoConfigRefiner 闭环） ──────────────

  /**
   * 接受配置建议 — 调用 confirmConfigSuggestion 持久化到配置文件
   */
  ipcMain.handle(
    IPC_CHANNELS.SUGGESTION_ACCEPT,
    async (_event, suggestion: { type: 'rule' | 'persona' | 'skill'; name: string; content: string; confidence: number; source?: string }) => {
      return safeHandle(
        'SUGGESTION_ACCEPT',
        { success: false, error: '未知错误' },
        async () => {
          // P1-SEC-01 输入验证：拒绝含路径分隔符的配置名，防止路径遍历写入
          if (!isValidConfigName(suggestion.name)) {
            return { success: false, error: '无效的配置名称' };
          }
          // P1-SEC-01 输入验证：拒绝超大内容，防止内存耗尽
          if (!isValidContent(suggestion.content)) {
            return { success: false, error: '内容过长' };
          }
          const config = ctx.agent.config;
          if (!config) {
            return { success: false, error: '配置管理器未就绪' };
          }
          await config.confirmConfigSuggestion(suggestion);
          return { success: true };
        },
      );
    },
  );

  /**
   * 拒绝配置建议 — 仅记录日志，不持久化
   *
   * 用户拒绝后该建议被丢弃，不会再次出现（除非下次对话再次提取到相同建议）。
   */
  ipcMain.handle(
    IPC_CHANNELS.SUGGESTION_REJECT,
    async (_event, _suggestion: { type: 'rule' | 'persona' | 'skill'; name: string; content: string; confidence: number; source?: string }) => {
      // 拒绝仅记录日志，无副作用
      return { success: true };
    },
  );

  // ─── H2：用户画像（UserProfile 闭环） ────────────────────

  /**
   * 列出所有画像条目（含已确认 + 待确认）
   *
   * 已确认条目：持久化在 SQLite（source='profile'），进程重启后保留
   * 待确认条目：仅存内存缓存，进程重启后丢失
   */
  ipcMain.handle(IPC_CHANNELS.USER_PROFILE_LIST, async () => {
    return safeHandle(
      'USER_PROFILE_LIST',
      { entries: [] as Array<{ id: string; category: string; value: string; source: string; weight: number; confirmed: boolean; updatedAt: string }> },
      () => {
        const profile = ctx.agent.userProfile;
        if (!profile) {
          return { entries: [] };
        }
        // 合并已确认 + 待确认条目
        const confirmed = profile.getConfirmed();
        const pending = profile.getPending();
        const entries = [...confirmed, ...pending].map((e) => ({
          id: e.id,
          category: e.category,
          value: e.value,
          source: e.source,
          weight: e.weight,
          confirmed: e.confirmed,
          updatedAt: e.updatedAt,
        }));
        return { entries };
      },
    );
  });

  /**
   * 确认待确认画像条目 — 写入存储 + 标记 confirmed
   *
   * 确认后条目持久化到 SQLite（source='profile'），后续 buildSystemPrompt 会包含。
   */
  ipcMain.handle(IPC_CHANNELS.USER_PROFILE_CONFIRM, async (_event, id: string) => {
    return safeHandle(
      'USER_PROFILE_CONFIRM',
      { success: false, error: '未知错误' },
      async () => {
        const profile = ctx.agent.userProfile;
        if (!profile) {
          return { success: false, error: '用户画像管理器未就绪' };
        }
        await profile.confirm(id);
        return { success: true };
      },
    );
  });

  /**
   * 拒绝画像条目 — 从缓存删除，已确认的也从存储删除
   *
   * 拒绝后条目不再出现在 systemPrompt 中，也不会被召回。
   */
  ipcMain.handle(IPC_CHANNELS.USER_PROFILE_REJECT, async (_event, id: string) => {
    return safeHandle(
      'USER_PROFILE_REJECT',
      { success: false, error: '未知错误' },
      async () => {
        const profile = ctx.agent.userProfile;
        if (!profile) {
          return { success: false, error: '用户画像管理器未就绪' };
        }
        await profile.reject(id);
        return { success: true };
      },
    );
  });
}
