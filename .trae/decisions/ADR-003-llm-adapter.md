---
alwaysApply: false
description: LLM 适配层使用 OpenAI Chat Completions 兼容协议
---

# ADR-003 · LLM 适配层使用 OpenAI Chat Completions 兼容协议

> **状态**：✅ 已接受 **日期**：2026-06-02 **播种批次**：Memora 模式 A v1
> **来源**：(历史设计文档已归档：项目决策表.md §三)

## 背景

首期要支持国产模型（豆包/通义/DeepSeek），未来可能加 OpenAI、Anthropic、本地 Ollama。需要抽象统一的 LLM 接口。

## 决策

| 项           | 选择                                        |
| ------------ | ------------------------------------------- |
| 接口协议     | OpenAI Chat Completions 兼容                |
| HTTP 客户端  | Node.js 22+ 原生 fetch                      |
| 流式响应     | SSE（Server-Sent Events）                   |
| 适配器接口   | `LlmProvider` 抽象类 + 多实现               |
| 首期实现     | DeepSeek（兼容好 + 价格低）+ 豆包（中文强） |
| API Key 管理 | 环境变量 + 配置

## 理由

- **OpenAI 兼容协议**：豆包/通义/DeepSeek/Ollama 全部支持；零额外适配
- **原生 fetch**：零依赖；SSE 流式原生支持
- **抽象 `LlmProvider`**：符合设计哲学"代码与模型分工"；模型可热切换
- **双家备份**：可用性提升；不同场景不同模型
- **环境变量 + 配置**：不入 Git；分级回退

## 替代方案

| 方案               | 放弃原因                         |
| ------------------ | -------------------------------- |
| Anthropic 原生协议 | 需独立适配；投入产出比低         |
| 单一厂商硬编码     | 可用性风险；不符合"领域无关"哲学 |
| 加密存储 API Key   | 投入产出比低                     |
| axios              | 依赖重；fetch 已够用             |

## `LlmProvider` 接口

```typescript
// src/llm/provider.ts
export interface LlmProvider {
  readonly name: string; // 厂商名
  chat(messages: Message[], opts?: ChatOptions): AsyncIterable<Chunk>;
  // ...
}
```

## 影响

- 所有 LLM 调用走 `LlmProvider` 接口
- 模型切换 = 换 provider 实现，业务代码零改动
- API Key 从环境变量读取（支持 `${ENV_VAR}` 占位符展开）
- v1.2：支持多 Provider 映射表 + 运行时切换

### 配置格式

**旧格式**（单 Provider，向后兼容）：

```json
{
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "apiKey": "${MEMORA_LLM_API_KEY}",
    "baseUrl": "https://api.deepseek.com/v1"
  }
}
```

**新格式**（多 Provider，v1.2）：

```json
{
  "llm": {
    "providers": {
      "deepseek": {
        "provider": "deepseek",
        "model": "deepseek-chat",
        "apiKey": "${DEEPSEEK_API_KEY}"
      },
      "openai": {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "apiKey": "${OPENAI_API_KEY}",
        "baseUrl": "https://api.openai.com/v1"
      }
    },
    "active": "deepseek"
  }
}
```

### 年轮修订（2026-07-28）：内核纯透传化，删除 presets 预设表

**背景**：原 `factory.ts` 内置 `presets` 表（deepseek/doubao/openai 三家的 `baseUrl` + `defaultModel`），在 `createProviderFromConfig` 中作为兜底回退。问题：

1. **维护成本高**：厂商模型迭代频繁（如 doubao-pro-32k → doubao-pro-128k），presets 极易过期
2. **违反领域无关原则**：内核 `src/llm/` 不应硬编码具体厂商信息，违反"核心库提供机制，宿主提供策略"分层边界（见 [backend_layers_rules.md §核心库 vs 宿主项目职责边界](../rules/backend_layers_rules.md)）
3. **掩盖配置缺失**：用户配置缺 baseUrl/model 时，presets 静默回退，导致运行时行为与配置文件不一致

