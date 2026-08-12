# 角色包标准（RolePack Spec）

> **定位宣言**：角色包是一份**可共享的装载卡**——自包含的 Agent 行为单元（文件夹包，最小形态为单文件），任何 Agent 实现都能装载。
> **范式主张**：Agent = 最小闭环 + 装载卡。专业性来自装载的角色包，不来自代码分支；换装 = 换 Agent。
> **memora 与本标准的关系**：memora 是**首个实现（reference implementation）**，本规范**不绑定 memora**。其他 Agent 实现本规范后即可装载生态中的角色包。
> **类比**：USB-C（接口标准）/ Docker 镜像（可移植容器）/ HTML（浏览器兼容的文档标准）。

---

## 一、核心原则（4 条）

1. **中立性**：角色包是文件夹包（最小形态单文件）、自包含、不依赖任何 Agent 实现的文本契约；
2. **渐进兼容**：认识的生效，不认识的安全跳过——任何实现至少能装载 L1；
3. **自描述**：文件自带 schema 版本（`formatVersion`），跨实现一致性靠版本 + 校验；
4. **能力声明**：工具按"能力"（capability）声明，由各实现映射到自有工具，不绑具体实现。

---

## 二、文件格式（文件夹包：单文件为最小形态，文件夹为完整形态）

**格式决策（2026-08-12 定案，2026-08-12 行业校准）**：角色包采用 **文件夹包（bundle）** 形态，对齐 skills 生态（`SKILL.md` + `references/` + `scripts/` + `assets/`）——因为**角色包是 skills 的超集（见 §2.1），必须继承其分发形态**。单文件保留为**最小形态**（无资源时的极简卡），完整能力以文件夹承载。

> **行业同构验证（2026-08-06）**：OpenAI / AWS / Microsoft / Vercel / Cursor 五方 + Google 发布的 **Agent Plugins 1.0.0**（文件夹=插件：`plugin.json` + `skills/` + `mcp.json` + 反域名扩展目录）与本节文件夹包骨架**独立收敛于同一设计**，证明本格式处于设计空间的收敛点。本规范在三点与其校准：① 文件夹形态 `manifest.json` **必填**（§2.2/§2.4）；② 预留 `mcp.json` 桥作 L2 可选，`capabilities` 仍为 L1 中立层（§四）；③ 未知键「**警告并忽略**」而非静默（§三/§五）。

### 2.1 角色包 vs Skills（代际关系）

| | Skills（现状生态） | 角色包（未来范式） |
|---|---|---|
| 本质 | **能力单元**——会做什么 | **完整行为单元**——以什么身份、用什么能力、受什么约束、怎么行事 |
| 内容 | 步骤/脚本/参考 | persona + rules + skills + strategy（**有身份的能力包**） |
| 关系 | — | **角色包内嵌/聚合 skills**，是 skills 的容器与超集 |

**范式主张**：分享一个 skill，别人获得一个能力；分享一个角色包，别人获得一个"有性格的 Agent 行为单元"。**角色包代替 skills** = 能力分发升级为行为分发。

### 2.2 文件夹包结构（完整形态）

```
我的角色包/                        ← 文件夹，zip 压缩分发
├── role-pack.md                  # ★核心定义：strategy + skills 声明 + persona/rules 正文（对齐 SKILL.md 的角色；文件夹形态下不含元数据字段）
├── skills/                       # 内嵌标准 skills 包（每个一个子文件夹，SKILL.md 声明 capability 标签，与 §四 声明按 capability 去重合并）
│   ├── write-file/
│   │   ├── SKILL.md
│   │   └── scripts/...
│   └── web-search/
│       └── SKILL.md
├── references/                   # 知识引用（对齐 skills 的 references/）
├── assets/                       # 资源（模板、图片、示例）
├── scripts/                      # L3 代码钩子（远期，沙箱隔离后启用）
├── manifest.json                 # ★文件夹形态必填且为唯一权威：name / formatVersion / 合规字段 / 分发元数据（§2.4 单一真理源）
└── com.memora/（可选）            # 反域名命名空间：memora 专有行为层（对齐 Agent Plugins 扩展惯例，其他实现忽略，§十）
```

### 2.3 最小形态（单文件）

无资源、无内嵌 skills 时，`role-pack.md` **单独即是一个最小角色包**（可零依赖装载 L1）：

