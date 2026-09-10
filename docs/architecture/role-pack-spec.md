# 角色包标准（RolePack Spec）

> **定位宣言**：角色包是一份**可共享的装载卡**——自包含的 Agent 行为单元（文件夹包，`manifest.json` 为核心控制文件），任何 Agent 实现都能装载。
> **范式主张**：Agent = 最小闭环 + 装载卡。专业性来自装载的角色包，不来自代码分支；换装 = 换 Agent。
> **memora 与本标准的关系**：memora 是**首个实现（reference implementation）**，本规范**不绑定 memora**。其他 Agent 实现本规范后即可装载生态中的角色包。
> **类比**：USB-C（接口标准）/ Docker 镜像（可移植容器）/ HTML（浏览器兼容的文档标准）。
>
> **演进状态**：角色包标准当前处于**草案演进期**。memora 优先打磨内核基础（turn + 记忆系统），其运行不依赖角色包键；**角色包字段 v1 冻结延后至基础接口定型后**——避免标准字段随基础演进反复横跳。本章节中依赖未冻结基础或尚无参考实现消费的键一律以 `[草案]` 标注（§六状态列），不承诺跨实现一致行为。硬通货要素（签名 / 依赖声明 / 目录）作为远期演进方向随 v1 冻结一并规划，当前不设计。

***

## 一、核心原则（4 条）

1. **中立性**：角色包是文件夹包、自包含、不依赖任何 Agent 实现的文本契约；
2. **渐进兼容**：认识的生效，不认识的安全跳过——任何实现至少能装载 L1；
3. **自描述**：文件自带 schema 版本（`formatVersion`），跨实现一致性靠版本 + 校验；
4. **能力声明**：工具按"能力"（capability）声明，由各实现映射到自有工具，不绑具体实现。

***

## 二、文件格式（文件夹包：manifest.json 唯一核心控制文件）

**格式决策**：角色包统一为**文件夹包（bundle）** 形态——系统此前未启用角色包（无存量包），故**不保留单文件 .md / role-pack.md 旧格式**。每个角色包 = 一个文件夹，`manifest.json` 是**唯一核心控制文件**（元数据 + L2 策略 + skills 白名单 + capabilities 注册），内容文件（persona.md / rules.md / skills/\*）作为独立文档按约定名装载（skills 目录动态扫描，C3；persona/rules 纯约定名零声明，§2.3）。

> **设计要点（内容文件独立性）**：persona / rules / skills 是独立 Markdown 文档，用户既可**独立移植**这些文档到其他项目，也可**整体装载**角色包。manifest 只承载元数据/策略/capabilities/skills 白名单，不内嵌正文——元数据/策略单一真理源在 manifest，正文单一真理源在内容文件，二者不双写。

### 2.1 角色包 vs Skills（代际关系）

| <br /> | Skills（现状生态）   | 角色包（未来范式）                                        |
| ------ | -------------- | ------------------------------------------------ |
| 本质     | **能力单元**——会做什么 | **完整行为单元**——以什么身份、用什么能力、受什么约束、怎么行事               |
| 内容     | 步骤/脚本/参考       | persona + rules + skills + strategy（**有身份的能力包**） |
| 关系     | —              | **角色包内嵌/聚合 skills**，是 skills 的容器与超集              |

**范式主张**：分享一个 skill，别人获得一个能力；分享一个角色包，别人获得一个"有性格的 Agent 行为单元"。**角色包代替 skills** = 能力分发升级为行为分发。

### 2.2 文件夹包结构（唯一形态）

```
我的角色包/                        ← 文件夹，zip 压缩分发
├── manifest.json                 # ★核心控制文件（唯一权威）：元数据 + strategy + skills 白名单 + capabilities 注册（内容文件纯约定名，不注册路径）
├── persona.md                    # 可选：身份设定（约定文件名，§2.3）
├── rules.md                      # 可选：确定性规则（约定文件名，§2.3）
├── skills/                       # 可选：内嵌技能（目录动态扫描，frontmatter 声明，§四 C3）
│   ├── write.md                 # 单文件形式：直接 .md 文件
│   ├── search.md
│   └── my-skill/                # 文件夹形式：子目录 SKILL.md（Claude Code 标准）
│       └── SKILL.md
├── references/                   # 可选：知识引用
├── assets/                       # 可选：资源（模板、图片、示例）
└── com.memora/（可选）            # 反域名命名空间：memora 专有行为层（对齐 Agent Plugins 扩展惯例，其他实现忽略）
```

**manifest.json 示例**（元数据 + 策略 + capabilities + skills 白名单，全部单一权威；persona.md / rules.md 为约定文件名零声明，不注册路径）：

