# 角色包标准（RolePack Spec）

> **定位宣言**：角色包是一份**可共享的装载卡**——自包含的 Agent 行为单元（文件夹包，`manifest.json` 为核心控制文件），任何 Agent 实现都能装载。
> **范式主张**：Agent = 最小闭环 + 装载卡。专业性来自装载的角色包，不来自代码分支；换装 = 换 Agent。
> **memora 与本标准的关系**：memora 是**首个实现（reference implementation）**，本规范**不绑定 memora**。其他 Agent 实现本规范后即可装载生态中的角色包。
> **类比**：USB-C（接口标准）/ Docker 镜像（可移植容器）/ HTML（浏览器兼容的文档标准）。
>
> **演进状态（2026-08-13）**：角色包标准当前处于**草案演进期**。memora 优先打磨内核基础（问答闭环 + 记忆系统），其运行不依赖角色包键；**角色包字段 v1 冻结延后至基础接口定型后**——避免标准字段随基础演进反复横跳。本章节中依赖未冻结基础或尚无参考实现消费的键一律以 `[草案]` 标注（§六状态列），不承诺跨实现一致行为。硬通货要素（签名 / 依赖声明 / 目录）作为远期演进方向随 v1 冻结一并规划，当前不设计。

---

## 一、核心原则（4 条）

1. **中立性**：角色包是文件夹包、自包含、不依赖任何 Agent 实现的文本契约；
2. **渐进兼容**：认识的生效，不认识的安全跳过——任何实现至少能装载 L1；
3. **自描述**：文件自带 schema 版本（`formatVersion`），跨实现一致性靠版本 + 校验；
4. **能力声明**：工具按"能力"（capability）声明，由各实现映射到自有工具，不绑具体实现。

---

## 二、文件格式（文件夹包：manifest.json 唯一核心控制文件）