```markdown
---
name: 小说写作
formatVersion: 1.0.0
description: 短篇小说与文案写作助手
keywords: [写作, 小说, 故事]
trigger: [写作, 写一篇, 写个故事]
author: memora
version: 1.0.0
# interactionType: tool_assistant（缺省即工具型，§七 分档校验）
strategy:
  prepare:
    contextAssembly: hybrid
    recentRounds: 5
    memoryRecall: full
  act:
    toolMode: allow
    temperature: 0.8
  reflect:
    summary: on
    handoff: wait
  global:
    askOn: [ambiguity, decision, missing_info]
    askLimit: 3
skills:
  - capability: file:write
    description: 把成稿写入本地文件
  - capability: file:read
    description: 读回文件自审
  - capability: web:search
    description: 写作查资料
---
## Persona

你是一位擅长短篇小说与文案的写作助手，先与用户讨论思路，成稿时结构完整、有细节、结尾留余味。

## Rules

- 不写真实姓名、联系方式等敏感信息
- 结尾留白，不把反转写死
```

### 2.4 渐进升级规则

- **单文件 → 文件夹**：角色包需要**内嵌 skills 包**（§四 绑定规则，单文件不可内嵌）或 `references/`/`assets/` 等资源目录时，升级为文件夹包——**装载行为不变**（都以 role-pack.md 为入口）；仅有 capabilities 声明、无内嵌资源的角色包保持单文件形态即可（L1 能力靠实现映射，不强制升级）；
- **manifest 双形态（单一真理源）**：单文件形态下 **frontmatter 即 manifest**（元数据字段都在 frontmatter，§2.3 即示范）；升级为文件夹后，**`manifest.json` 成为唯一权威**——元数据字段（`name` / `formatVersion` / `version` / `description` / `author` / 合规字段等）整体迁入 `manifest.json`，**文件夹形态下 role-pack.md 的 frontmatter 只允许 `strategy` + `skills` 两个键**，其余元数据键出现即被校验器拒绝（见 §八）；文件夹形态下 `manifest.json` **必填**，缺失即拒绝加载；
- **迁移即搬移，无合并歧义**：单文件 → 文件夹时，frontmatter 元数据段整体复制进 `manifest.json`，`strategy`/`skills` 保留在 role-pack.md；两个形态各自只有一份权威，同字段永不双写；
- **manifest 字段集（对齐 Agent Plugins plugin.json）**：`name`（必填）/ `formatVersion`（必填）/ `version` / `description` / `author` / `homepage` / `repository` / `license` / `keywords` / `interactionType` / `aiIdentityDisclosure` / `minorProtection`（合规字段为可选 + 分档，仅 `companion` 强校验，§七）/ `extensions`（反域名命名空间对象）；
- **加载规则**：装载器先找 `role-pack.md`（文件夹）或 `<名>.md`（单文件）；`skills/` 内嵌包按 skills 生态标准加载（复用现有解析器）；
- **内嵌 skills 上限（行业实测校准）**：渐进式披露下，内嵌 skills 包建议 **≤10 个**（超出降级为引用已注册技能，避免 30+ skills 的启动税非线性恶化）；单个内嵌 SKILL.md 建议 **≤500 行**，详述放 `references/`；
- 分发：文件夹 zip 压缩（对齐 skills 市场分发方式）。

**格式厚度的来源（三层，不在文件后缀）**：

1. **schema**：role-pack.md frontmatter 每个键的类型/取值/必填有规范定义（见 §六）→ 校验器可机检；
2. **嵌套 YAML 取代点路径平铺**：`strategy.prepare.contextAssembly` 在文件内是嵌套对象——无路径拼写问题，终结旧键名的 snake/camel 分裂；规范引用用点路径，与文件内嵌套等价映射；
3. **文件夹承载扩展**：skills 内嵌 / references / assets / scripts（L3）——**单文件不装下的，文件夹装**，格式不推翻、只升级。

---

## 三、三层结构

