# 作品投影：AI 怎么"看懂"你的作品（白话设计）

> **定位**：探索期设计草稿（2026-08-25 定案方向 C），记录"作品投影（workProjection）"的设计结论。**未固化为 ADR**，待代码落地、真实场景复现稳定后再定案。
>
> **关联**：[memory-as-summary.md](memory-as-summary.md)（记忆即摘要）· [memory-role-pack-boundary.md](memory-role-pack-boundary.md)（记忆×角色包边界）· [白话设计文档.md](../白话设计文档.md)（运行机制白话版）

---

## 一、它是什么

你在项目里写了一堆文档、代码、笔记。AI 帮你干活时，会读这些文件，但"读完就忘"——下次换会话，它还得重新读、重新理解一遍：这文件是干嘛的。

**作品投影，就是一个"作品索引"**：一个指向源文件（或自带内容）的简单卡片，字段：

- **name**：作品名（默认取文件名）
- **description**：一句话说明（LLM 生成，用户可手改）
- **source**：源文件路径（**可选**，相对项目根）。有 source = 指向外部文件；**缺省 = 自指**（这份投影文件本身就是被投影的文档，正文即内容）
- **mode**：必读开关（`always` 必读 / `on-demand` 按需，默认按需）

关键是：**卡片正文即内容，source 只是"这份文档在哪"的入口**。有 source 时，AI 要理解原文，顺着 `source` 再 `read_file` 读——读到的永远是新的，不会过时；source 缺省（自指）时，这份投影文件本身就是那份"文档"，正文就是文档内容（可能是规则、说明或笔记），`always` 模式装配时自动注入。

---

## 二、为什么是"索引"而不是"浓缩摘要"

早先想过把投影做成"浓缩摘要"（summary + structure + keyDecisions）。但那个设计有个根本毛病：它是**第二份数据**——原文之外又让 LLM 生成一份浓缩，所以才会过时、才要 hash 反复重生成维护，还违反"单一真理源"。

改成"索引"后，问题直接消失：

| | 浓缩摘要（弃） | 索引（定案） |
|---|---|---|
| 内容 | summary/structure/keyDecisions | name + description + source |
| 本体 | LLM 二次生成，会过时 | 原文是唯一真理源，永不过时 |
| 防腐 | hash 反复重生成 | 不需要（描述就一句，详读走原文） |
| 可改 | 只读"死印象" | 用户直接改文本 |

---

## 三、它站哪：独立第三轨

作品投影不属于现有的两样东西，是独立的第三轨：

| 轨道 | 管什么 | 打个比方 |
|------|--------|----------|
| **角色包** | 你怎么做事（身份/规矩/技能） | "我的工作方式说明书" |
| **记忆系统** | 我们聊了什么（对话摘要） | "我们聊天的笔记" |
| **作品投影** | 你的某件作品是什么（索引） | "这个项目里有哪些作品" |

**不能进角色包**——角色包是通用规范，作品投影只针对具体文件。**不能进记忆系统**——记忆只管问答闭环，作品投影管的是磁盘上稳定存在的文档。三者各管各的，所以投影落在项目级目录 `<memoraDir>/projections/`，不参与记忆召回、不参与记忆治理。

---

## 四、定案设计（方案 C）

### 4.1 三大原则

1. **用户主动触发，LLM 生成**——不再 `read_file` 自动 fire-and-forget。用户对 AI 说"记住这个文件"（或点按钮），AI 才去总结写卡片。
2. **复用 skills 的格式，不共用其载体**——存储格式对齐 skill（markdown + frontmatter），扫描复用 `scanMarkdownDir` + `parseFrontmatter`；但逻辑入口独立，不塞进 `SkillManager`（作品≠技能）。
3. **文件即真理源，用户直接编辑**——不做专属 UI 视图，用户用 VSCode 打开作品文件直接改 `description`/正文，删文件即删索引。

### 4.2 存储格式

**每个作品一个 `.md` 文件**，存 `<memoraDir>/projections/`：

```markdown
---
name: 架构设计
description: 系统分层与模块边界的定案说明
source: docs/architecture.md
mode: on-demand
---

（正文：索引卡片的备注，或内容卡片的规则全文）
```

