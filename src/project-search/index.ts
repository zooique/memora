/**
 * 项目搜索模块出口：宿主项目 import 接入。
 * 只导出接口类型 + 超时保护包装（safe*），与 web-search / web-fetch / code-exec 同构。
 */
export type {
  IProjectSearchProvider,
  ProjectFileMatch,
  ProjectFileSearchOptions,
  ProjectTextMatch,
  ProjectTextSearchOptions,
  ProjectTextSearchResult,
} from '@/project-search/types.js';
export { safeSearchProjectFiles, safeSearchProjectText } from '@/project-search/projectSearchProvider.js';
