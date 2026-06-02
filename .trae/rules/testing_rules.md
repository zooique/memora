---
alwaysApply: false
description: 测试规范（三层金字塔 + Mock LLM 策略）
version: v0.1
date: 2026-06-02
---

# 测试规范

> 详见 [测试策略.md](../../docs/基础设计文档/测试策略.md) +
> [ADR-007 · 测试策略](./decisions/ADR-007-testing-strategy.md)

## 1. 三层金字塔

| 层级     | 目标占比 | 范围         | 速度       |
| -------- | -------- | ------------ | ---------- |
| 单元测试 | 50%      | 单个函数/类  | < 1s/用例  |
| 集成测试 | 35%      | 多个模块协同 | < 5s/用例  |
| E2E 测试 | 10%      | 完整链路     | < 30s/用例 |
| 基准测试 | 5%       | 性能数据     | 视场景     |

## 2. Mock LLM 策略

**绝对禁止**：

- ❌ 在测试中调用真实 LLM API（昂贵、慢、非确定性）
- ❌ Mock 整个 LLM SDK（脆弱，与实现耦合）

**正确做法**：

- ✅ 用 MSW（Mock Service Worker）拦截 HTTP 请求
- ✅ 测试中 `LlmProvider` 注入 `MockProvider`
- ✅ 准备多种 fixture 场景：纯文本响应 / 工具调用 / 流式中断

详见 [tests/fixtures/llm-mock.ts](../../tests/fixtures/llm-mock.ts)

## 3. 覆盖率目标

| 指标 | 目标  |
| ---- | ----- |
| 行   | ≥ 80% |
| 函数 | ≥ 80% |
| 分支 | ≥ 75% |
| 语句 | ≥ 80% |

**不计入覆盖率**：

- `src/index.ts`（CLI 入口，纯装配）
- `src/**/*.d.ts`（类型声明）
- `src/**/*.test.ts`（测试自身）

## 4. 阶段一必须包含的测试

- [x] 记忆类型 schema 校验（types.test.ts）
- [x] 路径白名单 6 个用例（path-guard.test.ts）
- [x] SQLite 索引 CRUD（index.test.ts）
- [x] LLM Provider Mock 流式响应（openai-compatible.test.ts）
- [ ] Agent Loop 一轮对话（阶段一·E2E）
- [ ] CLI 启动 + 退出（阶段一·E2E）

## 5. 测试反模式

- ❌ `expect(true).toBe(true)` 占位
- ❌ 测试间共享可变状态
- ❌ 用 sleep 等待异步（用 `vi.waitFor` 替代）
- ❌ 在测试中调真实文件系统的项目目录（用 `mkdtempSync`）
- ❌ 单元测试依赖网络
