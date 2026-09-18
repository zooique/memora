---
name: 角色包制作器
description: 创建 memora 角色包（role-pack）：采集需求 → 脚本初始化骨架 → LLM 精修 → 校验 → 交付角色包目录。当用户要求新建角色/助手/人格包、初始化角色包模板、或为 memora 制作自定义角色时使用。
layer: agent
---

# 角色包制作器

为一个 memora 角色创建**结构合法**的角色包目录。核心是**静态模板 + 复制改名脚本**：模板是结构唯一真相源（不用手写 JSON 结构），脚本负责复制与填槽，LLM 只做个性化精修。

## 何时触发

用户需要**新建**一个 memora 角色/助手/人格包时激活本技能，典型说法：
- "帮我创建一个 共鸣小说家 / 白话方案设计师 / 客服 角色包"
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
| 能力面 | `capabilities`（特权键，或省略 = 全部暴露；`[]` = 仅默认常驻） |
| 行为偏好 | 温度 / 主动提问 / 召回等 → strategy 键 |

需求不足时按 [memora 角色包开放键指南](../../../../../../docs/role-pack-开放键指南.md) 或直接补问，不臆造。

### 第二步：脚本初始化骨架

用脚本把内置静态模板（`templates/standard/`）复制到当前项目并按角色填槽：

