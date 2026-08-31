/**
 * 项目搜索集成入口：带超时保护的加载包装，组合宿主自定义实现。
 * 搜索失败时降级返回空结果（不抛异常），不中断对话流程（30s 超时防卡死 Agent 主循环）。
 */
import type {
  IProjectSearchProvider,
  ProjectFileMatch,
  ProjectFileSearchOptions,
  ProjectTextMatch,
  ProjectTextSearchOptions,
} from '@/project-search/types.js';

/** 项目搜索超时时间（毫秒） */
const PROJECT_SEARCH_TIMEOUT_MS = 30_000;

/**
 * 带超时和错误处理的按文件名搜索包装：超时或失败时不抛异常，返回空数组（降级）。
 * 供 ToolExecutor 调用，避免宿主实现卡死主循环。
 */
export async function safeSearchProjectFiles(
  provider: IProjectSearchProvider,
  options?: ProjectFileSearchOptions,
): Promise<ProjectFileMatch[]> {
  const timeoutPromise = new Promise<ProjectFileMatch[]>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error('项目文件搜索超时（30s）'));
    }, PROJECT_SEARCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([provider.searchFiles(options), timeoutPromise]);
  } catch {
    // 搜索失败不抛异常，降级为空结果
    return [];
  }
}

/**
 * 带超时和错误处理的按内容搜索包装：超时或失败时不抛异常，返回空数组（降级）。
 */
export async function safeSearchProjectText(
  provider: IProjectSearchProvider,
  options: ProjectTextSearchOptions,
): Promise<ProjectTextMatch[]> {
  const timeoutPromise = new Promise<ProjectTextMatch[]>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error('项目内容搜索超时（30s）'));
    }, PROJECT_SEARCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([provider.searchText(options), timeoutPromise]);
  } catch {
    // 搜索失败不抛异常，降级为空结果
    return [];
  }
}
