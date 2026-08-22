# 角色包开放键使用指南（发布包版）

> **面向对象**：安装 `@zooique/memora` 后，编写 / 理解角色包（role pack）的开发者——既包括**宿主接入者**（要把角色包能力接进自己的产品），也包括**角色包作者**（要填写 `manifest.json`）。
> **定位**：本指南回答「manifest.json 里的开放键填什么、**被谁消费**、有什么上限」。它是 memora 发布包内的角色包使用入口。
> **相关文档**：
> - 中立规范（跨所有 Agent 实现的契约，**仓库内文档**）：[role-pack-spec.md](./architecture/role-pack-spec.md)
> - 详细填写手册（含全部区间 / 错误修正 / 键的落实状态，**仓库内文档**）：[role-pack-authoring-guide.md](./architecture/role-pack-authoring-guide.md)
> - 示例角色包（结构参考，不参与运行时分发）：[role-packs/](../role-packs/README.md)

---

## 一、角色包是什么

角色包 = 一个文件夹 + `manifest.json`（唯一核心控制文件）+ 内容文件：

```
角色包名/
├── manifest.json        # ★ 元数据 + strategy 策略 + capabilities + skills 白名单
├── persona.md           # 角色身份设定（约定文件名，可缺省）
├── rules.md             # 确定性规则（约定文件名，逐行解析）
└── skills/              # 技能目录（动态扫描，新增技能只写文件即可）
```

把角色包文件夹放进 `configDir/role-packs/` 即可装载。`manifest.json` 里的字段统称**开放键**——它们是内核、宿主、UI 三方协作的契约，本文档回答「谁在用它们」。

---

## 二、三层消费方逻辑（先理解"键被谁用"）

所有开放键的消费方分三层，**不是所有键都是给宿主接入的**：

| 层 | 消费方 | 键 | 用途 |
|----|--------|-----|------|
| **① 内核直接消费** | memora 内核 | `keywords` / `trigger` / `exclusiveWith` / `skills` / `strategy` | 自动匹配、互斥判定、技能扫描、行为策略 |
| **② 中立接口（宿主接入点）** | 宿主 / 其他实现 | `capabilities` / `handoffPrompt` | 能力映射、接手话术 |
| **③ 元数据（UI 展示）** | 宿主 UI | `name` / `displayName` / `description` / `author` | 标识与展示 |

### 2.1 ① 内核直接消费层（memora 实现细节）

这些键由 memora 内核自己跑逻辑，**宿主不需要处理**：

- `keywords` / `trigger`：合并为**匹配词源**，供 `autoMatch` 自动匹配角色包（`trigger` 兼容 `keywords` 双写法，字符串数组或逗号串，**非正则**）。
- `exclusiveWith`：互斥角色包名列表，用于粘性切换判定（A 声明排除 B，B 应反向声明 A）。
- `skills`：内嵌技能白名单（目录动态扫描，声明项仅作白名单过滤；不声明则全量扫描 `skills/`）。
- `strategy`：L2 行为策略（`prepare` / `act` / `reflect` / `global` 四组），控制记忆召回、工具、衔接、预算等行为偏好。

> 这些键的**上限由内核统一守门**（见 §2.4），因为解析入口在内核。

### 2.2 ② 中立接口层（宿主接入点）

这一层是**为宿主 / 跨实现接入预留的中立契约**——角色包不绑具体实现，由各实现自己消费：

- **`capabilities`（能力声明）**：以**中立能力命名空间**声明（`域:动作`，如 `file:write` / `web:search`），不绑具体工具。**各实现（memora 是 reference implementation）自行映射到自有工具**：
  - memora 侧映射表在 `src/role-pack/capabilityMap.ts`（SSOT）——`file:read` → `read_file`、`web:search` → `web_search` 等；
  - **宿主可以有自己的映射表**：例如 `code:execute` 需宿主注入 `ICodeExecutionProvider` 才真正暴露；
  - 未知能力（不在映射表）跳过，不阻塞装载。
  - 角色包声明 `capabilities` 后，工具暴露面 = 该角色包能力白名单（换角色 → 工具集切换）。
- **`handoffPrompt`（接手话术）**：该角色包**被宿主带入对话（激活 + 聚焦）时**预填输入框的特色衔接话术——作者为「这个角色接手任务时怎么说」定制的提示词，缺省由宿主回退通用话术。**宿主消费**（如 memora-vscode 在 `roles_handoff` 处理中读取 `listMeta().handoffPrompt` 预填）；内核仅透传 + 校验（非字符串 warning 不阻塞装载）。

### 2.3 ③ 元数据层（UI 展示）

