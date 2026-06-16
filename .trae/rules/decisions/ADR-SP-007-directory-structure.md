---
alwaysApply: false
description: "memora-sprite 宿主：目录结构"
---

# ADR-SP-007 · 目录结构

> **状态**：✅ 已接受（2026-06-16）
> **依赖**：[ADR-008](./ADR-008-directory-structure.md)（内核目录结构）

## 背景

精灵是 memora 仓库内的独立 package，需要确定其在仓库中的位置和内部目录结构。

## 决策

**`hosts/memora-sprite/` 作为独立 package，按职责分层。**

```
hosts/memora-sprite/
├── package.json              ← 独立依赖（memora + better-sqlite3）
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts              ← 入口：Agent 实例化 + 生命周期
    ├── storage/
    │   ├── sqliteStorage.ts  ← IMemoryStorage 实现
    │   └── sessionStore.ts   ← ISessionStore 实现
    ├── sprite/
    │   ├── sprite.ts         ← 精灵主控：唤醒调度 + 对话管理 + 主动行为
    │   ├── spriteConfig.ts   ← 精灵配置持久化（sprite.json 读写）
    │   ├── triggers.ts       ← SpriteTrigger 接口 + TimerTrigger + TriggerBus
    │   ├── fileWatcherTrigger.ts ← 文件变化触发器（ADR-SP-004 阶段二）
    │   ├── interaction.ts    ← IInteraction 交互层接口
    │   └── cliInteraction.ts ← CLI 交互层实现（readline）
    └── __tests__/
        ├── sqliteStorage.test.ts
        ├── sessionStore.test.ts
        ├── sprite.test.ts
        └── sprite-integration.test.ts
```

## 理由

- **`hosts/` 先例**：ADR-005 已确立 `hosts/memora-cli/` 作为宿主项目位置，精灵遵循同一约定
- **独立 package.json**：精灵的 native 依赖（better-sqlite3）不污染内核
- **按职责分层**：与内核 ADR-008 一致，storage/ 和 sprite/ 各自独立
- **最小结构**：阶段一只需 3 个目录（storage/sprite/__tests__），不过度设计

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| `packages/memora-sprite/` | 需要引入 pnpm workspace，过度工程 |
| `src/hosts/sprite/` | 与内核 src/ 混在一起，依赖隔离困难 |
| 独立仓库 | 精灵与内核强耦合，独立仓库增加同步成本 |

## 影响

- `.gitignore` 需添加 `hosts/memora-sprite/node_modules/` 和 `hosts/memora-sprite/dist/`
- 精灵的 tsconfig.json 的 `paths` 不使用 `@/` 别名（精灵是小项目，相对路径足够）
- 阶段二引入 Electron 时，新增 `electron/` 目录放主进程和渲染进程代码