**格式决策（2026-08-14 收敛）**：角色包统一为**文件夹包（bundle）** 形态——系统此前未启用角色包（无存量包），故**不保留单文件 .md / role-pack.md 旧格式**。每个角色包 = 一个文件夹，`manifest.json` 是**唯一核心控制文件**（元数据 + L2 策略 + 内容路径注册 + skills 注册），内容文件（persona.md / rules.md / skills/*）作为独立文档由 manifest 按路径注册装载。

> **设计要点（内容文件独立性）**：persona / rules / skills 是独立 Markdown 文档，用户既可**独立移植**这些文档到其他项目，也可**整体装载**角色包。manifest 只做路径注册，不内嵌正文——元数据/策略单一真理源在 manifest，正文单一真理源在内容文件，二者不双写。

### 2.1 角色包 vs Skills（代际关系）

| | Skills（现状生态） | 角色包（未来范式） |
|---|---|---|
| 本质 | **能力单元**——会做什么 | **完整行为单元**——以什么身份、用什么能力、受什么约束、怎么行事 |
| 内容 | 步骤/脚本/参考 | persona + rules + skills + strategy（**有身份的能力包**） |
| 关系 | — | **角色包内嵌/聚合 skills**，是 skills 的容器与超集 |

**范式主张**：分享一个 skill，别人获得一个能力；分享一个角色包，别人获得一个"有性格的 Agent 行为单元"。**角色包代替 skills** = 能力分发升级为行为分发。

### 2.2 文件夹包结构（唯一形态）

```
我的角色包/                        ← 文件夹，zip 压缩分发
├── manifest.json                 # ★核心控制文件（唯一权威）：元数据 + strategy + 内容路径注册 + skills 注册
├── persona.md                    # 可选：身份设定（允许缺省，§2.3）
├── rules.md                      # 可选：确定性规则
├── skills/                       # 可选：内嵌技能（每个一文件，manifest.skills 注册）
│   ├── write.md
│   └── search.md
├── references/                   # 可选：知识引用
├── assets/                       # 可选：资源（模板、图片、示例）
└── com.memora/（可选）            # 反域名命名空间：memora 专有行为层（对齐 Agent Plugins 扩展惯例，其他实现忽略）
```

**manifest.json 示例**（元数据 + 策略 + 内容路径 + 技能注册，全部单一权威）：

```json
{
  "name": "技术文档工程师",
  "formatVersion": "1.0.0",
  "description": "技术文档写作助手",
  "keywords": ["文档", "API"],
  "author": "memora",
  "interactionType": "tool_assistant",
  "strategy": {
    "prepare": { "contextAssembly": "fixed", "recentRounds": 5 },
    "act": { "toolMode": "allow", "temperature": 0.6 },
    "reflect": { "handoff": "wait" }
  },
  "persona": "persona.md",
  "rules": "rules.md",
  "skills": [
    { "file": "skills/write.md", "name": "write" },
    { "file": "skills/search.md", "name": "search" }
  ],
  "capabilities": [
    { "capability": "file:write", "description": "写入文件" },
    { "capability": "web:search", "description": "联网搜索" }
  ]
}
```

### 2.3 内容文件独立性与 persona 缺省

- **persona.md / rules.md / skills/* 是独立 Markdown 文档**，由 manifest 按路径注册装载。用户可**独立移植**这些文档，也可**整体装载**角色包；
- **persona.md 为约定文件名（2026-08-18 简化，与 rules.md 对称）**：身份设定**约定俗成为 `persona.md`**——manifest 未声明 `persona` 字段时装载器回退约定名；声明路径仅为向后兼容的自由命名；
- **rules.md 为约定文件名（2026-08-18 简化）**：rules 规则文件**约定俗成为 `rules.md`**——manifest 未声明 `rules` 字段时装载器回退约定名；声明路径仅为向后兼容的自由命名。消除「路径写错静默丢规则」错误面；
- **persona 允许缺省**：省略 `persona` 字段（或指向文件不存在）时，角色包无身份设定，仅靠策略驱动行为；
- 内容文件**不含 frontmatter**——元数据/策略单一真理源在 manifest.json，正文单一真理源在内容文件，二者不双写。

### 2.4 单一真理源与字段集

- **manifest.json 是唯一的权威（SSOT）**：元数据 + L2 策略 + 内容路径注册 + skills 注册全部在此，无第二份权威，同字段永不双写；
- **manifest 字段集**：`name`（必填）/ `displayName`（可选，UI 展示名，缺省回退 `name`）/ `formatVersion`（必填）/ `version` / `description` / `author` / `homepage` / `repository` / `license` / `keywords` / `trigger` / `exclusiveWith`（互斥声明，§13 粘性匹配）/ `interactionType` / `aiIdentityDisclosure` / `minorProtection`（合规字段为可选 + 分档，仅 `companion` 强校验，§七）/ `strategy`（L2 策略，§六）/ `handoffPrompt`（接手衔接提示词，自洽声明，§2.5）/ `persona`、`rules`（内容文件路径，可选；均缺省回退约定名 `persona.md`/`rules.md`，§2.3）/ `skills`（技能注册对象数组，§四）/ `capabilities`（能力声明顶层数组，§四 C2）；
- **skills 字段集**：`file`（必填，技能文件路径或已注册技能名，生态指针）+ `name`（可选）/ `description`（可选）；能力声明请放顶层 `capabilities`（C2）；
- **capabilities 字段集**：`capability`（必填，中立能力名 `域:动作`，§四）+ `description`（可选）；声明角色可调用的中立能力（工具白名单面）；
- **加载规则**：装载器扫描 `role-packs/<名>/` 文件夹，读取 `manifest.json`，按路径装载 persona.md / rules.md **正文**（`rules` 未声明时回退约定名 `rules.md`）；skills 转译为注册形状 + 派生态指针（正文经 read_skill 按需装载，§四 渐进披露）；无 `manifest.json` 的文件夹不计入角色包，`manifest.json` 非法 JSON 时跳过该包；
- **内嵌 skills 上限（行业实测校准）**：渐进式披露下，内嵌 skills 建议 **≤10 个**；单个内嵌技能文件建议 **≤500 行**，详述放 `references/`；
- **分发**：文件夹 zip 压缩（对齐 skills 市场分发方式）。

### 2.5 接手衔接提示词（handoffPrompt，角色包自洽声明）

**定位**：`handoffPrompt` 是该角色包**被宿主带入对话（激活 + 聚焦）时**预填输入框的特色衔接话术——作者为「这个角色接手任务时怎么说」定制的提示词。缺省由宿主回退通用话术。

**设计边界（2026-08-17 定案）**：角色包是**独立自洽**的装载卡（§11 插卡解耦）——**只描述自己，不引用其他角色包**。跨包移交（A→B 交接链）属宿主层工作流编排（§十一 A2A 预留：依赖声明由宿主解析，远期非承诺），**不进角色包格式**；角色包之间的切换由用户主动通过宿主「带入对话」原语完成。

```jsonc
{
  "name": "写作助手",
  "handoffPrompt": "我已准备好开始写作任务，请告诉我主题与要求；若承接上文，请先概述当前进度。"
}
```

**消费方**：宿主（如 memora-vscode 在 `roles_handoff` 处理中读取 `listMeta().handoffPrompt` 预填输入框，缺省回退通用话术）；内核仅透传 + 校验（非字符串 warning 不阻塞装载，§五 键级渐进）。

**格式厚度**：schema 定义（类型/校验）+ 自描述语义，不引入结构嵌套——单字符串字段，复杂度匹配问题。

**格式厚度的来源（三层，不在文件后缀）**：

1. **schema**：manifest.json 每个键的类型/取值/必填有规范定义（见 §六）→ 校验器可机检；
2. **嵌套对象取代点路径平铺**：`strategy.prepare.contextAssembly` 在 manifest 内是嵌套对象——无路径拼写问题，终结旧键名的 snake/camel 分裂；规范引用用点路径，与文件内嵌套等价映射；
3. **文件夹承载扩展**：skills 内嵌 / references / assets / scripts（L3）——格式不推翻、只升级。

---

## 三、三层结构

```
角色包（文件夹包）
├── manifest.json（★核心控制文件 = 元数据 + L2 策略 + 内容路径注册 + skills 注册）
│   ├── 元数据：name / displayName / formatVersion / keywords / trigger / version / 合规字段 ...
│   ├── strategy：L2 行为策略（嵌套对象，见 §六）
│   └── skills：技能注册对象数组（file / name / description，§四）
│   └── capabilities：能力声明顶层数组（capability / description，§四 C2）
├── persona.md（L1 内容层：身份与视角，可选，§2.3）
├── rules.md（L1 内容层：边界与安全约束，可选）
├── skills/       # 内嵌技能文件（manifest.skills 注册，兼容 skills 生态结构）
├── references/   # 知识引用
├── assets/       # 资源（模板、图片）
└── scripts/      # L3 代码钩子（远期）
```

### L1：最小兼容面（任何实现必须能装载）

| 字段/文件 | 语义 | 装载行为 |
|------|------|---------|
| `persona.md` | 身份与视角 | 作为 system prompt 注入（允许缺省） |
| `rules.md` | 边界与安全契约 | 作为安全约束生效（实现可对接自身护栏） |
| `manifest.capabilities` | 能力清单 | 按 `capability` 映射到实现可用工具（工具白名单） |
| `manifest.skills[].file` | 技能文件 | 渐进披露 L2 按需装载（read_skill） |

L1 是纯文本契约——**即使实现不认识 L2/L3，也能完整装载 L1**（persona/rules 是独立 Markdown 正文；skills 是 manifest 结构化注册，机器可读），这就是"插上就能用"。

### L2：行为策略层（键级渐进）

- 枚举式行为开关，角色只"选择"不"定义"；
- **已知键生效，未知键警告并忽略（warn + ignore，不阻塞装载）**——杜绝拼写错误被静默吞掉（对齐 Agent Plugins「reported and ignored」，见 §五）。

> **边界声明（2026-08-13）**：L2 枚举是**行为参数**层——角色在此只能"选择"预定义开关，不能"定义"逻辑，这保证可安全传播。**它不承诺"思维过程"的差异化**：真正决定角色专业性的，是 L1 内容层（persona/rules 知识）与远期 L3 代码层（自定义能力）。角色包的价值分层 = **L1 专业性 / L2 行为偏好 / L3（远期）能力扩展**。"角色包代替 skills"（§2.1）兑现的是"内容分发 + 行为分发"，"思维过程分发"依赖 L1/L3，非 L2 枚举职责。

### L3：代码层（远期）

- 自定义钩子；必须沙箱隔离防恶意代码；**当前不设计、不启用**。

---

## 四、能力声明（capabilities 独立模块 + skills 技能注册）

**C2 定案（2026-08-18）**：能力面与内容面分离——`manifest.capabilities`（顶层数组）声明**角色可调用的中立能力**（工具白名单面），`manifest.skills`（对象数组）回归**技能文件引用**（内容面）。不再混在一个数组里。

```json
"skills": [
  { "file": "skills/write.md", "name": "write", "description": "把成稿写入本地文件" },
  { "file": "skills/search.md", "name": "search", "description": "写作查资料" }
],
"capabilities": [
  { "capability": "file:write", "description": "写入文件" },
  { "capability": "web:search", "description": "写作查资料" },
  { "capability": "llm:summarize" }
]
```

- **`capabilities`（顶层，能力面）**：每项 `{ capability: '域:动作', description? }`。声明角色可调用的中立能力，经 capabilityMap 映射为工具白名单（agent.ts applyRolePackToolExposure，「换装 = 换 Agent」）；
- **`skills`（技能注册，内容面）**：每项 `{ file, name?, description? }`。`file` 为技能文件路径（生态指针），正文经渐进披露 L2（read_skill）按需装载；纯能力声明不再放 skills（放顶层 capabilities）；
- **实现映射**：memora 把 `file:write` 映射到内置 `writeFile` 工具；其他实现映射到自有工具；
- **未知能力**：装载方跳过该能力（可选提示"能力不可用"），不阻塞；
- 命名空间采用 `域:动作`（`file:` / `web:` / `llm:` / `tool:`），扩展由社区协商，先保持最小集。

**capability 是内核唯一行为入口**：`manifest.capabilities` 声明的能力（如 `web:search`）装载时映射到工具白名单；未声明 capabilities 的角色包 → 白名单为 null（全部暴露，保持现状）。

> **技能正文定位（渐进披露 L1/L2）**：`skills/{file}` 指向的技能文件正文默认**不预装载**，`capabilities` 是内核的**工具暴露入口**（映射工具白名单）。技能正文经**渐进披露**按需装载（对齐 Agent Skills 行业标准）：
> - **L1 常驻元数据**：`manifest.skills` 的 `name` + `description` 暴露给 LLM（每技能一行，省 token），LLM 据此判断何时读取技能；
> - **L2 按需装载**：LLM 调用 `read_skill` 工具，按技能名读取 `file` 指向的技能正文——`file` 从"生态指针"变为"装载入口"；
> - **标准契约**：`capability` 保证生效（工具暴露面）；技能正文装载经 `read_skill` 按需提供，实现应支持 `read_skill` 以兑现渐进披露（memora 已实现，见 [role-pack-skills-progressive-disclosure.md](./role-pack-skills-progressive-disclosure.md)）。
>
> **两级技能统一（2026-08-18）**：memora 技能体系由**两级**构成，共用同一渐进披露逻辑——**通用技能（全局池 `configDir/skills/`，全局激活）** + **角色包技能（`manifest.skills`，角色激活才激活）**。两级均以「L1 清单（name + description 常驻 system prompt）+ L2 `read_skill` 按需读正文」同构工作：
> - 通用技能清单随 system prompt 常驻（`SkillManager.buildSkillList`），角色包技能清单随 `rolePackPrompt`（角色激活时）；
> - `read_skill` 先查激活角色包技能、再查全局通用技能池（`assembler` 装配注入）；
> - 两级同构避免「通用技能在每个角色包复制一份」——全局一份，角色包只声明角色特有技能。

**具体连接桥（L2 可选，`mcp.json`）**：capabilities 是**抽象能力声明**（要什么能力、实现无关）；当角色包需要**开箱即用**的具象连接时，可在文件夹根放 `mcp.json`（对齐 Agent Plugins 1.0 的 transport 声明：`stdio` / `streamable-http` / `http+sse`），由实现映射到自有运行时。两者不冲突：**capabilities 是 L1 中立契约，mcp.json 是 L2 可选实现加速**——不声明 mcp.json 的角色包仍可被任何实现按 capabilities 装载。

### 四·一 标准能力命名空间（中立语义字典，v1 最小集）

> 能力命名规则：`域:动作` 格式，全小写，连字符分隔。`域` 是领域（`file` / `web` / `memory` / `task` / `llm`），`动作` 是具体行为。状态含义同 §六：**冻结** = 有参考实现（memora）真实消费；**`[草案]`** = 尚无参考实现消费，待验证。

| 能力名 | 语义定义 | 实现要求 | 状态 |
|--------|---------|---------|------|
| `file:read` | 读取本地文件系统文件内容 | 需提供文件路径与权限控制（memora → `read_file`） | 冻结 |
| `file:write` | 写入/创建本地文件系统文件 | 需提供路径范围与权限限制（memora → `write_file`） | 冻结 |
| `file:list` | 列举目录下文件列表 | 需提供目录路径与权限控制（memora → `list_dir`） | 冻结 |
| `web:search` | 网络搜索获取实时信息 | 需注入 `IWebSearchProvider`（memora → `web_search`） | 冻结 |
| `memory:recall` | 从长期记忆系统中召回相关记忆 | 基础记忆能力，Agent 应支持（memora → `search_memories`） | 冻结 |
| `task:plan` | 管理任务计划（创建/更新表格） | 需提供任务管理系统（memora → `task_table_write` / `task_table_update`） | 冻结 |
| `llm:summarize` | 调用 LLM 做文本摘要 | 内核内部能力，无需独立工具映射（memora 映射为空） | 冻结 |
| `llm:code-review` | 调用 LLM 做代码安全与质量审查 | 可选，需 LLM 支持代码分析 | `[草案]` |

**能力确定原则**（对齐 §五 双闸门演进）：

1. **验证门**：新能力名必须有参考实现真实消费方可进入标准（冻结状态）；未验证的能力标 `[草案]` 保留在字典中征集验证；
2. **中立门**：冻结后的能力名不可重命名，语义不可变更——实现向标准看齐，而非标准向实现看齐；
3. 已知能力名（不在本表内）按「未知能力跳过」装载（§四），不阻塞。

### 四·二 MCP 集成设计（接口定义 + 角色包声明路径）

> **定位**：MCP（Model Context Protocol）是 2026 年行业标准工具调用协议。角色包标准不要求任何实现必须支持 MCP，但支持 MCP 的实现应遵循本节定义的抽象接口和声明路径，以保证角色包跨实现可移植性。

**核心原则**：MCP 是 L2 传输层细节，不是 L1 能力声明。

- `capabilities` 声明角色包**需要什么能力**（L1，实现无关）；
- `mcp.json` 声明角色包**如何通过 MCP 获得这些能力**（L2，可选实现加速）；
- 同一能力声明与内嵌 MCP 服务器并存时，以 MCP 服务器为准（具体实现优先于抽象声明）；
- 不声明 `mcp.json` 的角色包仍可被任何实现按 capabilities 装载（L1 兼容）。

#### 角色包 MCP 声明格式（`mcp.json`）

文件夹根部的 `mcp.json` 对齐 Agent Plugins 1.0 的 MCP 服务器声明格式：

```json
{
  "mcpServers": {
    "file-system": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"]
    },
    "web-search": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-web-search"]
    }
  }
}
```

| 字段 | 必填 | 取值 | 说明 |
|------|------|------|------|
| `mcpServers` | 是 | 对象 | 服务器名字典，key 为服务器标识（角色包内唯一） |
| `<key>.transport` | 是 | `stdio` / `streamable-http` / `http+sse` | 传输协议类型 |
| `<key>.command` | 仅 `stdio` | 字符串 | 可执行文件路径或 npx 命令 |
| `<key>.args` | 否 | 字符串数组 | 命令行参数 |
| `<key>.env` | 否 | 对象 | 环境变量键值对 |

**兼容性规则**：

- 不认识 `mcp.json` 的实现：按「未知文件忽略」处理，退回到按 `capabilities` 映射自有工具（L1 兼容）；
- 不认识某传输协议的实现：跳过该服务器声明，**不阻塞装载**（可选提示"某能力因传输协议不可用"）；
- `mcp.json` 是文件夹形态专属能力（可选），角色包统一为文件夹形态，故无"单文件不含 mcp.json"的限制。

#### 参考实现接口（`IMcpTransport`）

memora 内核通过以下接口抽象 MCP 通信，宿主注入具体客户端实现：

```typescript
/** MCP 工具描述 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** MCP 工具执行结果 */
export interface McpToolResult {
  content: Array<{ type: 'text' | 'image' | 'resource'; text?: string; mimeType?: string }>;
  isError?: boolean;
}