- `name`（唯一标识，缺失用文件夹名兜底）、`displayName`（UI 展示名，缺省回退 `name`）、`description`、`author`。
- 内核仅作标识/校验；真正消费是宿主的角色包清单 / UI 展示。

### 2.4 为什么上限由内核统一守门

**无论最终消费方是谁，`manifest.json` 的解析入口都在 memora 内核**（`validator.ts` 校验 + `rolePackManager.ts` 装载）。内核作为装载器在入口守门——对所有开放字段统一限长：

- 对**内核字段**：防资源失控（匹配词列表膨胀拖慢 autoMatch、巨型内容占内存/上下文）；
- 对**宿主字段**：防巨型数据透传给宿主（宿主收到的是已被内核约束过的安全数据）。

这正是「零依赖内核」哲学：**内核做守门，宿主做消费**。所以上表中所有字段的上限，全部由内核入口统一控制（见 §三），不区分消费方。

---

## 三、开放键速查表（消费方 + 上限）

> 详细区间 / 错误修正 / 键的落实状态见 [role-pack-authoring-guide.md](./architecture/role-pack-authoring-guide.md)（仓库内文档）。下表是发布包内的精简速查。
> **上限 SSOT**：`src/role-pack/validator.ts`（非策略键）与 `src/role-pack/strategyKeys.ts`（策略键数值区间）。

### 3.1 元数据层

| 键 | 类型 | 消费方 | 上限 | 说明 |
|----|------|--------|------|------|
| `name` | string | ③ UI / 内核标识 | ≤200 字符 | 唯一标识（缺失用文件夹名兜底） |
| `displayName` | string | ③ UI | ≤200 字符 | UI 展示名，缺省回退 `name` |
| `description` | string | ③ UI | ≤200 字符 | 角色包描述 |
| `author` | string | ③ UI | ≤200 字符 | 作者/来源 |

### 3.2 中立接口层（宿主接入）

| 键 | 类型 | 消费方 | 上限 | 说明 |
|----|------|--------|------|------|
| `capabilities` | 对象数组 | ② 宿主 / 各实现映射 | ≤50 项 | `{ capability: "域:动作", description? }`；映射到各实现自有工具 |
| `handoffPrompt` | string | ② 宿主预填 | ≤2000 字符 | 被带入对话时预填的接手话术 |

### 3.3 内核消费层

| 键 | 类型 | 消费方 | 上限 | 说明 |
|----|------|--------|------|------|
| `keywords` | string[] 或逗号串 | ① 内核匹配 | 最多 20 个，单个 ≤50 字符 | 自动匹配关键词 |
| `trigger` | string[] 或逗号串 | ① 内核匹配 | 最多 20 个，单个 ≤50 字符 | 触发词（精确/包含匹配，**非正则**）；与 keywords 合并 |
| `exclusiveWith` | string[] 或逗号串 | ① 内核互斥 | 最多 20 个 | 互斥角色包名（粘性切换判定） |
| `skills` | 对象数组 | ① 内核扫描 | ≤50 项 | 技能白名单（`{ file, name?, description? }`） |
| `strategy` | 嵌套对象 | ① 内核行为 | 各数值键有上下限（见 authoring-guide §四） | L2 行为策略（prepare/act/reflect/global） |

> **越界行为统一**：开发期 `validator` 校验报 error（拒绝装载提示）；运行时按上限截断 / 回退默认（宽容容错）。

---

## 四、内容文件约定（零声明）

`persona.md` / `rules.md` / `skills/` 全部**约定俗成**——manifest **不注册内容路径**（防路径写错静默丢内容）：

| 文件 | 约定 | 说明 |
|------|------|------|
| `persona.md` | 约定名 | 角色身份设定（frontmatter 可声明 `traits.*` 数值 trait，clamp 0-1） |
| `rules.md` | 约定名 | 确定性规则（逐行解析 `- ` / `* ` / `n. ` 列表） |
| `skills/` | 目录动态扫描 | 新增技能只写文件即可，frontmatter 声明 `name` / `description`（渐进披露 L1） |

---

## 五、最小示例

```json
{
  "name": "doc-writer",
  "displayName": "文档设计师",
  "description": "技术文档设计角色包",
  "keywords": ["文档", "API", "教程"],
  "formatVersion": "1.0.0",
  "interactionType": "tool_assistant",
  "strategy": {
    "prepare": { "memoryRecall": "full", "contextAssembly": "hybrid" },
    "act": { "toolMode": "allow", "temperature": 0.3 },
    "reflect": { "handoff": "wait" },
    "global": { "tokenBudget": 12000 }
  },
  "capabilities": [
    { "capability": "file:write", "description": "写文件" },
    { "capability": "web:search", "description": "搜索" }
  ],
  "handoffPrompt": "你好，我是文档设计师，请告诉我你想设计什么文档。"
}
```