frontmatter 四字段：

- `name`（作品名）
- `description`（一句话；兼「按需拉取的匹配依据」——LLM 据此判断是否 `read_file` 读全文）
- `source`（**可选**，源文件相对项目根的路径，如 `docs/architecture.md`；**缺省 = 自指**，即这份投影文件本身就是被投影的文档）
- `mode`（可选，`always` 必读 / `on-demand` 按需，默认 `on-demand`）

> **注入防御**：frontmatter 字段值均经单行化处理（折叠换行为空格），防止换行注入破坏 `key: value` 结构。`name` / `description` / `source` 三个字段均执行单行化后才写入 frontmatter。

正文 body 即「内容」：`source` 指向外部时是可选备注；`source` 缺省（自指）时，正文就是这份「文档」的完整内容——这份文档写了什么（规则/说明/笔记），系统不设限，照读即可。

> **source 约定（定案）**：显式值时存**相对项目根**的路径（换机器/换路径后索引不失效，内核读取时据项目根 `resolve` 成绝对路径再交 `read_file`）；**缺省 = 自指**（`source: <自身文件名>`），即这份投影文件本身就是要投影的文档。投影因此始终是「一份文档的入口」——指向外部或指向自己之别，**不引入任何新语义类别**。

> 存储从现状的 JSON（`<slug>.json` + hash）改为 markdown frontmatter，与 skill 同构——格式复用，字段不同。

### 4.3 source 指向外部 vs 自指 + 必读开关

同一份 md 载体，`source` 只有两种姿态——指向外部文件，或缺省（= 自指指向自己）。这不是两类东西，是同一种「文档入口」的两种挂法：

| | 指向外部 | 自指（source 缺省） |
|---|---|---|
| source | 显式指向真实文件 | 缺省（= 指向这份投影文件本身） |
| 正文 | 可选手写备注 | **这份文档的完整内容** |
| 本质 | 某件作品的索引 | 一份「文档」的投影（正文即内容） |
| 典型用法 | 指向架构文档、核心模块 | 把规则/说明/笔记直接写进卡片正文 |

**装配注入 = 元数据清单常驻 + 正文按需（两级渐进披露）**：

