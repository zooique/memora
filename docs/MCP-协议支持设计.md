# MCP 协议支持设计

> 基于 MCP 2026-07-28 规范（Stateless Protocol Core）的 Agent 工具扩展方案。
> 设计定位：P3 后续，高优先级，4 小时设计 + 8 小时实现。

---

## 1. 背景与目标

### 1.1 现状

当前工具注册是硬编码的：`BUILTIN_TOOLS` 定义 6 个内置工具 + `registerTool()` 供宿主注册自定义工具。所有工具在编译时已知，缺少动态工具发现机制。

### 1.2 目标

通过 MCP（Model Context Protocol）协议，让 Agent 能动态发现和调用外部工具：

- **动态发现**：Agent 启动时（或运行时）连接 MCP 服务器，自动发现可用工具
- **标准协议**：遵循 MCP 2026-07-28 规范，使用 JSON-RPC 2.0 通信
- **零侵入内核**：MCP 工具以"自定义工具"形式注册到现有 ToolExecutor，不修改 AgentLoop 核心逻辑
- **可选集成**：MCP 支持是可选模块，仅在配置了 MCP 服务器时激活

### 1.3 设计约束

| 约束 | 说明 |
|------|------|
| 零依赖内核 | 核心库不强制依赖 `@modelcontextprotocol/client`，MCP 为可选能力 |
| 向后兼容 | 无 MCP 配置时行为完全不变 |
| 幂等一致 | MCP 工具遵循现有幂等契约（idempotent / idempotent-key / non-idempotent） |
| 错误隔离 | 单个 MCP 服务器故障不影响其他工具和 Agent 主流程 |

---

## 2. 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                        Agent 系统                              │
│                                                              │
│  ┌──────────────┐      ┌──────────────────────────────┐      │
│  │  ToolExecutor │      │         MCPManager           │      │
│  │              │      │                              │      │
│  │  BUILTIN_TOOLS│     │  ┌────────────────────────┐  │      │
│  │  customTools  │◄────│  │   MCPClient(stdio)     │  │      │
│  │              │     │  ├────────────────────────┤  │      │
│  │  execute()   │     │  │   MCPClient(SSE)       │  │      │
│  │              │     │  ├────────────────────────┤  │      │
│  │  registerTool│◄────│  │   MCPClient(HTTP)      │  │      │
│  └──────────────┘      │  └────────────────────────┘  │      │
│                        └──────────────────────────────┘      │
│                              │                               │
│                         ┌────┴─────┐                        │
│                         │  配置加载  │                        │
│                         │ mcpServers│                        │
│                         └──────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 核心组件

| 组件 | 职责 |
|------|------|
| **MCPManager** | 管理多个 MCP 客户端连接生命周期；连接时自动发现工具并注册到 ToolExecutor |
| **MCPClient** | 单个 MCP 服务器的客户端封装，处理 JSON-RPC 通信 |
| **Transport** | 传输层抽象，支持 stdio / SSE / HTTP 三种模式 |

### 2.2 数据流

```
Agent 启动
  │
  ├─ 加载配置（含 mcpServers）
  │
  ├─ MCPManager.init()
  │    │
  │    ├─ 对每个 MCP 服务器：
  │    │    ├─ 创建 MCPClient（按传输类型）
  │    │    ├─ 连接服务器
  │    │    ├─ 调用 tools/list → 获取工具列表
  │    │    └─ 对每个工具：
  │    │         ├─ 构造 ToolDefinition
  │    │         ├─ 包装为 ToolHandler（代理到 MCPClient.callTool）
  │    │         └─ 调用 ToolExecutor.registerTool()
  │    │
  │    └─ 全部连接完成后，Agent 就绪
  │
  ├─ AgentLoop 运行
  │    │
  │    └─ LLM 调用工具时：
  │         ├─ ToolExecutor.execute() 路由到对应 handler
  │         └─ handler 调用 MCPClient.callTool() → JSON-RPC request
  │
  └─ Agent 关闭时：MCPManager.disconnect() 断开所有连接
```

---

## 3. 接口定义

### 3.1 IMCPProvider（MCP 客户端接口）

