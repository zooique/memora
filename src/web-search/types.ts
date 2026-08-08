/**
 * 网络搜索提供者接口定义
 *
 * 定义 IWebSearchProvider 接口，让 memora 内核具备可注入的网络搜索能力。
 * 宿主项目可通过实现此接口注入自定义搜索引擎（如 Google Custom Search、Bing API 等），
 * 内核提供基于 DuckDuckGo HTML 的默认降级实现。
 *
 * 设计原则：
 * - 接口注入，遵循 LlmProvider 模式：IWebSearchProvider 接口供宿主实现
 * - 零依赖：内核不新增第三方依赖
 * - 领域无关：搜索接口纯抽象，搜索引擎类型/API 由宿主自定义
 */

/** 单条搜索结果 */
export interface SearchResult {
  /** 搜索结果标题 */
  title: string;
  /** 搜索结果链接 */
  url: string;
  /** 搜索结果摘要 */
  snippet: string;
}

/** 搜索选项 */
export interface WebSearchOptions {
  /** 返回结果数量上限（默认 5） */
  limit?: number;
}

/**
 * 网络搜索提供者接口
 *
 * 宿主项目实现此接口并注入 AgentOptions.webSearchProvider，
 * 即可让 memora Agent 拥有网络搜索能力。
 * 未注入时，Agent 不会暴露 web_search 工具给 LLM。
 */
export interface IWebSearchProvider {
  /** 搜索互联网，返回结构化结果列表 */
  search(query: string, options?: WebSearchOptions): Promise<SearchResult[]>;
}