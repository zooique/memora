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

| 指标 | 目标  | 备注                                                  |
| ---- | ----- | ----------------------------------------------------- |
| 行   | ≥ 75% | repl.ts（CLI 入口）由 e2e 覆盖，不计入单元测试覆盖率  |
| 函数 | ≥ 85% | 核心逻辑函数覆盖率要求更高                            |
| 分支 | ≥ 70% | loop.ts/factory.ts 的条件分支较难在单元测试中完全覆盖 |
| 语句 | ≥ 75% | 与行覆盖率保持一致                                    |

**不计入覆盖率**：

- `src/index.ts`（CLI 入口，纯装配）
- `src/**/*.d.ts`（类型声明）
- `src/**/*.test.ts`（测试自身）

## 4. 阶段一必须包含的测试

- [x] 记忆类型 schema 校验（types.test.ts）
- [x] 路径白名单 6 个用例（path-guard.test.ts）
- [x] SQLite 索引 CRUD（index.test.ts）
- [x] LLM Provider Mock 流式响应（openai-compatible.test.ts）
- [x] Agent Loop 单元测试（loop.test.ts · 10 用例）
- [x] Agent Loop 一轮对话（e2e.test.ts · 5 场景）
- [x] CLI 启动 + 退出（e2e.test.ts · 5 场景）
- [x] 记忆召回管线（recall.test.ts · 7 用例）
- [x] init 命令（init.test.ts · 4 用例）
- [x] 权限模型（permissions.test.ts · 4 用例）
- [x] LLM 工厂（factory.test.ts · 8 用例）
- [x] 项目管理器（project-manager.test.ts · 11 用例）

## 5. 测试反模式

- ❌ `expect(true).toBe(true)` 占位
- ❌ 测试间共享可变状态
- ❌ 用 sleep 等待异步（用 `vi.waitFor` 替代）
- ❌ 在测试中调真实文件系统的项目目录（用 `mkdtempSync`）
- ❌ 单元测试依赖网络