```
角色包（文件夹包 / 单文件最小形态）
├── role-pack.md（★核心定义 = 三层结构载体）
│   ├── frontmatter（YAML 结构化内核）
│   │   ├── 元数据：name / formatVersion / keywords / trigger / version ...（仅单文件形态；文件夹形态下迁入 manifest.json，§2.4）
│   │   ├── strategy：L2 行为策略（嵌套对象，见 §六）
│   │   └── skills：能力声明数组（capability + description，见 §四）
│   ├── L1 内容层（★必读 = 最小兼容面）
│   │   ├── ## Persona  → 身份与视角（装载为 system prompt）
│   │   └── ## Rules    → 边界与安全约束
│   ├── L2 策略层（可选，键级渐进）→ frontmatter.strategy
│   └── L3 代码层（扩展，远期：自定义钩子，沙箱隔离后启用）
├── skills/       # 内嵌标准 skills 包（完全兼容 skills 生态结构）
├── references/   # 知识引用
├── assets/       # 资源（模板、图片）
└── scripts/      # L3 代码钩子（远期）
```

### L1：最小兼容面（任何实现必须能装载）

| 章节 | 语义 | 装载行为 |
|------|------|---------|
| `## Persona` | 身份与视角 | 作为 system prompt 注入 |
| `## Rules` | 边界与安全契约 | 作为安全约束生效（实现可对接自身护栏） |
| `frontmatter.skills` | 能力清单 | 按 `capability` 映射到实现可用工具 |

L1 是纯文本契约——**即使实现不认识 L2/L3，也能完整装载 L1**（persona/rules 是正文 Markdown；skills 是 frontmatter 结构化数组，机器可读），这就是"插上就能用"。

### L2：行为策略层（键级渐进）

- 枚举式行为开关，角色只"选择"不"定义"；
- **已知键生效，未知键警告并忽略（warn + ignore，不阻塞装载）**——杜绝拼写错误被静默吞掉（对齐 Agent Plugins「reported and ignored」，见 §五）。

### L3：代码层（远期）

- 自定义钩子；必须沙箱隔离防恶意代码；**当前不设计、不启用**。

---

## 四、能力声明（skills → capabilities）

`frontmatter.skills` 以**结构化数组**声明角色包需要的能力，使用**中立能力命名空间**，不绑具体实现：

```yaml
skills:
  - capability: file:write      # 写文件
    description: 把成稿写入本地文件
  - capability: file:read       # 读文件
    description: 读回文件自审
  - capability: web:search      # 网络搜索
    description: 写作查资料
  - capability: llm:summarize   # 摘要（实现内部能力）
```

- **实现映射**：memora 把 `file:write` 映射到内置 `writeFile` 工具；其他实现映射到自有工具；
- **未知能力**：装载方跳过该能力（可选提示"能力不可用"），不阻塞；
- 命名空间采用 `域:动作`（`file:` / `web:` / `llm:` / `tool:`），扩展由社区协商，先保持最小集；
- `capability` 为必填、`description` 可选（供 LLM 与校验器理解）。

**capabilities 与内嵌 skills 的绑定（单向）**：`skills/` 内嵌的每个 SKILL.md 必须在其 frontmatter 声明 `capability` 标签（如 `capability: web:search`），装载时**按 capability 去重合并**——同一能力声明与内嵌包并存时，以内嵌包为准（具体实现优先于抽象声明）；**单文件最小形态只能有 `capabilities` 声明、不能内嵌 skill**（内嵌是文件夹形态专属能力）；capabilities 未匹配到任何内嵌包时，按实现映射到自有工具（原规则不变）。

**具体连接桥（L2 可选，`mcp.json`）**：capabilities 是**抽象能力声明**（要什么能力、实现无关）；当角色包需要**开箱即用**的具象连接时，可在文件夹根放 `mcp.json`（对齐 Agent Plugins 1.0 的 transport 声明：`stdio` / `streamable-http` / `http+sse`），由实现映射到自有运行时。两者不冲突：**capabilities 是 L1 中立契约，mcp.json 是 L2 可选实现加速**——不声明 mcp.json 的角色包仍可被任何实现按 capabilities 装载。

---

## 五、兼容契约（其他 Agent 如何装载）

| 装载方认识程度 | 行为 |
|---------------|------|
| L1（必读） | persona → system prompt；rules → 约束；skills → 能力清单 |
| L2 已知键 | 对应行为开关生效 |
| L2 未知键 | **警告并忽略（warn + ignore），不阻塞装载**（杜绝拼写错误静默吞掉） |
| 未知能力 | 跳过（可选提示） |
| `formatVersion` 不兼容 | 拒绝加载 + 提示按迁移规则升级（见下） |
| `minKernelVersion` 高于实现版本 | 拒绝加载（或警告降级运行，由实现决定） |
| 元数据双写（文件夹形态下 role-pack.md frontmatter 含 `name` 等元数据键） | **拒绝加载** + 提示"元数据权威在 manifest.json"（校验器检查，§八） |

