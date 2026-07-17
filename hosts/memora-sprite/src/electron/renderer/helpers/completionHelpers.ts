/**
 * 补全模块共享工具函数
 *
 * 提取 quickInput.ts 和 inputAreaManager.ts 中重复的 fillFromMemory 逻辑，
 * 满足 ADR-017 枝叶层 2 次提取原则。
 */

import type { CompletionItem } from '../quick-input/quickInputCompletion.js';
import { reportError } from './errorHelpers.js';

/** showMemory IPC 返回的记忆详情（仅 content 字段，最小化类型依赖） */
interface MemoryDetail {
  content: string;
}

/**
 * 从数据库获取记忆全量内容并回填
 *
 * 内核 searchMemories 返回的 contentPreview 已被截断（120 字符），
 * 选中记忆候选时通过 showMemory IPC 回库查全量内容。
 * 查询失败时降级使用截断预览 text。
 *
 * @param item 选中的补全候选项（含 memoryId 和降级用的截断 text）
 * @param showMemory 回库查询函数（quickInput 用 this.api.showMemory，主窗口用 window.electronAPI.showMemory）
 * @param fillText 回填文本到输入框的回调
 * @param errorLabel 错误日志标签（区分调用来源）
 * @returns 全量内容字符串（成功时）或截断预览 text（降级时）
 */
export async function fetchMemoryContent(
  item: CompletionItem,
  showMemory: (id: string) => Promise<{ memory: MemoryDetail | null }>,
  fillText: (text: string) => void,
  errorLabel: string,
): Promise<void> {
  const memoryId = item.memoryId!;
  try {
    const result = await showMemory(memoryId);
    const fullContent = result?.memory?.content?.trim();
    if (fullContent) {
      fillText(fullContent);
      return;
    }
  } catch (error) {
    reportError(errorLabel, error, 'warn');
  }
  // 降级：使用截断预览填充（保证不阻塞输入）
  fillText(item.text);
}