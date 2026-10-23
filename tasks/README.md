# tasks —— 任务台账与证据附件区

## 目录构成

| 路径 | 性质 | 纪律 |
|---|---|---|
| `待完成任务.md` | **唯一台账**（单台账制，2026-10-10 用户拍板） | 销项标 ✅ 留原区在册；每真发一版随版本号把已关闭项整区迁入 `archive/`；开放 / 观察 / 明确不做项一律留本台账 |
| 根目录其余 `审查报告-*` / `方案-*` / `审查-*` 文件 | 过程产物（**证据附件**形态） | **留原位不移动**：存活判据 = 被真相链任一消费（`archive/` 收据 / 主台账 / `.trae/rules` / `src`），**不限于** archive 收据——2026-10-23 实测 9 份无 archive 收据但被台账或报告引用，故不写成「全部被收据钉死」 |
| `archive/` | 版本归档 + 历史合集 | 纪律见 [archive/README.md](archive/README.md) |

## 新报告的落点规矩

1. **随版本归档走**：为某版本发版/审查产生的报告，被 `archive/<版本>-<线>.md` 条目以路径引用，
   放本目录根区（证据附件形态）。
2. **过时零引用报告**：全库引用扫描确认零入边（含历史层）且内容过时的，迁 `archive/reviews/`
   （2026-10-22 立的瘦身归档区，纪律见 archive/README.md 末节）。
3. **彻底删除**：删除档（零引用 + 无在途义务 + git 已跟踪）直接删，git 历史即档案——
   2026-10-23 DOC-DRAIN 删 `审查报告-2026-10-22-内核5.0.0发版条件复核.md`（5.0.0 已发布，时点快照失效）。
4. **降指针档**：零真相链消费、但被多份过程产物以裸名提及的，压成「结论 + 指针 + 历史说明」保留文件名
   （删会制造悬空文本）——2026-10-23 `审查报告-2026-10-11-SSOT审计弧总账.md` 即此档。

## 相关

- 归档纪律：[archive/README.md](archive/README.md)
- 过程稿三档处置（指针 / 删除 / 并入）：[.trae/rules/generic/exploration-decision-sedimentation-rules.md](../.trae/rules/generic/exploration-decision-sedimentation-rules.md)
- 引用扫描与分档工具：`npm run scan:docs:refs`（`scripts/doc-ref-scan.mjs`；`--check` 档校验证据附件入边）
