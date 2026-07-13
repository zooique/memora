---
alwaysApply: false
description:
  架构哲学原则（10
  条：万物皆记忆、永久性分级、冷热分离、模型分工、领域无关、增量召回、降级优先、自然遗忘、专注模式、单 Agent 模型）
version: v0.8
date: 2026-07-10
---

# 架构哲学原则

## 1. 万物皆记忆（Everything is Memory）

**原则**：Agent 接触的一切内容（人格、规则、技能、对话历史、工具定义）都是"记忆"。

**三层模型**（类比人脑）：

| 层                 | 内容                             | 存储方式                       | 召回优先级              |
| ------------------ | -------------------------------- | ------------------------------ | ----------------------- |
| 第 1 层：需求/意图 | 用户当前输入                     | 不存储，直达意识               | 当前对话直接可见        |
| 第 2 层：作品      | 用户的产出物（代码文件、小说等） | 文件本体归用户，Agent 只存投影 | domain 级，启动加载投影 |
| 第 3 层：记忆管道  | 角色、技能、规则、话题归档、心得 | 统一 SQLite 索引 + 文件冷存储  | 按永久性分级召回        |

**记忆关系图谱（侧车，ADR-014）**：记忆之间的关系（contradicts/supports/follows/refines 等）是独立于 Memory 7 字段的侧车数据结构，不侵入基元模型。关系数据由 InsightExtractor 在归档时构建，用于冲突检测和因果追溯。

**Persona 和 Skill 的定位**：

- **Skill（技能）**是“配置型记忆”——由 SkillManager 在内存中独立管理，同时写入 SQLite 索引（`source: skill`）以支持 recall 检索。类似人的“长期训练形成的思维模式”，通过关键词匹配触发，在上下文组装时作为最高优先级注入
  - 双路径设计：
    - 路径一（文件加载）：`SkillManager.load()` 启动时扫描 `configDir/skills/*.md` → 内存 + SQLite
    - 路径二（运行时注入）：`config.addSkill()` → `SkillManager.register()` + SQLite 索引（session-only，重启后丢失）
    - 路径三（持久化新增）：`config.confirm({type:'skill',...})` → 写配置文件 → 下次启动自动加载
  - **Skill 写入 SQLite 的理由**：技能虽由 SkillManager 独立管理，但写入 SQLite 索引后可被 recall() 检索到，实现语义/关键词双通道召回，与 PersonaManager 保持一致的存储策略
- **Persona（角色）**遵循“万物皆记忆”原则——存入 SQLite 作为 `source: persona` 的记忆。**在召回管线中做特殊处理**：bootstrap 时过滤掉所有 persona 来源，由 PersonaManager 单独管理角色注入（systemPromptPrefix）。角色可被话题关键词动态匹配自动切换，也可手动指定，支持 auto/manual 两种模式
- 类比人类：性格是你 persona 的一部分，可以被“选择”（在不同场合以不同角色应对），而技能是“能力”，始终在线

**在代码中的体现**：

- **PersonaManager**：扫描 `personas/*.md`，加载为 `source: persona` 记忆，存入 SQLite 索引。支持关键词自动匹配 + 手动指定 + 时间窗口缓冲（60s/3次）。角色通过 systemPromptPrefix 注入，不进 bootstrap
- **SkillManager**：扫描 configDir/skills/ 目录 + 关键词匹配，匹配到后注入下一轮 system
  prompt。**写入 SQLite 索引**（`source: skill`），支持 recall() 检索。运行时注入的技能（`addSkill()`）仅在当前会话有效，持久化需走 `config.confirm()`
- 记忆管道层（规则、话题归档、心得）通过 `recall()` 的统一召回管线检索
- `source` 开放字符串区分来源：`persona` 用于角色记忆，`rule` 用于规则，`skill` 用于技能，`insight` 用于对话提取
- `bootstrap` 阶段对 `source: persona` 做特殊过滤：全部排除，由 PersonaManager 通过 systemPromptPrefix 单独注入当前激活角色

