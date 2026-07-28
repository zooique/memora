# 方案归档

> 已实施完成的 HEAL 系列方案文档归档。活跃方案保留在 `docs/` 根目录。

## 归档清单

| 方案 | 实施日期 | 模式 | 说明 |
|------|---------|------|------|
| [方案-HEAL-10-appState领域拆分-20260727.md](./方案-HEAL-10-appState领域拆分-20260727.md) | 2026-07-27 | A（容器提取） | AgentRuntime 提取（9 字段） |
| [方案-HEAL-10B-WindowService提取-20260727.md](./方案-HEAL-10B-WindowService提取-20260727.md) | 2026-07-28 | A（容器提取） | WindowService 提取（4 字段） |
| [方案-HEAL-10C-QuickInputService提取-20260728.md](./方案-HEAL-10C-QuickInputService提取-20260728.md) | 2026-07-28 | A（容器提取） | QuickInputService 提取（2 字段） |
| [方案-HEAL-11-PerceptionCoordinator提取-20260728.md](./方案-HEAL-11-PerceptionCoordinator提取-20260728.md) | 2026-07-28 | A（容器提取） | PerceptionCoordinator 提取（3 字段） |
| [方案-HEAL-12-PanelRouter职责拆分-20260728.md](./方案-HEAL-12-PanelRouter职责拆分-20260728.md) | 2026-07-28 | B（职责拆分） | PanelRouter → 4 Controller |
| [方案-HEAL-15-renderer侧Controller重命名Orchestrator-20260728.md](./方案-HEAL-15-renderer侧Controller重命名Orchestrator-20260728.md) | 2026-07-28 | 命名一致性重构 | renderer 侧 Controller → Orchestrator |
| [方案-HEAL-16-UIManager渐进重构后续阶段-20260728.md](./方案-HEAL-16-UIManager渐进重构后续阶段-20260728.md) | 2026-07-28 | A（容器提取） | UIManager 渐进重构 Phase 2-4 |

## 活跃方案（保留在 docs/ 根目录）

- [方案-HEAL-17-Component基类建设-20260728.md](../方案-HEAL-17-Component基类建设-20260728.md) — Phase 3-4 触发式
- [方案-HEAL-17-Phase2-MessageBubbleComponent-20260728.md](../方案-HEAL-17-Phase2-MessageBubbleComponent-20260728.md) — 已完成，保留作 Phase 3-4 参考

## 引用关系

归档方案被以下文件引用：
- `tasks/已完成任务.md` — 6 处（HEAL-10/10B/10C/11/12/15）
- `.trae/rules/progressive-refactor-rules.md` — 6 处（同上，案例表）
- `tasks/sprite-ui-engineering-audit-2026-07-28.md` — 1 处（HEAL-16）