**formatVersion 迁移规则（对齐 Agent Plugins「schema URL 永不重指」）**：

- 每个 `formatVersion` 绑定一个**固定 schema URL**（如 `https://role-pack.dev/schemas/1.0.0/role-pack.schema.json`），发布后**永不改变内容**——同一版本号不可能指向两份不同规范；
- **minor 演进（1.0 → 1.1）**：仅新增 L2 键/可选字段——旧实现按「未知键警告并忽略」装载，新实现全量生效，**无需迁移**；
- **major 演进（1.0 → 2.0）**：键名/语义变更或 L1 结构变化——提供**迁移器**（读旧版 → 写新版），装载器对旧 major 拒绝加载并提示迁移；
- 校验器同时支持「声明格式版本校验」与「可迁移性检查」。

---

## 六、L2 策略键集（中立命名，v1 最小集）

> 文件内为**嵌套 YAML**（`strategy: { prepare: { ... }, act: { ... } }`），规范引用用**点路径**（`strategy.prepare.contextAssembly`）——两者等价映射，见 §二 样例。键名统一 **camelCase**；此表是 v1 最小集，后续版本演进由 `formatVersion` 控制。

| 组 | 键 | 取值（枚举） | 含义 |
|----|----|------------|------|
| prepare | `prepare.contextAssembly` | `fixed` / `query` / `hybrid` | 最近轮次加载策略 |
| prepare | `prepare.recentRounds` | 正整数 | 固定加载轮数 |
| prepare | `prepare.memoryRecall` | `full` / `limited` / `none` | 长期记忆召回 |
| prepare | `prepare.summaryRecall` | `on` / `off` | 摘要召回 |
| act | `act.toolMode` | `allow` / `block` | 是否允许工具调用 |
| act | `act.temperature` | 0.0~2.0 | 生成随机性 |
| act | `act.streaming` | `streaming` / `non-streaming` | 输出方式 |
| reflect | `reflect.summary` | `on` / `off` | 摘要生成 |
| reflect | `reflect.insightExtraction` | `on` / `off` | 洞察提炼 |
| reflect | `reflect.handoff` | `wait` / `loop` / `end` | 衔接决策 |
| global | `global.askOn` | `ambiguity` / `decision` / `missing_info` / `confirm` | Agent 主动提问触发（可组合） |
| global | `global.askLimit` | 正整数（默认 3） | 每任务提问上限 |
| global | `global.errorHandling` | `retry` / `degrade` / `stop` | 异常策略 |

---

## 七、合规与安全（中国 AI 拟人化新规对齐，2026-07-15 施行）

**背景**：《人工智能拟人化互动服务管理暂行办法》（2026-07-15 施行）划定"拟人化互动服务"红线；**豁免条款**明确"智能客服、知识问答、工作助手、学习教育、科学研究等不涉及持续性情感互动的服务不适用"。角色包范式定位**生产力 Agent（工作助手）**，落在豁免区间；但合规必须内建为标准属性，而非事后补丁。

**标准级合规设计（角色包自带）**：

1. **AI 身份标注**：`manifest`/frontmatter 声明 `aiIdentityDisclosure`（`true` 默认值）——**标准级仅要求字段可声明**；**实现级强制生效**：memora 作为 reference implementation 必须向用户明确标注 AI 身份（新规红线之一），并对缺失该字段的 `companion` 角色包拒绝加载；
2. **rule 段 = 内容红线载体**：`## Rules` 承载内容安全约束（不生成违法/低俗/侵权内容、不涉真实个人隐私、不诱导沉迷），随角色包装载即生效——**让"平台审核责任"落到结构化可校验的规则上**；
3. **拟人化场景声明**：frontmatter/manifest 增加 `interactionType: tool_assistant | companion`（默认 `tool_assistant`）——声明本角色包是**工具型工作助手**（豁免区间）还是**拟人化陪伴**（落入《办法》管辖，需单独合规路径 + 物理隔离）。**分档校验**：标准级**可选**（缺省即 `tool_assistant`）；**仅当显式声明 `companion` 时**，校验器执行完整合规检查（虚拟亲密关系红线拒绝、强制 `aiIdentityDisclosure`、`minorProtection` 必填）；memora 实现级对未声明且缺失合规字段的装载默认放行但提示补全；
4. **未成年人保护钩子**：`manifest` 声明 `minorProtection: required`（默认）——实现必须提供监护人管控入口（对应新规未成年人模式要求）；
5. **禁止面向未成年人的虚拟亲密关系**：校验器拒绝 `companion` 类角色包携带"虚拟亲属/虚拟伴侣"特征（红线）。