```
node scripts/skaffold.mjs <角色名> [--display 展示名] [--desc 一句话定位]
      [--handoff "衔接话术"] [--out 目标目录]
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
| `skills/*.md` | 领域方法库（frontmatter 必须含 `name` + `description`，目录扫描零声明；description 按[四问规范](#四问规范软自查)写明 做什么/何时用/输入/返回） |

#### capabilities（特权能力候选）

> **模型（tool-exposure-model 2026-09-08）**：`capabilities` = 角色声明的**超越默认边界的特权**。本地读写/记忆/技能等 16 个工具**默认常驻**（`DEFAULT_EXPOSED_TOOLS`），**无需声明即可用**（省略 capabilities 同理）。只有下面 4 类特权键声明后才进入工具白名单：

| capability | 对应工具 |
|-----------|---------|
| `web:search` / `web:fetch` | `web_search` / `web_fetch`（外部网络特权） |
| `code:execute` | `run_code`（LLM 现写代码执行特权；需宿主注入执行器） |
> 注：`task:plan` 不再映射——任务表（`task_table_write` / `task_table_update`）是内核**常驻必要基建**（2026-09-16 用户拍板直接暴露），任何角色无论是否声明 `task:plan` 都可使用；声明与否行为一致，故不再作为特权能力映射（见 tool-exposure-model.md）。

> ⚠️ **语义红线（已对齐特权模型）**：`capabilities: []`（空数组）= **仅默认常驻工具**（本地读写/记忆/技能/项目脚本全可用，不开放任何特权）——纯本地型角色应写 `[]` 而非省略；**省略** capabilities = 全部暴露（含特权工具）；声明特权键 = 常驻 + 白名单内的特权工具。「换角色 = 特权工具集切换」。详见 [tool-exposure-model.md](../../../../../../docs/architecture/tool-exposure-model.md)。

#### strategy 键速查（16 键；未改动的键可删除 = 内核默认）

`prepare`（1）默认值：`summaryFocus`(≤500字符，默认省略)。注：`understandingConfirm` 已回收（2026-09-13）——confirm 并入 `askOn` 含 `'confirm'` 触发，echo 由内核 Turn 起始策略覆盖，勿再填写；2026-09-09（memory-tool-recall-design 阶段2）起 `memoryRecall`/`memoryRecallPercent`/`minFallback`/`contextAssembly`/`recallConfidence`/`summaryRecall` 6 个召回键已退役——记忆检索改由 `memory_search` 工具触发，勿再填写。
`act`（7）默认值：`toolMode`=allow｜`temperature`=0.7(0~2)｜`outputLimit`=4096(1~65536)｜`toolStepLimit`=20(0~100)｜`providerRouting`=auto｜`multiStepReasoning`=auto｜`toolReadonly`=full
`reflect`（3）默认值：`summary`=on｜`selfReview`=0(0~10，布尔数字：0=关闭，>0 一律收敛为 1=终审一次，写 2 与写 1 效果相同)｜`userFollowup`=silent
`global`（5）默认值：`askOn`=['ambiguity','decision','missing_info']｜`askLimit`=10(1~10)｜`errorHandling`=retry｜`contextLimit`=0(0~1000000，0=不设额外上限、跟随 provider 窗口)｜`stepBudget`=50(0~500)

### 第四步：校验（写→验→用闭环）

1. `manifest.json` 为合法 JSON；`formatVersion` 必填（x.y.z）。
2. 所有数值/枚举在上述区内；`summaryFocus` ≤500 字符。
3. `name` 有效（1~64 位，中文/字母/数字/下划线/连字符，不以 `.` 开头）。
4. `skills/*.md` 均含 frontmatter 且带 `description`（缺则技能不可用）。
5. （软自查）`skills/*.md` 的 description 按[四问规范](#四问规范软自查)对照，含糊措辞（如"处理数据"）须重写。
6. **禁止**命名 `memora助手`（memora 内置兜底契约角色，避免冲突）。

#### 四问规范（软自查）

`description` 是 LLM 决定是否 `read_skill` 拉取正文的唯一说明书——写不好，技能会系统性漏召（技能存在但 LLM 以为无关）。精修技能时对照四问：

| 问 | 说明 | 反例 → 正例 |
|----|------|------------|
| ① 做什么 | 一句话动作（动词 + 对象） | 处理数据 → 将 Markdown 表格转 CSV |
| ② 何时用 | 触发场景，帮助 LLM 判断相关性 | 需要整理文档数据时用 |
| ③ 输入 | 接受什么（路径/文本/参数） | 输入：表格文件路径 |
| ④ 返回 | 结果形式，含失败形态 | 返回：CSV 文本；无表格时返回明确提示 |

作品投影等索引描述同理：一句话说清「文件是什么 + 何时会用到」。

#### 技能使用引导（persona/rules 高亮"何时用"）

**每个内置 skill 都应在 persona.md/rules.md 里补一处使用时机引导**——明示「什么情况用这个 skill」。技能能力定义仍以技能文件为唯一真理源，设定文本只写**何时用**、不复述做法；调用决策由**场景契约**驱动，而非靠猜扁平 description。

- **persona.md**：在工作流程/阶段里挂技能（如"阶段6 对白即行动（用 `dialogue-craft`）"）；
- **rules.md**：写成触发式纪律（如"伏笔必须回收：埋得轻、收得重（用 `foreshadow` 维护埋点清单）"）。

**引用格式（强制）**：引用技能时**必须用反引号把技能名括起来**（写成 `dialogue-craft` 这样的形式）——这是设定文本里技能引用的唯一合法形式。两条硬约束：

1. **技能名 = kebab-case**，与文件名（`skills/x.md`）/ 目录名（`skills/x/SKILL.md`）严格一致；改名须同步全部引用。
2. **保留字规则**：persona/rules 里反引号包裹的 kebab 词**一律判定为技能引用**——所以这两个文件里不要反引号包裹非技能标识（如 `local-first`），需要提到时写普通文本。

**覆盖自查（双向）**：交付前逐个核对——
- **正向**：每个内置 skill 在 persona/rules **至少一处**被引用，避免"存在但永不调用"的僵尸技能（共鸣小说家最初 5 个技能零引用即此缺口；白话方案设计师曾 6/6 全部零引用）；
- **反向**：每条引用都指向真实存在的技能——防改名后残留的**悬空引用**（改了 `skills/` 里的名字却漏改设定文本）。

> 完整规范与论证见内核仓库 `docs/architecture/role-pack-authoring-guide.md` §2.5（使用引导）与 §2.6（引用格式）；两个方向均由 `src/role-pack/__tests__/builtinPackCoverage.test.ts` 自动守卫（新增未引用技能 / 引用不存在的技能都会红）。

### 第五步：交付

校验通过后，把 `<角色名>/` 目录作为完整成果交给用户。**不复制到任何宿主目录**——由用户复制到目标 memora 宿主的角色包目录或用户 skills 目录。

## DO / DON'T

### ✅ 必须做

- 先采集四要素需求再跑脚本，不凭空假设角色定位。
- 用 `node scripts/skaffold.mjs` 初始化骨架（模板 = 结构唯一真相源，不手写 JSON 结构）。
- 精修只在产出文件内进行，产出后逐项跑校验清单。
- `capabilities` 写数组前确认每个键都是特权键（web/code/task）；纯本地角色写 `[]`（仅常驻工具）；需要全部暴露才省略字段。
- `skills/*.md` 一律带 frontmatter `name` + `description`，且 description 按[四问规范](#四问规范软自查)写清 做什么/何时用/输入/返回。
- 每个内置 skill 都在 persona.md/rules.md **至少一处**高亮"何时用"，且**引用一律用反引号包裹技能名**（如 `foreshadow`）；交付前双向核对：无僵尸技能（每个技能被引用）+ 无悬空引用（每条引用都存在），见[技能使用引导](#技能使用引导personarules高亮何时用)。

### ❌ 禁止做

- 禁止手写 manifest.json 结构（一律从模板生成，防止键名/区间漂移）。
- 禁止把产物复制进任何宿主目录（memora 的 role-packs/、用户 skills 目录均不负责）。
- 禁止创建保留名 `memora助手`。
- 禁止遗漏 `formatVersion` / 允许数值超出速查区间。
- 禁止交付未校验的产物。

## 不适用场景

- **修改已有角色包**：已存在角色包需调整 → 直接编辑目标文件，不重跑骨架。
- **概念咨询**："什么是角色包/策略键" → 引导用户读 [role-pack-spec.md](../../../../../../docs/architecture/role-pack-spec.md)。
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

- 策略键速查 / 校验区间以 [strategyKeys.ts](../../../../../../src/role-pack/strategyKeys.ts) 与 [role-pack-spec.md](../../../../../../docs/architecture/role-pack-spec.md) 为准（本文件速查表与之一致）。
- 技能引用格式（反引号包裹技能名 + 双向守卫）以 [role-pack-authoring-guide.md](../../../../../../docs/architecture/role-pack-authoring-guide.md) §2.6 为准。
- 若发现本文件键速查与内核出现分歧，以内核为准并**更新本文件**（本 skill 跟随内核同步，不是独立权威）。
