---
alwaysApply: false
description:
  架构哲学原则（12
  条：万物皆记忆、永久性分级、冷热分离、模型分工、领域无关、增量召回、降级优先、自然遗忘、专注模式、单 Agent 模型、角色包插卡、可观测性边界）
---

# 架构哲学原则

## 1. 万物皆记忆（Everything is Memory）

**原则**：Agent 接触的一切内容都是"记忆"。记忆分为两类轨道——**设定记忆**（骨骼）和**对话记忆**（血肉），各自有独立的存储和访问模型。

> **承载形态收敛（ADR-025，2026-08-17）**：设定记忆的**唯一承载形态 = 角色包**（`role-packs/<名>/` 下 persona.md / rules.md / skills/*），不再是散落的 `configDir/personas|rules|skills` 目录 + SQLite 索引；记忆系统 = **摘要记忆本体**（round-summary 轮次级 + content 会话级，按 summaryType 语义标签分类，type 不设时效）。**角色包内容收敛（2026-08-18）**：内容文件约定名（persona.md/rules.md）、能力声明独立顶层 capabilities（C2）、技能两级渐进披露（通用全局 + 角色包绑定，§11.5）。本节的 `configDir/*.md` + SQLite 描述为**当前实现状态**，已收敛至目标态（§1.1/§1.2 即目标态描述——设定记忆纯文件装载、不写 SQLite / 记忆库）。详见 [memory-role-pack-boundary.md](../../docs/architecture/memory-role-pack-boundary.md) 与 [ADR-025](../decisions/ADR-025-memory-role-pack-boundary.md)。

### 1.1 两层记忆模型

```
┌─ 设定记忆 (Config Memory) ─────────────────────┐
│  Persona:  "我是谁"                              │
│  Rule:     "我要遵守什么"                         │
│  Skill:    "我会什么特殊能力"                      │
│                                                  │
│  访问：确定性注入，不经过 recall                   │
│  存储：.md 文件（git 可追踪）+ 内存缓存            │
│  真理源：配置文件（configDir/）                    │
│  变更：用户编辑 → watcher → 热重载                │
│  哲学："Agent 的骨骼 —— 定义存在，而非累积经验"    │
└──────────────────────────────────────────────────┘

┌─ 对话记忆 (Episodic Memory · 摘要记忆本体) ─────┐
│  RoundSummary: "这一轮聊了什么"（轮次级）          │
│  Content:      "这一段会话沉淀了什么"（会话级）      │
│                                                  │
│  访问：双通道召回 (关键词+语义)，相关度排序         │
│  存储：SQLite + VectorStore                       │
│  真理源：memora.db（运行时索引）                   │
│  变更：每轮/会话结束自动生成摘要 + type 标签        │
│  溯源：roundId + sessionId → 回溯原始对话          │
│  自然遗忘：superseded 写时取代 + score 衰减        │
│  哲学："Agent 的血肉 —— 经验累积，动态生长"        │
└──────────────────────────────────────────────────┘
```

**桥梁**：设定记忆与对话记忆经 `summaryFocus` 提炼视角衔接（见 §1.2），无 `autoConfigRefiner` 独立转化链路。

### 1.2 设定记忆的唯一承载 = 角色包（Persona / Rule / Skill）

设定记忆（persona / rules / skills）**唯一归角色包**（`role-packs/<名>/manifest.json` 核心控制 + 内容文件 persona.md / rules.md / skills/），**纯文件 + 内存缓存装载，不写 SQLite / 记忆库**（见 [memory-role-pack-boundary-rules.md](./memory-role-pack-boundary-rules.md) R1/R3/R7，ADR-025）。旧 `configDir/personas|rules|skills + SQLite 索引` 模型及其 API（`PersonaManager` / `ConfigManager` / `matchAndInjectSkill` / `bootstrapMemories getBySource('rule')`）已全部随收敛移除，不再作为设定记忆入口。

- **Persona**：`persona.md` 约定名（未声明即回退）；确定性注入 systemPromptPrefix；粘性触发词匹配（`autoSwitch` + `exclusiveWith` 互斥，确定性信号而非语义匹配）；能力声明在 manifest 顶层 `capabilities`（C2）。不写 SQLite / 记忆库。
- **Skill**：全局技能池 `configDir/skills/`（全局激活）+ 角色包 `skills/`（角色激活才激活），两级统一**渐进披露**——L1 元数据常驻 system prompt、L2 `read_skill` 按需读正文、L3 `read_resource`/`run_skill_script`，目录动态扫描（C3）。不写 SQLite / 记忆库。
- **Rule**：`rules.md` 约定名；确定性注入、始终在线。不写 SQLite / 记忆库。

**桥梁**：`summaryFocus` 提炼视角（角色包 prepare 策略）让对话的归纳沉淀为摘要记忆的同时，以角色包视角决定"值得记什么"——骨骼（角色包视角）与血肉（摘要记忆）经**单一记忆单轨**（摘要即记忆）衔接，不再有 `autoConfigRefiner` 独立转化链路。

### 1.3 记忆冲突消解（侧车模型已废弃）

记忆之间的关系侧车（ADR-014，contradicts/supports/follows/refines 等）已于 2026-08-14 判定为过度设计并整体移除。冲突检测改用 `supersededBy` 布尔标记（写路径取代检测，读时过滤），详见 [ADR-021](../decisions/ADR-021-memory-conflict-supersede-write-path.md) 与 §2 召回策略表。

### 1.4 禁止

- ❌ 创建 `RulesService` / `SkillsService` / `TopicsService` 等独立子系统
  - 例外：RolePackManager / SkillManager 是设定记忆的入口（角色包 / 技能装载），不是"独立子系统"
- ❌ 为不同记忆类型建立不同的存储后端
- ❌ 引入"系统提示词硬编码"
- ❌ 将 Persona/Skill 数据写入 SQLite（无召回消费者，纯浪费）

## 2. 永久性分级决定召回确定性

**原则**：不是所有记忆都要 100% 召回；按永久性等级决定确定性。

| source 标签 | 召回策略                | 示例               |
| ----------- | ----------------------- | ------------------ |
| `persona`   | 设定记忆，不参与 recall  | 人格               |
| `rule`      | 100% 启动加载（bootstrap） | 安全规则、编码规范 |
| `skill`     | 设定记忆，不参与 recall  | 领域知识、能力技能 |
| `content`   | 按相关度增量召回（归档模式三态控制，ADR-015） | 会话归档的工作内容投影 |
| `work-projection` | 不参与 recall（落项目目录 `<memoraDir>/projections/`，随项目隔离） | 作品投影（Agent 读取用户作品生成的概要，2026-08-20 起移出记忆库） |
| `round-summary` | 按相关度增量召回 | 轮次摘要（记忆即摘要，含 preference/fact/decision/intent/general 类型） |
| `profile`   | 按相关度增量召回        | 用户画像（存量数据兼容，2026-08-14 起不再新写入） |

**记忆关系图谱已移除**：独立侧车模型（`MemoryRelation`/`IMemoryRelationStore`/`RelationBuilder`）判定为过度设计并整体移除（ADR-014 废弃，2026-08-14），冲突检测改用 `supersededBy` 布尔标记（见 §1.3）；用户画像收敛为 `round-summary` 的 `type=preference` 召回（见 [memory-as-summary.md](../../docs/architecture/memory-as-summary.md)）。

## 3. 冷热分离（File vs DB）

**原则**：文件承载本体（可读可编辑），数据库承载索引（高性能检索）。

| 存储                  | 内容                       | 何时读写                 |
| --------------------- | -------------------------- | ------------------------ |
| 文件（`.md`/`.json`） | 记忆内容本体               | 启动时扫描；用户手动编辑 |
| SQLite 索引           | 标签、永久性、权重、关键词 | 高频查询；FTS5 搜索      |

**事务一致性**：写文件 + 写索引必须事务对齐。

## 4. 代码与模型分工

**原则**：代码负责确定性工作（记忆查询、Token 预算、文件读写），模型负责不确定性工作（意图理解、内容生成、决策）。

**信号采集 vs 语义判断的边界**：

- ✅ 代码做"信号采集"——关键词匹配、频次统计、阈值比较等确定性计算，结果作为信号注入 LLM prompt
  - 例：`AffectController.deriveAffectFromMessages()` 用关键词匹配采集温暖度/直接度信号（修正值 [-0.3, +0.3]），零 LLM 成本，信号经指数平滑后注入 `buildAffectPrompt`，最终情绪理解由 LLM 完成
- ❌ 代码做"语义判断"——理解用户情绪背后的意图、生成情绪化的回应等不确定性工作
  - 例：不应在代码中硬编码"用户说'谢谢'时回复'不客气'"——这应由 LLM 根据上下文生成

**判断标准**：如果逻辑可以用"if 关键词命中 then 数值 += delta"表达，是信号采集（代码职责）；如果需要理解上下文语义才能决策，是语义判断（LLM 职责）。

**反模式**：

- ❌ 让 LLM 决定"要不要检索更多记忆"（应该由 token 预算监控代码触发）
- ❌ 让代码做"语义判断"——理解情绪意图、生成情绪化回应（应该让 LLM 处理）
- ❌ 让 LLM 直接写数据库（应该 LLM 调工具，代码执行工具）

## 5. 领域无关

**原则**：核心代码不耦合任何领域。领域特性通过 `personality.md` / `rules/` /
`skills/` 注入。

**验证标准**：

- 切到小说创作领域：不改 src/ 一行代码，只换 `.memora/` 目录
- 切到编程辅助领域：同上
- 切到日程规划领域：同上

## 6. 增量召回（不预加载）

**原则**：上下文窗口是稀缺资源，记忆是丰富资源。启动时只加载确定性 100% 的记忆（always +
domain），其余在 Agent Loop 中按需检索。

**在代码中的体现**：

- `bootstrap` 只加载 `rule` 来源标签（Persona 由 `systemPromptPrefix` 确定性注入，Skill 经渐进披露——L1 元数据常驻、L2 `read_skill` 按需读取）
- `insight` / `archive` 级记忆不进启动加载，由 `recall()` 在 Loop 中按需召回（async，双通道：语义搜索 + 关键词搜索，结果合并去重）
- 向量搜索失败时静默降级到关键词——保护专注态不被网络抖动打断
- 单次增量召回 Token 预算不超过上下文窗口的 10%
- 归档时走记忆归档三原则过滤，拒绝低价值重复信息
- **冲突消解（ADR-021）**：记忆冲突通过 `supersededBy` 布尔标记表达（写路径取代检测，读时过滤），不再使用关系图谱侧车（ADR-014 已废弃）
- `recall()` 默认 `excludeSources` 为空（`DEFAULT_RECALL_EXCLUDE_SOURCES = []`，设定记忆已不写入记忆库、ADR-025，无需在召回侧排除）

**禁止**：

- ❌ 启动时全量加载所有话题文件——浪费上下文
- ❌ 一次性注入所有技能描述——干扰模型判断
- ❌ 因为"可能用到"就把不相关记忆塞进 prompt

## 7. 降级优先（Degrade Before Breaking）

**原则**：非关键操作失败时，降级服务而非中断对话。用户永远能收到响应，哪怕不是最优响应。

**降级层级**：

| 优先级 | 操作               | 失败策略             | 代码证据                                |
| ------ | ------------------ | -------------------- | --------------------------------------- |
| P0     | 对话响应           | 不可降级             | Agent Loop 核心路径无 try/catch         |
| P1     | 消息持久化         | 记日志，不抛异常     | `appendMessage()` catch-only-log        |
| P2     | 轮次摘要归档       | 跳过本次，不阻塞     | `roundSummaryGenerator.generate()` fire-and-forget |
| P3     | 启动补执归档       | 跳过，Agent 正常启动 | `awaitPendingArchives()` 5s 超时兜底    |
| P4     | 项目切换（释放锁） | warn，继续切换       | `switchProject()` catch-only-warn       |

**禁止**：

- ❌ 归档失败导致对话中断（归档 ≠ 对话）
- ❌ 消息写入失败导致抛出（历史丢失 ≠ 对话不可用）
- ❌ 启动时归档补执阻塞 Agent 初始化超过 3 秒

## 8. 自然遗忘优于完美记忆

**原则**：接受"部分遗忘"是工程现实。剪枝、归档、权重衰减是核心机制，不是补丁。

**在代码中的体现**：

- `decayScores()` 按 `GOVERNANCE_SOURCES` 衰减记忆 score（治理源由 [governance.ts](../../src/memory/governance.ts) 统一维护；由内核 Agent 定时调度，宿主经 `decayCompleted` 事件确认）。当前治理源为空——profile 已随角色包边界收敛移除、work-projection 已随移出记忆库（2026-08-20），衰减循环空转但机制保留，未来新增治理源从 `GOVERNANCE_SOURCES` 声明即可
- **round-summary 不参与 score 衰减**（2026-08-17 对齐实现）：其"遗忘"由两条机制承担——① 写路径取代检测（`superseded` 标记，ADR-021 + 加权 Jaccard 算法）压制被覆盖的旧摘要；② score 衰减自然沉底（长期未访问的记忆分数衰减，相关性排序自然排不到前面）。**类型时间窗口已废弃**（2026-08-17 定论）：type 不设时效，记忆是否有效由 superseded + score 衰减判定，不由时间流逝判定。score 衰减只作用于治理源声明的长期沉淀记忆，避免对轮次级记忆重复施加衰减机制
- 减法式衰减 + 下限保留：score 降至下限后不再继续衰减，保留最低权重（公式细节详见 `MemoryDecayScheduler` 实现与 [ADR-015](../decisions/ADR-015-archive-mode.md)）
- `init()` 时首次衰减 + 定时衰减（由内核 `MemoryDecayScheduler` 调度）
- 物理清理：`purgeExpiredMemories(before)` 清理过期软删除记忆；回收站定时器默认保留 30 天

**设计取舍**：减法式衰减 + 下限保留保证记忆不会完全消失（可被召回但权重极低），与"永不删除"不同——物理清理由回收站机制负责，权重衰减仅影响召回优先级。

**禁止**：

- ❌ "永不删除任何记忆"——存储会爆炸
- ❌ "所有记忆一视同仁"——会导致噪声淹没信号
- ❌ "召回越多越好"——会击穿上下文窗口

## 9. 专注模式（应无所住，而生其心）

**原则**：Memora鼓励用户**深度专注**于一个领域持续探索，而非频繁切换话题。系统设计应**支持切换、默认专注**——切换能力保留，但默认值偏向沉浸。

**佛家映射**：

- "应无所住"：Agent 启动时只加载 `persona` + `rule` + `skill`
  记忆（无所挂碍，清净空灵），不预载任何话题
- "而生其心"：用户一开口，记忆按语义/关键词自然浮现（`recall()` 双通道召回）
- 专注：同话题内缓存召回结果，让用户有更长的"沉浸窗口"

**在代码中的体现**：召回双通道、`excludeSources`、向量搜索静默降级见 §6 增量召回；衰减调度见 §8 自然遗忘。专注模式的核心体现是「默认值偏向沉浸 + 支持显式切换」（见下方「用户显式切换的支持」）。

**禁止**：

- ❌ 启动时预载全量话题记忆——污染专注态
- ❌ 用户每次说话都触发全量检索——破坏沉浸
- ❌ 话题切换阈值过低——鼓励"蜻蜓点水"式对话
- ❌ 鼓励"多线程并行处理多话题"——这违反单一专注原则

**用户显式切换的支持**：

- 显式命令（如 `switchSession()`）享有最高优先级，直接切换会话
- 切换后重新组装上下文，让新话题的"生其心"从空灵中浮现
- 这是"专注"原则的补充而非冲突——专注是默认，切换是例外

## 10. 单 Agent 模型（配置文件是真理源）

**原则**：Memora 被宿主接入后，就是该程序的唯一 Agent。memora.db 是 Agent 级共享资源，不随子项目切换重建。

**配置文件是真理源，SQLite 是运行时索引**：

- configDir 下的配置文件（personas/rules/skills/tools）由 MemoryLoader 在启动时扫描，加载到 SQLite 中
- 项目级 projectPath/.memora/ 只放 rules/ 和 skills/，不放 memora.db
- 用户记忆（dataDir）存放 memora.db + sessions/，纯数据，不含配置
- `config.addRule()` 是运行时注入（写入 SQLite，会话级），不经配置文件
- `config.confirm()` 写入配置文件（持久化，重启后依然生效）

**在代码中的体现**：

- `ProjectManager.ensureAgentResources()`：确保 memora.db 只创建一次（Agent 级）
- `ProjectManager.initProject()`：三层加载（项目级 → Agent 级配置），不重建数据库
- `ProjectManager.shutdown()`：关闭 Agent 级数据库（仅在 Agent 整体关闭时调用）
- `ProjectManager.closeProject()`：只释放项目锁，不关数据库

**禁止**：

- ❌ 每个子项目创建独立的 memora.db——记忆是 Agent 级的
- ❌ 项目切换时关闭/重建数据库——记忆跨项目持久化
- ❌ 将配置直接写入 SQLite 作为持久化存储——配置文件才是真理源

## 11. 角色包是参数集，插卡解耦（通用引擎 ↔ 专业卡）

**原则**：memora 内核是执行闭环的通用引擎，角色包是参数集——persona（身份）、rules（规则）、capabilities（能力）、strategy（策略）四件套作为外部可注入的参数，将通用引擎配置为特定领域的专家。**通用性和专业性在此正交解耦**。

### 11.1 插卡模型

```
memora 内核 = 插卡机（不变）         角色包 = 卡（可变）
─────────────────────               ─────────────────────
单轮闭环引擎                         persona → 身份设定
Trigger → Prepare → Act              rules → 行为约束
  → Reflect → Handoff               capabilities → 工具集
独立的记忆归档与召回系统              strategy → 行为开关
                                    knowledge → 知识背景
```

**memora 不需要知道自己是谁——它只需要知道"当前插的是什么卡"。**

### 11.2 卡的核心属性

| 属性 | 含义 | 设计体现 |
|------|------|---------|
| **可插拔** | 同一角色包可被不同 Agent 实现装载 | role-pack-spec 标准格式，实现无关 |
| **可共享** | 角色包是纯文本文件，可分发、可版本管理 | 文件夹形态：manifest.json（唯一核心控制文件）+ persona.md/rules.md/skills/* 内容文件 |
| **可叠加** | 支持多角色包组合 | L1 必读 + L2 可选策略键级渐进 |
| **不自洽** | 角色包不包含执行引擎 | 依赖宿主 Agent 的闭环引擎，自身是纯声明 |

### 11.3 设计推导：角色包 = 单轮闭环的参数化配置

角色包的最小单元不是文件，而是**一次角色注入**——在某轮闭环的 Prepare 阶段，一个角色包被装载到 Agent 的行为空间中：

```
function singleTurn(context: Context, rolePack: RolePack): Handoff {
  // Prepare 阶段：rolePack.strategy.prepare 决定如何装配 context
  // Act 阶段：    rolePack.strategy.act 决定如何执行
  // Reflect 阶段：rolePack.strategy.reflect 决定如何沉淀
  // Handoff:     rolePack.strategy.reflect.handoff 决定下一步
}
```

在这个视角下：

- **校验器不是独立系统**——校验是 Prepare 阶段输入检查的一部分
- **管理器不是独立系统**——管理是 Handoff 阶段"匹配→切换"策略的一部分
- **能力映射不是独立系统**——映射是 Act 阶段工具暴露面配置的一部分

一切"看起来像独立模块"的东西，本质上都是闭环不同阶段的行为。**这与"执行闭环是 Agent 最小完整单元"（single-truth-source-mindset.md）完全同构。**

### 11.4 验证标准

- 用户写一个角色包文件夹（manifest.json 声明元数据与策略 + persona.md/rules.md/skills/* 内容文件）→ memora 装载 → 变成翻译专家：不改 `src/` 一行代码
- 用户换一个角色包文件夹 → memora 装载 → 变成代码审查专家：同上

### 11.5 技能的两级性（2026-08-18 定案）

技能不是角色包四件套（persona/rules/capabilities/strategy）之一，而是独立维度，**两级同构**：

```
通用技能（全局池 configDir/skills/）→ 全局激活（通用能力共享，不随角色变）
角色包技能（manifest.skills）→ 角色激活才激活（角色专属内容）

两级统一渐进披露：L1 元数据清单常驻 system prompt + L2 read_skill 按需读正文
```

- **能力面独立**（C2）：`manifest.capabilities` 顶层声明（工具白名单）与 `manifest.skills`（技能文件引用）分离——「能做什么」与「有什么技能正文」是两件事；
- **避免复制**：通用技能全局一份，角色包不重复——「写小说的角色不需要加载写代码的通用技能」（用户设计原则）；
- **内容文件约定名**：persona.md / rules.md 约定俗成（manifest 未声明回退约定名），消除路径错误面。
- 用户把同一个角色包文件夹给另一个兼容 Agent 装载 → 同样行为

### 11.5 禁止

- ❌ 角色包包含执行引擎逻辑（它是一次参数注入，不是子 Agent）
- ❌ memora 内核 hardcode 任何领域知识（全部通过角色包参数化）
- ❌ 角色包与 memora 内核版本强耦合（通过 formatVersion 兼容，而非版本绑定）

## 12. 可观测性边界（2026-08-15 建议 B 落地补充）

**原则**："模型看到了什么"属可观测性诉求，由 ITracer 接口承载指纹 hash，**不入记忆存储（sessionStore）**。观测性与记忆职责分离——内核提供机制（埋点接口），宿主负责策略（是否启用、监控面板）。

**在代码中的体现**：

- `llm.call` span 记录 `systemPromptHash`（系统提示内容指纹）
- `recall.recall` span 记录 `attachedMemoryCount` / `attachedMemoryFingerprint`（记忆条数与 ID 集合指纹）
- 仅当宿主注入真实 Tracer 时计算指纹，NOOP 模式下零开销
- 指纹生成使用 `utils/hash.ts` 的 `sha256Fingerprint` 纯函数，复用于作品投影 hash

**禁止**：

- ❌ 在 sessionStore 中存储完整上下文快照（"自然遗忘优于完美记忆"）
- ❌ 未注入 Tracer 时执行指纹计算（NOOP 零开销）
- ❌ 指纹 hash 与记忆内容存储耦合
