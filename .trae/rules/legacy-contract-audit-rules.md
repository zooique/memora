---
alwaysApply: false
description: 带伤设计（历史折衷残痕）审查规则——区分「正常设计」与「兼容的无奈设计」，四类带伤模式 + 实证判定流程
---

# 带伤设计审查规则（Legacy Contract Audit）

> **适用范围**：Memora 全库审查（`src/` 内核心 + `hosts/` 下宿主），用于识别"从零新写绝不会这么写"的历史折衷设计
> **触发**：全库 SSOT 排查、大改前对既有模块的带伤审查、新模块设计时的反模式自检
> **与现有规则关系**：本文件是 [single-truth-source-mindset.md](./single-truth-source-mindset.md) 的实证落地维度（把"最小单元/单一真理源"转成可执行的带伤识别标准）；与 [comment-doc-slimming-rules.md](./comment-doc-slimming-rules.md) 互补（前者收代码残痕，后者收注释残痕）
> **关联决策**：[决策 README](../decisions/README.md)

## 1. 一句话定义

> **带伤设计 = 看似符合直觉、跑起来也正常，但"从零新写时绝不会这么写"的设计。**
> 它不是 bug，是历史演进留下的折衷——为兼容旧契约/旧数据/旧调用而被迫多绕的一层，正常设计本不需要它。

## 2. 判别标准（三条核心，命中 ≥1 即疑似）

| 标准 | 说明 | 项目实例 |
| ---- | ---- | ---- |
| **同语义多实现** | 同一逻辑/格式/规则在 ≥2 处各自实现：一处是 SSOT、另一处是绕过它的手写，且 SSOT 明文"禁止"却被历史代码违反 | `SESSION_ID_PATTERN` 正则 vs `splitSessionId` |
| **绕一层才能接上** | 某接口/字段因历史包袱保留，正常设计让消费方走"真源方法"，带伤处却直接用旧契约/旧字段凑合 | `meta.roundIds` 双轨 + `getRoundIds` 降级兜底 |
| **靠业务差异撑着** | ≥2 处调用对同一校验有不同失败语义（一处报错、一处兜底），统一函数不敢替换，手写逻辑得以旁生 | openSession 抛错 vs markSessionTimedOut warn 兜底 |

> **反模式自问三题**（偏离则回到正常设计）：
> ① 这套逻辑从零设计会这样写吗？
> ② 去掉"兼容旧 XX"这一层，核心是否仍完整？
> ③ 是否在 SSOT 边界之外另开了一条手写通道？

## 3. 五类带伤模式（模块级识别信号）

| 模式 | 识别信号 | 已收敛实例 |
| ---- | ---- | ---- |
| **双轨镜像** | 两处存同一份状态，靠 `sync*`/`synchronize`/双写函数对齐；两字段语义重叠需保持一致 | `meta.roundIds` + `roundIdsStore`（已删字段，收敛到 `getRoundIds()` 真源） |
| **降级兜底残留** | "优先 X、否则降级 Y"，而 Y 永不触达；或 `??` 回退恒右侧、`||` 回退恒死；或**布尔式恒真**（如 `!aborted && !paused` 正常轮恒 true）导致"想干活却一步没干成"被当成功 | ViewLoader 优先真源/降级 `meta.roundIds`（已删降级分支） |
| **类型 hack** | `as unknown as` / `as any` / `@ts-ignore` 侥幸绕过类型约束（生产代码多处） | 多为良性（库类型缺口），如 DOMPurify 参数桥接 |
| **重复实现** | 同语义不同名的函数/正则/常量散落；相同魔法数/哈希硬编码多处 | `SESSION_ID_PATTERN` vs `splitSessionId`（已收敛到 `isValidSessionId`） |
| **僵尸声明** | 宣称"能力/事实"却生产代码零消费：注释宣称零实现的能力、能力位恒 false 零消费、派生字段零消费者、对外宣告通道零验收。**识别关键**：该通道不可观测、不设防、失败被静默（验收位问"跑完没有"而非"干成没有"） | `provider.ts` "fallback 到纯文本 tool_call" 注释（null 实现了静默降级）→ 已纠为中实注释 |

## 4. 实证判定流程（关键：先读码，再定类）

**不是所有"怪"都是带伤**——审查必须读码确认"真带伤 vs 良性 vs 已收敛"，不能只看表象：

| 判定 | 判断依据 | 处置 |
| ---- | ---- | ---- |
| **真带伤** | 上述 4 类模式 + 有 ≥1 处历史折衷证据（SSOT 明文禁止却被绕过 / 兼容旧契约字段 / 靠业务差异撑着） | 走收敛流程（§5） |
| **良性** | 有明确设计意图注释（如库类型缺口桥接）、有单一真源且全库无重复、有独立测试 | 不处理，记录判定 |
| **已收敛** | SSOT 清理已覆盖（镜像已删、降级已删、导出已收回） | 跳过，避免重复劳动 |

## 5. 收敛流程（改造约束）

