# Memora — Agent 定位与多身份设计

> **定位**：回答 Memora agent 的两个根本问题——"agent 是单一还是多元？"
> "rules 与 skills 是什么关系？"，沉淀用户决策的智慧 **关系**：本文档是
> [agent设计.md](./agent设计.md) 的"定位子文档"，是
> [agent上下文组装协议.md](./agent上下文组装协议.md) 的"边界子文档"
> **状态**：🚧 思考沉淀（暂未实施） **日期**：2026-06-03

---

## 一、Agent 的根本定位

### 1.1 单一 Agent 原则

**Memora 的核心立场**：**每个用户只有一个 Agent**。

这个 Agent 是用户的**长期助手**——直接对接用户、记住用户的所有习惯与历史。Agent 不分裂、不并行、不"分身"。

**为什么单一**：

- **记忆连续性**：用户的偏好、习惯、决策风格是**长期沉淀**的财富。多个 Agent 之间会形成"记忆孤岛"——A
  agent 知道的事 B agent 不知道
- **人格统一性**：用户面对的永远是同一个人格，不会因为切换 agent而产生"沟通风格断层"
- **避免运维负担**：多个 agent 意味着多份配置、多个 .memora/ 目录、多套安全权限——对个人用户而言是负担
- **符合"专注模式"**：单一 agent 鼓励深潜，多个 agent 鼓励浅尝辄止

### 1.2 与市面"多 Agent 平台"的关系

市面上的多 agent 平台（Coze / Dify
/ 扣子）让用户**新建多个 agent**——这其实是让用户新建"带特定能力的角色容器"。

**Memora 的解法**：**内部单一 Agent，外部通过"身份切换"模拟多 agent 体验**。

```
市面平台心智模型：               Memora 心智模型：
─────────────                  ─────────────
进程 → Agent A (代码)            进程 → Agent（单一内核）
进程 → Agent B (小说)                  ├─ 身份：程序员
进程 → Agent C (客服)                  ├─ 身份：作家
                                     └─ 身份：父亲
用户在不同 agent 间切换         用户在"身份"间切换
记忆完全隔离                    记忆完全共享
```

**关键差异**：

- **市面**：进程级隔离，记忆不共享
- **Memora**：配置级隔离，记忆**完全共享**——所有身份共用同一个 `.memora/`
  数据库，所有话题记录都能跨身份看到

---

## 二、"身份"概念的两种实现路径

实现"多身份"有两条路径。**先思考后选型**。

### 2.1 路径 A：复用现有 Domain 概念（推荐）

**核心思想**：把现有的"领域（Domain）"概念**重新语义化**——
Domain 不再是"知识维度"，而是"身份容器"。

| 维度         | 当前 Domain 语义       | 重定义后 Domain 语义     |
| ------------ | ---------------------- | ------------------------ |
| **定位**     | 跨项目可复用的知识领域 | 面向用户的"身份/角色"    |
| **典型例子** | "法律"、"医学"         | "程序员"、"作家"、"父亲" |
| **数据隔离** | 完全独立 SQLite        | ⚠️ **需要改为共享**      |
| **切换代价** | 关闭旧库 + 开新库      | **轻量切换，只换配置**   |
| **共享记忆** | ❌ 隔离                | ✅ 共享                  |
| **数量预期** | 少（2-5 个）           | 中（5-10 个）            |

**优点**：

- ✅ 零新概念，CLI 直接对齐市场预期
- ✅ 底层单 agent，记忆真正共享
- ✅ 符合"专注模式"哲学

**缺点**：

- ⚠️ `domain` 命名对"父亲/朋友"等非专业身份有语义尴尬（但用户可自由命名）
- ⚠️ 现有 `DomainManager.switchDomain()`
  是"硬切换"（关闭旧 SQLite），改为"软切换"需修改 2 个现有测试

### 2.2 路径 B：新增 Identity 概念

**核心思想**：保留 Domain 概念不动，新增 `IdentityManager` 专门管身份。

```
DomainManager（领域）     →  知识维度（法律/医学/工程）
IdentityManager（身份）   →  角色维度（程序员/作家/父亲）
```

**优点**：

- ✅ 语义清晰，概念正交
- ✅ 现有 Domain 完全不动，无破坏性

**缺点**：

- ❌ 引入新概念，违反"自然生长原则"
- ❌ 用户使用成本上升（"什么时候用 domain，什么时候用 identity？"）
- ❌ 短期内没有真实场景需要这种区分

### 2.3 推荐：路径 A

**理由**：

1. **当前 Domain 概念本来就是"装载特定能力的容器"**——这正是身份的本质
2. **Memora 是个人工具**，不需要"领域 vs 身份"的精细区分
3. **市面认知**——`memora domain list` 看起来就是"我有几个 agent"，对用户最友好
4. **自然生长**——不引入新概念，等用户真的开始用"领域"装"身份"后，再观察是否需要分离

### 2.4 路径 A 的实施前置条件

**未实施**，因为这是一个有破坏性的改动。当前状态：

- ✅ `DomainManager` 已存在
- ✅ `Agent` 类已能拿到 `DomainContext`
- ❌ `switchDomain()` 当前是"硬切换"（关闭旧 SQLite）
- ❌ 缺 CLI 的 `memora domain create/list/edit` 命令
- ❌ 现有 2 个测试期望"硬切换"行为

**实施前需要决策的问题**（见 §4 待决策项）

---

## 三、Rules 与 Skills 的关系

### 3.1 核心结论

**Rules 和 Skills 是同一种东西的两种形态**——都是"行为约束"，只是**永久性不同**。

`MemoryType` 枚举（[src/memory/types.ts](../../src/memory/types.ts)）：

