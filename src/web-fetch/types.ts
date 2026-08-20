/**
 * 网页抓取提供者接口定义：让 memora 内核具备可注入的网页正文抓取能力。
 * 宿主实现 IFetchProvider 注入自定义抓取实现（接口注入，遵循 IWebSearchProvider 模式；零依赖）。
 * 与 web_search 成对构成「搜索→抓取」闭环：web_search 给出候选 URL，web_fetch 读正文。
 */

/** 抓取到的网页内容 */
export interface FetchedPage {
  /** 页面 URL（若发生重定向则返回实际地址） */
  url: string;
  /** 页面标题（无标题时为空串） */
  title: string;
  /** 清洗后的正文纯文本 */
  content: string;
  /** 内容类型（如 "text/html"、"application/pdf"），无法识别时为空串 */
  contentType?: string;
}

/** 抓取选项 */
export interface FetchOptions {
  /** 返回正文最大字符数（默认 8000） */
  maxChars?: number;
}

/**
 * 网页抓取提供者接口：宿主实现并注入 AgentOptions.fetchProvider 提供抓取能力；
 * 未注入时 Agent 不会暴露 web_fetch 工具给 LLM。
 */
export interface IFetchProvider {
  /** 抓取 URL 并返回清洗后的正文纯文本 */
  fetch(url: string, options?: FetchOptions): Promise<FetchedPage>;
}
