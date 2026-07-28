# HEAL-15 renderer 侧 Controller 重命名 Orchestrator 方案

> 来源：HEAL-15 P1 架构级待办（待完成任务.md）。renderer/sprite 同名 MemoryController/PersonaController 异义，IDE 跳转/grep 检索极易混淆。
> 日期：2026-07-28
> 模式：命名一致性重构（非 progressive-refactor-rules 模式 A/B，但遵循其"方案设计先行 + 炼化归元收尾"流程）

## 一、现状分析

### 1.1 痛点

renderer 侧与 sprite 侧存在同名 `MemoryController` / `PersonaController`，但形态、依赖、职责层完全正交：

| 维度 | sprite 侧 | renderer 侧 |
|------|-----------|-------------|
| 形态 | `class MemoryController` | `createMemoryController()` 工厂函数 |
| 依赖 | `Agent` + `IVectorStore`（直连内核数据） | `UIManager` + `window.electronAPI`（IPC 远程调用） |
| 职责层 | 业务逻辑层（数据操作 + 内核委托） | UI 编排层（IPC 编排 + 委托 PanelManager 渲染） |
| 方法命名 | 数据语义：`list/show/delete/upsert/search` | 流程语义：`setupXxxPanel/loadXxxList/loadXxxDebounced` |

**影响**：IDE 跳转弹出多选；grep 检索返回混合结果；新成员需额外上下文区分。

### 1.2 调研结论

- sprite 侧 `class MemoryController` / `class PersonaController` 是真理源，保留 Controller 后缀合理（业务逻辑层）
- renderer 侧工厂函数实际是"UI 编排器"，改名 Orchestrator 更准确反映职责
- renderer 侧 `controllers/` 目录下仅 4 个文件（memoryController / personaController / sessionController / settingsController），其中 memoryController 和 personaController 有同名冲突，sessionController 和 settingsController 无冲突但应保持命名一致

### 1.3 本轮重命名范围

| 原名 | 新名 | 类型 |
|------|------|------|
| `controllers/` | `orchestrators/` | 目录 |
| `memoryController.ts` | `memoryOrchestrator.ts` | 文件 |
| `personaController.ts` | `personaOrchestrator.ts` | 文件 |
| `sessionController.ts` | `sessionOrchestrator.ts` | 文件 |
| `settingsController.ts` | `settingsOrchestrator.ts` | 文件 |
| `createMemoryController` | `createMemoryOrchestrator` | 工厂函数 |
| `createPersonaController` | `createPersonaOrchestrator` | 工厂函数 |
| `createSessionController` | `createSessionOrchestrator` | 工厂函数 |
| `createSettingsController` | `createSettingsOrchestrator` | 工厂函数 |

### 1.4 不改名的归档

| 对象 | 理由 |
|------|------|
| sprite 侧 `class MemoryController` / `class PersonaController` | 真理源，业务逻辑层，Controller 后缀合理 |
| renderer 侧 `controllers/` 目录下的测试文件 | 测试文件随源文件重命名（见 §三） |

## 二、命名合理性

### 2.1 为什么是 Orchestrator？

- **Controller**：暗示"控制"业务逻辑（数据操作 + 状态管理）——sprite 侧的 class 符合
- **Orchestrator**：暗示"编排"多个协作方（IPC 调用 + PanelManager 渲染 + 闭包状态）——renderer 侧的工厂函数符合
- 与 renderer 侧已有命名惯例对齐：`PerceptionCoordinator`（协调器）、`PanelRouter`（路由器）等都是角色化命名，非泛化 Controller

### 2.2 与 sprite 侧的调用链路

```
renderer 侧 createMemoryOrchestrator (UI 编排)
  → window.electronAPI.xxx (IPC)
    → 主进程 IPC handler
      → Sprite 门面方法
        → sprite 侧 class MemoryController (业务逻辑)
          → Agent.memory → 存储/向量库
```

两层通过 IPC 解耦，命名应反映层级差异。

