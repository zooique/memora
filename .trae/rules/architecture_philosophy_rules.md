---
alwaysApply: false
description:
  架构哲学原则（10
  条：万物皆记忆 v2、永久性分级、冷热分离、模型分工、领域无关、增量召回、降级优先、自然遗忘、专注模式、单 Agent 模型）
---

# 架构哲学原则

## 1. 万物皆记忆 v2（Everything is Memory）

**原则**：Agent 接触的一切内容都是"记忆"。v2 将记忆分为两类轨道——**设定记忆**（骨骼）和**对话记忆**（血肉），各自有独立的存储和访问模型。

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

┌─ 对话记忆 (Episodic Memory) ────────────────────┐
│  Conversation: "我们聊过什么"                     │
│  Insight:      "我总结出什么规律"                  │
│  UserProfile:  "用户偏好什么"                      │
│                                                  │
│  访问：语义召回 (RAG)，相关度排序                  │
│  存储：SQLite + VectorStore                       │
│  真理源：memora.db（运行时索引）                   │
│  变更：每轮对话自动归档                            │
│  哲学："Agent 的血肉 —— 经验累积，动态生长"        │
└──────────────────────────────────────────────────┘
```

**桥梁**：`autoConfigRefiner` 将对话洞察转化为设定文件——骨骼从血肉中结晶。

### 1.2 Persona、Rule、Skill 的各自定位

**Persona（角色）**：
- 存储：`configDir/personas/*.md`（文件真理源）+ 内存缓存（Persona[]）
- 注入：`systemPromptPrefix`（当轮生效，由 `refreshPersonaPrefix` 动态更新）
- 匹配：关键词 + LLM 辅助语义匹配，在 `chat()` 开头执行
- 模式：auto（自动匹配）/ manual（手动固定）
- 回退：默认回到 `list[0]`（首个角色）
- 锁定：30s 内 5 次切换 → 2 分钟自动恢复
- **不写入 SQLite**：Persona 是设定记忆，无召回路径消费者

**Skill（技能）**：
- 存储：`configDir/skills/*.md`（文件真理源）+ 内存缓存（SkillEntry[]）
- 注入：`injectSystemMessage`（当轮实时注入，由 `matchAndInjectSkill` 在 recall 后执行）
- 匹配：regex trigger 优先（score=1.0），其次关键词匹配（阈值 0.3）
- 自然过期：`cleanTemporarySystemMessages` 每轮清理临时注入
- **不写入 SQLite**：Skill 是设定记忆，无召回路径消费者

**Rule（规则）**：
- 存储：`configDir/rules/*.md`（文件真理源）+ SQLite 索引（`source: rule`）
- 注入：`bootstrapMemories` → `messages[0]`（始终在线，由 `refreshBootstrapMemories` 更新）
- CRUD：通过 `ConfigManager` 操作 SQLite + 回调刷新 system prompt
- **保留在 SQLite**：bootstrap 路径通过 `getBySource('rule')` 读取，这是唯一合法的索引消费

### 1.3 记忆关系图谱（侧车，ADR-014）

记忆之间的关系（contradicts/supports/follows/refines 等）是独立于 Memory 7 字段的侧车数据结构，不侵入基元模型。关系数据由 InsightExtractor 在归档时构建，用于冲突检测和因果追溯。

### 1.4 禁止

- ❌ 创建 `RulesService` / `SkillsService` / `TopicsService` 等独立子系统
  - 例外：PersonaManager / SkillManager 是顶层过滤器，不是"独立子系统"，它们是设定记忆的入口
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
| `insight`   | 按相关度增量召回        | 对话提取的洞察、历史话题归档 |
| `profile`   | 按相关度增量召回        | 用户画像（身份、偏好、专长） |

> **v2 变更**：`persona` 和 `skill` 已从 SQLite 索引解耦，改为纯文件 + 内存缓存。`recall()` 默认 excludeSources 仍然包含三者作为防御，但 persona/skill 在索引中不再存在。`rule` 保留在 SQLite，供 bootstrap 路径读取。

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

- `bootstrap` 只加载 `rule` 来源标签（Persona 由 `systemPromptPrefix` 注入，Skill 由 `matchAndInjectSkill` 当轮动态注入）
- `insight` / `archive` 级记忆不进启动加载，由 `recall()` 在 Loop 中按需召回（async，双通道：语义搜索 + 关键词搜索，结果合并去重）
- 向量搜索失败时静默降级到关键词——保护专注态不被网络抖动打断
- 单次增量召回 Token 预算不超过上下文窗口的 10%
- 归档时走记忆归档三原则过滤，拒绝低价值重复信息
- **记忆关系按需查询**：召回记忆后，可通过 `IMemoryRelationStore.getRelations(memoryId)` 查询该记忆的关系（矛盾/支持/衍生等），用于上下文增强和冲突提示。关系查询不进入 bootstrap，仅在需要时触发（ADR-014）
- `recall()` 默认 `excludeSources = [persona, rule, skill]`（设定记忆不进入召回，双重防御）

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
