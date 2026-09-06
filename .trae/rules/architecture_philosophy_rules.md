---
alwaysApply: false
description: 架构哲学原则（12 条：万物皆记忆、永久性分级、冷热分离、模型分工、领域无关、增量召回、降级优先、自然遗忘、专注模式、单 Agent 模型、角色包插卡、可观测性边界）
---

# 架构哲学原则（精简版）

> 本文件只留**现生效的可执行铁律**；演进历史、示意图、哲学铺陈已删。设计推导见 `docs/architecture/` 与 ADR。

## 1. 万物皆记忆

记忆两类轨道：**设定记忆**（骨骼：persona/rule/skill）+ **对话记忆**（血肉：round-summary 问答闭环摘要记忆，会话级摘要归会话记录存储 SessionMeta）。

- 设定记忆**唯一归角色包**（`role-packs/<名>/` manifest 控制 + persona.md/rules.md/skills/*），纯文件 + 内存缓存装载，**不写 SQLite / 记忆库**（ADR-025）。旧 `configDir/personas|rules|skills + SQLite` 模型及 `PersonaManager/ConfigManager/matchAndInjectSkill/bootstrapMemories getBySource('rule')` 已全部移除。
- Persona：`persona.md` 约定名；确定性注入 systemPromptPrefix；**手动切换唯一入口**（无 autoSwitch/自动匹配/exclusiveWith，切换只经宿主 `switchRolePack`）；角色包可建组（组长 + 组员名单，组员仅小组会议内表层装配发言）。能力声明在 manifest 顶层 `capabilities`。
- Skill：全局池 `configDir/skills/`（全局激活）+ 角色包 `skills/`（角色激活才激活），两级渐进披露（L1 元数据常驻 / L2 `read_skill` 读正文 / L3 `read_resource`·`run_skill_script`），目录动态扫描。
- Rule：`rules.md` 约定名；确定性注入、始终在线。
- 桥梁：`summaryFocus` 提炼视角衔接骨骼与血肉，**单一记忆单轨**（摘要即记忆），无 `autoConfigRefiner` 独立链路。
- 冲突消解用 `supersededBy` 布尔标记（写路径取代检测，读时过滤），无关系图谱侧车（ADR-021）。

**禁止**：

- ❌ 创建 `RulesService`/`SkillsService`/`TopicsService` 等独立子系统（`RolePackManager`/`SkillManager` 是装载入口，不属此类）
- ❌ 为不同记忆类型建立不同存储后端
- ❌ 引入"系统提示词硬编码"
- ❌ 将 Persona/Skill 数据写入 SQLite（无召回消费者，纯浪费）

## 2. 永久性分级决定召回确定性

按 source 标签决定召回策略：

| source | 召回策略 |
| --- | --- |
| `persona` | 设定记忆，不参与 recall |
| `rule` | 100% 启动加载（bootstrap） |
| `skill` | 设定记忆，不参与 recall |
| `content` | 按相关度增量召回（治理页手动写入轨，非内核自动） |
| `work-projection` | 不参与 recall（落项目 `<memoraDir>/projections/`） |
| `round-summary` | 按相关度增量召回（唯一自动轨） |
| `profile` | 按相关度增量召回（存量兼容，不再新写入） |

## 3. 冷热分离（File vs DB）

文件承载记忆本体（可读可编辑），SQLite 承载索引（标签/永久性/权重/关键词，FTS5）。**写文件 + 写索引必须事务对齐**。

## 4. 代码与模型分工

**代码做确定性工作（信号采集），模型做不确定性工作（语义判断）**。

- ✅ 代码：关键词匹配、频次统计、阈值比较等确定性计算，结果作为信号注入 LLM prompt（如 AffectController 采集温暖度/直接度信号）。
- ❌ 代码做语义判断（理解意图、生成情绪化回应）——由 LLM 完成。
- 判断标准：能写成"if 关键词命中 then 数值 += delta"是信号采集；需理解上下文语义才决策是语义判断。

**反模式**：❌ 让 LLM 决定"要不要检索更多记忆"（应由 token 预算代码触发）；❌ 代码做语义判断；❌ 让 LLM 直接写数据库（应 LLM 调工具、代码执行工具）。

## 5. 领域无关

核心代码不耦合任何领域，领域特性经角色包注入。**验证标准**：切到小说/编程/日程领域，不改 `src/` 一行代码、只换 `.memora/` 目录。

## 6. 增量召回（不预加载）

启动只加载确定性 100% 的记忆（rule），其余在 Agent Loop 按需 `recall()`。

- `bootstrap` 只加载 `rule` 标签（Persona 经 systemPromptPrefix 注入，Skill 经渐进披露 L1/L2）
- `recall()` 双通道（语义 + 关键词），启动级/archive 级不进启动加载
- 向量搜索失败静默降级到关键词（保护专注态不被网络抖动打断）
- 单次增量召回 Token 预算 ≤ 上下文窗口 10%
- 归档走记忆归档三原则过滤，拒绝低价值重复信息
- 冲突经 `supersededBy`（ADR-021）；`DEFAULT_RECALL_EXCLUDE_SOURCES = []`

**禁止**：❌ 启动时全量加载话题文件；❌ 一次性注入所有技能描述；❌ 因"可能用到"把不相关记忆塞进 prompt。

## 7. 降级优先

非关键操作失败时降级服务而非中断对话：

| 优先级 | 操作 | 失败策略 |
| --- | --- | --- |
| P0 | 对话响应 | 不可降级（核心路径无 try/catch） |
| P1 | 消息持久化 | 记日志，不抛异常（`appendMessage` catch-only-log） |
| P2 | 轮次摘要归档 | 跳过本次，不阻塞（fire-and-forget） |
| P3 | 启动补执归档 | 跳过，5s 超时兜底 |
| P4 | 项目切换释放锁 | warn，继续切换 |

**禁止**：❌ 归档失败中断对话（归档 ≠ 对话）；❌ 消息写入失败抛出；❌ 启动归档补执阻塞初始化超 3 秒。

## 8. 自然遗忘优于完美记忆

**无主动衰减**（`MemoryDecayScheduler` 已移除）。治理 = **supersede（写时取代）+ boost（召回加权）**；物理清理靠回收站（默认保留 30 天）。

- round-summary 不参与 score 衰减，其遗忘由写路径取代 + 召回 boost 承担；**type 不设时效**（有效否由 superseded + 召回相关性判定，不由时间）。
- `purgeExpiredMemories(before)` 清理过期软删除记忆；`MemoryInspector.listFading` 提供健康观测（>60 天未访问），内核只读不做主动清理。

**禁止**：❌ 永不删除任何记忆；❌ 所有记忆一视同仁；❌ 召回越多越好（会击穿上下文窗口）。

## 9. 专注模式

**默认专注、支持显式切换**：默认值偏向沉浸，切换保留。

**禁止**：❌ 启动预载全量话题记忆；❌ 用户每次说话全量检索；❌ 话题切换阈值过低；❌ 鼓励多线程并行处理多话题。

**显式切换**：显式命令（如 `switchSession()`）最高优先级直接切换，切换后重新组装上下文；专注是默认、切换是例外。

## 10. 单 Agent 模型（配置文件是真理源）

Memora 被宿主接入后即该程序唯一 Agent，`memora.db` 是 Agent 级共享资源，不随子项目切换重建。**配置文件是真理源，SQLite 是运行时索引**。

- 项目级 `projectPath/.memora/` 只放 rules/skills，不放 memora.db；用户记忆（dataDir）存 memora.db + sessions/，纯数据。
- `config.addRule()` 是运行时注入（会话级，不经配置文件）；`config.confirm()` 写配置文件（持久化）。

**禁止**：❌ 每个子项目独立 memora.db；❌ 项目切换时关闭/重建数据库；❌ 将配置直接写入 SQLite 作为持久化存储。

## 11. 角色包是参数集，插卡解耦（通用引擎 ↔ 专业卡）

内核是 turn（问答闭环）的通用引擎，角色包是参数集（persona/rules/capabilities/strategy 四件套），正交解耦。**memora 不需要知道自己是谁——只需知道当前插的是什么卡。**

- 卡：**可插拔**（role-pack-spec 标准格式，实现无关）、**可共享**（纯文本可分发/版本管理，manifest 唯一核心控制）、**不自洽**（不含执行引擎，是纯声明）。
- **任何时候只有一个角色包生效**（v0.13 定案：手动切换单一角色包 + 组长角色包会议名单，组员仅会议内发言，ADR-028）。
- 校验/管理/能力映射都非独立系统，是闭环各阶段行为（Prepare/Act/后台 Reflect）。
  > **废弃说明（2026-09-05）**：旧设计含 `Handoff` 阶段（与 Prepare/Act 并列）。seed 收敛后 turn 结束即 done，`seed/orchestrator.ts` 只聚合 prepare/act/reflect，**Handoff 阶段已删除**——气口（step 边界暂停）是 loop 内 step 编排的自然属性，不属独立的闭环阶段。
- 技能两级（见 §1 Skill）：通用技能全局一份，角色包不重复（避免复制）；`manifest.capabilities`（能做什么）与 `manifest.skills`（技能正文）分离。

**禁止**：❌ 角色包包含执行引擎逻辑；❌ 内核 hardcode 任何领域知识；❌ 角色包与内核版本强耦合（用 formatVersion 兼容）。

## 12. 可观测性边界

"模型看到了什么"由 ITracer 承载指纹 hash，**不入记忆存储（sessionStore）**。内核提供机制（埋点接口），宿主负责策略。

- `llm.call` span 记 `systemPromptHash`；`recall.recall` span 记 `attachedMemoryCount`/`fingerprint`。
- 仅宿主注入真实 Tracer 时计算指纹（NOOP 零开销）；指纹用 `sha256Fingerprint` 纯函数。

**禁止**：❌ 在 sessionStore 存储完整上下文快照；❌ 未注入 Tracer 时执行指纹计算；❌ 指纹 hash 与记忆内容存储耦合。