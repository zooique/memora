# deliverables —— 过程产物附件区（非真相链）

> **定位**：本目录收录 4.0.0 ~ 5.0.0 时代的**过程产物**（审查报告 / 方案稿 / 落地收据 / 门禁结果），
> 是版本归档条目（`tasks/archive/<版本>-<线>.md`）与 ADR 的**证据附件**，**不属于真相链**
> （真相链 = `docs/白话设计文档.md` + `docs/导航索引.md` + `tasks/待完成任务.md` + `.trae/decisions/`）。

## 治理规则

1. **引用链存活即保留**：被 `tasks/archive/`、`.trae/decisions/`、`src/`（含测试）、`tasks/待完成任务.md`
   引用的文件**留在原路径**——按 [exploration-decision-sedimentation-rules](../.trae/rules/generic/exploration-decision-sedimentation-rules.md)
   S5「历史层引用旧路径不得改写」，移动即伤归档收据的可溯性。
2. **零引用即清理**（判据可机检）：入边为零（含 CHANGELOG / 台账 / archive 历史层）且无在途义务的文件，
   走删除档——git 历史即档案，不留副本。清理工具范式 = `.workbuddy/tmp-pack/doc-drain-scan.mjs`
   （引用扫描 + 引用者分层：真相链 / docs 内部 / 过程产物互引 / 索引；导航索引的同义反复引用不计入活跃度）。
3. **新增文件须自描述**：头部必须标注「状态 + 生成日期 + 真相基线 + 处置触发」
   （如 `内核公开API-剪枝方案-20261017.md`：触发 = 5.0.0 发布 / CHANGELOG `[5.0.0]` 归档时降指针档）。
4. **不做索引枢纽**：本目录不进 `docs/导航索引.md`（过程产物不占导航面），由本 README 单点说明。

## 清理记录

| 日期 | 动作 | 清单 |
|---|---|---|
| 2026-10-23 | DOC-DRAIN 删 6 份（零引用） | `内核4.0.0-发布前质量审查-独立复核-20261010.md` / `内核4.0.0-SSOT落地质量审查-20261010.md`（成对）/ `发布前设计缺口评估-20260923.md` / `审查报告-4.0.0发布门禁-基于小说项目生产轮-20261009.md` / `真机复现评估-修复后首轮-20261009.md` / `engineering-assurance/session-summary-2026-09-20.md` |

> 保留项（引用链存活）：`内核公开API-剪枝方案-20261017.md`（ADR-039 过程稿指针）·
> `内核上下文管理模块-修复落地收据-20261015.md`（archive/5.0.0-kernel.md 引用）·
> `内核变更报告-4.0.0发布后至今-20261017.md`（archive/5.0.0-kernel.md + scripts 引用）·
> `插件初始化按钮-SSOT不带伤实现评估-20261012.md`（archive/0.1.0-host.md 引用）·
> `loop契约显化-盘点与首批落地-20261010.md`（commentHygiene 测试 + 台账引用）·
> `engineering-assurance/release-gonogo-memora-kernel-4.0.0-2026-10-08.md`（archive/4.0.0-kernel.md 引用，链上 4 份随留）·
> `生长点清单-内核-新枝破土扫描-20261022.md`（未来迭代方案出边链接 + 近期活跃扫描）。
