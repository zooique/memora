# 方案：IWebSearchProvider 网络搜索接口

## 1. 核心需求

Memora 内核需要内置网络搜索能力，使 Agent 在需要实时信息时能通过 LLM 自主调用搜索。当前 web_search 完全依赖宿主通过 `registerTool()` 注册，导致：

- 每个宿主必须重复实现 web_search 工具定义
- 内核系统 prompt 不知道宿主是否有搜索能力
- 没有标准化的搜索接口抽象

## 2. 设计原则

- **接口注入，遵循 LlmProvider 模式**：`IWebSearchProvider` 接口供宿主实现，内核提供默认降级实现
- **零依赖**：内核不新增第三方依赖，默认实现使用 Node.js 18+ 内置 `fetch`
- **降级优先**：未注入搜索能力时，LLM 被告知"网络搜索不可用"，不影响对话
- **领域无关**：搜索接口纯抽象，搜索引擎类型/API 由宿主自定义

## 3. 接口定义

```typescript
// src/webSearch/types.ts

/** 单条搜索结果 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 网络搜索提供者接口 */
export interface IWebSearchProvider {
  /** 搜索互联网，返回结构化结果 */
  search(query: string, options?: WebSearchOptions): Promise<SearchResult[]>;
}

/** 搜索选项 */
export interface WebSearchOptions {
  limit?: number;
}
```

## 4. 默认实现：FetchWebSearchProvider

使用 `https://html.duckduckgo.com/html/?q=` 策略（DuckDuckGo 的 HTML 版本，无需 API Key），解析搜索结果中的 `<a>` 标签和摘要文本。

```typescript
// src/webSearch/fetchWebSearchProvider.ts

export class FetchWebSearchProvider implements IWebSearchProvider {
  // 使用内置 fetch（Node 18+），零额外依赖
  async search(query: string, options?: WebSearchOptions): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const html = await response.text();
    // 解析 HTML 提取结果
    return parseSearchResults(html, options?.limit ?? 5);
  }
}
```

## 5. 集成到 Agent

### 5.1 AgentOptions 新增字段

```typescript
export interface AgentOptions {
  // ... 现有字段
  
  /** 网络搜索提供者（可选，不传则不启用网络搜索能力） */
  webSearchProvider?: IWebSearchProvider;
}
```

### 5.2 AgentLoop 新增工具定义

当 `webSearchProvider` 注入时，AgentLoop 自动注册 `web_search` 内置工具（与 `read_file`/`write_file` 同级），LLM 可直接调用。

### 5.3 System Prompt 信息注入

| 状态 | 注入信息 |
|------|---------|
| 有 webSearchProvider | "你有网络搜索能力，可通过 web_search 工具获取实时信息" |
| 无 webSearchProvider | 不注入，LLM 不知道有搜索能力 |

### 5.4 错误处理

```
搜索失败 → 降级返回 "网络搜索暂不可用，请稍后重试" → 不中断对话
搜索超时 → 30s 超时保护 → 降级返回
```

## 6. 架构兼容性

### 6.1 与现有工具系统的关系

- `web_search` 作为第 5 个内置工具，不通过 `registerTool()` 注册
- 宿主可通过 `registerTool()` 注册同名工具覆盖内置行为（当前不允许覆盖内置工具，需修改此限制）
- 或 宿主通过 `AgentOptions` 注入自定义 `IWebSearchProvider` 覆盖默认实现

### 6.2 与 "领域无关" 原则

网络搜索是通用能力，不是领域绑定。与 `read_file`/`write_file` 同属"通用工具"类别。

### 6.3 与 "零依赖" 原则

- 默认实现使用 `fetch`（Node.js 18+ 内置）
- 不引入第三方 HTML 解析库（使用 `DOMParser` 或正则提取）
- 接口定义纯 TypeScript 类型，零运行时开销

## 7. 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/webSearch/types.ts` | 新增 | 接口定义 |
| `src/webSearch/fetchWebSearchProvider.ts` | 新增 | 默认实现 |
| `src/agent/types.ts` | 修改 | AgentOptions 新增 webSearchProvider 字段 |
| `src/agent/agent.ts` | 修改 | 构造参数接收 + 传递给 loop |
| `src/agent/loop.ts` | 修改 | 新增 web_search 内置工具 + 系统 prompt 注入 |
| `src/agent/builtinTools.ts` | 修改 | 新增 web_search 工具定义 |
| `src/agent/builtinToolHandlers.ts` | 修改 | 新增 webSearch 处理器 |
| `src/agent/toolExecutor.ts` | 修改 | 分发 web_search 到内置处理器 |
| `src/index.ts` | 修改 | 导出 IWebSearchProvider 等类型 |
| `src/webSearch/webSearchProvider.ts` | 新增 | 集成入口（组合默认实现 + 错误处理） |

## 8. 分层推演

### 执行步骤

1. **接口层**：新建 `src/webSearch/types.ts`，定义 `IWebSearchProvider`、`SearchResult`、`WebSearchOptions`
2. **默认实现**：新建 `src/webSearch/fetchWebSearchProvider.ts`，基于 `fetch` 封装 DuckDuckGo HTML 搜索
3. **集成层**：新建 `src/webSearch/webSearchProvider.ts`，提供错误处理 + 超时保护的包装
4. **AgentOptions**：修改 `src/agent/types.ts`，新增 `webSearchProvider?: IWebSearchProvider`
5. **Agent 构造**：修改 `src/agent/agent.ts`，接收 webSearchProvider 并传递给 loop
6. **AgentLoop**：修改 `src/agent/loop.ts`，新增 web_search 工具定义 + 条件注入系统 prompt
7. **内置工具**：修改 `src/agent/builtinTools.ts`，新增 `web_search` 工具定义
8. **内置处理器**：修改 `src/agent/builtinToolHandlers.ts`，新增 `webSearch` 方法
9. **工具执行器**：修改 `src/agent/toolExecutor.ts`，分发 `web_search` 到内置处理器
10. **导出**：修改 `src/index.ts`，导出新类型
11. **测试**：新增 `src/webSearch/__tests__/` 测试文件