# 召回近因排序设计（纯近因路线）

> **状态**：~~提案待审~~ → **已被 [memory-tool-recall-design.md](memory-tool-recall-design.md) 取代**（2026-09-09 范式切换：自动注入 → 纯工具化 + 首步检索，排序问题域随注入语境消失）。本文档仅保留一条有效结论：accessedAt 作工具结果 P2 次序键 + 命中即 touch（见新文档 §3.4/§5.2）。保留原貌供决策链回溯。
> **日期**：2026-09-09
> **关联**：[memory-as-summary.md](memory-as-summary.md)（召回主设计）· [memory-role-pack-boundary.md](memory-role-pack-boundary.md) D7/D6 · [ADR-025](../../.trae/decisions/ADR-025-memory-role-pack-boundary.md) · [module-inventory.md](module-inventory.md)
> **决策链**：score 单调不减窘境（2026-09-09 实证）→ 时间/权重层叠质疑 → accessedAt 单标尺提案 → 纯近因定案（本项目暂不引深刻轨道）→ **范式切换：纯工具化（2026-09-09 拍板）**

## 历史说明
本文为召回近因排序（accessedAt 次序键）的决策记录，已随 2026-09-09 范式切换被 [memory-tool-recall-design.md](memory-tool-recall-design.md) 取代；唯一保留的有效结论见上方状态块。正文已随 2026-09-18 docs 清理瘦身为头部索引，完整历史见 git 历史。