```json
{
  "name": "技术文档工程师",
  "formatVersion": "1.0.0",
  "description": "技术文档写作助手",
  "keywords": ["文档", "API"],
  "author": "memora",
  "interactionType": "tool_assistant",
  "strategy": {
    "prepare": { "summaryFocus": "以技术文档视角提炼要点" },
    "act": { "toolMode": "allow", "temperature": 0.6 }
  },
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

**匹配字段双写法（keywords / trigger）**：

> **`[草案]`（2026-09-08 状态收敛）**：本节匹配字段目前**无参考实现消费**——memora 参考实现 v0.13 起角色包仅手动切换，自动匹配链已移除（解析置空、validator 仅未知键宽容）。按 §六 双闸门纪律（无参考实现消费的键一律标 `[草案]`，不承诺跨实现一致行为），本节语义保留为标准匹配字段定义（中立标准正文），状态列标 `[草案]` 征集实现验证；实现可按「未知键 warn + ignore」装载。

* `keywords` 与 `trigger` 为**角色匹配字段**（`trigger` 兼容 `keywords`，二者汇入同一匹配词源）：

  * `keywords`：角色的关键词/匹配词，用于文本匹配判定；

  * `trigger`：补充触发词，与 `keywords` 合并去重后作为**单一匹配词源**（§ 匹配语义）。

* 两者均支持**两种合法写法**（实现按此定义解析）：

  1. **字符串数组**：`"keywords": ["文档", "API"]`（规范推荐写法）；
  2. **逗号分隔字符串**：`"keywords": "文档, API"`（等价的宽松写法）。

* 其余类型（如数值、数组含非字符串元素）为非法值。

### 2.3 内容文件独立性与零声明约定

* *persona.md / rules.md / skills/* 是独立 Markdown 文档\*。用户可**独立移植**这些文档，也可**整体装载**角色包；

* **内容文件零声明**：`persona.md`（身份）、`rules.md`（规则）为**约定文件名**——装载器一律回退约定名，**manifest 不注册内容路径**（R7 纪律：manifest 禁止路径注册，防"路径写错静默丢内容"）；`skills/` 目录动态扫描（C3）。manifest 只承载「非约定内容」：capabilities、strategy、handoffPrompt、元数据与合规字段；

* **persona.md 为约定文件名**：身份设定**约定俗成为** **`persona.md`**——装载器不读 manifest 路径字段，一律回退约定名；

* **rules.md 为约定文件名**：rules 规则文件**约定俗成为** **`rules.md`**——装载器不读 manifest 路径字段，一律回退约定名。消除「路径写错静默丢规则」错误面；

* **persona 允许缺省**：`persona.md` 文件不存在时，角色包无身份设定，仅靠策略驱动行为；

* 内容文件**不含 frontmatter**——元数据/策略单一真理源在 manifest.json，正文单一真理源在内容文件，二者不双写。

### 2.4 单一真理源与字段集

* **manifest.json 是唯一的权威（SSOT）**：元数据 + L2 策略 + skills 白名单声明 + capabilities 注册全部在此，无第二份权威，同字段永不双写；

* **manifest 字段集**：`name`（必填）/ `displayName`（可选，UI 展示名，缺省回退 `name`）/ `formatVersion`（必填）/ `version` / `description` / `author` / `homepage` / `repository` / `license` / `keywords` / `trigger` / `interactionType` / `aiIdentityDisclosure` / `minorProtection`（合规字段为可选 + 分档，仅 `companion` 强校验，§七）/ `strategy`（L2 策略，§六）/ `handoffPrompt`（接手衔接提示词，自洽声明，§2.5）/ `skills`（可选白名单过滤，§四 C3）/ `capabilities`（能力声明顶层数组，§四 C2）。**不含内容文件路径字段**——persona.md / rules.md 为纯约定名，manifest 不注册路径（R7 纪律，§2.3）；

> **`[草案]` 状态注记（2026-09-08 收敛）**：`homepage` / `repository` / `license` / `minKernelVersion` 为标准字段（生态通用元数据 + 版本兼容远期键），但当前**无参考实现消费**（memora 参考实现不读，按「未知键 warn + ignore」处理）。按 §六 双闸门纪律标 `[草案]`，征集实现验证后冻结；`keywords`/`trigger` 匹配字段见 §2.2 的 `[草案]` 注记。

* **内容文件零声明**：`persona.md` / `rules.md` / `skills/` 全部**约定俗成**——persona 与 rules 不声明即回退约定名，skills 目录动态扫描。manifest 只承载「非约定内容」：capabilities、strategy、handoffPrompt、元数据与合规字段；

* **skills 目录扫描（C3）**：`skills/` 目录下的 `.md` 文件**动态扫描**注册——文件 frontmatter 声明 `name`/`description`，正文为技能内容。**新增技能只写文件，无需改 manifest**。manifest.skills 可选：声明 `file` 时按文件过滤（白名单语义），未声明则全部扫描；

* **capabilities 字段集**：`capability`（必填，中立能力名 `域:动作`，§四）+ `description`（可选）；声明角色可调用的中立能力（工具白名单面）；

* **加载规则**：装载器扫描 `role-packs/<名>/` 文件夹，读取 `manifest.json`，按约定名装载 persona.md / rules.md **正文**（无路径注册，零声明）；**skills 目录动态扫描**（frontmatter 元数据 + 正文经 read\_skill 按需装载，§四 渐进披露）；无 `manifest.json` 的文件夹不计入角色包，`manifest.json` 非法 JSON 时跳过该包；

* **内嵌 skills 上限（行业实测校准）**：渐进式披露下，内嵌 skills 建议 **≤10 个**；单个内嵌技能文件建议 **≤500 行**，详述放 `references/`；

* **分发**：文件夹 zip 压缩（对齐 skills 市场分发方式）。

### 2.5 接手衔接提示词（handoffPrompt，角色包自洽声明）

**定位**：`handoffPrompt` 是该角色包**被宿主带入对话（激活 + 聚焦）时**预填输入框的特色衔接话术——作者为「这个角色接手任务时怎么说」定制的提示词。缺省由宿主回退通用话术。

**设计边界**：角色包是**独立自洽**的装载卡（§11 插卡解耦）——**只描述自己，不引用其他角色包**。跨包移交（A→B 交接链）属宿主层工作流编排（§十一 A2A 预留：依赖声明由宿主解析，远期非承诺），**不进角色包格式**；角色包之间的切换由用户主动通过宿主「带入对话」原语完成。

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
2. **嵌套对象取代点路径平铺**：`strategy.prepare.summaryFocus` 在 manifest 内是嵌套对象——无路径拼写问题，终结旧键名的 snake/camel 分裂；规范引用用点路径，与文件内嵌套等价映射；
3. **文件夹承载扩展**：skills 内嵌 / references / assets / scripts（L3）——格式不推翻、只升级。

***

## 三、三层结构

```
角色包（文件夹包）
├── manifest.json（★核心控制文件 = 元数据 + L2 策略 + skills 白名单 + capabilities 注册；内容文件纯约定名）
│   ├── 元数据：name / displayName / formatVersion / keywords / trigger / version / 合规字段 ...
│   ├── strategy：L2 行为策略（嵌套对象，见 §六）
│   └── capabilities：能力声明顶层数组（capability / description，§四 C2）
├── persona.md（L1 内容层：身份与视角，约定文件名，§2.3）
├── rules.md（L1 内容层：边界与安全约束，约定文件名）
├── skills/       # 内嵌技能文件（目录动态扫描，frontmatter 声明 name/description，§四 C3，兼容 skills 生态结构）
├── references/   # 知识引用
├── assets/       # 资源（模板、图片）
└── scripts/      # L3 代码钩子（远期）
```

### L1：最小兼容面（任何实现必须能装载）

| 字段/文件                    | 语义      | 装载行为                            |
| ------------------------ | ------- | ------------------------------- |
| `persona.md`             | 身份与视角   | 作为 system prompt 注入（允许缺省）       |
| `rules.md`               | 边界与安全契约 | 作为安全约束生效（实现可对接自身护栏）             |
| `manifest.capabilities`  | 能力清单    | 按 `capability` 映射到实现可用工具（工具白名单） |
| `manifest.skills[].file` | 技能文件    | 渐进披露 L2 按需装载（read\_skill）       |

L1 是纯文本契约——**即使实现不认识 L2/L3，也能完整装载 L1**（persona/rules 是独立 Markdown 正文；skills 是 manifest 结构化注册，机器可读），这就是"插上就能用"。

### L2：行为策略层（键级渐进）

* 枚举式行为开关，角色只"选择"不"定义"；

* **已知键生效，未知键警告并忽略（warn + ignore，不阻塞装载）**——杜绝拼写错误被静默吞掉（对齐 Agent Plugins「reported and ignored」，见 §五）。

> **边界声明**：L2 枚举是**行为参数**层——角色在此只能"选择"预定义开关，不能"定义"逻辑，这保证可安全传播。**它不承诺"思维过程"的差异化**：真正决定角色专业性的，是 L1 内容层（persona/rules 知识）与远期 L3 代码层（自定义能力）。角色包的价值分层 = **L1 专业性 / L2 行为偏好 / L3（远期）能力扩展**。"角色包代替 skills"（§2.1）兑现的是"内容分发 + 行为分发"，"思维过程分发"依赖 L1/L3，非 L2 枚举职责。

### L3：代码层（远期）

* 自定义钩子；必须沙箱隔离防恶意代码；**当前不设计、不启用**。

***

## 四、能力声明（capabilities 独立模块 + skills 目录扫描）

**C2 定案**：能力面与内容面分离——`manifest.capabilities`（顶层数组）声明**角色可调用的中立能力**（工具白名单面），skills 回归**技能内容面**。

**C3 定案**：skills 从「manifest 注册数组」改为「**目录动态扫描**」——`skills/` 目录支持**两种形式**（与全局技能池 `scanMarkdownDir` 同构）：

1. **单文件形式**：`skills/*.md` 直接子项下的 `.md` 文件自动注册
2. **文件夹形式**：`skills/<名>/SKILL.md` 子目录中的 `SKILL.md`（Claude Code 标准）自动注册

frontmatter 声明 `name`/`description`。**新增技能只写文件，无需改 manifest**。manifest.skills 可选：声明 `file` 时按文件过滤（白名单语义），未声明则全部扫描。

```json
"skills": [
  { "file": "skills/write.md" },
  { "file": "skills/my-skill/SKILL.md" }
],
"capabilities": [
  { "capability": "file:write", "description": "写入文件" },
  { "capability": "web:search", "description": "写作查资料" },
  { "capability": "llm:summarize" }
]
```

技能文件 frontmatter 示例（`skills/write.md`）：

```markdown
---
name: write
description: 把成稿写入本地文件
---

# write：成稿写入
（技能正文…）
```

* **`capabilities`（顶层，能力面）**：每项 `{ capability: '域:动作', description? }`。声明角色可调用的中立能力，经 capabilityMap 映射为工具白名单（agent.ts applyRolePackToolExposure，「换装 = 换 Agent」）；

* **`skills`（目录扫描，内容面）**：`skills/` 下**两种形式**动态扫描——单文件 `skills/*.md` 和文件夹 `skills/<名>/SKILL.md`（Claude Code 标准）。frontmatter 的 `name`（缺省取文件名/目录名）/`description` 暴露给 LLM（L1 清单），正文经渐进披露 L2（read\_skill）按需装载；纯能力声明不放 skills（放顶层 capabilities）；

* **实现映射**：memora 把 `file:write` 映射到内置 `write_file` 工具；其他实现映射到自有工具；

* **未知能力**：装载方跳过该能力（可选提示"能力不可用"），不阻塞；

* 命名空间采用 `域:动作`（`file:` / `web:` / `memory:` / `task:` / `llm:` / `code:`），扩展由社区协商，先保持最小集。

**capability 是内核的特权入口**（tool-exposure-model：默认常驻 vs 角色启动）：`manifest.capabilities` 声明的能力（如 `web:search`）装载时映射为**特权工具白名单**；本地只读/项目内/内核基建工具默认常驻、不受白名单影响；未声明 capabilities 的角色包 → 白名单为 null（全部暴露，保持现状）。

> **技能正文定位（渐进披露 L1/L2）**：`skills/{file}` 指向的技能文件正文默认**不预装载**，`capabilities` 是内核的**工具暴露入口**（映射工具白名单）。技能正文经**渐进披露**按需装载（对齐 Agent Skills 行业标准）：
>
> * **L1 常驻元数据**：`manifest.skills` 的 `name` + `description` 暴露给 LLM（每技能一行，省 token），LLM 据此判断何时读取技能；
>
> * **L2 按需装载**：LLM 调用 `read_skill` 工具，按技能名读取 `file` 指向的技能正文——`file` 从"生态指针"变为"装载入口"；
>
> * **标准契约**：`capability` 保证生效（工具暴露面）；技能正文装载经 `read_skill` 按需提供，实现应支持 `read_skill` 以兑现渐进披露（memora 已实现，见 [role-pack-skills-progressive-disclosure.md](./role-pack-skills-progressive-disclosure.md)）。
>
> **两级技能统一**：memora 技能体系由**两级**构成，共用同一渐进披露逻辑——**通用技能（全局池** **`configDir/skills/`，全局激活）** + **角色包技能（`manifest.skills`，角色激活才激活）**。两级均以「L1 清单（name + description 常驻 system prompt）+ L2 `read_skill` 按需读正文」同构工作：
>
> * 通用技能清单随 system prompt 常驻（`SkillManager.buildSkillList`），角色包技能清单随 `rolePackPrompt`（角色激活时）；
>
> * `read_skill` 先查激活角色包技能、再查全局通用技能池（`assembler` 装配注入）；
>
> * 两级同构避免「通用技能在每个角色包复制一份」——全局一份，角色包只声明角色特有技能。

**具体连接桥（L2 可选，`mcp.json`）**：capabilities 是**抽象能力声明**（要什么能力、实现无关）；当角色包需要**开箱即用**的具象连接时，可在文件夹根放 `mcp.json`（对齐 Agent Plugins 1.0 的 transport 声明：`stdio` / `streamable-http` / `http+sse`），由实现映射到自有运行时。两者不冲突：**capabilities 是 L1 中立契约，mcp.json 是 L2 可选实现加速**——不声明 mcp.json 的角色包仍可被任何实现按 capabilities 装载。

> **`[草案]`（2026-09-08 状态收敛）**：`mcp.json` 为 L2 可选机制，当前**无参考实现消费**（memora 参考实现不装载 mcp.json，实现按「未知文件忽略」回退 L1 capabilities）。按 §六 双闸门纪律标注 `[草案]`，征集实现验证后冻结。

### 四·一 标准能力命名空间（中立语义字典，v1 最小集）

> 能力命名规则：`域:动作` 格式，全小写，连字符分隔。`域` 是领域（`file` / `web` / `memory` / `task` / `llm`），`动作` 是具体行为。状态含义同 §六：**冻结** = 有参考实现（memora）真实消费；**`[草案]`** = 尚无参考实现消费，待验证。

| 能力名               | 语义定义               | 实现要求                                                                    | 状态     |
| ----------------- | ------------------ | ----------------------------------------------------------------------- | ------ |
| `file:read`       | 读取本地文件系统文件内容       | 需提供文件路径与权限控制（memora → `read_file`）                                      | 冻结     |
| `file:write`      | 写入/创建本地文件系统文件      | 需提供路径范围与权限限制（memora → `write_file`）                                     | 冻结     |
| `file:list`       | 列举目录下文件列表          | 需提供目录路径与权限控制（memora → `list_dir`）                                       | 冻结     |
| `web:search`      | 网络搜索获取实时信息         | 需注入 `IWebSearchProvider`（memora → `web_search`）                         | 冻结     |
| `web:fetch`       | 抓取指定网页正文           | 需注入 `IFetchProvider`（memora → `web_fetch`，与 `web:search` 成对构成「搜索→抓取」闭环） | 冻结     |
| `code:execute`    | 通用代码执行（计算/数据处理/验证） | 需注入 `ICodeExecutionProvider`（memora → `run_code`，沙箱由宿主提供）               | 冻结     |
| `memory:recall`   | 从长期记忆系统中召回相关记忆     | 基础记忆能力，Agent 应支持（memora → `search_memories`）                            | 冻结     |
| `task:plan`       | 管理任务计划（创建/更新表格）    | 需提供任务管理系统（memora → `task_table_write` / `task_table_update`）            | 冻结     |
| `llm:summarize`   | 调用 LLM 做文本摘要       | 内核内部能力，无需独立工具映射（memora 映射为空）                                            | 冻结     |
| `llm:code-review` | 调用 LLM 做代码安全与质量审查  | 可选，需 LLM 支持代码分析                                                         | `[草案]` |

> **memora 消费口径（2026-09-08，tool-exposure-model）**：上表中 `file:read` / `file:write` / `file:list` / `memory:recall` 在 memora 属**默认常驻工具**——声明与否都不影响可见性（`DEFAULT_EXPOSED_TOOLS` 恒暴露），该四键在 memora 侧已丧失白名单映射能力（保留于中立字典供其他实现消费，memora 不再映射）；`web:search` / `web:fetch` / `code:execute` / `task:plan` 为**特权键**，声明才进入工具白名单。

**能力确定原则**（对齐 §五 双闸门演进）：

1. **验证门**：新能力名必须有参考实现真实消费方可进入标准（冻结状态）；未验证的能力标 `[草案]` 保留在字典中征集验证；
2. **中立门**：冻结后的能力名不可重命名，语义不可变更——实现向标准看齐，而非标准向实现看齐；
3. 已知能力名（不在本表内）按「未知能力跳过」装载（§四），不阻塞。

### 四·二 MCP 集成设计（接口定义 + 角色包声明路径）

> **定位**：MCP（Model Context Protocol）是 2026 年行业标准工具调用协议。角色包标准不要求任何实现必须支持 MCP，但支持 MCP 的实现应遵循本节定义的抽象接口和声明路径，以保证角色包跨实现可移植性。

**核心原则**：MCP 是 L2 传输层细节，不是 L1 能力声明。

* `capabilities` 声明角色包**需要什么能力**（L1，实现无关）；

* `mcp.json` 声明角色包**如何通过 MCP 获得这些能力**（L2，可选实现加速）；

* 同一能力声明与内嵌 MCP 服务器并存时，以 MCP 服务器为准（具体实现优先于抽象声明）；

* 不声明 `mcp.json` 的角色包仍可被任何实现按 capabilities 装载（L1 兼容）。

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

| 字段                | 必填        | 取值                                       | 说明                        |
| ----------------- | --------- | ---------------------------------------- | ------------------------- |
| `mcpServers`      | 是         | 对象                                       | 服务器名字典，key 为服务器标识（角色包内唯一） |
| `<key>.transport` | 是         | `stdio` / `streamable-http` / `http+sse` | 传输协议类型                    |
| `<key>.command`   | 仅 `stdio` | 字符串                                      | 可执行文件路径或 npx 命令           |
| `<key>.args`      | 否         | 字符串数组                                    | 命令行参数                     |
| `<key>.env`       | 否         | 对象                                       | 环境变量键值对                   |

**兼容性规则**：

* 不认识 `mcp.json` 的实现：按「未知文件忽略」处理，退回到按 `capabilities` 映射自有工具（L1 兼容）；

* 不认识某传输协议的实现：跳过该服务器声明，**不阻塞装载**（可选提示"某能力因传输协议不可用"）；

* `mcp.json` 是文件夹形态专属能力（可选），角色包统一为文件夹形态，故无"单文件不含 mcp.json"的限制。

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

* `IMcpTransport` 是依赖倒置接口，由宿主实现，通过构造函数注入；

* 内核不包含任何 MCP 客户端逻辑（零依赖原则）；

* 宿主未注入时，按「MCP 能力不可用」处理，角色包仍能按 L1 装载；

* 宿主实现可对接任意 MCP 客户端库（官方的、自实现的、或通过子进程启动的）。

**实现边界**：`IMcpTransport` 当前只定义最小接口（`listTools` + `callTool` + `close`），不包含资源模板、提示模板、订阅通知等 MCP 高级特性——这些可在后续版本扩展，不破坏已有实现。

***

## 五、兼容契约（其他 Agent 如何装载）

| 装载方认识程度                                       | 行为                                               |
| --------------------------------------------- | ------------------------------------------------ |
| L1（必读）                                        | persona → system prompt；rules → 约束；skills → 能力清单 |
| L2 已知键                                        | 对应行为开关生效                                         |
| L2 未知键                                        | **警告并忽略（warn + ignore），不阻塞装载**（杜绝拼写错误静默吞掉）       |
| 未知能力                                          | 跳过（可选提示）                                         |
| `formatVersion` 不兼容                           | 拒绝加载 + 提示按迁移规则升级（见下）                             |
| `minKernelVersion` 高于实现版本                     | 拒绝加载（或警告降级运行，由实现决定）                              |
| manifest.json 中内容文件缺失（persona/rules 指向的文件不存在） | 警告降级（内容文件可选，缺失按空处理）                              |

**formatVersion 迁移规则（对齐 Agent Plugins「schema URL 永不重指」）**：

* 每个 `formatVersion` 绑定一个**固定 schema URL**（如 `https://role-pack.dev/schemas/1.0.0/role-pack.schema.json`），发布后**永不改变内容**——同一版本号不可能指向两份不同规范；

* **minor 演进（1.0 → 1.1）**：仅新增 L2 键/可选字段——旧实现按「未知键警告并忽略」装载，新实现全量生效，**无需迁移**；

* **major 演进（1.0 → 2.0）**：键名/语义变更或 L1 结构变化——提供**迁移器**（读旧版 → 写新版），装载器对旧 major 拒绝加载并提示迁移；

* 校验器同时支持「声明格式版本校验」与「可迁移性检查」。

**双闸门演进（键级）——新键进入标准的门槛**：

任何键要进入标准正文（§六），必须依次通过两道闸门；未通过验证门的键只能以 `[草案]` 状态保留在 §六 征集实现验证：

1. **验证门**：该键**必须有参考实现真实消费**（运行时读取并影响行为，而非仅有类型定义/默认值）。无参考实现的键不进标准——纸面设计不构成标准依据（§五 原则 ②）;
2. **中立门**：通过验证门后，命名须中立（不绑任何实现的内部命名），命名与语义一并**冻结**；此后个别实现不得再为自身内部命名改标准（见 §九 对齐声明）。

**僵尸键与预留键原则**：

* **僵尸键（实现内部技术债）**：参考实现内部的已定义但零消费字段（如 memora `types.ts` 中的 `toolWhitelist`/`toolBlacklist` 等）。**只标注不动，不剪枝、不进标准**；不得因"定义过"就主张其进入标准。

* **预留键（设计空间预留）**：为未来行为分支预留的字段。这些字段在代码中会明确标记为「预留键，不承诺当前生效」。预留键**承载设计空间全景**，但在当前版本**内核不消费，声明不生效**，仅作为未来扩展的占位符。消费方应参照 `types.ts` `BehaviorStrategy` 接口的「诚实化声明」清单，区分实际生效键与预留键，避免误以为"声明即生效"。（注：早期 `understandingConfirm`/`costBudget` 曾属此类，现已分别落地为「内核消费」与「已撤键」——`costBudget` 因内核无定价能力、宿主无执行者，于 2026-08-28 从标准撤下；`taskClassification`/`safetyRule` 经审查已清除。当前标准无纯预留键。）

**命名归标准原则**：实现内部旧命名（如 memora 旧 `act.toolCalls` / `reflect.endingHandoff`）通过解析层**别名迁移**到标准键名（旧键 → 新键，warn 降级提示），消费方一律读标准键——实现向标准看齐，而非标准向实现看齐（§九）。

**SSOT 下沉原则（单一真理源）**：

* 当某一逻辑（如格式化、校验、压缩）在多个调用点被使用时，必须下沉到**唯一真理源**（如 `SkillManager.formatSkillForPrompt`）。

* 调用方（如 `RolePackManager`）只负责调用，不包含重复的格式化或压缩逻辑，确保未来修改只需在真理源处进行一次。

**防呆设计原则**：

* 抽象基类的方法（如 `createEntry`）应尽可能提供**默认空实现**（返回 `null` 或默认值），而不是强制子类实现。

* 仅当子类覆写该方法时，才提供实际逻辑。这避免了强制子类实现“永远不会被调用的异常”等防呆代码，降低了维护噪音和代码复杂度。

***

## 六、L2 策略键集（中立命名，v1 最小集）

> 文件内为**嵌套 YAML**（`strategy: { prepare: { ... }, act: { ... } }`），规范引用用**点路径**（`strategy.prepare.summaryFocus`）——两者等价映射，见 §二 样例。键名统一 **camelCase**；此表是 v1 最小集，后续版本演进由 `formatVersion` 控制。
>
> **实现先行、标准追认**：此表只收已归标准的**中立命名键**。实现（memora）可先于标准扩展已消费键（如 `act.outputLimit` / `act.toolStepLimit` / `act.multiStepReasoning` / `global.tokenBudget` / `global.stepBudget` 等），这些键按「实现消费 → 提炼进标准」追认，未入表前不承诺跨实现一致行为（§五 双闸门演进）。完整实现键集与区间见 memora 侧 [role-pack-authoring-guide.md](role-pack-authoring-guide.md) §三 / `src/role-pack/strategyKeys.ts`。
>
> **状态列含义（P0 键集对齐）**：
>
> * **冻结** = 有参考实现（memora）真实消费 + 语义/命名已归标准——任何实现应支持一致行为；
>
> * **`[草案]`** = 尚无参考实现消费，保留在标准正文以征集实现验证（§五 双闸门演进：通过验证门才可冻结）——实现可装载（按未知键 warn + ignore 的键级渐进），但不承诺跨实现一致行为。

| 组       | 键                             | 取值（枚举）                                                | 含义                                                                                         | 状态      | 实现消费要求                                                                                                                                                |
| ------- | ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| prepare | `prepare.contextAssembly`     | `fixed` / `query` / `hybrid`                          | 最近轮次加载策略（**删除**（2026-09-09，memory-tool-recall-design 阶段2）：记忆纯工具化召回后上下文装配恒为 hybrid，不再有 fixed/query 分支；实现直接移除 `resolveContextAssembly`）                   | 废弃      | 删除（阶段2 键族退役；上下文装配固有 hybrid，无角色包开关）                                                                          |
| prepare | `prepare.recentRounds`        | 正整数                                                   | 固定加载轮数（**删除**：被「上下文预算装配」动态轮数取代，见本节文末；实现直接移除，不留过渡兼容）                                        | 废弃      | 动态填充后轮数为派生值，不再显式声明                                                                                                                                    |
| prepare | `prepare.memoryRecall`        | `full` / `limited` / `none`                           | 长期记忆召回（**删除**（2026-09-09 阶段2）：记忆纯工具化召回后无自动注入消费端；实现直接移除 `resolveMemoryRecallMode`）            | 废弃      | 删除（recall 改由 `memory_search` 工具触发）                                                                                                                              |
| prepare | `prepare.memoryRecallQuota`   | 正整数                                                   | 记忆召回限额（token，绝对量）（**删除**：过渡到百分比，见本节文末；实现直接移除 `resolveMemoryRecallQuota`）                   | 废弃      | limited 裁剪改为按 `memoryRecallPercent` cap 换算                                                                                                            |
| prepare | `prepare.memoryRecallPercent` | 0.0\~1.0（角色包设）                                        | 记忆召回占可用预算的百分比（cap 非 quota）（**删除**（2026-09-09 阶段2）：记忆层 cap 由缺口常数取代，见 §上下文预算装配；实现直接移除 `resolveMemoryRecallPercent`） | 废弃      | 记忆层 cap 恒用内核固定比例 0.4（`budget.ts` `DEFAULT_MEMORY_CAP_RATIO`），不再由角色包声明                                                                                    |
| prepare | `prepare.summaryRecall`       | `on` / `off`                                          | 摘要召回（**删除**（2026-09-09 阶段2）：等价语义承接为 `memory_search` 工具 `source` 过滤参数，不引全局键）                       | 废弃      | 删除（全局键语义消失：查询时自选 source 过滤）                                                                                        |
| prepare | `prepare.summaryFocus`        | 非空字符串                                                 | 角色包提炼视角：判断 round-summary「值得记什么」的信息维度与保留形式（领域无关机制，替换通用归纳框架，JSON+SummaryType 硬契约保留；内容由角色包提供） | 冻结      | 由实现提炼进标准（结构化信息保真 + 提炼侧视角下沉）；memora 消费（agent.ts → `resolveSummaryFocus` → `roundSummaryGenerator.generate` 注入提炼视角 prompt）；首个消费者为编程/方案卡，未达「≥2 处复用」机制化门槛 |
| prepare | `prepare.minFallback`         | 非负整数                                                  | 召回保底下限（**删除**（2026-09-09 阶段2）：角色包策略键退役，recall() 函数层默认由 recall.ts 自持），不作用于 loop 自循环阶段的压缩摘要上限                 | 废弃      | `DEFAULT_MIN_FALLBACK` 曾下沉 `utils/recallDefaults.ts`（2026-09-10 随 `recall()` 召回编排一并删除），recall() 调用方按需传参，不经角色包策略 ||
| act     | `act.toolMode`                | `allow` / `block`                                     | 是否允许工具调用                                                                                   | 冻结      | memora 消费（agent.ts 工具开关）；命名归标准（旧 `act.toolCalls`）                                                                                                     |
| act     | `act.temperature`             | 0.0\~2.0                                              | 生成随机性                                                                                      | 冻结      | memora 消费（agent.ts `buildChatOptionsFromStrategy` 注入 ChatOptions.temperature，越界忽略）；**由实现提炼进标准**（对账发现被真实消费后补录）                                         |
| act     | `act.streaming`               | `streaming` / `non-streaming`                         | 输出方式                                                                                       | 冻结      | memora 消费（agent.ts `buildChatOptionsFromStrategy` 注入 ChatOptions.stream）；**由实现提炼进标准**（对账发现被真实消费后补录）                                                   |
| reflect | `reflect.summary`             | `on` / `off`                                          | 摘要生成                                                                                       | 冻结      | memora 消费（seed/orchestrator.ts 轮次摘要生成开关，非法值归位 on）；**由实现提炼进标准**（对账发现被真实消费后补录；memora 旧字段 `summaryGeneration` 为僵尸键，只标注不动）                                |
| reflect | `reflect.selfReview`        | 0 或正整数（兼容旧 'on'→1 / 'off'→0）                          | 自审查轮数：LLM 纯文本回复后自动审查 N 轮（0=关闭）                                                             | 冻结      | memora 消费（agent.ts 自审查轮数，mvp-scope §三·一）；**由实现提炼进标准**（spec 原缺，对账发现被真实消费后补录）；历史键 `loopContinue` 别名回退                                                       |
| reflect | `reflect.userFollowup`        | `ask` / `silent`                                      | 用户追问策略：ask=主动引导对话 / silent=只等输入                                                            | 冻结      | memora 消费（agent.ts 衔接 + types.ts 提问指令注入）；**由实现提炼进标准**（spec 原缺，对账发现被真实消费后补录）                                                                           |
| global  | `global.askOn`                | `ambiguity` / `decision` / `missing_info` / `confirm` | Agent 主动提问触发（可组合）                                                                          | 冻结-条件消费 | memora 消费（types.ts `assembleRolePack` 提问指令注入，**仅** **`reflect.userFollowup=ask`** **时生效**）；条件消费 = 字段冻结，但行为仅在指定策略组合下激活                                 |
| global  | `global.askLimit`             | 正整数（默认 3）                                             | 每任务提问上限                                                                                    | 冻结-条件消费 | memora 消费（同上，userFollowup=ask 时生效，缺省 3）                                                                                                               |
| global  | `global.errorHandling`        | `retry` / `degrade` / `stop`                          | 异常策略                                                                                       | 冻结      | memora 消费（strategyResolver `resolveErrorHandling` → loop 异常处理分支，非法值归位 retry）；**由实现提炼进标准**（对账发现被真实消费后补录）                                               |
| global  | `global.taskLoopLimit`        | 非负整数（默认 10，0=关闭）                                      | 外部任务驱动循环步数上限（**删除**：多 turn 任务编排 2026-09-04 删除后语义收窄为「会议步骤数截断」，2026-09-06 会议确定性预置退役（ADR-028 收敛补记）后键已无常量消费方，实现直接移除，不留过渡兼容） | 废弃      | 三度收敛：多 turn 上限 → 会议截断 → 删除；现迭代上限由 `stepBudget`/`maxIterations` 承载 |

### 角色包配置边界：机制参数开放判定标准（决策依据）

> **用途**：后续"某个参数要不要开放给角色包"时，按以下四条判定，不凭直觉。
> **依据**：2026-08-22 对「替换保留窗口（`replaceRoundsKeepRecent`）」是否开放的评审结论——判定为**不开放**，沉淀此标准。

| # | 维度         | 可开放（✅）                          | 留全局（❌）                        |
| - | ---------- | ------------------------------- | ----------------------------- |
| 1 | **语义归属**   | 装配/内容策略——影响"本轮给模型什么内容"          | 压缩/空间机制——影响"旧轮怎么淘汰"           |
| 2 | **角色感知度**  | 角色差异可感知、可表达、有真实需求（如编程角色要多正文少记忆） | 感知弱、用户难以表达"我这个角色要 X"（如保留几轮正文） |
| 3 | **单一真理源**  | 开放后仍单一来源 + 明确优先级（角色包 vs 宿主选项）   | 开放后制造双真理源、需合并规则               |
| 4 | **真实场景触发** | 已有真实场景体验受损 + 经实测证实              | 无需求、属预埋（违反惰性优化）               |

**判例**：

* ✅ 已开放：`prepare.summaryFocus`（内容提炼视角，角色提供）；`prepare.memoryRecallPercent` / `prepare.minFallback` 曾开放，随阶段2（2026-09-09）召回键族整体退役（见 §上下文预算装配 注记）

* ❌ 留全局：`replaceRoundsKeepRecent`（替换保留窗口，压缩机制、角色感知低——已固化 Agent 级选项 + 默认 5，见 §上下文预算装配）、`archiveMode`（会话归档机制）

### 上下文预算装配（动态轮数，已冻结）

> **状态**：已冻结（2026-08-23 固化）。完整对话进入量从「固定 N 轮（recentRounds）」改为「按上下文预算动态填充」，轮数为派生值、不显式声明。容量来自模型运行时，分配偏好来自角色包。
>
> **固化依据**：代码已落地并被测试锁定（96 文件 / budget·loop·compaction·contextPreparer 专项测试），被 src 生产代码引用，经真实场景消费验证——满足 S2 触发条件（探索期决策沉淀机制）。

#### A. 动机

固定 N 轮与内容长短脱节——短消息浪费容量、长内容（代码粘贴）超限触发 contextManager 截断丢旧消息。把「装几轮」改成派生值，由「角色包分配偏好 × 模型运行时容量」共同决定，才能真正用满窗口。

#### B. 角色包键面（阶段2 后归零，记忆层 cap 由内核常数承载）

> **阶段2 注记（2026-09-09，memory-tool-recall-design）**：本表两个分配键 `prepare.memoryRecallPercent` / `prepare.minFallback` 已随召回策略键族**整体退役**（表② minFallback 本属召回保底，非「记忆摘要层分配」，归入键族一并移除）。记忆摘要层 cap 比率现为**内核常数** `budget.ts` 的 `DEFAULT_MEMORY_CAP_RATIO = 0.4`（见 §上下文预算装配 顶层常量），不再由角色包声明——「上下文预算装配」动态轮数填充机制本身保留。

迁移面下 L2 键**原**保留 2 个分配键（现均已退役，列此留档）：

| # | 键                                       | 作用域           | 含义（退役前）                                                                        |
| - | --------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| ① | `prepare.memoryRecallPercent`（0.0\~1.0） | 分配上限（cap，非定额） | **记忆摘要层占可用预算的上限百分比**。记忆摘要层 = 完整对话层填满后剩余空间的拾遗填充，≤ 预算 × 该值；只装完整对话层未覆盖的旧摘要；与正文章节互斥不双写。现由内核常数 `DEFAULT_MEMORY_CAP_RATIO=0.4` 取代 |
| ② | `prepare.minFallback`（非负整数）             | 运行前装配保底       | **召回保底下限**：recall 语义结果不足此数时，补最近记忆补足。曾由 `utils/recallDefaults.ts` 的 `DEFAULT_MIN_FALLBACK=2` 函数层默认取代；该常量已随 2026-09-10 剪枝删除（`recall()` 召回编排整体退役），召回保底机制**不存于现行实现**           |

> 原键面③ `global.taskLoopLimit`（硬上限兜底）已删除（2026-09-06，见上表删除标注）：loop 迭代上限现由 `stepBudget`（软上限）与内核 `maxIterations`（`DEFAULT_MAX_ITERATIONS` 兜底）双重承载，不再设角色包「硬上限」键。
> `contextAssembly`（fixed/query/hybrid）、`memoryRecall`（full/limited/none）、`summaryRecall`（on/off）、`recallConfidence` 等开关已随阶段2（2026-09-09）召回键族整体退役——记忆纯工具化召回后无自动注入消费端，不再有固定/查询装配分支。

#### C. 预算模型（容量来源 × 分配偏好 → 派生轮数）

```
可用预算 = Provider窗口 − 固定开销(system+persona+rules+技能L1+工具schema)
        − 输出预留(≈15~20%)

顶级锚点空间 = 触发输入 + 首个回答（独立划块，永不压缩，不参与百分比分配）
剩余预算    = 可用预算 − 顶级锚点空间

完整对话层 = 剩余预算，从最近往回塞到 ~90% 止（先装，锚点不动）
记忆摘要层 = 剩余预算 − 完整对话层实际占用（拾遗填充，≤ 剩余预算 × 内核常数 `DEFAULT_MEMORY_CAP_RATIO`（0.4））
动态轮数   = 完整对话层能装几轮就是几轮（派生值，不显式声明）
```

* **现为内核固定 cap 而非角色包 quota**：完整对话层无条件优先，记忆摘要层是"完整对话层填满后剩余空间的拾遗"，`DEFAULT_MEMORY_CAP_RATIO` 只封顶防止记忆挤占对话（洞 2 解法）——阶段2（2026-09-09）该 cap 由角色包键 `memoryRecallPercent` 退役为内核常数（`budget.ts`），不再逐包声明。

* **顶级锚点独立划块**：触发输入+首个回答自预算公式最上游划走，永不压缩；剩余预算低于最小可运行阈值 → 装配前判定无法支撑 loop（确定性拒绝，而非跑起来后提前软上限）（洞 3 解法）。洞 3 有**两道防线**：

  * **第一道 · 产品输入上限**：超大内容在**源头**被控住——输入框设字符上限，超大内容改走文件、用 `read_file` 读，不让大文本进上下文撑爆后续运转（对齐大厂输入可控约定）。

  * **第二道 · 装配前判负（兜底）**：即便第一道放行了，装配前仍用公式算一遍——顶级锚点划走后剩余预算 < 最小可运行阈值 → 确定性拒绝/降级（提示"内容过大，建议放进文件用 read\_file 读"），而非放任跑起来后提前软上限。

三层分工：容量（Provider/模型，运行时）→ cap 常数（内核 `DEFAULT_MEMORY_CAP_RATIO`，仅封顶）+ 锚点（内核，独立划块）→ 轮数（内核按预算填充派生）。

#### D. 锚点分级（装配 vs 压缩，两个维度不冲突）

完整对话**装配维度**和 loop **压缩维度**是两件事，分别定义：

| 内容                         | 装配维度（完整对话装载）                    | 压缩维度（loop 溢出时）            | 说明                                   |
| -------------------------- | ------------------------------- | ------------------------- | ------------------------------------ |
| 会话第一条问答闭环                  | **必然加载**（默认在场）                  | ✅ 允许压缩（次级锚点）              | 提供初始背景，可牺牲                           |
| 触发 loop 的问答闭环（用户输入 + 首个回答） | **必然加载 + 独立划块**（顶级锚点）           | ❌ **永不压缩**（顶级锚点）          | 整个 loop 的存在理由，语义根不能漂移；自预算公式最上游保留独立空间 |
| 其余 turn 正文                   | 按预算从最近往回塞到 \~90% 止（留 buffer 防抖） | 溢出即压成压缩摘要（loop 内临时态，收尾即弃） | 可压区                                  |

> 装配 vs 压缩是两个独立维度：「装配必然加载」≠「压缩永不牺牲」。次级锚点（第一条）默认在场，但压缩到极致时允许让位给压缩摘要。

#### D2. 两级空间管理（替换优先，压缩兜底）

空间不足时，**先替换、再压缩**，两级优先级排列：

* **第一级 · 替换工具（从记忆直接取，零生成成本）**：问答闭环收尾必产记忆摘要并存库，故每个已完成闭环都有现成摘要。空间不足时，把完整对话层中某轮正文**替换成它自己的记忆摘要**——不是新生成，是从库中取对应摘要，成本近乎为零。loop 场景同样适用：上一轮完整问答闭环进来时，若已沉淀记忆摘要，直接替换。此工具与 loop 压缩是**同一转换能力的两级**，而非两套独立维护的逻辑（单一真理源）。

* **第二级 · loop 压缩工具（临时生成，无可替换时才用）**：作用对象是**尚无记忆摘要**的东西——进行中的 turn、超大 tool\_result。产临时压缩摘要，loop 收尾即弃，不进记忆库。

> **作用对象互补**：替换工具只对"已沉淀记忆摘要的问答闭环"可用；压缩工具只对"无记忆摘要的 turn/工具结果"可用。同一空间管理链条的两级，不是并列工具。

> **裁决归属（内核 vs LLM）**：
>
> * **替换 = 内核自动、确定性、按最早时序（LRU）做**——它是机械搬移（从库取现成摘要换掉最旧轮次），无任何语义判断，**不交给 LLM，也不暴露为 LLM 可调的工具**。LLM 无感，仅在摘要过短、上下文可能断裂时才给一个只读提示（可经 `trace_summary` 回溯原始对话）。
>
> * **压缩 = 由 LLM 触发**——只有它需要现场语义判断（把尚无摘要的 turn/工具结果压成临时摘要）。**区分度：可机械搬移（替换）→ 内核自动；需语义生成（压缩）→ 交 LLM。** 遵循单一真理源（替换与压缩共享同一"正文转摘要"转换能力）。

> **压缩的目标边界（顶级锚点保护，硬约束）**：压缩工具（`compress_context`）只作用于**当前触发输入（顶级锚点）之前、已完成使命的旧 turn/工具结果**；当前输入所在轮次**永不压缩**。若上下文**无当前输入之前的旧轮次**（如新对话第一轮就触发压缩），压缩工具返回「无可压缩目标」——此时正确的出口是**软上限收尾**（注入收尾信号、LLM 收敛交付），而不是把触发输入压掉继续硬跑。语义闭环：**压缩永远只压"根之前"的旧轮次；根之前没有旧轮次时，该收尾就收尾，不压根。**

> **替换的保留窗口（单一真理源参数）**：替换策略保留**最近 N 轮正文原样**（保证对话连续性），越界轮次按 **LRU 最早先换**。默认 `N=5`（实现常量 `DEFAULT_REPLACE_KEEP_RECENT_ROUNDS`），宿主可用 `replaceRoundsKeepRecent` 覆盖。**触发条件为"轮数越界"而非 token 预算**——早替换无害（越界旧轮次本将让位），优先简单确定性。**截断重排后替换层跳过**：截断会提取关键消息重插中间，roundId 与轮次的尾部对齐映射失效，此时替换降级 no-op，空间维护交回截断机制的摘要注入（避免错位替换正文）。

#### D3. 替换与召回的互斥（装配时间线闭合）

替换产物会不会被召回重复注入？**不会**——由装配时间线自然保证，无需额外互斥逻辑：

```
装配帧（外部输入触发）：
  ① 算 exclude：recentRoundIds = 完整对话层将注入的轮次（含即将注入的正文轮次）
  ② 召回：recall(excludeRoundIds) —— 剔除这些轮次的摘要，装的是完整对话层之外的旧摘要
  ③ 装正文：把最近 N 轮正文注入完整对话层（第一条问答闭环若在最近 N 轮，必在其中）
运行帧（loop 只追加 / 长对话靠替换）：
  Loop：仅追加本轮结果，不召回
  长对话：某轮正文被「替换」成它自己已存摘要（替换产物与记忆库中该摘要同 roundId）
下一装配帧：
  该轮已在最近 N 轮 → getRecentRoundIds 涵盖 → 再次记入 exclude → 其摘要不会被动二次召回
```

**关键**：召回**只发生在装配时这一次外部输入**；替换发生在**运行阶段且运行阶段不召回**。替换产物（roundId 已在记忆库）在下一次装配时被 `exclude` 集**自然收纳**，绝不双写。**互斥是"装配时 exclude 覆盖了\[正文+替换产物]对应轮次"这一事实的派生物，无需专门互斥机制。**（注：`excludeRoundIds` 按 `roundId` 过滤，凡已注入正文或已替换成摘要的轮次，其 roundId 都在集内。）

> 该时间线与 memora 实现一致：`contextPreparer.recallAndInject` 先算 `getRecentRoundIds` → `recall(excludeRoundIds)` → 后 `getRecentHistory` 注入正文；`recall.ts` 按 `metadata.roundId` 前置过滤。因果闭合。

#### E. Loop 终止条件（三条件 OR 触发）

loop 何时收敛停止，由以下三条确定性信号 OR 触发，任一命中即终止：

1. **硬上限**：内核 `maxIterations`（`DEFAULT_MAX_ITERATIONS` 兜底）+ 角色包 `stepBudget` 软声明——防死循环烧 token 的确定性兜底。**触顶不是硬止损**：收尾时报告完成进度 + 列出未完成内容，等用户输入继续；下一次装配按记忆递归自然续接（此段问答闭环也照常沉淀一条"做到哪、剩哪"的记忆摘要）。（2026-09-06 起原「键③ taskLoopLimit 硬上限」已删，迭代上限回归上述双承载。）
2. **软上限**（内核预算检测，无角色包键）：替换/压缩已把**完整对话层除顶级锚点外全部替换为摘要形态**，且**摘要层 token 达容量上限**——注入收尾信号，LLM 收敛产出最终交付。触发点是**摘要层容量阈值**（确定性物理量），不是「全变摘要了吗」的状态快照。
3. **自然结束**：LLM 完成任务交付——turn 自己收敛为 done（2026-09-05 废弃前用 handoff=end/wait 表示，turn 内不再有 Handoff 决策键）。
4. **装配前判负**（洞 3 独立路径）：顶级锚点（触发输入+首个回答）划走后剩余预算 < 最小可运行阈值 → 该输入无法支撑 loop，装配前确定性拒绝/降级，而非计入上述软上限统计。

> 软上限属于**内核**，不需要角色包键：角色包只负责「分配上限（①②）」，容量计算与软上限信号由内核统一预算检测产出，保持角色包键面最小。触发输入本身过大是与软上限**不同的失败原因**，走独立的装配前判负路径。

#### F. 受影响键与互斥约束

* **删除**：`recentRounds`（轮数语义消失，动态填充后轮数为派生值；实现直接移除，不留过渡兼容）。

* **删除**：`memoryRecallQuota`（绝对 token 语义在动态容量下不自洽，由键① `memoryRecallPercent` 取代；实现直接移除 `resolveMemoryRecallQuota`）。

* **开关移除**：`contextAssembly`（fixed/query/hybrid）随阶段2（2026-09-09）召回键族退役——记忆纯工具化召回后上下文装配恒为 hybrid，不再有 fixed/query 分支（见 §六 键表）。「fixed/hybrid 的最近对话装载由固定 N 轮改按预算填充」的预算化语义已并入 §上下文预算装配（动态轮数），无需该开关。

* **互斥约束**：记忆摘要层与完整对话层须维持互斥。**互斥是"完整对话层实际注入轮数"这个事实的派生物**（不是独立参数）：`excludeRoundIds` = 完整对话层注入的正文轮次集合，记忆摘要层只装这些轮次之外的旧摘要——因果闭合，无需单独计算窗口（洞 2 解法）。

***

## 七、合规与安全（中国 AI 拟人化新规对齐，2026-07-15 施行）

**背景**：《人工智能拟人化互动服务管理暂行办法》（2026-07-15 施行）划定"拟人化互动服务"红线；**豁免条款**明确"智能客服、知识问答、工作助手、学习教育、科学研究等不涉及持续性情感互动的服务不适用"。角色包范式定位**生产力 Agent（工作助手）**，落在豁免区间；但合规必须内建为标准属性，而非事后补丁。

**标准级合规设计（角色包自带）**：

1. **AI 身份标注**：`manifest`/frontmatter 声明 `aiIdentityDisclosure`（`true` 默认值）——**标准级仅要求字段可声明**；**实现级强制生效**：memora 作为 reference implementation 必须向用户明确标注 AI 身份（新规红线之一），并对缺失该字段的 `companion` 角色包拒绝加载；
2. **rule 段 = 内容红线载体**：`## Rules` 承载内容安全约束（不生成违法/低俗/侵权内容、不涉真实个人隐私、不诱导沉迷），随角色包装载即生效——**让"平台审核责任"落到结构化可校验的规则上**；
3. **拟人化场景声明**：frontmatter/manifest 增加 `interactionType: tool_assistant | companion`（默认 `tool_assistant`）——声明本角色包是**工具型工作助手**（豁免区间）还是**拟人化陪伴**（落入《办法》管辖，需单独合规路径 + 物理隔离）。**分档校验**：标准级**可选**（缺省即 `tool_assistant`）；**仅当显式声明** **`companion`** **时**，校验器执行完整合规检查（虚拟亲密关系红线拒绝、强制 `aiIdentityDisclosure`、`minorProtection` 必填）；memora 实现级对未声明且缺失合规字段的装载默认放行但提示补全；
4. **未成年人保护钩子**：`manifest` 声明 `minorProtection: required`（默认）——实现必须提供监护人管控入口（对应新规未成年人模式要求）；
5. **禁止面向未成年人的虚拟亲密关系**：校验器拒绝 `companion` 类角色包携带"虚拟亲属/虚拟伴侣"特征（红线）。

**范式方向约束（最重要的一条）**：角色包生态的立身之本是**生产力**（工作助手、知识问答、工具执行）——**不做情感陪伴、不做虚拟恋人**。豆包/千问 2026-07 下线的是无工具、无决策、不可控的 UGC 陪聊 Bot；千问保留并加码的正是"协议化、工具化、能落地"的工具型 Agent——角色包标准站在这条政策允许且鼓励的赛道上。

**安全审计（角色包发布前提）**：角色包是可下载、可共享的装载卡——是**供应链攻击载体**。行业实测：公开技能库中 **36% 含提示注入**（Snyk）、平均质量仅 6.2/12（SkillsBench）——无审计的开放目录是风险源。因此**安全审计是角色包进入可传播目录的前提**（不只合规）：角色包的 persona/rules/strategy/内嵌 skills 在发布前须经注入检测与质量审查；memora 作为 reference implementation 对下载角色包做基础注入扫描，发现恶意内容拒绝装载。签名/完整性校验（防篡改）随"硬通货"远期规划一并落地（见定位宣言演进状态）。**当前不实现，先确立硬门槛。**

***

## 八、校验（跨实现一致性）

* 提供**格式校验器**（独立于任何实现）：校验 manifest.json 的必填字段（`name`/`formatVersion`）、键名合法性、版本语义、顶层字段类型与上限（§二，含 handoffPrompt）、L2 策略键与区间（§六）、capabilities 格式（§四）、**合规字段（§七，分档：仅** **`companion`** **角色包全量强校验，`tool_assistant`** **默认值兜底）**；**内容文件零声明**——persona/rules 为约定文件名，不校验路径注册，由装载器回退约定名；skills 为目录扫描（C3），技能文件 frontmatter 由装载器读取，不在 manifest 校验面；

* **内容红线检测 = 装载边界的"守门提示"（§七 第 5 条，区别于格式校验器）**：正文在独立内容文件（persona.md/rules.md），格式校验器为**纯函数不读文件**——它只保证 manifest.json 的"格式正确"，是**正确性守门人**；而 companion 虚拟亲密关系红线是**安全守门人**，由装载方在读取内容后调用 `checkCompanionContentRedline` 检测，触发即拒绝装载。二者职责分离：**格式校验器管"合不合规范"，内容红线检测管"该不该放行"**——前者失败提示修正格式，后者失败（仅 `companion`）直接拦截，不作为格式问题混报；`manifest.json` 层仅校验合规字段声明（interactionType / disclosure / minorProtection）；

* 校验通过 = 任何实现可装载；校验失败 = 实现拒绝加载并给出原因；

* 目标是生态内角色包**一次编写，处处装载**。

***

## 九、与 memora 的关系

| 项                                                                                            | 说明                                                                                                       |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| memora                                                                                       | **reference implementation**（首个实现本标准的 Agent 内核）；**合规从严执行**：标准级合规字段为可选 + 分档（§七），memora 实现级强制 AI 身份标注等合规义务 |
| `role-packs/`（memora 仓库）                                                                     | 示例角色包（小说助手 / 文档设计师 / 方案设计师，结构参考，不参与运行时分发）                                                                |
| [architecture\_philosophy\_rules.md §11](../../.trae/rules/architecture_philosophy_rules.md) | memora 视角的角色包定位（插卡机模型，通用引擎 ↔ 专业卡）                                                                        |
| [mvp-scope.md §二](mvp-scope.md)                                                              | MVP 落地范围 = 本标准的 L1 + 核心 L2 键子集                                                                           |
| 演进状态                                                                                         | 角色包标准处**草案演进期**，v1 字段冻结延后至内核基础（turn / 记忆系统）定型后——见本文档定位宣言                                                 |

> 标准优先于实现（P0 键集对齐）：memora 已对齐本规范中立命名——`strategy.act.toolCalls` → `act.toolMode`；解析层保留旧键 → 标准键**别名迁移**（warn 降级提示，不阻断装载），消费方一律读标准键。memora 内部曾定义但零消费的字段（如历史上的 `understandingConfirm`/`taskClassification`/`reflect.endingHandoff`）经审计已清除；`reflect.handoff` 键 2026-09-05 废弃（turn 结束即 done，不再有衔接决策）。规范演进以 `formatVersion` 控制，不破坏已装载的卡。

### 9.1 来源边界声明

> **问题**：角色包来源区分（内置 vs 插件贡献 vs 未来用户自定义）应该由谁承担？
> **结论**：**内核不感知来源语义，多来源由宿主以多实例（multi-instance）承载**。此声明是"内核-宿主"职责边界的一部分，防止来源区分逻辑反向渗入内核。

**职责划分**：

| 职责                    | 归属                    | 说明                                                     |
| --------------------- | --------------------- | ------------------------------------------------------ |
| 装载 `role-packs/` + 激活 | 内核（`RolePackManager`） | 构造入参 `configDir`，扫描 `<configDir>/role-packs/`；保持最小单元不变 |
| 来源是什么、有几个来源           | 宿主                    | 决定 configDir / 实例个数（每个来源一个 `RolePackManager` 实例）       |
| 来源分组展示、只读标记           | 宿主                    | UI 策略（如"插件 A 贡献的角色包"分组）                                |
| 用户自定义（未来）             | 宿主                    | 新增一个实例指向用户目录                                           |

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

* **来源语义 = 哪个实例**：宿主聚合各实例 `listMeta()` 展示，按实例分组天然完成"哪个插件提供的"；

* **命名冲突天然隔离**：同名角色包分属不同实例不冲突；

* **只读/可编辑 = 宿主对实例的策略**：插件实例只读，用户实例可写；

* **零内核改动**：内核保持"装载+激活"最小单元，不感知来源。

**伏笔的正确形态**：不预埋字段，而是**明确边界让未来自然生长**（单一真理源）。未来开放用户自定义时，宿主只需：新目录放用户角色包 → 新建 `RolePackManager` 实例 → 聚合两实例列表展示。内核一行不改。

#### 示例库 vs 宿主生产库

> **问题**：memora 仓库根 `role-packs/` 与宿主内置（如插件 `src/extension/role-packs/`）存在同名角色包，是否需强制同步？
> **结论**：**不追求同步**。两者定位不同、归属独立、生命周期各自演进，不属于 SSOT 反模式（stale mirror）。

| 目录                 | 身份                               | 归属                                          | 分发       |
| ------------------ | -------------------------------- | ------------------------------------------- | -------- |
| 根 `role-packs/`    | **示例 / 参考**（展示角色包目录结构、字段用法、内核机制） | memora 内核示例库                                | 不进入任何运行时 |
| 宿主内置 `role-packs/` | **生产配置**（端用户实际使用）                | 各宿主（当前插件由 esbuild `copyRolePacks` 内嵌进 dist） | 随宿主产物分发  |

**处理原则**：

1. 示例库与生产库**各自独立维护**，内容相似是"示例恰好选用了同名角色"，非同一份数据的多拷贝；
2. 接入者应以**宿主内置**为生产真理源，根示例库仅作**结构 / 字段 / 能力参考**；
3. 新增宿主时，复制根示例到宿主内置后即"分叉"，后续各自演进，不回写根示例。

> 根示例库的接入者指引见 [role-packs/README.md](../../role-packs/README.md)（声明性入口，本处为规范性定义）。

### 9.2 内容层归属声明

> **问题**：persona / rules / skills 的「内容」由谁承载？角色包还是记忆系统？
> **结论**：**设定记忆（persona / rules / skills）唯一归角色包内容层（L1）**；记忆系统只承载**对话记忆**（round-summary，按 summaryType 分类）。二者是两种东西，不互存、不双写。详见 [memory-role-pack-boundary.md](memory-role-pack-boundary.md)。

**分界线（设计真理源）**：

| 维度                                    | 归属       | 承载形态                                                          |
| ------------------------------------- | -------- | ------------------------------------------------------------- |
| 你是谁 / 你怎么做事（persona / rules / skills） | **角色包**  | `persona.md` / `rules.md` / `skills/*`（manifest.json 注册，§2.2） |
| 聊了什么 / 发生过什么                          | **记忆系统** | round-summary（带 summaryType 分类标签）                             |

**配套约束**：

1. **记忆库不写入设定记忆**：`persona` / `rule` / `skill` 不作为记忆库 source 写入（记忆库写入路径已收敛，设定记忆唯一归角色包）。
2. **角色包不写对话记忆**：角色包只承载设定，不承载轮次摘要。
3. **存量兼容**：已写入记忆库的存量设定记忆行保留（软删兼容），但不再有新写入；宿主提供一次性迁移即可清理。
4. **guardrail 已摘除**：guardrail 为「零规则、无扫描映射、无消费者」的空转链，已随档 1 一并移除；原「guardrail 归宿待定」决策作废（见 memory-role-pack-boundary.md §四档 3）。

**演进状态**：已收敛至目标态——`PersonaManager` 与 persona 兜底已移除，`assembler.ts` 的 `systemPrefixParts` 唯一装配 `rolePackPrompt` + 全局技能清单；角色包优先且唯一（见 memory-role-pack-boundary.md §四档 2/3）。

***

## 十、与行业标准的关系（Agent Skills / Agent Plugins）

| 标准                                      | 定位                                                     | 与角色包的关系                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Agent Skills（Anthropic 2025-12）         | 能力单元（SKILL.md + scripts/references/assets，渐进披露）        | 角色包**内嵌兼容**：`skills/` 即 Agent Skills 格式；L1/L2/L3 渐进披露同构（§2.4）                                                            |
| Agent Plugins 1.0（2026-08-06，五方+Google） | 能力+工具连接的文件夹包（plugin.json + skills/ + mcp.json + 反域名扩展） | **骨架同构**（§二）：文件夹 + manifest + skills/ + 命名空间扩展；角色包在其上增加**行为层**（persona/rules/strategy）——行业可移植层目前**不含身份/行为**，这正是角色包的差异化空白 |
| memora                                  | 角色包的 reference implementation                          | 见 §九                                                                                                                     |

**竞争姿态（范式立场）**：不与 Agent Plugins 竞争「能力分发」，而是补齐其明确留白——**行为分发**（有身份的 Agent 行为单元）。Agent Plugins 把 persona 留给 client-specific 扩展（如 VS Code `agents/` 目录）；角色包把 persona/rules/strategy 做成**可移植核心（L1）**。反域名命名空间目录（`com.memora/`，§2.2）保证两者共存：**标准核心对齐行业，专有行为层进命名空间**——不绑死任何一家，也不放弃差异化。

***

## 十一、A2A 协议预留

> **定位**：A2A（Agent-to-Agent）是 Google/Microsoft 推动的智能体间通信协议。memora 当前定位为单 Agent 引擎，不实现 A2A 客户端；但角色包格式在设计上预留多 Agent 场景的可扩展性，为后续生态发展留出空间。

**预留原则**：

1. **角色包不自洽**（[architecture\_philosophy\_rules.md §11.2](../../.trae/rules/architecture_philosophy_rules.md)）：角色包不包含执行引擎，依赖宿主 Agent 的闭环引擎运行。这一特性天然适用于多 Agent 场景——每个角色包实例是一个独立 Agent，由宿主编排。
2. **interactionType 扩展点**：`interactionType` 字段（§七）当前为 `tool_assistant` / `companion` 二分，未来可扩展 `gateway` 或 `coordinator` 等角色类型，由宿主注入 A2A 路由逻辑。
3. **能力声明可路由**：`capabilities` 声明（§四）是中立能力名，多 Agent 宿主可基于能力名将子任务路由到对应角色包实例——memora 的插卡模型天然支持这种"Triage and Specialist"架构（2026 年行业标准，见 [§四·二 MCP 集成设计](#四二-mcp-集成设计接口定义--角色包声明路径)）。
4. **当前不实现**：memora 内核不包含 A2A 客户端代码，不定义 A2A 传输接口。多 Agent 编排由宿主在闭环引擎之上实现，内核不感知。

**未来演进方向**（非承诺）：

* 当生态需要多角色包协作时，可定义 `A2A 声明` 字段（如 `dependsOn: ["role-pack-a", "role-pack-b"]`），由宿主负责解析依赖并启动对应的 Agent 实例；

* A2A 传输层可复用 `IMcpTransport` 相同的注入模式（依赖倒置，宿主注入），不引入内核依赖。

