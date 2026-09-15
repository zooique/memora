/**
 * 项目搜索集成入口：带超时保护的加载包装，组合宿主自定义实现。
 * 搜索失败时不抛异常、不中断对话流程（30s 超时防卡死 Agent 主循环）；
 * 但**失败不再降级为「空结果」**——二者必须可区分，见 `safeSearchProjectText` 的注释。
 */
import type {
  IProjectSearchProvider,
  ProjectFileMatch,
  ProjectFileSearchOptions,
  ProjectTextSearchOptions,
  ProjectTextSearchResult,
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
 * 带超时和错误处理的按内容搜索包装：超时或失败时不抛异常。
 *
 * **为什么失败不返回空数组**（SEARCH-1 · F3）：`[]` 与「真零命中」在调用侧**逐字同形**，
 * 于是「搜索坏了」被当成「项目里没有」——这是本仓最隐蔽的一类假阴性（ripgrep 用 exit 2 与 1
 * 区分这两态，内核此前把三态压成了两态）。失败→上报 `failed: true`（**不是** error，对齐
 * "no results is not an error"：不置错、不重试，只在文案里如实说明检索未完成），由调用方分流表述。
 *
 * 注：`safeSearchProjectFiles`（name 模式）保持数组形状不变（D5 边界：本次不动 name 模式），
 * 其失败→`[]` 的同类静默问题已单独登记为候选，不合并进本次变更。
 */
export async function safeSearchProjectText(
  provider: IProjectSearchProvider,
  options: ProjectTextSearchOptions,
): Promise<ProjectTextSearchResult> {
  const timeoutPromise = new Promise<ProjectTextSearchResult>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error('项目内容搜索超时（30s）'));
    }, PROJECT_SEARCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([provider.searchText(options), timeoutPromise]);
  } catch {
    // 失败不抛异常，但**不再伪装成可信的零命中**
    return { matches: [], truncated: false, failed: true };
  }
}
