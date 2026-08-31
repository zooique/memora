/**
 * 项目搜索提供者接口定义：让 memora 内核具备可注入的「项目内搜索」能力。
 * 宿主实现 IProjectSearchProvider 注入自定义实现（VS Code 宿主用 workspace.findFiles /
 * findTextInFiles，等价 IDE 全局搜索 Ctrl+Shift+F）。接口注入，遵循 IWebSearchProvider
 * 模式；零依赖。
 */

/** 按文件名 glob 命中的文件 */
export interface ProjectFileMatch {
  /** 文件相对项目根的路径 */
  path: string;
}

/** 按内容全文命中的文件（含行级定位，供后续 read_file 精读） */
export interface ProjectTextMatch {
  /** 文件相对项目根的路径 */
  path: string;
  /** 命中行号（1 起；宿主可不提供） */
  line?: number;
  /** 命中行预览片段（去控制字符 + 限长，防上下文注入） */
  preview?: string;
}

/** 按文件名搜索的选项 */
export interface ProjectFileSearchOptions {
  /** 文件名 glob（如匹配 src 目录下全部 TS 文件）；省略时列出项目全部文件（受 maxResults 限制） */
  query?: string;
  /** 限定目录/文件 glob（可选，如仅搜 src 目录） */
  include?: string;
  /** 排除 glob（可选，如排除 node_modules 目录） */
  exclude?: string;
  /** 返回结果数量上限 */
  maxResults?: number;
}

/** 按内容全文搜索的选项 */
export interface ProjectTextSearchOptions extends ProjectFileSearchOptions {
  /** 内容查询词（宿主按需转为正则） */
  pattern: string;
}

/**
 * 项目搜索提供者接口：宿主实现并注入 AgentOptions.projectSearchProvider 提供
 * 「在项目（当前工作区）中搜索文件」能力；未注入时内核不暴露 search_project 工具给 LLM。
 */
export interface IProjectSearchProvider {
  /** 按文件名 glob 搜索项目文件，返回相对项目根的文件路径列表（按 include/exclude 过滤） */
  searchFiles(options?: ProjectFileSearchOptions): Promise<ProjectFileMatch[]>;
  /** 按内容全文搜索项目文件（等价全局搜索内容），返回命中文件及行预览 */
  searchText(options: ProjectTextSearchOptions): Promise<ProjectTextMatch[]>;
}