/** MCP 传输层抽象（宿主注入） */
export interface IMcpTransport {
  /** 列出指定 MCP 服务器的所有工具 */
  listTools(serverName: string): Promise<McpTool[]>;
  /** 调用指定 MCP 服务器的指定工具 */
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** 关闭所有 MCP 连接（清理时调用） */
  close(): Promise<void>;
}
```

**宿主注入模式**（与 `ILogger` / `IMemoryStorage` 同构）：

- `IMcpTransport` 是依赖倒置接口，由宿主实现，通过构造函数注入；
- 内核不包含任何 MCP 客户端逻辑（零依赖原则）；
- 宿主未注入时，按「MCP 能力不可用」处理，角色包仍能按 L1 装载；
- 宿主实现可对接任意 MCP 客户端库（官方的、自实现的、或通过子进程启动的）。

**实现边界**：`IMcpTransport` 当前只定义最小接口（`listTools` + `callTool` + `close`），不包含资源模板、提示模板、订阅通知等 MCP 高级特性——这些可在后续版本扩展，不破坏已有实现。

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
| manifest.json 中内容文件缺失（persona/rules 指向的文件不存在） | 警告降级（内容文件可选，缺失按空处理） |

**formatVersion 迁移规则（对齐 Agent Plugins「schema URL 永不重指」）**：

- 每个 `formatVersion` 绑定一个**固定 schema URL**（如 `https://role-pack.dev/schemas/1.0.0/role-pack.schema.json`），发布后**永不改变内容**——同一版本号不可能指向两份不同规范；
- **minor 演进（1.0 → 1.1）**：仅新增 L2 键/可选字段——旧实现按「未知键警告并忽略」装载，新实现全量生效，**无需迁移**；
- **major 演进（1.0 → 2.0）**：键名/语义变更或 L1 结构变化——提供**迁移器**（读旧版 → 写新版），装载器对旧 major 拒绝加载并提示迁移；
- 校验器同时支持「声明格式版本校验」与「可迁移性检查」。

