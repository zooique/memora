# 宿主对齐方案 · 历史快照索引（已归档）

> ⚠️ **本文件已于 2026-08-31 归档为历史快照**，不再作为现行实现依据。
> 早期宿主对齐方案的完整正文（含已演进废弃的接口，如 `IMemoryStorage` 治理方法、`runMemoryDecayOnce`、`PersonaManager` 时期事件）原存档 `tasks/归档/host-plugin-alignment-历史快照.md`，已随 2026-09-04 tasks 目录整理删除（git 历史可溯）。本文件现仅保留下方「现行宿主接入契约」索引（本文件也是历史脉络参考，新宿主对接请只读下列现行文档）。

## 现行宿主接入契约（以这些为准）

| 文档 | 用途 |
|------|------|
| [memora-接入指南.md](../memora-接入指南.md) | **现行宿主接入契约基线**（Provider / 存储 / 会话 / 工具 / 安全决策，含 preExecutionCheck 恒放行纪律） |
| [memora-api-reference.md](../memora-api-reference.md) | 内核公开 API 参考 |
| [architecture/module-inventory.md](module-inventory.md) | 内核模块清单与生长路线图（L0-L6） |
| [architecture/agent-design-philosophy.md](agent-design-philosophy.md) | 设计哲学（turn 为种子） |