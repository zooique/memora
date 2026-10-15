---
alwaysApply: false
description: 脚本运行三形态与三层安全防线定案——三形态统一执行单元、暴露/边界/执行三层防线、confirmScriptRun 统一确认闸（owner 默认放行走审计、guest 恒确认 fail-closed、confirmScripts 单开关约束全部脚本）、沙箱与 classifier 不进内核
---

# ADR-040 · 脚本运行三形态与安全防线

> **状态**：✅ 已接受
> **日期**：2026-09-08 设计定案并落地（三形态 / 暴露模型 / 确认闸 + 测试全绿），2026-09-11 确认面收口定案（`run_skill_script`）；2026-10-15 补录 ADR（固化依据 = 沉淀规则 S2 第 3 条「真实场景复现消费、不再横跳」；用户拍板，探索草稿头衔摘除）
> **定案真源**：`docs/architecture/script-run-security-design.md`（三形态明细 / 主流养分表 / 落地清单 / 已弃用选项均留该档，本 ADR 只收定案浓缩，S3）

## 背景

宿主对话中 LLM 如实回答「没有运行脚本的能力」——根因是角色包能力白名单暴露面不对称：技能工具默认全暴露、但角色包一旦声明任何 capabilities 即被误杀。修暴露面时必须同时定死「脚本怎么分形态、防线怎么分层、谁来确认」这套安全边界，否则后续 `run_project_script`、`run_command` 会各自凭手感接线。

## 决策

1. **三形态**（按「来源 × 生命周期 × 权限」）：
   | 形态 | 工具 | 权限模型 |
   | --- | --- | --- |
   | 技能内嵌 | `run_skill_script` | 默认开放，豁免角色包能力白名单（技能目录脚本经作者审阅） |
   | LLM 临时 | `run_code` | 角色包 `code:execute` 控制 + 宿主注入 `ICodeExecutionProvider` |
   | 项目现成 | `run_project_script` | 默认开放，豁免能力白名单（路径锁项目根） |
2. **统一执行单元**：技能 / 项目两形态共用内核子进程执行器（`skillScriptRunner`，仅根目录不同），**不建三个引擎**；`run_code` 执行器由宿主注入（零依赖红线）。
3. **三层防线**：暴露层（豁免集 vs capabilityMap 白名单分治）→ 边界层（路径白名单 = 来源根目录 + `resolveSafePath` 防穿越，**执行分支内二次强制**，响应「注册≠强制」教训）→ 执行层（node/python/shell 三档运行时白名单 + 超时 60s/600s + windowsHide）。
4. **确认面统一（2026-09-11 收口）**：三个脚本工具同走 `confirmScriptRun` 一个闸——owner 且 `confirmScripts=false` 自动批准（必走审计）；**guest 恒确认**（不设「来源可信」豁免，fail-closed）；`confirmScripts=true` 时 owner 亦确认（单开关约束全部脚本执行）。该开关后续成为 `run_command` 审批档位的复用先例。
5. **内核边界红线**：容器 / seatbelt / VM 级沙箱与 classifier 式 AI 审核**不进内核**（宿主职责，`ICodeExecutionProvider` 即预留口）。

## 理由

- **与已验证主流范式对齐**：弹窗是最弱防线（审批接受率实证）故确认通道不默认弹窗；沙箱 × 审批是正交旋钮故暴露面与执行隔离分开；「allowlist 注册但执行未强制」是真实 CVE 根因故边界在执行分支内二次强制（养分明细与来源留定案真源 §二）。
- **guest 恒确认**：无 OS 级沙箱支撑「边界内自动」的前提，来源可信豁免只对 owner 成立——缝合三脚本工具的语义裂缝。
- **复用而非复制**：三形态一个执行器、三工具一个确认闸，复杂度在既有机制上生长，不新增引擎。

## 替代方案

一律弹窗确认 / 内核内置沙箱 / classifier AI 审核 / `skill:*` 能力键声明 / 复用 `run_code` 承载项目脚本——均已弃用，**弃因明细留定案真源 §六**，此处不复写（S3）。

## 影响 / 引用方

- `docs/architecture/script-run-security-design.md`：定案真源（本 ADR 的明细指针所指）
- `docs/architecture/tool-exposure-model.md`：豁免面判据的上位规则（由本设计的暴露不对称问题催生）
- `docs/方案-命令执行能力-run_command-20260922.md`：审批档位复用 `confirmScripts` 模式、`confirmScriptRun` 为审批执行链路统一确认入口
- `src/security/pathGuard.ts`：`confirmScriptRun` 确认闸实现
- `src/agent/toolExecutor.ts`：三脚本工具与 `run_command` 的确认接线、路径白名单二次校验
- 台账「脚本安全设计固化」：销项收据（含固化依据措辞订正）

## 何时回顾

- **出现第四种脚本来源形态**：先问归入既有三形态的哪一类，不新建执行引擎——归不进去才评新形态。
- **有人提出放宽「guest 恒确认」**：前提不存在不得放宽——须先有 OS 级沙箱支撑「边界内自动」。
- **`confirmScripts` 语义或档位改动**：三脚本工具 + `run_command` 四面同步核（单开关是全称约束，改动必须穷举消费面）。
- **沙箱 / classifier 提出进内核**：违本 ADR 第 5 条，须先改本 ADR 状态再动代码。