- **L1 元数据清单（所有卡片常驻）**：装配上下文时始终注入 `projections/` 下所有卡片的 `name + description` 清单（超轻量「指针索引」），让 LLM 知道「有哪些作品、各自是什么」，据此按需取用。
- **L2 正文（按 `mode` 决定）**：`always` 卡片在清单之上额外出正文（轻量，**不含 source 外部原文**）；`on-demand`（默认）不进正文，LLM 据 `description` 判断相关性后 `read_file` 读卡片 (projections/*.md) 或源文件。

> 由此，「写规则并让它每次都被读」= **source 缺省（自指）+ 正文写规则 + `mode: always`**，无需任何 hack。注意：这只产生「一份正文恰好写了规则的文档投影」，系统**不据此新增「规则」语义类别**。

**边界（防混，为何不碰 role-pack 规则）**：投影始终是「文档」语义、角色包 rules 是「设定」语义，两者类别不同、天然不冲突——

- 角色包 rules = **结构化设定**（「你怎么做事」，manifest 注册、语义标签为 rule，跟角色走、跨项目复用）
- 作品投影 = **文档入口**（「这份文档是什么」，source 指向外部或自指，跟项目走）

正文里恰好写了规则，不改变「它是文档投影」这个事实，因此**不违反 role-pack boundary 的 R1「规则一律进角色包」**——因为这里没有任何「规则」被系统识别，只有一份文档被投影。

> **依据（网络为土壤，2026-08-25 检索）**：L1 元数据清单常驻 = Claude Code「MEMORY.md 三层指针索引（stores pointers, not data）」+ Cursor「Apply Intelligently（description 驱动按需拉取）」；description 作为 gatekeeper 见 agent-sh 研究（skills 渐进披露中 description 是最重要的激活门槛）。

### 4.4 登记入口（方案 C 定案）

**内核全留，宿主分两步走**：

- **内核**：提供 `register_work` 工具（LLM 在对话里能调，写一个 md 文件）。
- **宿主第一版**：只提供"打开作品文件（VSCode 内置编辑器）"的入口，登记先靠对话里对 AI 说。
- **宿主后续**：视图跑顺了再补右键"登记为作品"按钮。

> **slug 冲突行为**：不同路径但同文件名时，slug 相同会后写覆盖先写（最后登记的生效）。这是有意为之——用户多次登记同名文件时，以最新一次为准。

---

## 五、内核要改的

1. **存储格式改 md**：`WorkProjectionEntry` 改瘦为 `{ name, description, source?, mode? }`（去 `id`/`summary`/`structure`/`keyDecisions`/`fileHash`/`updatedAt`——id 由文件名推导，无需 hash）。`source` 可选（缺省 = 自指该份投影文件本身），`mode` 默认 `on-demand`。

2. **斩断自动链**：删 [builtinToolHandlers.ts:210-214](file:///f:/zooique/memora/src/agent/builtinToolHandlers.ts#L210-L214) 里 `read_file` 自动触发生成的逻辑。

3. **读复用扫描、写复用写文件**：
   - 读 = `scanMarkdownDir(projectionsDir)`（复用 [scanner.ts](file:///f:/zooique/memora/src/utils/scanner.ts)），`listWorks` 即扫描结果。
   - 写 = `register_work` 工具拼 frontmatter + 写 `.md` 文件。
   - **不需要** `updateWorks`/`removeWorks` API——用户直接改文件/删文件。

4. **新工具 `register_work`**：复用 [read_skill](file:///f:/zooique/memora/src/agent/toolExecutor.ts#L674-L686) 的注入回调模式——`toolExecutor` 定义 `registerWork` 回调，`assembler` 注入 manager 实现。参数 `path` + `description`（LLM 总结的一句话），内核负责写 `projections/<slug>.md`（索引卡片，带 source）。自指卡片（source 缺省）第一版靠用户手写文件 + VSCode 编辑，不进工具参数。

5. **装配注入（两级渐进披露）**：assembler 装配上下文时，① 先注入所有卡片的 `name + description` 清单（L1 元数据常驻，超轻量，让 LLM 知道有哪些作品）；② 再对 `mode: always` 的卡片额外出正文（L2，轻量；不把 source 指向的外部原文灌进来）；③ `on-demand` 卡片仅进 L1 清单，靠 `read_file` 按需读全文。与 skills 的二级渐进披露同构。

> **缓存失效时机**：`contextBlock()` 同步读取内存缓存。缓存刷新触发点 = ① `register_work` 登记后自动刷新；② 装配初始化时主动刷新；③ 角色切换时刷新。用户外部直接编辑/删除 md 文件后，需等到下次刷新才生效——当前设计依赖显式刷新，后续可考虑 `fs.watch` 文件监听自动刷新。

---

## 六、宿主要改的

1. **打开作品文件**：提供一个入口（命令/菜单），用 VSCode 内置编辑器打开 `projections/` 下的作品卡片，用户直接编辑 `name`/`description`/正文。

2. **可选：列出作品列表**：扫描 `projections/` 目录列个清单，点一项跳到对应 md 文件或源文件。

3. **登记入口**：第一版靠对话，右键按钮后续补。

> 不做专属"作品视图 + 编辑表单"——VSCode 编辑器就是现成的 UI。

---

## 七、一句话总判

> **作品投影 = 用户主动触发的"作品索引"（markdown + frontmatter：name + description + 可选 source 路径 + mode 必读开关），不是 LLM 二次生成的浓缩摘要。source 显式 = 指向外部文件，缺省 = 自指（正文即文档内容）；投影始终是「一份文档的入口」，不引入规则/设定等新语义类别。装配两级渐进披露：L1 所有卡片 name+description 清单常驻（指针索引），L2 always 卡片额外出正文、on-demand 靠 description 按需 read。原文是唯一真理源，卡片只是入口。独立第三轨：不进角色包、不进记忆系统，落项目级目录。存储格式对齐 skill（可复用扫描 + 直接文本编辑），但保留独立载体。用户用 VSCode 直接编辑，无需专属 UI 视图。内核提供 `register_work` 工具，斩断 read_file 自动链。**
