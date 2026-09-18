---
alwaysApply: false
description: "memora 内核 Web 搜索模块——IWebSearchProvider 接口 + FetchWebSearchProvider 内置实现，条件暴露给 LLM"
---

# ADR-017 · Web 搜索模块

> **状态**：✅ 已接受（2026-07-30，回溯补录）
> **依赖**：ADR-010（Agent 工具注册机制）

## 背景

v2.0 版本的 Agent 内置工具列表不含网络搜索能力。用户需求显示：

1. **实时信息需求**——LLM 训练数据截止日期后的事件（如最新新闻、股价、天气）无法回答
2. **竞争产品对标**——同类产品（如 Claude、ChatGPT）已内置 web search 能力
3. **宿主差异化**——不同宿主可能有不同的搜索后端（如 SerpAPI、Bing Search、自定义内网搜索）

## 决策

采用 **接口 + 条件注入** 模式（与内核其余可注入能力同构的通用接口注入模式）。

### 1. 接口定义（`src/web-search/types.ts`）

`SearchResult { title; url; snippet }` + `IWebSearchProvider.search(query, options?): Promise<SearchResult[]>`。完整定义以源码为准，此处不内嵌。

### 2. 内置实现（`src/web-search/fetchWebSearchProvider.ts`）

使用 Node.js 内置 `fetch`（零第三方依赖），通过 HTML 解析提取搜索结果片段。

### 3. 条件暴露

- 仅当宿主注入 `IWebSearchProvider` 实现时，LLM 工具列表中才出现 `web_search` 工具
- 未注入时，LLM 被告知"网络搜索能力不可用"
- 防止无关宿主暴露无用工具

### 4. 幂等性保护

- `web_search` 标记为 `idempotent`（相同查询返回一致结果）
- 注册时检查 `WEB_SEARCH_TOOL` 名称防重复注册

## 模块结构

```
src/web-search/
├── types.ts                  ← WebSearchResult / IWebSearchProvider 接口
├── webSearchProvider.ts      ← safeSearch 包装 + 工具注册逻辑
├── fetchWebSearchProvider.ts ← FetchWebSearchProvider 实现（Node.js fetch）
└── __tests__/
    ├── webSearchProvider.test.ts    ← 工具结构/可见性/注册保护测试
    └── fetchWebSearchProvider.test.ts ← HTML 解析/错误处理/超时测试
```

## 设计要点

1. **零依赖内核原则**——`IWebSearchProvider` 接口不含任何第三方依赖，`FetchWebSearchProvider` 使用 Node.js 内置 `fetch`
2. **安全兜底**——`safeSearch` 提供成功/失败/超时三级降级策略，防止搜索失败阻塞 Agent 流程
3. **测试覆盖**——16 个测试用例覆盖工具结构完整性、执行逻辑、provider 行为、重复注册保护
4. **宿主扩展**——宿主可提供自定义 `IWebSearchProvider` 实现（如接入内部搜索 API），无需修改内核

## 后果

### 正面

- LLM 能力补全——实时信息查询不再依赖训练数据截止日期
- 架构一致性——接口注入模式与内核其余可注入能力同构
- 宿主灵活性——搜索后端可替换，不绑定特定服务

### 负面

- 新增顶层模块，需同步更新 project-rules.md §3 冻结目录清单
- HTML 解析正则表达式脆弱，搜索结果格式变更可能导致解析失败
- 网络搜索增加 Agent 响应延迟（受网络状况影响）