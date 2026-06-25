---
alwaysApply: false
description: 测试规范（三层金字塔 + Mock LLM 策略）
version: v0.3
date: 2026-06-25
---

# 测试规范

> 详见 [ADR-007 · 测试策略](./decisions/ADR-007-testing-strategy.md)

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

| 指标 | 目标  | 备注                                                  |
| ---- | ----- | ----------------------------------------------------- |
| 行   | ≥ 75% | CLI 入口已移出至宿主项目，不计入内核覆盖率  |
| 函数 | ≥ 85% | 核心逻辑函数覆盖率要求更高                            |
| 分支 | ≥ 70% | loop.ts/factory.ts 的条件分支较难在单元测试中完全覆盖 |
| 语句 | ≥ 75% | 与行覆盖率保持一致                                    |

**不计入覆盖率**：

- `src/index.ts`（库导出入口，纯重导出）
- `src/**/*.d.ts`（类型声明）
- `src/**/*.test.ts`（测试自身）

## 4. 当前测试文件清单（32 文件 · 501 用例）

**agent/**：
- [x] Agent 门面类（agent.test.ts）
- [x] Agent Loop 主循环（loop.test.ts）
- [x] 消息历史（messageHistory.test.ts）
- [x] 工具执行器（toolExecutor.test.ts）
- [x] 作品投影（workProjection.test.ts）

**memory/**：
- [x] 记忆加载器（loader.test.ts）
- [x] 项目管理器（projectManager.test.ts）
- [x] 记忆召回（recall.test.ts）
- [x] 会话存储契约（sessionStoreContract.test.ts）
- [x] 文件存储（store.test.ts）
- [x] 记忆类型（types.test.ts）
- [x] 用户画像（userProfile.test.ts）
- [x] 向量存储（vectorStore.test.ts）
- [x] 记忆关系存储（relationStore.test.ts）— IMemoryRelationStore 接口 + InMemoryRelationStore 实现

**utils/**：
- [x] Frontmatter 解析（frontmatter.test.ts）
- [x] 文本分词（segmenter.test.ts）
- [x] 错误工具函数（errors.test.ts）
- [x] JSON 工具函数（json.test.ts）

**其他模块**：
- [x] 角色管理（personaManager.test.ts）
- [x] 技能管理（skillManager.test.ts）
- [x] 路径白名单（pathGuard.test.ts）
- [x] 配置加载（loader.test.ts）
- [x] LLM 嵌入（embedding.test.ts）
- [x] LLM 工厂（factory.test.ts）
- [x] LLM Provider Mock（openaiCompatible.test.ts）
- [x] 集成测试（llm-integration.test.ts）
- [x] 配置管理器（configManager.test.ts）
- [x] 洞察提取（insightExtractor.test.ts）
- [x] 护栏（guardrail.test.ts）
- [x] 日志（logger.test.ts）
- [x] 指标（metrics.test.ts）
- [x] 降级（degradation.test.ts）

**已完成（Phase 1，ADR-014）**：
- [x] 记忆关系存储（relationStore.test.ts）— IMemoryRelationStore 接口 + InMemoryRelationStore 实现
- [x] 冲突检测（insightExtractor.test.ts 扩展）— extract() 流程中的关系构建逻辑

## 5. 测试反模式

- ❌ `expect(true).toBe(true)` 占位
- ❌ 测试间共享可变状态
- ❌ 用 sleep 等待异步（用 `vi.waitFor` 替代）
- ❌ 在测试中调真实文件系统的项目目录（用 `mkdtempSync`）
- ❌ 单元测试依赖网络
