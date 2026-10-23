# tasks —— 任务台账与证据附件区

## 目录构成

| 路径 | 性质 | 纪律 |
|---|---|---|
| `待完成任务.md` | **唯一台账**（单台账制，2026-10-10 用户拍板） | 销项标 ✅ 留原区在册；每真发一版随版本号把已关闭项整区迁入 `archive/`；开放 / 观察 / 明确不做项一律留本台账 |
| 根目录其余 `审查报告-*` / `方案-*` / `审查-*` 文件 | 版本归档条目的**证据附件** | **留原位不移动**：路径被 `tasks/archive/*.md` 收据钉死，移动即改写历史层引用（S5 红线） |
| `archive/` | 版本归档 + 历史合集 | 纪律见 [archive/README.md](archive/README.md) |

## 新报告的落点规矩

1. **随版本归档走**：为某版本发版/审查产生的报告，被 `archive/<版本>-<线>.md` 条目以路径引用，
   放本目录根区（证据附件形态）。
2. **过时零引用报告**：全库引用扫描确认零入边（含历史层）且内容过时的，迁 `archive/reviews/`
   （2026-10-22 立的瘦身归档区，纪律见 archive/README.md 末节）。
3. **彻底删除**：删除档（零引用 + 无在途义务 + git 已跟踪）直接删，git 历史即档案——
   2026-10-23 DOC-DRAIN 删 `审查报告-2026-10-22-内核5.0.0发版条件复核.md`（5.0.0 已发布，时点快照失效）。

## 相关

- 归档纪律：[archive/README.md](archive/README.md)
- 过程稿三档处置（指针 / 删除 / 并入）：[.trae/rules/generic/exploration-decision-sedimentation-rules.md](../.trae/rules/generic/exploration-decision-sedimentation-rules.md)
- 引用扫描与分档工具：`.workbuddy/tmp-pack/doc-drain-scan.mjs`
