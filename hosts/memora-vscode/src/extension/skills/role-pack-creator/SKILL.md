---
name: 角色包制作器
description: 创建 memora 角色包（role-pack）：采集需求 → 脚本初始化骨架 → LLM 精修 → 校验 → 交付角色包目录。当用户要求新建角色/助手/人格包、初始化角色包模板、或为 memora 制作自定义角色时使用。
keywords: 角色包,新建角色,创建角色,角色模板,初始化角色,role-pack,新建助手,人格包,memora角色
trigger: /(?=.*(角色包|新角色|角色模板|人格包|新助手|memora角色))(?=.*(创建|新建|初始化|制作|生成))/
layer: agent
---

# 角色包制作器

为一个 memora 角色创建**结构合法**的角色包目录。核心是**静态模板 + 复制改名脚本**：模板是结构唯一真相源（不用手写 JSON 结构），脚本负责复制与填槽，LLM 只做个性化精修。

## 何时触发

用户需要**新建**一个 memora 角色/助手/人格包时激活本技能，典型说法：
- "帮我创建一个 小说助手 / 文档设计师 / 客服 角色包"
- "初始化一个角色包模板"
- "制作一个 memora 角色"

**不触发**：用户只是询问角色包概念、修改已有角色包、或已有成品只需安放（见[不适用场景](#不适用场景)）。

## 核心执行骨架

```
采集需求 → 脚本初始化骨架 → LLM 精修 → 校验 → 交付
```

- **采集需求**：问清角色名/定位/能力面/行为偏好（四件事）。
- **脚本初始化**：静态模板复制 + 填槽，产出 4 个文件骨架。
- **LLM 精修**：唯一允许改的环节（manifest/persona/rules/skills）。
- **校验**：写→验→用闭环，逐项核对。
- **交付**：把 `<角色名>/` 目录交给用户，不复制到任何宿主目录。

## 详细步骤

### 第一步：采集需求（问清四件事）

| 项 | 决定 |
|----|------|
| 角色名 / 展示名 | 目录名 + `name`/`displayName` |
| 一句话定位 | `description` + persona 第一句 |
| 能力面 | `capabilities`（或省略 = 全放行） |
| 行为偏好 | 温度 / 主动提问 / 召回等 → strategy 键 |

需求不足时按 [memora 角色包开放键指南](../../../../../docs/role-pack-开放键指南.md) 或直接补问，不臆造。

### 第二步：脚本初始化骨架

用脚本把内置静态模板（`templates/standard/`）复制到当前项目并按角色填槽：

```
node scripts/skaffold.mjs <角色名> [--display 展示名] [--desc 一句话定位]
      [--keywords 触发词1,触发词2] [--handoff "衔接话术"] [--out 目标目录]
```

- `<角色名>` 必填；`--out` 缺省为当前工作目录（产物 = `./<角色名>/`）；
- 脚本**拒绝**：空名 / 非法目录名 / 目标已存在（防覆盖）/ 保留名 `memora助手`；覆盖需 `--force`；
- 框架产出 4 个文件：`manifest.json`、`persona.md`、`rules.md`、`skills/README.md`（占位符已替换）。

### 第三步：LLM 精修（核心设计环节）

修改产出文件（**这是唯一允许改的地方**）：

| 文件 | 改什么 |
|------|--------|
| `manifest.json` | 按需增删 `capabilities`、调整 `strategy` 键（只保留要用改的键，键集见下表） |
| `persona.md` | 角色身份/职责/风格/边界（并入 system prompt，第一优先级） |
| `rules.md` | 工作方法/流程/禁忌（`- ` 无序列表逐条 + 段落合并） |
| `skills/*.md` | 领域方法库（frontmatter 必须含 `name` + `description`，目录扫描零声明） |

#### capabilities（能力面）候选

| capability | 对应工具 |
|-----------|---------|
| `file:read` / `file:write` / `file:list` | `read_file` / `write_file` / `list_dir` |
| `web:search` / `web:fetch` | `web_search` / `web_fetch` |
| `code:execute` | `run_code`（需宿主注入执行器） |
| `memory:recall` | `search_memories` |
| `task:plan` | `task_table_write` / `task_table_update` |
| `llm:summarize` / `project:search` | 内核能力 / `search_project` |

> ⚠️ **语义红线**：`capabilities: []`（空数组）或仅含无工具映射的能力 = **无任何工具可调用（全禁）**。需要放行全部工具时**省略** capabilities 字段（= 全放行）。凡写数组即显式白名单。

#### strategy 键速查（28 键；未改动的键可删除 = 内核默认）

`prepare`（8）默认值：`memoryRecall`=full｜`understandingConfirm`=off｜`memoryRecallPercent`=0.4(0~1)｜`minFallback`=2(0~100)｜`summaryFocus`(≤500字符，默认省略)｜`contextAssembly`=hybrid｜`recallConfidence`=0.6(0~1)｜`summaryRecall`=on
`act`（10）默认值：`toolMode`=allow｜`temperature`=0.7(0~2)｜`outputLimit`=4096(1~65536)｜`streaming`=streaming｜`toolStepLimit`=20(0~100)｜`providerRouting`=auto｜`inputInterrupt`=allow｜`multiStepReasoning`=auto｜`toolReadonly`=full｜`toolApproval`=auto
`reflect`（4）默认值：`summary`=on｜`handoff`=wait｜`selfReview`=0(0~10)｜`userFollowup`=silent
`global`（6）默认值：`askOn`=['ambiguity','decision','missing_info']｜`askLimit`=3(1~10)｜`errorHandling`=retry｜`tokenBudget`=200000(0~1000000)｜`stepBudget`=50(0~500)｜`taskLoopLimit`=10(0~100)

### 第四步：校验（写→验→用闭环）

1. `manifest.json` 为合法 JSON；`formatVersion` 必填（x.y.z）。
2. 所有数值/枚举在上述区内；`summaryFocus` ≤500 字符；`keywords` ≤20 个。
3. `name` 有效（1~64 位，中文/字母/数字/下划线/连字符，不以 `.` 开头）。
4. `skills/*.md` 均含 frontmatter 且带 `description`（缺则技能不可用）。
5. **禁止**命名 `memora助手`（memora 内置兜底契约角色，避免冲突）。

### 第五步：交付

校验通过后，把 `<角色名>/` 目录作为完整成果交给用户。**不复制到任何宿主目录**——由用户复制到目标 memora 宿主的角色包目录或用户 skills 目录。

## DO / DON'T

### ✅ 必须做

- 先采集四要素需求再跑脚本，不凭空假设角色定位。
- 用 `node scripts/skaffold.mjs` 初始化骨架（模板 = 结构唯一真相源，不手写 JSON 结构）。
- 精修只在产出文件内进行，产出后逐项跑校验清单。
- `capabilities` 写数组前确认每个能力都有工具映射；全放行就省略字段。
- `skills/*.md` 一律带 frontmatter `name` + `description`。

### ❌ 禁止做

- 禁止手写 manifest.json 结构（一律从模板生成，防止键名/区间漂移）。
- 禁止把产物复制进任何宿主目录（memora 的 role-packs/、用户 skills 目录均不负责）。
- 禁止创建保留名 `memora助手`。
- 禁止遗漏 `formatVersion` / 允许数值超出速查区间。
- 禁止交付未校验的产物。

## 不适用场景

- **修改已有角色包**：已存在角色包需调整 → 直接编辑目标文件，不重跑骨架。
- **概念咨询**："什么是角色包/策略键" → 引导用户读 [role-pack-spec.md](../../../../../docs/architecture/role-pack-spec.md)。
- **宿主安装/安放**：把现成角色包放进某宿主目录 → 由用户自行复制，本技能不代劳。
- **非 memora 角色**：为其他框架/Agent 建角色 → 与本技能无关，不激活。

识别到以上场景时，告知用户并给出替代路径（见下方退出话术）。

## 退出 / 接力话术

- 不适用时："这是角色包修改/概念咨询/宿主安放场景，不需要新建骨架。我可以直接帮你：编辑目标角色包 / 讲解规范 / 指出安放位置。"
- 缺执行能力时（无法跑 node 脚本）："生成骨架需要在本机执行 `node scripts/skaffold.mjs`，当前环境无法运行脚本。你可以手动复制 `templates/standard/` 并按 SKILL.md 键速查填槽。"

## 依赖与运行说明

- 本技能依赖 **Node.js ≥ 22**（`scripts/skaffold.mjs` 使用 `node:fs/promises` 等内置模块，零第三方依赖）。
- 在 TRAE IDE 中：用终端执行 `node scripts/skaffold.mjs ...`（脚本路径相对 `SKILL.md` 所在目录）。
- `templates/standard/` 是**脚本私有资源**（非 L3 `resources/` 索引），由脚本直接复制，无需 `read_resource` 读取。

## 规范唯一真相源（SSOT）

- 策略键速查 / 校验区间以 [strategyKeys.ts](../../../../../src/role-pack/strategyKeys.ts) 与 [role-pack-spec.md](../../../../../docs/architecture/role-pack-spec.md) 为准（本文件速查表与之一致）。
- 若发现本文件键速查与内核出现分歧，以内核为准并**更新本文件**（本 skill 跟随内核同步，不是独立权威）。
