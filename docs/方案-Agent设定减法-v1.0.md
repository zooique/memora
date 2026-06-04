# 方案：Agent 设定减法 — 3 模块化

> 来源：问诊（Agent 职能边界分析 → 工具注册机制 → 初始化流程梳理 → 角色系统优化）日期：2026-06-04 版本：v1.1（排雷修正：L1~L7）核心矛盾：概念膨胀 ←→ 用户心智简洁性

## 1. 问题诊断

### 1.1 现状：7+ 概念，用户心智负担重

当前 Agent 暴露给用户的概念：

| 概念           | 用户感知         | 存储位置                    | 动态性               |
| -------------- | ---------------- | --------------------------- | -------------------- |
| Config         | "agent 怎么运行" | .memora/config.json         | 静态                 |
| personality.md | "默认人格"       | agent-config/personality.md | 静态                 |
| personas/\*.md | "角色"           | agent-config/personas/      | 静态                 |
| rules/\*.md    | "规则"           | agent-config/rules/         | 静态                 |
| skills/\*.md   | "技能"           | agent-config/skills/        | 动态（关键词匹配）   |
| tools          | "工具"           | 代码注册                    | 动态（registerTool） |
| domain         | "领域"           | .memora/ 子目录             | 手动切换             |

7 个概念中，personality / personas / rules / domain 存在大量重叠：

- personality 和 personas 本质都是"身份"，只是单数 vs 复数
- rules 是"身份"的附属品（编辑角色有编辑规则，作家角色有创作规则）
- domain 是"身份"的粗粒度版（小说领域 = 作家/编辑/策划的集合）

### 1.2 核心洞察

用户只需要理解 3 件事：

1. **Agent 怎么运行**（设定）
2. **Agent 是谁**（身份）
3. **Agent 能做什么**（技能）

## 2. 目标架构：3 模块

```
Agent = 设定 + 身份 + 技能
```

### 2.1 模块定义

| 模块           | 本质         | 用户感知               | 动态性                        | 存储方式                   |
| -------------- | ------------ | ---------------------- | ----------------------------- | -------------------------- |
| **Agent 设定** | 基础设施配置 | "agent 怎么运行"       | 静态                          | Config + rules             |
| **身份**       | 我是谁       | "agent 以什么角色说话" | 动态（话题触发 / 手动指定）   | personality 记忆（SQLite） |
| **技能**       | 我能做什么   | "agent 有哪些能力"     | 动态（关键词匹配 / 工具注册） | skill 记忆 + registerTool  |

### 2.2 当前概念 → 3 模块映射

| 当前概念                | 归入               | 处理方式                           |
| ----------------------- | ------------------ | ---------------------------------- |
| Config（LLM/安全/记忆） | Agent 设定         | 不变                               |
| personality.md          | 身份               | 合并为 personality 类型记忆        |
| personas/\*.md          | 身份               | 合并为 personality 类型记忆        |
| rules/\*.md             | Agent 设定         | 保留为 rule 类型记忆（启动时加载） |
| skills/\*.md            | 技能               | 不变                               |
| tools（内置 + 自定义）  | 技能               | 工具是技能的"手脚"                 |
| domain                  | **删除**           | 身份切换覆盖领域切换需求           |
| user profile            | Agent 设定（内部） | 用户画像是设定的隐含部分           |
| work projection         | 技能（内部）       | 作品投影是技能的隐含支撑           |

### 2.3 关键变化：删除 Domain 概念

当前 DomainManager 的职责是"切换 .memora/ 目录"——本质是切换记忆空间。但在 3 模块架构中，身份切换已经覆盖了这个需求：

- 用户从小说聊到代码 → 身份从"墨羽"切到"码农" → 记忆挂载自动跟随
- 不需要显式的"领域"概念，身份本身就是领域的载体

DomainManager 的 `switchDomain()` 做了两件事：

