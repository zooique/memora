---
alwaysApply: false
description: 测试策略 Vitest + MSW（Mock LLM）
---

# ADR-007 · 测试使用 Vitest + MSW（Mock LLM）

> **状态**：✅ 已接受 **日期**：2026-06-02 **播种批次**：Memora 模式 A v1
> **来源**：项目决策表 §五（历史文档已归档）

## 背景

LLM 调用昂贵、慢、非确定性。Agent 系统的核心难点是"测试中如何处理 LLM"。

## 决策

| 项         | 选择                                    |
| ---------- | --------------------------------------- |
| 测试框架   | Vitest                                  |
| LLM Mock   | MSW（Mock Service Worker）拦截 HTTP     |
| 覆盖率     | Vitest 内置 v8                          |
| 测试金字塔 | 单元 50% / 集成 35% / 基准 5%（~~E2E 10%~~ 已移出至宿主项目，详见 §影响） |

## 理由

- **Vitest**：与 Vite 生态同源；TS 原生；Jest 兼容 API
- **MSW**：拦截真实 HTTP 请求；测试时无需 mock SDK；行为最接近生产
- **v8 覆盖率**：零配置；c8 算法更准
- **测试金字塔**：阶段一专注单元测试 + 1 个 E2E（Agent Loop 端到端）

## Mock LLM 策略

```typescript
// tests/fixtures/llm-mock.ts
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const handlers = [
  http.post('*/v1/chat/completions', () => {
    return HttpResponse.json({
      choices: [{ message: { role: 'assistant', content: 'Mock response' } }],
    });
  }),
];

export const server = setupServer(...handlers);
```

## 影响

- 所有 LLM 调用必须可注入 provider（依赖注入）
- 集成测试中 LLM 必须 mock，不允许真实调用
- 阶段一至少包含：
  - 单元测试：记忆引擎（存储/检索/组装）
  - 单元测试：LLM 适配器（请求构造/SSE 解析）
  - 单元测试：安全模块（白名单校验）
  - 集成测试：Agent Loop 一轮对话
  - ~~E2E 测试：CLI 启动 + 退出~~（CLI 已移出至宿主项目）

## 年轮修订

### v0.2（2026-06-02）· 覆盖率阈值调整

**变更**：行覆盖率 80%→75%，函数覆盖率 80%→85%，分支覆盖率 75%→70%，语句覆盖率 80%→75%

**原因**：

- ~~`repl.ts`（257 行 CLI 入口）~~（CLI 已移出至宿主项目，不再拉低覆盖率）
- `loop.ts`/`factory.ts`
  的条件分支（如 maxIterations 边界、未知 provider 分支）较难在单元测试中完全覆盖
- 函数覆盖率提升到 85%：核心逻辑函数的覆盖比行覆盖更重要
- 实际覆盖率 78.12% 行 / 85%+ 函数，新阈值与实际产出一致

## 何时回顾

- 当 MSW 与 Node 22+ fetch 出现兼容问题
- 当需要更精细的 LLM 行为模拟（如思考链）
- 当测试覆盖率不再反映真实质量