```typescript
/**
 * MCP 客户端接口
 *
 * 封装单个 MCP 服务器的连接生命周期和工具调用。
 * 不同传输类型（stdio/SSE/HTTP）实现此接口。
 */
interface IMCPClient {
  /** 服务器名称（配置中的 key，如 "filesystem"、"github"） */
  readonly name: string;

  /** 连接状态 */
  readonly connected: boolean;

  /**
   * 连接 MCP 服务器
   *
   * stdio 模式：spawn 子进程，建立 stdin/stdout 管道
   * SSE/HTTP 模式：建立 HTTP 连接
   */
  connect(): Promise<void>;

  /**
   * 断开连接
   * 清理子进程 / HTTP 连接
   */
  disconnect(): Promise<void>;

  /**
   * 获取工具列表
   *
   * 调用 MCP tools/list 方法，返回服务器提供的所有工具定义。
   * 结果可缓存——MCP 2026-07-28 规范支持 list results 缓存。
   *
   * @param options.cached 是否使用缓存结果（默认 true）
   * @returns MCP 工具定义列表
   */
  listTools(options?: { cached?: boolean }): Promise<MCPToolDefinition[]>;

  /**
   * 调用工具
   *
   * 调用 MCP tools/call 方法，执行指定工具。
   *
   * @param name 工具名
   * @param args 参数（JSON 对象）
   * @returns 工具执行结果（字符串）
   */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}
```

### 3.2 MCPToolDefinition（MCP 工具定义）

```typescript
/**
 * MCP 工具定义
 *
 * 从 MCP tools/list 响应中解析出的工具描述。
 * 与现有 ToolDefinition 结构对齐，但保留 MCP 原始字段。
 */
interface MCPToolDefinition {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 输入参数 Schema（JSON Schema 格式，MCP 2026-07-28 默认 dialect 2020-12） */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
```

### 3.3 MCPManager（MCP 管理器）

```typescript
/**
 * MCP 管理器
 *
 * 管理多个 MCP 客户端连接，负责：
 * 1. 根据配置创建客户端实例
 * 2. 连接/断开所有服务器
 * 3. 自动发现工具并注册到 ToolExecutor
 * 4. 监控连接健康状态
 */
class MCPManager {
  /**
   * @param configs MCP 服务器配置列表
   * @param toolExecutor 用于注册工具的 ToolExecutor 实例
   */
  constructor(
    configs: MCPServerConfig[],
    toolExecutor: ToolExecutor,
  );

  /**
   * 初始化所有 MCP 连接
   *
   * 遍历配置，创建客户端、连接服务器、发现工具并注册。
   * 单个服务器连接失败不影响其他服务器——错误隔离。
   */
  async init(): Promise<void>;

  /**
   * 断开所有 MCP 连接
   *
   * 遍历所有客户端，逐个断开连接。
   * 同时清理 ToolExecutor 中已注册的 MCP 工具。
   */
  async disconnect(): Promise<void>;

  /**
   * 获取所有已连接服务器的状态快照
   */
  getStatus(): MCPServerStatus[];
}
```

### 3.4 MCPServerConfig（MCP 服务器配置）

```typescript
/**
 * MCP 服务器配置
 *
 * 配置文件中 mcpServers 映射表中的值类型。
 * 支持两种传输模式：
 *   - stdio：spawn 本地子进程（如 npx 启动的 MCP 服务器）
 *   - SSE/HTTP：连接远程 MCP 服务器
 */
interface MCPServerConfig {
  /** 传输类型 */
  transport: 'stdio' | 'sse' | 'http';

  // stdio 模式
  /** 可执行文件路径（如 "npx"、"node"） */
  command?: string;
  /** 命令行参数 */
  args?: string[];

  // SSE/HTTP 模式
  /** 服务器 URL */
  url?: string;

  // 通用
  /** 环境变量（仅 stdio 模式，传给子进程） */
  env?: Record<string, string>;
  /** 超时时间（毫秒，默认 30000） */
  timeout?: number;
  /** 工具幂等性映射（可选，覆盖默认判断） */
  toolIdempotency?: Record<string, IdempotencyLevel>;
}
```

---

