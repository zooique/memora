---
alwaysApply: false
description: LLM 适配层使用 OpenAI Chat Completions 兼容协议
---

# ADR-003 · LLM 适配层使用 OpenAI Chat Completions 兼容协议

> **状态**：✅ 已接受 **日期**：2026-06-02 **播种批次**：Memora 模式 A v1
> **来源**：[项目决策表.md §三](../../docs/项目决策表.md)

## 背景

首期要支持国产模型（豆包/通义/DeepSeek），未来可能加 OpenAI、Anthropic、本地 Ollama。需要抽象统一的 LLM 接口。

## 决策

| 项           | 选择                                        |
| ------------ | ------------------------------------------- |
| 接口协议     | OpenAI Chat Completions 兼容                |
| HTTP 客户端  | Node.js 20+ 原生 fetch                      |
| 流式响应     | SSE（Server-Sent Events）                   |
| 适配器接口   | `LlmProvider` 抽象类 + 多实现               |
| 首期实现     | DeepSeek（兼容好 + 价格低）+ 豆包（中文强） |
| API Key 管理 | 环境变量 + cosmiconfig 二级回退             |

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
- API Key 必须从环境变量 `MEMORA_LLM_API_KEY` 读取
- 配置文件示例：

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

## 何时回顾

- 当 OpenAI 兼容协议不满足新需求（如多模态）
- 当某家厂商协议变更且不再兼容
- 当需要支持本地模型（Ollama 等——目前已通过兼容协议覆盖）