1. 关闭旧 SQLite + 打开新 SQLite（切换记忆空间）
2. 重新加载所有组件

删除 Domain 后，身份切换不需要切换 SQLite——所有身份共享同一个记忆空间，只是挂载的 personality 记忆不同。这更符合"万物皆记忆"原则。

## 3. 身份模块设计

### 3.1 身份 = personality 类型记忆

```yaml
# 身份记忆示例：墨羽（作家）
---
id: personality:mo-yu
type: personality
permanence: always
tags: 小说, 创作, 作家
weight: 1.0
keywords: 写, 创作, 小说, 章节, 角色, 故事情节
createdAt: 2026-06-04T00:00:00.000Z
updatedAt: 2026-06-04T00:00:00.000Z
---
# 墨羽 · 小说创作搭档

我是墨羽——你的专属小说创作搭档。
...
```

关键设计：

- `type: personality` — 统一记忆模型
- `permanence: always` — 永不衰减，永不归档
- `keywords` — 用于话题自动匹配（和技能一样的触发机制）
- 存入 SQLite — 统一索引，统一召回

### 3.2 身份激活机制

```
身份激活方式：
├── 自动模式（默认）：话题关键词匹配 → 自动切换身份
│   └── "帮我审一下第三章" → 匹配到"编辑"身份的 keywords → 注入编辑人格
└── 手动模式：下拉框指定 → 强制固定身份
    └── 选"墨羽" → 即使聊编辑也用作家视角
```

自动模式的具体流程（复用现有 SkillManager 的匹配逻辑）：

```
用户输入 → 提取关键词
         → 匹配 personality 记忆的 keywords 字段
         → 命中 → 注入身份 prompt（和技能注入同一个位置）
         → 未命中 → 保持当前身份
```

### 3.3 身份切换的缓冲设计

身份切换比技能切换成本高（LLM 风格突变），需要缓冲：

1. **注入方式**：告诉 LLM "你当前以编辑身份回应"，而非"你是编辑"
   - 这样 LLM 知道这是临时视角切换，不是身份重建
2. **切换频率**：允许每轮切换，但同一话题内连续切换不超过 3 次
   - 超过 3 次锁定当前身份，提示用户手动选择
3. **手动覆盖**：用户手动指定身份后，自动匹配暂停，直到用户切回"自动模式"

### 3.4 身份 vs 技能的注入位置

```
system prompt 结构：
┌─────────────────────────────┐
│ Agent 设定（Config + rules）│ ← 静态，启动时加载
├─────────────────────────────┤
│ 身份（当前激活的 personality）│ ← 动态，话题触发 / 手动指定
├─────────────────────────────┤
│ 用户画像                     │ ← 动态，从 SQLite 加载
├─────────────────────────────┤
│ 技能（匹配的 skill）         │ ← 动态，关键词匹配
├─────────────────────────────┤
│ 工具描述（内置 + 自定义）     │ ← 动态，registerTool
└─────────────────────────────┘
```

身份注入在技能之前——身份决定"我是谁"，技能决定"我怎么做"。

## 4. 实施任务

### 4.1 核心库改动

| ID    | 任务                                                                | 改动量     | 涉及文件                             | 依赖  |
| ----- | ------------------------------------------------------------------- | ---------- | ------------------------------------ | ----- |
| P-601 | PersonaManager 合并到记忆管线：身份记忆存入 SQLite                  | ~60 行     | personaManager.ts, memory/loader.ts  | 无    |
| P-602 | 身份自动匹配：复用 SkillManager 的关键词匹配逻辑                    | ~40 行     | agent.ts                             | P-601 |
| P-603 | 身份注入：chat() 中注入身份 prompt（和技能同一位置）                | ~30 行     | agent.ts, loop.ts                    | P-602 |
| P-604 | 删除 DomainManager：移除 switchDomain/listDomains                   | ~20 行删除 | agent.ts, repl.ts, domain-manager.ts | P-601 |
| P-605 | Agent 公共 API：switchPersona() + listPersonas() + setPersonaMode() | ~30 行     | agent.ts                             | P-602 |
| P-606 | src/index.ts：导出 PersonaMode 类型                                 | ~3 行      | index.ts                             | P-605 |
| P-607 | 测试：身份匹配 + 注入 + 手动覆盖 + 缓冲机制                         | ~60 行     | agent.test.ts                        | P-603 |