**范式方向约束（最重要的一条）**：角色包生态的立身之本是**生产力**（工作助手、知识问答、工具执行）——**不做情感陪伴、不做虚拟恋人**。豆包/千问 2026-07 下线的是无工具、无决策、不可控的 UGC 陪聊 Bot；千问保留并加码的正是"协议化、工具化、能落地"的工具型 Agent——角色包标准站在这条政策允许且鼓励的赛道上。

---

## 八、校验（跨实现一致性）

- 提供**格式校验器**（独立于任何实现）：校验必填字段、章节存在、键名合法性、版本语义、**合规字段（§七，分档：仅 `companion` 角色包全量强校验，`tool_assistant` 默认值兜底）**；文件夹形态下额外检查 role-pack.md frontmatter 键集（仅允许 `strategy`/`skills`，§2.4 单一真理源）；
- **双文件校验职责**（文件夹形态）：`manifest.json` 元数据层（必填字段 / 版本语义 / 合规分档）与 `role-pack.md` 内容层（章节 / strategy / skills / 红线）由校验器分开校验，`companion` 合规状态跨文件注入（§七 第 5 条红线闭环）——调用链与关键节点见配套时序图 [role-pack-validation-flow.html](role-pack-validation-flow.html)（补充图表，明暗双主题）；
- 校验通过 = 任何实现可装载；校验失败 = 实现拒绝加载并给出原因；
- 目标是生态内角色包**一次编写，处处装载**。

---

## 九、与 memora 的关系

| 项 | 说明 |
|----|------|
| memora | **reference implementation**（首个实现本标准的 Agent 内核）；**合规从严执行**：标准级合规字段为可选 + 分档（§七），memora 实现级强制 AI 身份标注等合规义务 |
| `role-packs/`（memora 仓库） | 示例角色包（翻译助手 / 技术文档工程师 / 项目总监） |
| [README.md §9](README.md) | memora 视角的角色包体系（装载、匹配、粘性、冲突裁决） |
| [mvp-scope.md §二](mvp-scope.md) | MVP 落地范围 = 本标准的 L1 + 核心 L2 键子集 |

> 标准优先于实现：memora 内部键名（如旧 `strategy.act.tool_calls`）逐步对齐本规范的中立命名；规范演进以 `formatVersion` 控制，不破坏已装载的卡。

---

## 十、与行业标准的关系（Agent Skills / Agent Plugins）

| 标准 | 定位 | 与角色包的关系 |
|---|---|---|
| Agent Skills（Anthropic 2025-12） | 能力单元（SKILL.md + scripts/references/assets，渐进披露） | 角色包**内嵌兼容**：`skills/` 即 Agent Skills 格式；L1/L2/L3 渐进披露同构（§2.4） |
| Agent Plugins 1.0（2026-08-06，五方+Google） | 能力+工具连接的文件夹包（plugin.json + skills/ + mcp.json + 反域名扩展） | **骨架同构**（§二）：文件夹 + manifest + skills/ + 命名空间扩展；角色包在其上增加**行为层**（persona/rules/strategy）——行业可移植层目前**不含身份/行为**，这正是角色包的差异化空白 |
| memora | 角色包的 reference implementation | 见 §九 |

**竞争姿态（范式立场）**：不与 Agent Plugins 竞争「能力分发」，而是补齐其明确留白——**行为分发**（有身份的 Agent 行为单元）。Agent Plugins 把 persona 留给 client-specific 扩展（如 VS Code `agents/` 目录）；角色包把 persona/rules/strategy 做成**可移植核心（L1）**。反域名命名空间目录（`com.memora/`，§2.2）保证两者共存：**标准核心对齐行业，专有行为层进命名空间**——不绑死任何一家，也不放弃差异化。