```typescript
export const MemoryType = {
  PERSONALITY: 'personality', // 人格
  RULE: 'rule', // 规则 ←—
  SKILL: 'skill', // 技能 ←— 同一种东西
  TOOL: 'tool', // 工具
  TOPIC: 'topic',
  ARCHIVE: 'archive',
} as const;
```

`rule` 和 `skill` 共享同一张 `memories`
表，共享同一套 RecallPipeline，共享同一套人格/规则文件结构。

### 3.2 区分维度

| 维度               | Rule（规则）                         | Skill（技能）             |
| ------------------ | ------------------------------------ | ------------------------- |
| **永久性**         | `always` / `domain`                  | `on-demand`（默认）       |
| **存储位置**       | `<configDir>/rules/*.md`             | `<configDir>/skills/*.md` |
| **加载时机**       | 启动时 100% 必召，注入 system prompt | 任务需要时按需召回        |
| **作用**           | 改变 agent 的"行为准则"              | 改变 agent 的"思考方式"   |
| **典型例子**       | "回复必须用中文"                     | "用 TDD 流程改代码"       |
| **冲突优先级**     | 兜底基线（永驻）→ 领域规则           | 技能不与规则冲突          |
| **和 tool 的关系** | 不可执行                             | 可能配套一组 tool         |

### 3.3 形象比喻：道与术

```
"回复必须用中文"            →  rule/always       （道 · 行为准则）
"代码改动前先读测试"         →  rule/always       （道 · 行为准则）
"用 TDD 流程"              →  skill/on-demand    （术 · 思考方式）
"写小说时遵循'三幕剧'结构"   →  skill/on-demand    （术 · 思考方式）
"读文件"                   →  tool/on-demand     （器 · 执行能力）
```

### 3.4 区分价值

如果都是 Memory，为什么还分 `rule` / `skill` 两个 type？
**因为永久性不同**——这决定了召回方式和配额：

| 永久性                       | 召回方式  | 配额占用 | 启动时加载 |
| ---------------------------- | --------- | -------- | ---------- |
| `always`（rule/personality） | 100% 注入 | 永驻 10% | ✅         |
| `domain`（rule）             | 100% 注入 | 领域 15% | ✅         |
| `on-demand`（skill/tool）    | 按需检索  | 能力 10% | ❌         |

**永久性分级决定召回确定性**（见
[architecture_philosophy_rules.md §2](../../.trae/rules/architecture_philosophy_rules.md)）。如果不分 type，就无法知道"该永久注入"还是"按需检索"。

### 3.5 禁止的写法

❌ **反例**：独立的 RulesService / SkillsService

```typescript
// 违反"万物皆记忆"原则
class RulesService { load(), search() }
class SkillsService { activate(), deactivate() }
```

✅ **正例**：一套 RecallPipeline 通用

```typescript
const recall = new RecallPipeline(index);
const ruleMemories = await recall.recall('...', { types: ['rule'] });
const skillMemories = await recall.recall('...', { types: ['skill'] });
const toolMemories = await recall.recall('...', { types: ['tool'] });
```

**这是"万物皆记忆"原则的胜利**——不需要两套子系统。

---

## 四、待决策项

### 4.1 路径 A 的破坏性评估

如果采用路径 A（重定义 Domain 为身份），需要修改：

| 改动                                           | 影响                   | 风险 |
| ---------------------------------------------- | ---------------------- | ---- |
| `DomainManager.switchDomain()` 改为"软切换"    | 现有 2 个测试需更新    | 中   |
| 新增 CLI 命令 `memora domain create/list/edit` | 无                     | 低   |
| `domain-templates.ts` 需扩展                   | 已有 `code/novel` 模板 | 低   |

### 4.2 不实施的理由

**当前不实施路径 A 的理由**：

1. **没有真实用户需求**——目前是阶段一，主要用户是项目作者本人
2. **破坏性改动需谨慎**——`switchDomain()` 行为变化会改变现有语义
3. **等真实场景**——等到第二个用户用 Memora 表达"我想建第二个 agent"时再做
4. **思考先于行动**——把设计沉淀在本文档，等需求验证后再实施

### 4.3 何时回顾

**触发实施路径 A 的条件**：

- ⏳ 累计 3 个以上用户表达"想新建 agent"
- ⏳ 阶段二"多宿主项目"完成后，自然产生身份切换需求
- ⏳ `memora domain create` 命令在 CLI 出现 5+ 次用户尝试（从日志统计）

### 4.4 路径 B 的备用

如果路径 A 在未来真的产生"领域 vs 身份"的语义冲突，再考虑路径 B。
**当前坚决不引入 Identity 概念**。

---

## 五、相关文档索引

- **agent 整体设计**：[agent设计.md](./agent设计.md)
- **上下文组装协议**：[agent上下文组装协议.md](./agent上下文组装协议.md)
- **记忆统一模型**：[记忆归档原则.md](./记忆归档原则.md)
- **架构哲学（含专注模式 §9）**：[.trae/rules/architecture_philosophy_rules.md](../../.trae/rules/architecture_philosophy_rules.md)
- **记忆类型定义**：[src/memory/types.ts](../../src/memory/types.ts)
- **领域管理器（待改造）**：[src/memory/domain-manager.ts](../../src/memory/domain-manager.ts)
- **Agent 门面类**：[src/agent/agent.ts](../../src/agent/agent.ts)

---

## 六、文档版本

| 版本 | 日期       | 变更                                  | 作者               |
| ---- | ---------- | ------------------------------------- | ------------------ |
| v0.1 | 2026-06-03 | 初版，沉淀"单 agent + 多身份"设计思考 | 用户 + Memora 团队 |

**变更说明**：

- **v0.1**：明确"单 agent + 多身份"立场，对比路径 A/B，推荐路径 A 但暂不实施