## 4. 传输层设计

### 4.1 stdio 传输（进程间通信）

```
┌──────────────┐    stdin/stdout    ┌──────────────┐
│  MCP Client  │ ──────────────────▶│  MCP Server  │
│  (Node.js)   │ ◀──────────────────│  (子进程)     │
│              │    JSON-RPC 2.0    │              │
└──────────────┘                    └──────────────┘
```

**实现要点**：
- 使用 `child_process.spawn()` 启动子进程
- 写入子进程 stdin（`JSON-RPC request\n`）
- 从子进程 stdout 读取行（`JSON-RPC response\n`）
- stderr 重定向到 logger（供 MCP 服务器输出日志）
- 子进程退出时自动触发重连逻辑

**JSON-RPC 通信格式**：

```json
// Request（Agent → MCP Server）
{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"read_file","arguments":{"path":"/test.txt"}}}

// Response（MCP Server → Agent）
{"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"file content"}]}}
```

### 4.2 SSE/HTTP 传输（远程连接）

**实现要点**：
- 使用 Node.js 原生 `fetch`（Node 18+）发送 HTTP 请求
- MCP 2026-07-28 规范：方法名在 `Mcp-Method` HTTP header，工具名在 `Mcp-Name` header
- 支持 Authorization header（Bearer token 等）
- 支持超时和重试

**HTTP 请求格式**：

```
POST /mcp HTTP/1.1
Content-Type: application/json
Mcp-Method: tools/call
Mcp-Name: read_file

{"jsonrpc":"2.0","id":"1","params":{"arguments":{"path":"/test.txt"}}}
```

---

## 5. 与现有架构的集成

### 5.1 工具注册

MCP 工具通过现有 `ToolExecutor.registerTool()` 机制注册，无需修改核心执行管线：

```typescript
// MCPManager 内部逻辑
async function registerMCPTool(
  tool: MCPToolDefinition,
  client: IMCPClient,
  toolExecutor: ToolExecutor,
): void {
  // 将 MCP 工具定义转换为 ToolDefinition
  const definition: ToolDefinition = {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: tool.inputSchema.properties,
      required: tool.inputSchema.required ?? [],
    },
  };

  // 包装为 ToolHandler，代理到 MCP 客户端
  const handler: ToolHandler = async (args, ctx) => {
    return await client.callTool(tool.name, args);
  };

  // 注册到 ToolExecutor
  toolExecutor.registerTool(definition, handler);
}
```

### 5.2 集成到 Agent 组装流程

在 `assembler.ts` 中的 `assembleComponents()` 函数中，添加 MCP 初始化步骤：

```typescript
// assembler.ts 新增逻辑（示意）
if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
  const mcpManager = new MCPManager(config.mcpServers, toolExecutor);
  await mcpManager.init();
  // 将 mcpManager 保存在 Agent 实例中，供关闭时清理
  agent.setMCPManager(mcpManager);
}
```

### 5.3 生命周期管理

| 阶段 | 操作 |
|------|------|
| Agent 初始化 | 创建 MCPManager，连接所有服务器，注册工具 |
| Agent 运行中 | 通过 ToolExecutor 正常调用 MCP 工具，错误隔离 |
| Agent 关闭 | 断开所有 MCP 连接，清理已注册的工具 |

### 5.4 幂等性处理

MCP 工具的幂等性默认遵循 MCP 工具定义中的 `isIdempotent` 字段（部分 MCP 服务器会声明）。对于未声明幂等性的工具，默认标记为 `non-idempotent`（保守策略）。用户可通过配置 `toolIdempotency` 覆盖。

---

## 6. 配置格式

### 6.1 配置文件扩展

在 `.memora/config.json` 中新增 `mcpServers` 字段：

```json
{
  "llm": { ... },
  "memory": { ... },
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace/allowed"],
      "timeout": 30000
    },
    "github": {
      "transport": "http",
      "url": "https://mcp.example.com/github",
      "timeout": 15000
    },
    "database": {
      "transport": "sse",
      "url": "http://localhost:3001/mcp",
      "timeout": 60000
    }
  }
}
```

### 6.2 Config 类型扩展