**双闸门演进（键级，P0 对账定案 2026-08-12）——新键进入标准的门槛**：

任何键要进入标准正文（§六），必须依次通过两道闸门；未通过验证门的键只能以 `[草案]` 状态保留在 §六 征集实现验证：

1. **验证门**：该键**必须有参考实现真实消费**（运行时读取并影响行为，而非仅有类型定义/默认值）。无参考实现的键不进标准——纸面设计不构成标准依据（§五 原则 ②）;
2. **中立门**：通过验证门后，命名须中立（不绑任何实现的内部命名），命名与语义一并**冻结**；此后个别实现不得再为自身内部命名改标准（见 §九 对齐声明）。

**僵尸键原则**：参考实现内部的已定义但零消费字段（如 memora `types.ts` 中的 `understandingConfirm`/`taskClassification`/`toolWhitelist`/`toolBlacklist` 等）属于实现内部技术债——**只标注不动，不剪枝、不进标准**；不得因"定义过"就主张其进入标准。完整僵尸键清单见 memora `types.ts` `BehaviorStrategy` 接口的诚实化声明。

**命名归标准原则**：实现内部旧命名（如 memora 旧 `act.toolCalls` / `reflect.endingHandoff`）通过解析层**别名迁移**到标准键名（旧键 → 新键，warn 降级提示），消费方一律读标准键——实现向标准看齐，而非标准向实现看齐（§九）。

