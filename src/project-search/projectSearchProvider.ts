/**
 * 项目搜索集成入口：带超时保护的加载包装，组合宿主自定义实现。
 * 搜索失败时不抛异常、不中断对话流程（30s 超时防卡死 Agent 主循环）；
 * 但**失败不再降级为「空结果」**——二者必须可区分，见 `safeSearchProjectText` 的注释。
 */
import type {
  IProjectSearchProvider,
  ProjectFileSearchOptions,
  ProjectFileSearchResult,
  ProjectTextSearchOptions,
  ProjectTextSearchResult,
} from '@/project-search/types.js';

/** 项目搜索超时时间（毫秒） */
const PROJECT_SEARCH_TIMEOUT_MS = 30_000;

/**
 * 带超时和错误处理的按文件名搜索包装：超时或失败时不抛异常。
 *
 * **为什么失败不返回空数组**（name 模式同 content）：`[]` 与「真零命中」在调用侧
 * **逐字同形**，于是「搜索坏了」被当成「项目里没有」——扁平数组返回正是这类
 * 假阴性的温床（返回 `ProjectFileSearchResult` 对象，放宽/截断/失败各有载体）。
 * 失败→上报 `failed: true`（**不是** error：不置错、不重试，只在文案里如实说明检索未完成），
 * 由调用方分流表述。
 */
export async function safeSearchProjectFiles(
  provider: IProjectSearchProvider,
  options?: ProjectFileSearchOptions,
): Promise<ProjectFileSearchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<ProjectFileSearchResult>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('项目文件搜索超时（30s）')),
      PROJECT_SEARCH_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([provider.searchFiles(options), timeoutPromise]);
  } catch {
    // 失败不抛异常，但**不再伪装成可信的零命中**
    return { matches: [], truncated: false, failed: true };
  } finally {
    // 成功/失败均清理超时定时器，防残留定时器拖住进程
    clearTimeout(timer);
  }
}

/**
 * 带超时和错误处理的按内容搜索包装：超时或失败时不抛异常。
 *
 * **为什么失败不返回空数组**：`[]` 与「真零命中」在调用侧**逐字同形**，
 * 于是「搜索坏了」被当成「项目里没有」——这是本仓最隐蔽的一类假阴性（ripgrep 用 exit 2 与 1
 * 区分这两态）。失败→上报 `failed: true`（**不是** error，对齐
 * "no results is not an error"：不置错、不重试，只在文案里如实说明检索未完成），由调用方分流表述。
 *
 * 注：`safeSearchProjectFiles`（name 模式）与 content 同一套元信息载体
 * （`ProjectFileSearchResult` + 失败→`failed: true`）。
 */
export async function safeSearchProjectText(
  provider: IProjectSearchProvider,
  options: ProjectTextSearchOptions,
): Promise<ProjectTextSearchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<ProjectTextSearchResult>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('项目内容搜索超时（30s）')),
      PROJECT_SEARCH_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([provider.searchText(options), timeoutPromise]);
  } catch {
    // 失败不抛异常，但**不再伪装成可信的零命中**
    return { matches: [], truncated: false, failed: true };
  } finally {
    // 成功/失败均清理超时定时器，防残留定时器拖住进程
    clearTimeout(timer);
  }
}