**禁止**：

- ❌ 创建 `RulesService` / `SkillsService` / `TopicsService` 等独立子系统
  - 例外：PersonaManager /
    SkillManager 是顶层过滤器，不是"独立子系统"，它们是记忆管道的入口守护者
- ❌ 为不同记忆类型建立不同的存储后端
- ❌ 引入"系统提示词硬编码"

## 2. 永久性分级决定召回确定性

**原则**：不是所有记忆都要 100% 召回；按永久性等级决定确定性。

| source 标签 | 召回策略                | 示例               |
| ----------- | ----------------------- | ------------------ |
| `persona`   | 100% 启动加载（角色）   | 人格               |
| `rule`      | 100% 启动加载（规则）   | 安全规则、编码规范 |
| `skill`     | 100% 启动加载（技能）   | 领域知识、能力技能 |
| `content`   | 按相关度增量召回（归档模式三态控制，ADR-015） | 会话归档的工作内容投影 |
| `insight`   | 按相关度增量召回        | 对话提取的洞察、历史话题归档 |
| `profile`   | 按相关度增量召回        | 用户画像（身份、偏好、专长） |

**记忆关系（侧车，ADR-014）**：MemoryRelation 不参与永久性分级，是独立的侧车数据。关系数据在 InsightExtractor 归档时构建，召回时通过 `getRelations(memoryId)` 按需查询，不进入 bootstrap 加载。

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

- `bootstrap` 只加载 `persona` + `rule` + `skill` 三类来源标签
- `insight` / `archive` 级记忆不进启动加载，由 `recall()` 在 Loop 中按需召回（async，双通道：语义搜索 + 关键词搜索，结果合并去重）
- 向量搜索失败时静默降级到关键词——保护专注态不被网络抖动打断
- 单次增量召回 Token 预算不超过上下文窗口的 10%
- 归档时走记忆归档三原则过滤，拒绝低价值重复信息
- **记忆关系按需查询**：召回记忆后，可通过 `IMemoryRelationStore.getRelations(memoryId)` 查询该记忆的关系（矛盾/支持/衍生等），用于上下文增强和冲突提示。关系查询不进入 bootstrap，仅在需要时触发（ADR-014）

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
| P2     | 话题归档           | 跳过本次，不阻塞     | `extractInsight()` fire-and-forget |
| P3     | 启动补执归档       | 跳过，Agent 正常启动 | `awaitPendingArchives()` 5s 超时兜底    |
| P4     | 项目切换（释放锁） | warn，继续切换       | `switchProject()` catch-only-warn       |

**禁止**：

- ❌ 归档失败导致对话中断（归档 ≠ 对话）
- ❌ 消息写入失败导致抛出（历史丢失 ≠ 对话不可用）
- ❌ 启动时归档补执阻塞 Agent 初始化超过 3 秒

## 8. 自然遗忘优于完美记忆

**原则**：接受"部分遗忘"是工程现实。剪枝、归档、权重衰减是核心机制，不是补丁。

**在代码中的体现**：

- `decayScores()` 衰减 insight/profile/work-projection 的 score（由内核 Agent 定时调度，sprite 通过 `decayCompleted` 事件确认）
- 减法式衰减 + 下限保留：score 降至下限后不再继续衰减，保留最低权重（公式细节详见 `MemoryDecayScheduler` 实现与 [ADR-015](./decisions/ADR-015-archive-mode.md)）
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

**在代码中的体现**：

- `recall()` 双通道召回：语义搜索（VectorStore，可选）+ 关键词搜索，结果合并去重
- `excludeSources` 默认排除 `persona` + `rule` + `skill`（已由 bootstrap 注入，避免重复）
- 向量搜索失败时静默降级到关键词——保护专注态不被网络抖动打断
- 记忆衰减机制：`decayScores()` 每小时自动衰减 insight/profile/work-projection

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

- configDir
  下的配置文件（personas/rules/skills/tools）由 MemoryLoader 在启动时扫描，加载到 SQLite 中
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