---

## 六、L2 策略键集（中立命名，v1 最小集）

> 文件内为**嵌套 YAML**（`strategy: { prepare: { ... }, act: { ... } }`），规范引用用**点路径**（`strategy.prepare.contextAssembly`）——两者等价映射，见 §二 样例。键名统一 **camelCase**；此表是 v1 最小集，后续版本演进由 `formatVersion` 控制。
>
> **状态列含义（P0 键集对齐，2026-08-12）**：
> - **冻结** = 有参考实现（memora）真实消费 + 语义/命名已归标准——任何实现应支持一致行为；
> - **`[草案]`** = 尚无参考实现消费，保留在标准正文以征集实现验证（§五 双闸门演进：通过验证门才可冻结）——实现可装载（按未知键 warn + ignore 的键级渐进），但不承诺跨实现一致行为。

| 组 | 键 | 取值（枚举） | 含义 | 状态 | 实现消费要求 |
|----|----|------------|------|------|------------|
| prepare | `prepare.contextAssembly` | `fixed` / `query` / `hybrid` | 最近轮次加载策略 | `[草案]` | 无参考实现消费，待验证 |
| prepare | `prepare.recentRounds` | 正整数 | 固定加载轮数 | 冻结 | memora 消费（agent.ts 互斥排除 + 最近对话注入轮数，未配置回退默认 3） |
| prepare | `prepare.memoryRecall` | `full` / `limited` / `none` | 长期记忆召回 | 冻结 | memora 消费（agent.ts 召回装配） |
| prepare | `prepare.memoryRecallQuota` | 正整数 | 记忆召回限额（token） | 冻结 | memora 消费（agent.ts 限额召回）；**由实现提炼进标准**（spec 原缺，对账发现被真实消费后补录） |
| prepare | `prepare.summaryRecall` | `on` / `off` | 摘要召回 | `[草案]` | 无参考实现消费，待验证 |
| prepare | `prepare.summaryFocus` | 非空字符串 | 角色包提炼视角：判断 round-summary「值得记什么」的信息维度与保留形式（领域无关机制，替换通用归纳框架，JSON+SummaryType 硬契约保留；内容由角色包提供） | 冻结 | 由实现提炼进标准（2026-08-16 结构化信息保真 + 提炼侧视角下沉）；memora 消费（agent.ts → `resolveSummaryFocus` → `roundSummaryGenerator.generate` 注入提炼视角 prompt）；首个消费者为编程/方案卡，未达「≥2 处复用」机制化门槛 |
| prepare | `prepare.minFallback` | 非负整数 | 召回保底下限（recall 结果不足时用最近记忆补足，0=关闭） | 冻结 | memora 消费（recall.ts 保底补全，未配置回退默认 2） |
| act | `act.toolMode` | `allow` / `block` | 是否允许工具调用 | 冻结 | memora 消费（agent.ts 工具开关）；命名归标准（旧 `act.toolCalls`） |
| act | `act.temperature` | 0.0~2.0 | 生成随机性 | `[草案]` | 无参考实现消费，待验证 |
| act | `act.streaming` | `streaming` / `non-streaming` | 输出方式 | `[草案]` | 无参考实现消费，待验证 |
| reflect | `reflect.summary` | `on` / `off` | 摘要生成 | `[草案]` | 无参考实现消费，待验证（memora 旧字段 `summaryGeneration` 为僵尸键，只标注不动） |
| reflect | `reflect.handoff` | `wait` / `loop` / `end` | 衔接决策 | 冻结 | memora 消费（agent.ts 衔接决策）；命名归标准（旧 `reflect.endingHandoff`） |
| reflect | `reflect.loopContinue` | 0 或正整数（兼容旧 'on'→1 / 'off'→0） | 自审查轮数：LLM 纯文本回复后自动审查 N 轮（0=关闭） | 冻结 | memora 消费（agent.ts 自审查轮数，mvp-scope §三·一）；**由实现提炼进标准**（spec 原缺，对账发现被真实消费后补录） |
| reflect | `reflect.userFollowup` | `ask` / `silent` | 用户追问策略：ask=主动引导对话 / silent=只等输入 | 冻结 | memora 消费（agent.ts 衔接 + types.ts 提问指令注入）；**由实现提炼进标准**（spec 原缺，对账发现被真实消费后补录） |
| global | `global.askOn` | `ambiguity` / `decision` / `missing_info` / `confirm` | Agent 主动提问触发（可组合） | 冻结-条件消费 | memora 消费（types.ts `assembleRolePack` 提问指令注入，**仅 `reflect.userFollowup=ask` 时生效**）；条件消费 = 字段冻结，但行为仅在指定策略组合下激活 |
| global | `global.askLimit` | 正整数（默认 3） | 每任务提问上限 | 冻结-条件消费 | memora 消费（同上，userFollowup=ask 时生效，缺省 3） |
| global | `global.errorHandling` | `retry` / `degrade` / `stop` | 异常策略 | `[草案]` | 无参考实现消费，待验证 |

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

