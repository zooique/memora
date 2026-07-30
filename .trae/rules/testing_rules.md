---
alwaysApply: false
description: 测试规范（三层金字塔 + Mock LLM 策略）
---

# 测试规范

> 详见 [ADR-007 · 测试策略](../decisions/ADR-007-testing-strategy.md)

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

详见 `src/llm/__tests__/` 下的 Mock Provider 实现

## 3. 覆盖率目标

> 阈值与 `vitest.config.ts` 的 `coverage.thresholds` 对齐，文档是配置的描述而非独立目标。

| 指标 | 目标  | 备注                                                  |
| ---- | ----- | ----------------------------------------------------- |
| 行   | ≥ 80% | CLI 入口已移出至宿主项目，不计入内核覆盖率  |
| 函数 | ≥ 88% | 核心逻辑函数覆盖率要求更高（1.0 发布阈值）            |
| 分支 | ≥ 75% | loop.ts/factory.ts 的条件分支较难在单元测试中完全覆盖 |
| 语句 | ≥ 80% | 与行覆盖率保持一致                                    |

**不计入覆盖率**：

- `src/index.ts`（库导出入口，纯重导出）
- `src/**/*.d.ts`（类型声明）
- `src/**/*.test.ts`（测试自身）

## 4. 测试反模式

- ❌ `expect(true).toBe(true)` 占位
- ❌ 测试间共享可变状态
- ❌ 用 sleep 等待异步（用 `vi.waitFor` 替代）
- ❌ 在测试中调真实文件系统的项目目录（用 `mkdtempSync`）
- ❌ 单元测试依赖网络
- ❌ 仅断言 mock 自身被调用（如 `expect(mockFn).toHaveBeenCalled()`），不验证被测对象的实际行为变化——此类测试无回归保护价值，应删除或补充行为断言
- ❌ 闪烁测试（intermittent failures）：因 timing/并发/环境差异偶发失败的测试必须立即修复或删除，不允许用 `test.retry` 掩盖。闪烁测试比缺失测试更危险——它侵蚀整个测试套件的信任基础