```typescript
// 在 Config 接口中新增 mcpServers 字段
export interface Config {
  llm: LlmConfig;
  memory: MemoryConfig;
  security: SecurityConfig;
  allowedPaths: string[];
  persona?: string;
  embedding?: EmbeddingConfig;
  mcpServers?: Record<string, MCPServerConfig>;  // 新增
}
```

---

## 7. 文件结构

```
src/mcp/
├── types.ts           # IMCPClient, MCPToolDefinition, MCPServerConfig 等接口
├── mcpManager.ts      # MCPManager 类——管理多个客户端连接
├── client.ts          # MCPClient 类——JSON-RPC 通信核心
├── transports/
│   ├── stdioTransport.ts   # stdio 传输实现（child_process.spawn）
│   └── httpTransport.ts    # SSE/HTTP 传输实现（fetch + EventSource）
├── toolConverter.ts   # MCPToolDefinition → ToolDefinition 转换
└── __tests__/
    ├── mcpManager.test.ts
    ├── client.test.ts
    └── transports.test.ts
```

---

## 8. 实现计划

### Phase 1：核心接口 + 基础实现（4 小时）

| 步骤 | 内容 | 涉及文件 |
|------|------|----------|
| 1 | 定义类型接口（IMCPClient, MCPToolDefinition, MCPServerConfig） | `src/mcp/types.ts` |
| 2 | 实现 MCPClient 核心（JSON-RPC 请求/响应/错误处理） | `src/mcp/client.ts` |
| 3 | 实现 stdio 传输层 | `src/mcp/transports/stdioTransport.ts` |
| 4 | 实现工具转换器 | `src/mcp/toolConverter.ts` |
| 5 | 单元测试覆盖 | `src/mcp/__tests__/` |

### Phase 2：MCPManager + 集成（3 小时）

| 步骤 | 内容 | 涉及文件 |
|------|------|----------|
| 6 | 实现 MCPManager（多客户端管理 + 自动注册） | `src/mcp/mcpManager.ts` |
| 7 | 集成到 assembler.ts（Agent 初始化时连接 MCP） | `src/agent/assembler.ts` |
| 8 | 扩展 Config 类型 + 配置加载 | `src/config/loader.ts` |

### Phase 3：HTTP/SSE 传输 + 完善（1 小时）

| 步骤 | 内容 | 涉及文件 |
|------|------|----------|
| 9 | 实现 HTTP/SSE 传输层 | `src/mcp/transports/httpTransport.ts` |
| 10 | 工具幂等性映射支持 | `src/mcp/toolConverter.ts` |
| 11 | 集成测试 + 边界测试 | `src/mcp/__tests__/` |

---

## 9. 设计决策记录

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| MCP SDK 使用 | 官方 SDK vs 自实现 | **自实现轻量客户端** | 零依赖内核原则；MCP 2026-07-28 是 stateless JSON-RPC，实现简单 |
| 工具注册时机 | 启动时 vs 运行时 | **启动时注册 + 运行时缓存** | 简单可靠；运行时热注册可通过后续 PR 支持 |
| 幂等默认值 | idempotent vs non-idempotent | **non-idempotent（保守）** | 不了解 MCP 工具语义时，保守策略更安全 |
| 配置位置 | 独立文件 vs 嵌入 config.json | **嵌入 config.json** | 保持单一配置入口，减少文件数量 |
| 依赖管理 | 直接依赖 vs 可选依赖 | **peer dependency（可选）** | 内核零依赖，MCP 功能作为可选能力 |

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| MCP 服务器不响应 | 工具调用超时 | 可配置超时 + 超时降级返回错误信息 |
| MCP 服务器返回恶意内容 | 安全风险 | 通过现有 SecurityGuard 路径校验；工具结果截断 |
| 子进程崩溃 | stdio 连接断开 | 自动重连 + 错误日志 + 已注册工具标记为不可用 |
| 工具名冲突 | MCP 工具与内置工具同名 | 命名空间前缀（如 `mcp_`）或拒绝注册 |
| 大量 MCP 工具 | 撑爆 LLM 上下文 | 工具描述截断 + 按需暴露（通过角色策略过滤） |