**安全审计（角色包发布前提，2026-08-13 声明）**：角色包是可下载、可共享的装载卡——是**供应链攻击载体**。行业实测：公开技能库中 **36% 含提示注入**（Snyk）、平均质量仅 6.2/12（SkillsBench）——无审计的开放目录是风险源。因此**安全审计是角色包进入可传播目录的前提**（不只合规）：角色包的 persona/rules/strategy/内嵌 skills 在发布前须经注入检测与质量审查；memora 作为 reference implementation 对下载角色包做基础注入扫描，发现恶意内容拒绝装载。签名/完整性校验（防篡改）随"硬通货"远期规划一并落地（见定位宣言演进状态）。**当前不实现，先确立硬门槛。**

---

## 八、校验（跨实现一致性）

- 提供**格式校验器**（独立于任何实现）：校验 manifest.json 的必填字段（`name`/`formatVersion`）、键名合法性、版本语义、L2 策略键（§六）、内容路径注册（`persona`/`rules`）、skills 注册格式（§四）、**合规字段（§七，分档：仅 `companion` 角色包全量强校验，`tool_assistant` 默认值兜底）**；
- **内容红线检测 = 装载边界的"守门提示"（§七 第 5 条，区别于格式校验器）**：正文在独立内容文件（persona.md/rules.md），格式校验器为**纯函数不读文件**——它只保证 manifest.json 的"格式正确"，是**正确性守门人**；而 companion 虚拟亲密关系红线是**安全守门人**，由装载方在读取内容后调用 `checkCompanionContentRedline` 检测，触发即拒绝装载。二者职责分离：**格式校验器管"合不合规范"，内容红线检测管"该不该放行"**——前者失败提示修正格式，后者失败（仅 `companion`）直接拦截，不作为格式问题混报；`manifest.json` 层仅校验合规字段声明（interactionType / disclosure / minorProtection）；
- 校验通过 = 任何实现可装载；校验失败 = 实现拒绝加载并给出原因；
- 目标是生态内角色包**一次编写，处处装载**。

