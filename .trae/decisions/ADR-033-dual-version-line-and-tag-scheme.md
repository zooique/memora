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

### 决策 2：tag 带包名前缀——`memora@3.0.0` / `vscode@x.y.z`

- **格式**：`<包名>@<semver>`（changesets 生态惯例）。tag 名全局唯一，双包各自裸 `v` 前缀必撞车，此格式从根上消除歧义；
- **存量冻结**：现有裸 `v` 前缀 tag（v1.0.2–v2.0.3）属历史层**不改写**（引用不可断）；自内核 3.0.0 起切换新格式；
- 打 tag 时机：`npm publish` 成功后 `git tag memora@x.y.z && git push origin memora@x.y.z`。

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
- tag 无撞车面，`git tag -l "memora@*"` 即可枚举单包历史；
- 零新增工具依赖，现有门禁链直接复用。

### 负面

- 手工打 tag 有遗漏风险——缓解：tag 步骤纳入 [memora-kernel-release-readiness](../../.trae/skills/memora-kernel-release-readiness/SKILL.md) 技能发布动作清单；
- 扩展上线 marketplace 后 CHANGELOG 若嫌双区拥挤需拆分（触发式，非现在做）。

## 引用方

- [memora-kernel-release-readiness 技能](../../.trae/skills/memora-kernel-release-readiness/SKILL.md)（发布动作链含 tag 步骤）
- CHANGELOG.md 双区结构（本决策 1 的既有实例）
- [ADR-VC-001](./ADR-VC-001-vscode-plugin-host.md) 决策 6（同仓库前置）
