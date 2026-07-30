---
alwaysApply: false
description: "memora-sprite 宿主：测试策略"
---

# ADR-SP-006 · 测试策略

> **状态**：✅ 已接受（2026-06-16）
> **依赖**：[ADR-007](./ADR-007-testing-strategy.md)（内核测试策略）

## 背景

精灵需要验证 SqliteStorage 实现的正确性，以及精灵主控逻辑。需要决定测试框架和策略。

## 决策

**Vitest + InMemoryStorage（单元）+ 临时 SQLite 文件（集成）。**

- 单元测试：精灵主控逻辑（sprite.ts、triggers.ts）用 InMemoryStorage mock
- 集成测试：SqliteStorage 用临时文件，测试后清理
- 契约测试：复用内核的 `sessionStoreContract.test.ts` 模式验证接口合规

## 理由

- **与内核一致**：Vitest + InMemoryStorage 单元测试模式已在内核验证（432 测试通过）
- **SqliteStorage 必须用真实 SQLite**：SQL 语法、事务行为、FTS5 搜索无法用 mock 验证
- **临时文件隔离**：每个测试用例创建独立的临时 SQLite 文件，测试后自动清理，无副作用
- **契约测试**：确保 SqliteStorage 的行为与 InMemoryStorage 一致，避免宿主实现偏离内核预期

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 全用 InMemoryStorage | SQL 语法、事务、FTS5 无法验证 |
| 全用真实 SQLite | 单元测试速度慢，每次创建文件开销大 |
| Jest | ESM 支持差，与内核不一致 |

## 影响

- 精灵的 `vitest.config.ts` 与内核保持一致
- SqliteStorage 集成测试用 `os.tmpdir()` 创建临时文件，`afterEach` 自动清理
- 精灵测试不依赖 memora 内核的测试文件，但可 import 内核的 `InMemoryStorage` 做对比