---

## 九、与 memora 的关系

| 项 | 说明 |
|----|------|
| memora | **reference implementation**（首个实现本标准的 Agent 内核）；**合规从严执行**：标准级合规字段为可选 + 分档（§七），memora 实现级强制 AI 身份标注等合规义务 |
| `role-packs/`（memora 仓库） | 示例角色包（翻译助手 / 技术文档工程师 / 项目总监） |
| [architecture_philosophy_rules.md §11](../.trae/rules/architecture_philosophy_rules.md) | memora 视角的角色包定位（插卡机模型，通用引擎 ↔ 专业卡） |
| [mvp-scope.md §二](mvp-scope.md) | MVP 落地范围 = 本标准的 L1 + 核心 L2 键子集 |
| 演进状态 | 角色包标准处**草案演进期**，v1 字段冻结延后至内核基础（问答闭环 / 记忆系统）定型后——见本文档定位宣言 |

> 标准优先于实现（P0 键集对齐，2026-08-12）：memora 已对齐本规范中立命名——`strategy.act.toolCalls` → `act.toolMode`、`strategy.reflect.endingHandoff` → `reflect.handoff`；解析层保留旧键 → 标准键**别名迁移**（warn 降级提示，不阻断装载），消费方一律读标准键。memora 内部已定义但零消费的字段（如 `understandingConfirm`/`taskClassification` 等）为**僵尸键，只标注不动**，不进入标准（§五 僵尸键原则）。规范演进以 `formatVersion` 控制，不破坏已装载的卡。

### 9.1 来源边界声明（2026-08-15 审查定案）

> **问题**：角色包来源区分（内置 vs 插件贡献 vs 未来用户自定义）应该由谁承担？
> **结论**：**内核不感知来源语义，多来源由宿主以多实例（multi-instance）承载**。此声明是"内核-宿主"职责边界的一部分，防止来源区分逻辑反向渗入内核。

**职责划分**：

| 职责 | 归属 | 说明 |
|------|------|------|
| 装载 `role-packs/` + 激活 | 内核（`RolePackManager`） | 构造入参 `configDir`，扫描 `<configDir>/role-packs/`；保持最小单元不变 |
| 来源是什么、有几个来源 | 宿主 | 决定 configDir / 实例个数（每个来源一个 `RolePackManager` 实例） |
| 来源分组展示、只读标记 | 宿主 | UI 策略（如"插件 A 贡献的角色包"分组） |
| 用户自定义（未来） | 宿主 | 新增一个实例指向用户目录 |

**关键事实（为什么内核不需要来源字段）**：

1. **来源知识天然在宿主侧**：`configDir` 由宿主传入（如 memora-vscode `resolveConfigDir()` 返回 `dist/extension/`），宿主 100% 知道自己装了哪些角色包、来自哪个插件；
2. **激活的角色包也是宿主指定**：宿主通过 `load(activePack)` / `activate(name)` 决定当前激活哪个包；
3. **内核是"装载 + 激活"执行器**：不拥有来源概念。若内核加 `origin` 字段 = 复述宿主已知信息，形成数据冗余 + 边界错位。

**未来多来源形态（不预埋，等到第二来源出现再落地）**：

```
插件 A → new RolePackManager(configDirA)   // role-packs/a/*
插件 B → new RolePackManager(configDirB)   // role-packs/b/*
用户   → new RolePackManager(userDir)      // 未来用户自定义
```

- **来源语义 = 哪个实例**：宿主聚合各实例 `listMeta()` 展示，按实例分组天然完成"哪个插件提供的"；
- **命名冲突天然隔离**：同名角色包分属不同实例不冲突；
- **只读/可编辑 = 宿主对实例的策略**：插件实例只读，用户实例可写；
- **零内核改动**：内核保持"装载+激活"最小单元，不感知来源。

**伏笔的正确形态**：不预埋字段，而是**明确边界让未来自然生长**（单一真理源）。未来开放用户自定义时，宿主只需：新目录放用户角色包 → 新建 `RolePackManager` 实例 → 聚合两实例列表展示。内核一行不改。

#### 示例库 vs 宿主生产库（2026-08-15 边界澄清）

> **问题**：memora 仓库根 `role-packs/` 与宿主内置（如插件 `src/extension/role-packs/`）存在同名角色包，是否需强制同步？
> **结论**：**不追求同步**。两者定位不同、归属独立、生命周期各自演进，不属于 SSOT 反模式（stale mirror）。

| 目录 | 身份 | 归属 | 分发 |
|------|------|------|------|
| 根 `role-packs/` | **示例 / 参考**（展示角色包目录结构、字段用法、内核机制） | memora 内核示例库 | 不进入任何运行时 |
| 宿主内置 `role-packs/` | **生产配置**（端用户实际使用） | 各宿主（当前插件由 esbuild `copyRolePacks` 内嵌进 dist） | 随宿主产物分发 |

**处理原则**：
1. 示例库与生产库**各自独立维护**，内容相似是"示例恰好选用了同名角色"，非同一份数据的多拷贝；
2. 接入者应以**宿主内置**为生产真理源，根示例库仅作**结构 / 字段 / 能力参考**；
3. 新增宿主时，复制根示例到宿主内置后即"分叉"，后续各自演进，不回写根示例。