**决策**：

| 项 | 旧 | 新 |
|----|----|----|
| `presets` 表 | 内核硬编码 3 家 | ❌ 删除 |
| `ProviderConfig.baseUrl` | 可选（回退 presets） | ✅ 必填（宿主负责填充） |
| `ProviderConfig.model` | 可选（回退 presets） | ✅ 必填 |
| `ProviderConfig.provider` | 路由标识 | 仅日志标识（`cloud`/`local`/厂商名均可，不影响路由） |
| `apiKey` 校验 | 内核强制非空 | ❌ 移除（本地 LLM 如 Ollama 可为空字符串；是否必需由下游 LLM 服务决定） |
| `openaiCompatible.ts` chat() 中的 apiKey 校验 | 提前报错 | ❌ 移除（透传给 OpenAI SDK，由服务端返回 401） |

**宿主层适配**：

- 宿主调用 `createProviderFromConfig` 时必须显式填充 `baseUrl`（`?? ""` 兜底空字符串，避免 `undefined` 传入）
- 宿主 UI（`providerManagement.ts`）新增"网络 API / 本地 API"模式切换：
  - 网络 API：apiKey 必填，baseUrl 默认 `https://api.example.com`
  - 本地 API：apiKey 可选，baseUrl 默认 `http://localhost:11434/v1`（Ollama）
  - `provider` 字段由用户输入改为模式标记（`cloud`/`local`），驱动 UI 校验逻辑

**影响**：

- 内核 `src/llm/factory.ts` 净减 ~30 行（删除 presets 表 + 回退逻辑 + apiKey 校验）
- 宿主 4 处调用点（`minimalHandlers.ts` / `index.ts`）`baseUrl || undefined` → `baseUrl ?? ""`
- `config.example.json` openai 条目补 `baseUrl`
- 用户配置文件无需迁移——旧配置若缺 baseUrl 会得到明确错误提示（"provider X 缺少 baseUrl"），而非静默回退到过期预设

### 多 Provider 管理 API

> **年轮修订（2026-06-18）**：以下多 Provider 映射表管理 API（listProviders/switchProvider/addProvider 等）在 God Object 拆分后已移出内核。当前内核仅提供 `setProvider(provider)` 和 `setBackgroundProvider(provider)` 两个方法，多 Provider 映射表管理由宿主项目负责。

| 方法                              | 说明                           | 状态 |
| --------------------------------- | ------------------------------ | ---- |
| `agent.setProvider(provider)`     | 运行时切换前台 Provider        | ✅ 已实现 |
| `agent.setBackgroundProvider(provider)` | 运行时切换后台 Provider  | ✅ 已实现 |
| `agent.listProviders()`           | 列出所有已注册 Provider 别名   | ❌ 已移出至宿主 |
| `agent.getActiveProviderName()`   | 获取当前激活的 Provider 名     | ❌ 已移出至宿主 |
| `agent.switchProvider(name)`      | 切换 Provider（即时生效）      | ❌ 已移出至宿主 |
| `agent.addProvider(name, config)` | 运行时动态添加（不写配置文件） | ❌ 已移出至宿主 |
| `agent.currentProvider`           | 只读访问当前 Provider 实例     | ❌ 已移出至宿主 |

### CLI 命令

> CLI 已移出至宿主项目（CLI 移出决策详见 [ADR-002](./ADR-002-storage-layer.md) + [project-rules.md §1（零依赖内核）](../rules/project-rules.md)）。以下命令由宿主项目（如 `hosts/memora-sprite/`）实现。

```bash
memora config-llm list          # 列出 Provider（宿主实现）
memora config-llm add <name>    # 交互式添加（写入配置文件，宿主实现）
memora config-llm use <name>    # 切换激活 Provider（写入配置文件，宿主实现）
```

## 何时回顾

- 当 OpenAI 兼容协议不满足新需求（如多模态）
- 当某家厂商协议变更且不再兼容
- 当需要支持本地模型（Ollama 等——目前已通过兼容协议覆盖）
