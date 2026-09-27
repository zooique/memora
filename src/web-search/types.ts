/**
 * 网络搜索提供者接口定义：让 memora 内核具备可注入的网络搜索能力。
 * 宿主实现 IWebSearchProvider 注入自定义搜索引擎（接口注入，遵循 LlmProvider 模式；零依赖）。
 */
/** 单条搜索结果 */
export interface SearchResult {
  /** 搜索结果标题 */
  title: string;
  /** 搜索结果链接 */
  url: string;
  /** 搜索结果摘要 */
  snippet: string;
  /**
   * 实际服务的搜索后端名称（如 'Bing' / 'DuckDuckGo'）。
   * 降级发生时由 FetchWebSearchProvider 打标，供宿主/工具结果透出「已降级」提示；
   * 可选：自定义 IWebSearchProvider 可不填（向后兼容，现有调用方忽略此字段）。
   */
  endpoint?: string;
}

/** 搜索选项 */
export interface WebSearchOptions {
  /** 返回结果数量上限（默认 5） */
  limit?: number;
}

/**
 * 搜索端点契约：名称 + URL 构造 + HTML 解析。
 * 宿主可构造自己的 SearchEndpoint 注入 FetchWebSearchProvider / buildSearchEndpoints，
 * 内核内置 SEARCH_ENDPOINT_REGISTRY 仅作零配置保底基线（非真理源）。
 */
export interface SearchEndpoint {
  /** 端点名称（降级打标 / 结果透出用） */
  name: string;
  /** 由查询构造请求 URL */
  buildUrl(query: string): string;
  /** 从结果页 HTML 解析出结构化结果 */
  parse(html: string, limit: number): SearchResult[];
}

/**
 * 网络搜索提供者接口：宿主实现并注入 AgentOptions.webSearchProvider 提供搜索能力；
 * 未注入时 Agent 不会暴露 web_search 工具给 LLM。
 */
export interface IWebSearchProvider {
  /** 搜索互联网，返回结构化结果列表 */
  search(query: string, options?: WebSearchOptions): Promise<SearchResult[]>;
}