> 根示例库的接入者指引见 [role-packs/README.md](../../role-packs/README.md)（声明性入口，本处为规范性定义）。

### 9.2 内容层归属声明（2026-08-17 定案）

> **问题**：persona / rules / skills 的「内容」由谁承载？角色包还是记忆系统？
> **结论**：**设定记忆（persona / rules / skills）唯一归角色包内容层（L1）**；记忆系统只承载**对话记忆**（round-summary，按 summaryType 分类）。二者是两种东西，不互存、不双写。详见 [memory-role-pack-boundary.md](memory-role-pack-boundary.md)。

**分界线（设计真理源）**：

| 维度 | 归属 | 承载形态 |
|------|------|----------|
| 你是谁 / 你怎么做事（persona / rules / skills） | **角色包** | `persona.md` / `rules.md` / `skills/*`（manifest.json 注册，§2.2） |
| 聊了什么 / 发生过什么 | **记忆系统** | round-summary（带 summaryType 分类标签） |

**配套约束**：

1. **记忆库不写入设定记忆**：`persona` / `rule` / `skill` 不作为记忆库 source 写入（当前 `configManager` / `loader` 的写入路径待收敛，见 memory-role-pack-boundary.md §四档 1）。
2. **角色包不写对话记忆**：角色包只承载设定，不承载轮次摘要。
3. **存量兼容**：已写入记忆库的存量设定记忆行保留（软删兼容），但不再有新写入；宿主提供一次性迁移即可清理。
4. **guardrail 已摘除（2026-08-17）**：guardrail 为「零规则、无扫描映射、无消费者」的空转链，已随档 1 一并移除；原「guardrail 归宿待定」决策作废（见 memory-role-pack-boundary.md §四档 3）。

**演进状态**：当前实现为「双轨中间态」（角色包与 PersonaManager/SkillManager 并存，[assembler.ts](../../src/agent/assembler.ts:234) 角色包优先、persona 兜底）；按档 0→3 渐进收敛至本目标态。

---

## 十、与行业标准的关系（Agent Skills / Agent Plugins）

| 标准 | 定位 | 与角色包的关系 |
|---|---|---|
| Agent Skills（Anthropic 2025-12） | 能力单元（SKILL.md + scripts/references/assets，渐进披露） | 角色包**内嵌兼容**：`skills/` 即 Agent Skills 格式；L1/L2/L3 渐进披露同构（§2.4） |
| Agent Plugins 1.0（2026-08-06，五方+Google） | 能力+工具连接的文件夹包（plugin.json + skills/ + mcp.json + 反域名扩展） | **骨架同构**（§二）：文件夹 + manifest + skills/ + 命名空间扩展；角色包在其上增加**行为层**（persona/rules/strategy）——行业可移植层目前**不含身份/行为**，这正是角色包的差异化空白 |
| memora | 角色包的 reference implementation | 见 §九 |

**竞争姿态（范式立场）**：不与 Agent Plugins 竞争「能力分发」，而是补齐其明确留白——**行为分发**（有身份的 Agent 行为单元）。Agent Plugins 把 persona 留给 client-specific 扩展（如 VS Code `agents/` 目录）；角色包把 persona/rules/strategy 做成**可移植核心（L1）**。反域名命名空间目录（`com.memora/`，§2.2）保证两者共存：**标准核心对齐行业，专有行为层进命名空间**——不绑死任何一家，也不放弃差异化。

---

## 十一、A2A 协议预留

> **定位**：A2A（Agent-to-Agent）是 Google/Microsoft 推动的智能体间通信协议。memora 当前定位为单 Agent 引擎，不实现 A2A 客户端；但角色包格式在设计上预留多 Agent 场景的可扩展性，为后续生态发展留出空间。

**预留原则**：

1. **角色包不自洽**（[architecture_philosophy_rules.md §11.2](../rules/architecture_philosophy_rules.md)）：角色包不包含执行引擎，依赖宿主 Agent 的闭环引擎运行。这一特性天然适用于多 Agent 场景——每个角色包实例是一个独立 Agent，由宿主编排。
2. **interactionType 扩展点**：`interactionType` 字段（§七）当前为 `tool_assistant` / `companion` 二分，未来可扩展 `gateway` 或 `coordinator` 等角色类型，由宿主注入 A2A 路由逻辑。
3. **能力声明可路由**：`capabilities` 声明（§四）是中立能力名，多 Agent 宿主可基于能力名将子任务路由到对应角色包实例——memora 的插卡模型天然支持这种"Triage and Specialist"架构（2026 年行业标准，见 [§四·二 MCP 集成设计](#四二-mcp-集成设计接口定义--角色包声明路径)）。
4. **当前不实现**：memora 内核不包含 A2A 客户端代码，不定义 A2A 传输接口。多 Agent 编排由宿主（如 memora-sprite）在闭环引擎之上实现，内核不感知。

**未来演进方向**（非承诺）：

- 当生态需要多角色包协作时，可定义 `A2A 声明` 字段（如 `dependsOn: ["role-pack-a", "role-pack-b"]`），由宿主负责解析依赖并启动对应的 Agent 实例；
- A2A 传输层可复用 `IMcpTransport` 相同的注入模式（依赖倒置，宿主注入），不引入内核依赖。