1. **每可疑点先 grep/读码实证**，判定真带伤/良性/已收敛后再动刀
2. **优先在最小单元（SSOT 源）收敛**，不破坏原契约边界（如 `splitSessionId` 纯拆解语义保持，另加 `isValidSessionId` 作校验互补）
3. **保留两处失败语义**：若带伤点有"报错/兜底"两种结局，收敛后须逐一保留各自语义（openSession 抛错的 + markSessionTimedOut 兜底的）
4. **验证**：内核 + 宿主 `tsc` + 全量 `vitest` 全绿
5. **炼化归元**：规则对齐（命名/注释/SSOT 声明一致）→ 剪枝（无"不是XX而是XX"、无修复思路旁白、无修改痕迹）→ 提交前审查
6. 用 `refactor:` 提交，经 pre-commit（lint-staged + typecheck + commitlint）后推送

## 6. 已收敛残留清单（避免重复审查）

以下为已收敛的带伤点，新审查直接跳过。**按「模式级」记录**：同时登记「已收敛的模式」与其「复发识别信号」，当信号再次出现（即使字段名不同）即按同一模式收敛，而不是当作新 bug 另起炉灶。

| 模式 | 已收敛实例 | 复发识别信号（信号再现即按本模式收敛） |
| ---- | ---- | ---- |
| **双轨镜像** | `SessionMeta.roundIds` 双轨镜像 → 已删字段，收敛到 `ISessionStore.getRoundIds()/setRoundIds()` 真源；`trace_summary` schema 双真源 → 已收敛 `BUILTIN_TOOLS` 引用 `TRACE_SUMMARY_TOOL` | 出现新字段与某真源同时存同一份状态、靠 sync 对齐；同一 schema/常量被两处各自 import |
| **重复实现** | `sanitizeToolResult` → 已删，统一走 `sanitizeExternalText`；`SESSION_ID_PATTERN` → 已删，收敛到 `isValidSessionId`+`splitSessionId`；`messageCount` 重复派生 → 已删，收敛到 `deriveMessageCount` 单点；工具 `filter(web_search)` 两处 → 已收敛到 `resolveActiveTools` | 同语义不同名的函数/正则/常量 ≥2 处；同一算式在两方法各写一遍 |
| **僵尸声明** | `provider.ts` "fallback 到纯文本 tool_call" 注释 → 已纠为中实注释 | 注释宣称零实现的能力 / 能力位恒 false 零消费 / 派生字段零消费者 / 对外宣告通道零验收 |
| **降级兜底残留** | `flattenRoundsToMessages` 等 4 导出误暴露 → 已收回；`DEFAULT_L2_STRATEGY`/`askLimit` 二次写入 → 已收敛 `resolveL2Strategy(undefined)` | `??` 回退恒右 / `||` 回退恒死 / 布尔式恒真 / 已收回的导出再次暴露 |
| **派生量缓存进 DTO** | `messageCount` 曾缓存在 `SessionMeta`，认 `?? 0` 造值、失效不重算（**复发案例：2026-09-14，同模式另一实例**） | 真源可 O(1) 派生、却被缓存进 DTO 且消费方为 0；`??` 造默认值掩盖缺失 |

## 7 待验证带伤候选与预警信号（探索期登记，未固化）

> 与 §6 不同：这里是**尚未定类/尚未复现、仅登记待查**的带伤候选与可观测预警信号。原则：**先记录、不贸然动内核**——根因未明或样本不足时，改动即制造新带伤。当候选被真机复现并走完实证判定，再决定收敛或降级回 docs/。

| 登记点 | 现象 / 信号 | 待验证问题 | 处置路径 |
| ---- | ---- | ---- | ---- |
| **规避行为红旗（2026-09-15 真机）** | 桌面互动叙事项目 round 内，LLM 表达"绕过压缩缓存"，弃 read_file 改 shell 脚本/搜索引擎拿全文 | read_file 通道在 LLM 眼里"失真"——被压缩链 + 台账 400 字替身叠加后拿不回整份视角 | 宿主侧把"绕 read_file 改脚本"标记为可观测 trace；复现后定类 |
| **ADR-031 补缝过度拦截候选（2026-09-15 登记）** | 上一轮补"整读小文件也记全覆盖"（防 182 次重读永动机）后，可能反向拦截"LLM 合法重读拿回视角" | 整读小文件记全覆盖 + 压缩后重读回显摘要，是否让「对齐评估/全文比对」任务被迫绕路 | 真机复现确认是否过度拦截；不确认不动 |
| **主流差距（远期打磨方向，非现在做）** | 主流 read_file：大文件强制 `query` 意图参数；工具结果 offload 到 scratch 文件；read>N 未产出收敛暂停门 | 是否吸收进本项目 read_file 分段策略 | 待主流方向与本项目耦合需求明确后单独立项 |

> 关联：[single-truth-source-mindset.md](./single-truth-source-mindset.md)、[comment-doc-slimming-rules.md](./comment-doc-slimming-rules.md)、[progressive-refactor-rules.md](./progressive-refactor-rules.md)