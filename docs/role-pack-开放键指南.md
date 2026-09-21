# 角色包开放键使用指南（发布包版）

> **面向对象**：安装 `@zooique/memora` 后，编写 / 理解角色包（role pack）的开发者——既包括**宿主接入者**（要把角色包能力接进自己的产品），也包括**角色包作者**（要填写 `manifest.json`）。
> **定位**：本指南回答「manifest.json 里的开放键填什么、**被谁消费**、有什么上限」。它是 memora 发布包内的角色包使用入口。
> **相关文档**：
> - 中立规范（跨所有 Agent 实现的契约，随包发布）：[role-pack-spec.md](./architecture/role-pack-spec.md)
> - 详细填写手册（含全部区间 / 错误修正 / 键的落实状态，随包发布）：[role-pack-authoring-guide.md](./architecture/role-pack-authoring-guide.md)
> - 示例角色包（结构参考，随包发布、不参与宿主运行时装载）：[role-packs/](../role-packs/README.md)

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
| **① 内核直接消费** | memora 内核 | `skills` / `strategy` | 技能扫描、行为策略 |
| **② 中立接口（宿主接入点）** | 宿主 / 其他实现 | `capabilities` / `handoffPrompt` | 能力映射、接手话术 |
| **③ 元数据（UI 展示）** | 宿主 UI | `name` / `displayName` / `description` / `author` | 标识与展示 |

### 2.1 ① 内核直接消费层（memora 实现细节）

这些键由 memora 内核自己跑逻辑，**宿主不需要处理**：

- `skills`：内嵌技能白名单（目录动态扫描，声明项仅作白名单过滤；不声明则全量扫描 `skills/`）。
- `strategy`：L2 行为策略（`prepare` / `act` / `reflect` / `global` 四组），控制工具暴露、摘要视角、自审查、预算与提问等行为偏好。

> 这些键的**上限由内核统一守门**（见 §2.4），因为解析入口在内核。

### 2.2 ② 中立接口层（宿主接入点）

这一层是**为宿主 / 跨实现接入预留的中立契约**——角色包不绑具体实现，由各实现自己消费：

- **`capabilities`（能力声明）**：以**中立能力命名空间**声明（`域:动作`，如 `file:write` / `web:search`），不绑具体工具。**各实现（memora 是 reference implementation）自行映射到自有工具**：
  - **特权声明模型（2026-09-08 定，2026-09-16 扩）**：memora 侧映射表在 `src/role-pack/capabilityMap.ts`（SSOT）——仅 `web:search` / `web:fetch` / `code:execute` 映射为**特权工具白名单**；`file:*` / `memory:recall` / **`task:plan`（对应任务表）** 属**默认常驻工具**（`toolExecutor.DEFAULT_EXPOSED_TOOLS`），声明与否都不影响可见性、不再映射。任务表系内核多步任务必要基建（2026-09-16 用户拍板），非角色包可选的领域深度能力；
  - **宿主可以有自己的映射表**：例如 `code:execute` 需宿主注入 `ICodeExecutionProvider` 才真正暴露；
  - 未知能力（不在映射表）跳过，不阻塞装载。
  - 角色包声明 `capabilities` 后，工具暴露面 = 常驻豁免集 + 能力白名单内的特权工具（换角色 → 特权工具集切换）。
- **`handoffPrompt`（接手话术）**：该角色包**被宿主带入对话（激活 + 聚焦）时**预填输入框的特色衔接话术——作者为「这个角色接手任务时怎么说」定制的提示词，缺省由宿主回退通用话术。**宿主消费**（如 memora-vscode 在 `roles_handoff` 处理中读取 `listMeta().handoffPrompt` 预填）；内核仅透传 + 校验（非字符串 warning 不阻塞装载）。

### 2.3 ③ 元数据层（UI 展示）

- `name`（唯一标识，缺失用文件夹名兜底）、`displayName`（UI 展示名，缺省回退 `name`）、`description`、`author`。
- 内核仅作标识/校验；真正消费是宿主的角色包清单 / UI 展示。

### 2.4 为什么上限由内核统一守门

**无论最终消费方是谁，`manifest.json` 的解析入口都在 memora 内核**（`validator.ts` 校验 + `rolePackManager.ts` 装载）。内核作为装载器在入口守门——对所有开放字段统一限长：

- 对**内核字段**：防资源失控（匹配词列表膨胀拖慢匹配、巨型内容占内存/上下文）；
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
| `formatVersion` | string | ① 内核校验（可选，缺省 `1.0.0`） | semver（x.y.z） | 格式版本，绑定固定 schema URL，发布后不变；建议声明 |
| `displayName` | string | ③ UI | ≤200 字符 | UI 展示名，缺省回退 `name` |
| `description` | string | ③ UI | ≤200 字符 | 角色包描述 |
| `author` | string | ③ UI | ≤200 字符 | 作者/来源 |
| `version` | string | ③ 分发 | semver（x.y.z） | 角色包自身版本（可选） |

### 3.2 中立接口层（宿主接入）

| 键 | 类型 | 消费方 | 上限 | 说明 |
|----|------|--------|------|------|
| `capabilities` | 对象数组 | ② 宿主 / 各实现映射 | ≤50 项 | `{ capability: "域:动作", description? }`；映射到各实现自有工具 |
| `handoffPrompt` | string | ② 宿主预填 | ≤2000 字符 | 被带入对话时预填的接手话术 |

### 3.3 内核消费层

| 键 | 类型 | 消费方 | 上限 | 说明 |
|----|------|--------|------|------|
| `skills` | 对象数组 | ① 内核扫描 | ≤50 项 | 技能白名单（`{ file, name?, description? }`） |
| `strategy` | 嵌套对象 | ① 内核行为 | 各数值键有上下限（见 authoring-guide §四） | L2 行为策略（prepare/act/reflect/global） |

### 3.4 合规 / 分档层

| 键 | 类型 | 消费方 | 上限 | 说明 |
|----|------|--------|------|------|
| `interactionType` | string 枚举 | ① 内核合规 | `tool_assistant` / `companion`（缺省 `tool_assistant`） | 交互类型：工具型（豁免区间）vs 拟人化陪伴（完整合规校验） |
| `aiIdentityDisclosure` | boolean | ① 内核合规 | `true`（缺省） | 是否向用户明确标注 AI 身份（companion 必须显式 true） |
| `minorProtection` | string 枚举 | ① 内核合规 | `required`（缺省） | 未成年人保护模式（当前仅支持 required） |

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
  "name": "plain-designer",
  "displayName": "白话方案设计师",
  "description": "白话方案设计角色包",
  "formatVersion": "1.0.0",
  "interactionType": "tool_assistant",
  "strategy": {
    "prepare": { "summaryFocus": "以方案设计视角提炼要点" },
    "act": { "toolMode": "allow", "temperature": 0.3 },
    "global": { "contextLimit": 0 }
  },
  "capabilities": [
    { "capability": "file:write", "description": "写文件" },
    { "capability": "web:search", "description": "搜索" }
  ],
  "handoffPrompt": "你好，我是白话方案设计师，请告诉我你想解决什么模糊想法或痛点。"
}
```