### 4.2 novel-writer 示例改动

| ID    | 任务                                            | 改动量 | 涉及文件                                  | 依赖  |
| ----- | ----------------------------------------------- | ------ | ----------------------------------------- | ----- |
| P-608 | agent-config/ 重构：personality.md → 多身份记忆 | ~30 行 | agent-config/personality/, agentBridge.ts | P-601 |
| P-609 | Web UI：身份下拉框（自动 / 指定角色）           | ~60 行 | index.html, web.ts                        | P-605 |

### 4.3 实施顺序

```
P-601（身份记忆存 SQLite）
  → P-602（身份自动匹配）
    → P-603（身份注入）
      → P-605（公共 API）
        → P-606（类型导出）
    → P-604（删除 DomainManager）
  → P-607（测试）
    → P-608（novel-writer 重构）
      → P-609（Web UI 下拉框）
```

## 5. 风险评估

| 风险                                  | 等级 | 缓解措施                                     |
| ------------------------------------- | ---- | -------------------------------------------- |
| 身份频繁切换导致 LLM 风格断裂         | 🟡中 | 缓冲机制（3 次锁定 + 视角切换措辞）          |
| 删除 DomainManager 后记忆空间隔离丢失 | 🟡中 | 所有身份共享同一 SQLite，通过 keywords 区分  |
| PersonaManager 重构影响现有角色功能   | 🟢低 | 渐进式：先并存，后删除旧代码                 |
| 身份匹配和技能匹配冲突                | 🟢低 | 身份匹配优先于技能匹配，先注入身份再注入技能 |

## 6. 不做的事

| 方向                     | 原因                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| 身份绑定到领域           | 同一领域多角色（作家/编辑/策划），绑定领域粒度太粗                 |
| 身份像技能一样每轮都匹配 | 身份切换成本高于技能，需要缓冲                                     |
| 身份有 decay/archive     | `permanence: always` 的 personality 永不衰减                       |
| 合并 Config 和 rules     | rules 是记忆（可搜索/可挂载），Config 是配置（不可搜索），本质不同 |

## 7. 排雷修正（v1.1 · 2026-06-04）

> 排雷流程：逐步骤推演 9 个实施任务 → 发现 7 个风险（2 高危、4 中危、1 低危）→ 全修正

### L1 · 规则冲突：persona 进 SQLite 违反 architecture_philosophy §1

**规则原文**："Persona（人格）和 Skill（技能）不是'普通记忆'——不进入 SQLite 索引。"

**实际状态**：当前 `MemoryLoader.loadAllToIndex()` 已经扫描 `PERSONALITY`
类型并写入 SQLite，规则已被 v4 实现部分违反。

**修正**：

1. 更新 `architecture_philosophy_rules.md` §1：persona 作为 `permanence: always`
   的 personality 记忆存入 SQLite，但在召回管线中做特殊处理
2. `bootstrap()`
   中过滤 personality 类型记忆：只取当前激活身份的 1 条 personality，其余
   `always` 级 personality 不装入 bootstrap

### L2 · permanence: always 的爆炸风险

**风险**：10 个角色 × 每人都是 `permanence: always` →
bootstrap 装入 10 条人格 → 击穿 token 预算。

**修正**：`bootstrap()` 中增加过滤——

