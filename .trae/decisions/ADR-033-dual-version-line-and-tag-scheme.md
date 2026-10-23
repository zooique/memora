---
alwaysApply: false
description: 双包双版本线与发布 tag 规范——内核 npm / 扩展 marketplace 各自独立 semver，tag 带包名前缀防撞车，不引发布管理工具
---

# ADR-033 · 双包双版本线与发布 tag 规范

> **状态**：✅ 已接受
> **日期**：2026-09-30
> **依赖**：[ADR-VC-001](./ADR-VC-001-vscode-plugin-host.md) 决策 6（物理同仓库 + 发布期插件独立发 marketplace）——本 ADR 只定它未覆盖的**版本管理与 tag 增量**，不重复其内容
> **定位**：双包（内核 npm 包 + VS Code 扩展）的版本线、tag 格式、发布管理工具边界

## 背景

内核 `@zooique/memora` 是独立 npm 包，VS Code 宿主为方便开发同仓放置（[ADR-VC-001](./ADR-VC-001-vscode-plugin-host.md) 决策 6 已定同仓库 + git 可拆）。发版实践暴露三个未定案问题：①宿主变更如何占版本号；②git tag 格式（存量裸 `v` 前缀 tag 若被扩展沿用必撞车——tag 名全局唯一）；③是否需要 monorepo 发布管理工具。

## 决策

### 决策 1：双版本线——内核与扩展各自独立 semver

| 分发物 | 版本线 | 发布渠道 |
|---|---|---|
| 内核 `@zooique/memora` | 3.x.y（独立 semver） | `npm publish` |
| VS Code 扩展 | x.y.z（**独立** semver，与内核无锁定步进关系） | `vsce publish`（marketplace，未上线） |

- CHANGELOG 现行双区结构（`[Unreleased]（宿主变更 · 不占内核版本号）` 区 + 内核版本区）即本决策的既有实例，规则就此固化；
- 版本独立 ≠ 随意升版：兼容性由依赖声明表达。扩展发布前**锁定 bundle 的内核版本**（装确定版本 → build → `verify:dist-contract` 同代验证 → `vsce package`），dist 契约闸门已覆盖前半链。

### 决策 2：tag 格式——内核 `vX.Y.Z` / 宿主 `vscode@x.y.z`

> 🔴 **偏离原案（2026-10-23 订正）**：本 ADR 2026-09-30 初版定内核 tag = `memora@x.y.z`（`<包名>@<semver>`，changesets 惯例），
> 理由是「双包各自裸 `v` 前缀必撞车」。但实现侧内核 `release.yml` 触发条件 = `v[0-9]*`、5.0.0 实测用 `v5.0.0` 触发成功，
> `memora@` **不会触发发布链**（静默不发版）。内核实际采用 `vX.Y.Z`（`v` 后紧跟数字），与宿主 `vscode@x.y.z` 并列——
> 二者触发集合借 `v[0-9]*` vs `vscode@*` 天然不相交（宿主 `vscode@` 在 `v` 之后是 `scode`，非数字），同样消除撞车，不必走 `memora@` 前缀。
> 另：初版「`npm publish` 成功后打 tag」也已不适用——现 tag 是发布**触发器**（推 tag → 流水线跑门禁 + 暂存发布），不是发布结果。

- **格式**：内核 `vX.Y.Z`（如 `v5.0.0`），宿主 `vscode@x.y.z`（如 `vscode@0.1.0`）。存量裸 `v` 前缀 tag（v1.0.2–v2.0.3）属历史层**不改写**（引用不可断）。
- **tag 触发发布链（非发布后补 tag）**：内核 `git tag vX.Y.Z && git push origin vX.Y.Z` 即触发 `release.yml`（OIDC 免令牌暂存发布，门禁过 + 本人 2FA 审批才上架）；宿主推 `vscode@x.y.z` 触发 `host-release.yml`（出 vsix + GitHub Release；Marketplace / Open VSX 分发另走手动或后续 Trusted Publishing）。
- **枚举单包历史**：内核 `git tag -l "v[0-9]*"`（⚠️ `v*` 会同时命中宿主 `vscode@*`，须用 `v[0-9]*`）；宿主 `git tag -l "vscode@*"`。

### 决策 3：宿主定位 = 第一方参考宿主，不降格为「示例项目」

宿主是内核能力的完整消费者 + 真机验证场 + 接入范本（第三方自建宿主照抄它）。目录结构（`hosts/memora-vscode/`）与仓库归属不变——「示例」一词降格其地位，文档与对话一律用「参考宿主 / 第一方宿主」。

### 决策 4：不引 monorepo 发布管理工具（lerna / nx / changesets）

包数量（2）与发布频率（月级）低于工具收益阈值，手工双 tag + CHANGELOG 双区够用。**再评估触发**：包数 >2 或发布频率升至周级。

## 考虑的替代方案

| 方案 | 放弃原因 |
|---|---|
| hosts/ 拆独立仓库 | dist 同代闸门、双测门禁、跨包契约检查全部打散重建，纯亏（ADR-VC-001 决策 6 已定同仓库） |
| 扩展沿用裸 `v` 前缀 tag | 与内核存量 tag 撞车（tag 名全局唯一） |
| 单版本线（内核扩展同步升版） | 无关变更被强迫同步升版，semver 失真 |
| 上 changesets 等工具 | 低频双包场景工具是负担非收益（决策 4） |

## 后果

### 正面

- 双包各自按真实变更节奏升版，semver 语义保真；
- tag 无撞车面：内核 `git tag -l "v[0-9]*"`、宿主 `git tag -l "vscode@*"` 分别枚举单包历史（`v*` 会跨轴命中，须带数字锚）；
- 零新增工具依赖，现有门禁链直接复用。

### 负面

- 手工打 tag 有遗漏风险——缓解：tag 步骤纳入 [memora-kernel-release](../../.trae/skills/memora-kernel-release/SKILL.md) 技能发布动作清单；
- 扩展上线 marketplace 后 CHANGELOG 若嫌双区拥挤需拆分（触发式，非现在做）。

## 引用方

- [memora-kernel-release 技能](../../.trae/skills/memora-kernel-release/SKILL.md)（内核 tag = `vX.Y.Z`、触发 release.yml、2FA 审批——执行发版动作）
- CHANGELOG.md 双区结构（本决策 1 的既有实例）
- [ADR-VC-001](./ADR-VC-001-vscode-plugin-host.md) 决策 6（同仓库前置）