## 三、改动文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `renderer/controllers/memoryController.ts` → `renderer/orchestrators/memoryOrchestrator.ts` | **重命名 + 改函数名** | 文件移动 + `createMemoryController` → `createMemoryOrchestrator` + 内部注释更新 |
| `renderer/controllers/personaController.ts` → `renderer/orchestrators/personaOrchestrator.ts` | **重命名 + 改函数名** | 同上 |
| `renderer/controllers/sessionController.ts` → `renderer/orchestrators/sessionOrchestrator.ts` | **重命名 + 改函数名** | 同上 |
| `renderer/controllers/settingsController.ts` → `renderer/orchestrators/settingsOrchestrator.ts` | **重命名 + 改函数名** | 同上 |
| `renderer/renderer.ts` | 修改 | 4 处 import 路径 + 函数名 + 1 处 ReturnType 类型声明 |
| `renderer/initHelpers.ts` | 修改 | 1 处 type import 路径 + 函数名 + 1 处类型声明 |
| `__tests__/electron/renderer/memoryController.test.ts` → `memoryOrchestrator.test.ts` | **重命名 + 改引用** | 文件移动 + import 路径 + 函数名 + describe 字符串 |
| `__tests__/electron/renderer/personaController.test.ts` → `personaOrchestrator.test.ts` | **重命名 + 改引用** | 同上 |
| `__tests__/electron/renderer/sessionController.test.ts` → `sessionOrchestrator.test.ts` | **重命名 + 改引用** | 同上 |
| `__tests__/electron/renderer/settingsController.test.ts` → `settingsOrchestrator.test.ts` | **重命名 + 改引用** | 同上 |

## 四、不提取的归档

无。本轮是纯重命名，不涉及逻辑提取。

## 五、后续演进路径

无。HEAL-15 是独立任务，不触发后续阶段。

## 六、验证计划

- **类型检查**：`npm run typecheck:electron` 0 错误
- **全量测试**：`npm run test` 138 文件 / 4631 测试全通过
- **验证点**：
  - 4 个源文件正确移动到 `orchestrators/` 目录
  - 4 个工厂函数名正确改为 `createXxxOrchestrator`
  - renderer.ts + initHelpers.ts 的 import 路径和函数名同步更新
  - 4 个测试文件正确移动 + import 路径 + 函数名 + describe 字符串同步更新
  - sprite 侧 `class MemoryController` / `class PersonaController` 不受影响

## 七、实施完成（2026-07-28）

### 验证结果

- `npm run typecheck:electron`：0 错误
- `npm run test`：138 文件 / 4631 测试全通过

### 实际修改文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `renderer/controllers/memoryController.ts` → `renderer/orchestrators/memoryOrchestrator.ts` | **git mv + 改函数名** | `createMemoryController` → `createMemoryOrchestrator`（replace_all） |
| `renderer/controllers/personaController.ts` → `renderer/orchestrators/personaOrchestrator.ts` | **git mv + 改函数名** | `createPersonaController` → `createPersonaOrchestrator`（replace_all） |
| `renderer/controllers/sessionController.ts` → `renderer/orchestrators/sessionOrchestrator.ts` | **git mv + 改函数名** | `createSessionController` → `createSessionOrchestrator`（replace_all） |
| `renderer/controllers/settingsController.ts` → `renderer/orchestrators/settingsOrchestrator.ts` | **git mv + 改函数名** | `createSettingsController` → `createSettingsOrchestrator`（replace_all） |
| `renderer/renderer.ts` | 修改 | 4 处 import 路径 + 函数名 + 2 处 ReturnType 类型声明 |
| `renderer/initHelpers.ts` | 修改 | 1 处 type import 路径 + 函数名 + 1 处类型声明 |
| `__tests__/electron/renderer/memoryController.test.ts` → `memoryOrchestrator.test.ts` | **git mv + 改引用** | import 路径 + 函数名（replace_all） |
| `__tests__/electron/renderer/personaController.test.ts` → `personaOrchestrator.test.ts` | **git mv + 改引用** | import 路径 + 函数名（replace_all）+ describe 字符串 |
| `__tests__/electron/renderer/sessionController.test.ts` → `sessionOrchestrator.test.ts` | **git mv + 改引用** | import 路径 + 函数名（replace_all） |
| `__tests__/electron/renderer/settingsController.test.ts` → `settingsOrchestrator.test.ts` | **git mv + 改引用** | import 路径 + 函数名（replace_all） |
| `__tests__/sprite/controllers/personaController.test.ts` | 修改 | 1 处注释引用更新（旧路径 → 新路径） |
| `renderer/controllers/` 目录 | **删除** | git mv 后空目录清理 |

### 实施回顾

**git mv 保留历史**：8 个文件用 git mv 移动，git log --follow 可追溯完整历史。

**局部变量名保留决策**：实例名（sessionController / memoryController / personaController / settingsController）保留 Controller 后缀，理由：
- 它们是实例变量不是类名，不与 sprite 侧 `class MemoryController` 冲突
- 实例名反映"这是一个 Controller 实例"语义合理
- 改实例名会扩大改动面（renderer.ts 内数十处引用）且无收益

**sprite 侧注释同步**：`__tests__/sprite/controllers/personaController.test.ts` 第 5 行注释引用了旧路径，更新为新路径保持引用准确。

**零遗留验证**：`grep "renderer/controllers/|createMemoryController|createPersonaController|createSessionController|createSettingsController"` 返回 0 匹配。