```typescript
// 启动时：personality 类型只取当前激活的一个
const always = await this.index.getByPermanence('always');
const activePersonaMem =
  always.find(
    (m) => m.type === 'personality' && m.name === activePersonaName,
  ) ?? always.find((m) => m.type === 'personality');
const nonPersonality = always.filter((m) => m.type !== 'personality');
return [activePersonaMem, ...nonPersonality, ...domain].filter(Boolean);
```

这需要 `bootstrap()` 接收 `activePersonaName` 参数。

### L3 · P-604 删除 DomainManager 影响面低估

**修正**：实际影响 4 个文件（agent.ts、repl.ts、domain-manager.ts、domain-manager.test.ts），~40 行删除。P-604 估计更新为 ~40 行。

### L4 · 身份匹配和技能匹配的共存策略

**风险**：两个并行的关键词匹配系统可能相互干扰。

**修正**：

- 身份匹配阈值 ≥ 0.5（低于此分数不切换，保持当前身份）
- 身份匹配结果不影响技能匹配（两者独立运行）
- 身份匹配只在当前输入匹配得分 > 当前身份得分时才切换

### L5 · 缓冲机制改为时间窗口

**原设计**：同一话题内连续切换不超过 3 次（依赖隐式话题概念）。

**修正**：不依赖话题概念——

- 每切换一次记录时间戳
- 60 秒内切换超过 3 次 → 锁定当前身份
- 锁定后用户可手动解除，或 5 分钟自动恢复

### L6 · 身份注入方式

**原设计**："和技能注入同一个位置"（不够明确）。

**修正**：在 `AgentLoop` 中新增 `refreshPersona(personaPrompt)` 方法，重建
`messages[0]` 的身份部分，保留其余 system prompt 内容。调用时机：

- 自动匹配切到新身份时
- 用户手动切换身份时
- 用户切换回自动模式时

### L7 · agent-config/ 目录结构

**修正**：新增 `identities/` 目录存放身份文件（而非复用
`personality/`，避免与 MemoryLoader 扫描路径冲突）：

```
agent-config/
├── identities/           # 多身份（permanence: always）
│   ├── mo-yu.md          # 墨羽（作家）
│   └── editor.md         # 编辑
├── rules/                # 不变
└── skills/               # 不变
```

PersonaManager 改为从 `identities/` 扫描。

### 修正后实施任务（v1.1）

| ID    | 任务                                                 | 改动量     | 涉及文件                                                              | v1.1 修正                            |
| ----- | ---------------------------------------------------- | ---------- | --------------------------------------------------------------------- | ------------------------------------ |
| P-601 | PersonaManager 合并到记忆管线                        | ~80 行     | personaManager.ts, memory/loader.ts, architecture_philosophy_rules.md | L1: bootstrap 过滤非激活 personality |
| P-602 | 身份自动匹配                                         | ~40 行     | agent.ts                                                              | L4: 阈值 ≥0.5 + 独立于技能匹配       |
| P-603 | 身份注入：AgentLoop.refreshPersona()                 | ~40 行     | agent.ts, loop.ts                                                     | L6: refreshPersona 重建 messages[0]  |
| P-604 | 删除 DomainManager                                   | ~40 行删除 | agent.ts, repl.ts, domain-manager.ts, domain-manager.test.ts          | L3: 改动量修正                       |
| P-605 | Agent API: switchPersona/listPersonas/setPersonaMode | ~30 行     | agent.ts                                                              | L5: 时间窗口缓冲                     |
| P-606 | src/index.ts: 导出 PersonaMode                       | ~3 行      | index.ts                                                              | 不变                                 |
| P-607 | 测试：身份匹配 + 注入 + 缓冲                         | ~60 行     | agent.test.ts                                                         | L4+L5: 覆盖阈值 + 时间窗口           |
| P-608 | novel-writer 重构：identities/ 目录                  | ~30 行     | identities/\*\*, agentBridge.ts                                       | L7: identities/ 目录                 |
| P-609 | Web UI：身份下拉框                                   | ~60 行     | index.html, web.ts                                                    | 不变                                 |
