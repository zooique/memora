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

/**
 * 按内容搜索的**结果对象**（SEARCH-1 修复：三态通道）
 *
 * 为什么不是一个 `ProjectTextMatch[]`：截断/失败/放宽都是**关于本次检索本身**的元信息，
 * 挂在逐条命中上时**零命中就没有载体**（空数组承载不了任何字段）——于是「没搜到」与
 * 「没搜完」与「搜索坏了」在调用侧逐字同形。返回对象让这三态各自可见（对齐 ripgrep
 * 的 exit 0/1/2：有匹配 / 可信的零 / 出错了）。
 */
export interface ProjectTextSearchResult {
  /** 命中列表（零命中也可能是 "没搜完" 或 "搜索失败"，须结合下方标记判断，勿单独采信） */
  matches: ProjectTextMatch[];
  /** 检索被截断：零命中或少量命中都**不代表"不存在"** */
  truncated: boolean;
  /** 截断主因：`results` 结果达上限 / `files` 扫描达文件上限（二者可同时成立时以 `results` 为停因） */
  truncatedBy?: 'results' | 'files';
  /**
   * 实际参与匹配的文件数（宿主**上报的数据**，不是内核常量——内核从不扫描，见 D4 判定律：
   * 宿主内部预算量不得提升为内核常量，只能以结果对象数据上报）
   */
  scannedFiles?: number;
  /**
   * 只检索了**前一部分**（文件过大，后半段未覆盖）的文件数；`> 0` 时"零命中"不等于"不存在"
   *
   * 注意语义：这些文件**参与了检索**（不是被跳过），只是覆盖面不完整——故不叫 "skipped"。
   */
  partialReadFiles?: number;
  /**
   * 读取失败（权限不足 / 已被删除 / 悬空链接 / IO 错误）而**完全未参与检索**的文件数
   *
   * 与 `partialReadFiles` 区分：前者"看了但没看全"，后者"根本没看上"——两者都是"零命中不等于不存在"的
   * 依据，但补救动作不同（部分读 → 换更具体的关键词或 read_file 精读；读取失败 → 可重试）。
   */
  unreadableSkipped?: number;
  /** 某文件命中数曾被"单文件上限"截断（结果条数**不完整**） */
  perFileCapped?: boolean;
  /** 检索自身失败（超时/抛错）≠ 真零命中——与 `matches: []` **正交**，须分流表述 */
  failed?: boolean;
  /** 整串未精确命中、已放宽为分词匹配 → 结果**非精确**命中 */
  relaxed?: boolean;
  /**
   * 放宽时**实际使用**的词（文案"已按 … 放宽"的**唯一取值来源**）
   *
   * ⚠️ 调用方**不得**改用自己下发的那份 `terms`——那样就有两份副本需要保持一致（双轨镜像）；
   * 唯一真值 = 宿主回报的这个字段。
   */
  termsUsed?: string[];
}

/**
 * 按文件名搜索的结果对象（SEARCH-1 name 模式修复：与 content 对齐，两轮语义）
 *
 * 原先是扁平 `ProjectFileMatch[]`：零命中与放宽**没有载体**——空数组承载不了任何标志，
 * 于是「真零命中」与「放宽过的零命中」在调用侧逐字同形。与 `ProjectTextSearchResult`
 * 同构：放宽/截断都是**关于本次检索本身**的元信息，返回对象让各态各自可见
 * （对齐 ripgrep 的 exit 0/1/2：有匹配 / 可信的零 / 出错了）。
 */
export interface ProjectFileSearchResult {
  /** 命中列表（零命中也可能是"没搜完"或"搜索失败"，须结合标记判断，勿单独采信） */
  matches: ProjectFileMatch[];
  /** 整串 glob 未精确命中、已放宽为名称子串匹配 → 结果**非精确**命中 */
  relaxed?: boolean;
  /**
   * 放宽时**实际使用**的词（文案"已按 … 放宽"的**唯一取值来源**）
   *
   * ⚠️ 调用方**不得**改用自己下发的那份 `terms`——那样就有两份副本需要保持一致（双轨镜像）；
   * 唯一真值 = 宿主回报的这个字段。
   */
  termsUsed?: string[];
  /** 检索被截断（findFiles 达 maxResults 上限） */
  truncated?: boolean;
  /** 截断主因：`results` 结果达上限 / `files` 扫描达文件上限（name 模式下仅 results） */
  truncatedBy?: 'results' | 'files';
  /** 检索自身失败（超时/抛错）≠ 真零命中 —— 与 `matches: []` **正交**，须分流表述 */
  failed?: boolean;
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
  /**
   * 放宽词表（由内核分词 SSOT 产出，见 `buildSearchTerms`）；宿主**仅在整串/原样 glob 零命中时**才启用，
   * 未提供则不放宽。放宽的**判定**留在宿主（只有宿主知道扫了多少、有没有扫完）。
   * name 与 content 共用（SEARCH-1：两模式同一放宽设施，无第二套节奏）。
   */
  terms?: string[];
}

/** 按内容全文搜索的选项 */
export interface ProjectTextSearchOptions extends ProjectFileSearchOptions {
  /** 内容查询词（宿主按**字面量**匹配；宿主自行决定大小写与转义，内核不假定正则语义） */
  pattern: string;
}

/**
 * 项目搜索提供者接口：宿主实现并注入 AgentOptions.projectSearchProvider 提供
 * 「在项目（当前工作区）中搜索文件」能力；未注入时内核不暴露 search_project 工具给 LLM。
 */
export interface IProjectSearchProvider {
  /**
   * 按文件名 glob 搜索项目文件，返回命中列表 + **本次检索的元信息**（放宽/截断）
   *
   * 实现约定（宿主侧）：① 先按 `query` 原样作 glob 精确匹配（保会写 glob 的用法）；
   * ② 零命中且 `query` 无 glob 元字符、且 `terms` 非空时，才用 `terms` 按名称子串做一次
   * OR 放宽，并置 `relaxed` + 回填 `termsUsed`；③ 截断**必须回报**（宁少勿假）。
   */
  searchFiles(options?: ProjectFileSearchOptions): Promise<ProjectFileSearchResult>;
  /**
   * 按内容全文搜索项目文件（等价全局搜索内容），返回命中文件及行预览 + **本次检索的元信息**
   *
   * 实现约定（宿主侧）：① 先按 `pattern` 整串匹配（精确优先）；② 整串零命中且 `terms` 非空时，
   * 才用 `terms` 做一次 OR 放宽，并置 `relaxed` + 回填 `termsUsed`；③ 截断/跳过/失败等事实
   * **必须回报**（宁少勿假：报告"没搜完"好过让调用方把"没搜到"当成"不存在"）。
   */
  searchText(options: ProjectTextSearchOptions): Promise<ProjectTextSearchResult>;
}
