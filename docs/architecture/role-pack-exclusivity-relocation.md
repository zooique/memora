# 角色包体系：手动切换 + 队伍（组长+组员）+ 小组会议（已实施）

> **文档状态**：✅ 已实施（S0-S8 全链落地，2026-08-29；定案已占 [ADR-028](../../.trae/decisions/ADR-028-role-pack-manual-switch-teams-meeting.md)）
> **版本**：v0.13
> **创建日期**：2026-08-28
> **决策摘要**：角色包**只能手动切换**——这是唯一日常形态。角色包可**建组**（组长 + 组员名单，宿主数据）；**组员不参与日常使用**，唯一作用是作为**小组会议**的参与者（会议内临时表层装配：各成员 persona/rules/skills + 组长键）。**无自动流转、无模式开关、无组员日常切换、无叠加、无会议引擎**。兜底：内核兜底契约包。机制归内核、数据归宿主。

***

## 一、设计背景（废弃清单）

### 1.1 互斥声明废弃（黑名单 → 白名单）

角色包是**插卡**（architecture\_philosophy\_rules §11）：可插拔、可共享、不自洽，四要素全部**自指**。`manifest.exclusiveWith` 互斥声明是**他指**（"我对环境中某个邻居的态度"），与插卡独立性矛盾：作者只能写死创作时的邻居名（流通即失效）、黑名单默认全量可切（新包天然成漂移源）。**废弃。**

### 1.2 自动切换与自动流转废弃（角色包 = 键 + 表层文本）

角色包不只是提示词：`strategy` 键（memoryRecall / toolMode / temperature / tokenBudget / summaryFocus / handoff…）是 **Agent 运行的确定性行为配置**。因此角色包拆为两层：

```
底层键（strategy）   = "怎么工作"（行为配置：召回模式、工具面、预算、记忆视角…）
表层文本（persona/rules/skills）= "是谁/会什么/守什么"（设定记忆全量）
```

**切换键 = 隐式替换行为配置 = 抖动**：工具白名单、记忆策略、预算随键全变，正在执行的工具调用可能失权。**重配置对象只被显式调用**——autoSwitch 开关与组内自动流转（关键词命中即切）一律废弃。**显式 vs 隐式是分水岭**：手动切换（用户意图，OK）；系统偷偷换人（隐式抖动，砍）。

### 1.3 角色包"可叠加"废弃

`architecture_philosophy_rules` §11.2「可叠加」是上古设定。**任何时候只有一个角色包生效。** **§11.2「可叠加」属性删除**（实施时随规则对齐 + ADR）。

### 1.4 组员日常切换废弃

组员**不用于日常**（无下拉切换、无"手动指定成员"机制）。组员唯一作用 = 会议参与者。会议内成员只做**表层装配**（persona/rules/skills 换、键不换）——表层是轻量视角，键切换才是重操作，两者不混用。

## 二、目标态

### 2.1 一句话定义

> 用户**手动选择**一个角色包、手动切换（完整切换，含键）。角色包可**建组**（组长 + 组员名单）；组员唯一作用是参与**小组会议**（用户发起、LLM 用任务表组织、loop 既有闭环执行，各成员以表层装配发言，键恒为组长）。无自动流转、无模式开关、无组员日常切换、无叠加。

### 2.2 三种形态（任何时候只有一个角色包生效）

```
① 日常（唯一形态）：手动切换单一角色包（persona + 键 全量装配）
② 组：组长角色包的会议名单（数据，非选择对象）
③ 小组会议：组长 + 组员，逐成员表层装配发言（persona/rules/skills 换、键不换）
```

## 三、内核与宿主职责边界

| 层 | 归属 | 理由 |
| --- | --- | --- |
| **键（strategy）** | 恒为 `activePack`（当前角色包）；**会议内也恒为组长** | 行为配置不随视角切换——防抖动的根基 |
| **表层装配**（persona/rules/skills + skills 加载） | 当前装配视角：日常 = `activePack`；会议任务项 = 该任务声明的成员 | 表层是轻量视角，可临时覆盖 |
| 组**数据**（组长 → 组员名单） | 宿主持久化（用户级；VSCode = globalState） | 组是环境关系（谁是谁的组员取决于环境），**不进 manifest**（角色包零环境知识） |
| 选择**持久化** | 宿主持久化（用户级） | 用户 UI 产物；内核仅装配时经 `activeRolePack` 读取 |
| 兜底角色包（文件本体） | 内核 `role-packs/<BUILTIN_FALLBACK_PACK>` | 兜底是机制底线，随内核分发，各宿主零分叉 |
| 兜底包（分发与校验） | 宿主构建期同步 + **构建期校验** | 缺失即构建失败（失败尽早） |
| 组 **CRUD** | ❌ 不建内核子域 | 宿主角色管理视图承载 |

> **一句话**：内核 = 装配机制（键来源恒一、表层可临时覆盖）+ 兜底；宿主 = 组数据 + 选择持久化 + 会议入口。
>
> **持久化位置**：组与选择**不落 `.memora`**（= dataDir，§10 禁配置入数据目录）；沿用宿主持久化（用户级）。
>
> **生长顺序**：内核先落地（种子），宿主基于内核形态自然生长；设计阶段不考虑兼容旧代码（不留 deprecated），但文档不得引用不存在的事实项。

## 四、运行时语义

### 4.0 状态模型

| 状态 | 含义 | 生命周期 | 真理源 |
| --- | --- | --- | --- |
| `activePack` | 当前生效角色包（含键） | 会话内可变 | 内核（手动切换唯一入口） |

* **`activePack` 是唯一角色状态**。无选择投影、无粘性锚点、无流转态。
* 宿主持久化选择 → 装配时经 `activeRolePack` 注入 → 解析为 `activePack`（§4.1）；手动切换通知宿主写回（写回与否由宿主定）。
* **会议临时装配不是状态**：任务项级覆盖只在本步/本轮装配（步入口或 prepare 期）生效，用完即回，不改 `activePack`。

### 4.1 选择解析（单链）

```
activePack 解析（单一函数，所有场景共用）：
  ① activeRolePack（宿主持久化注入）→ 有效则生效
  ② builtinFallbackRole ?? BUILTIN_FALLBACK_PACK → 兜底
```

* 失效判定：角色包不存在（组员失效不影响组长；组失效仅影响会议，§4.4）。
* 落兜底时**一次性上报宿主**（宿主自行决定是否改写持久化），避免重复 warning。
* **兜底包运行时缺失**（用户手动删了文件）→ **无 persona 继续运行 + warning，不装配失败**（§7 降级优先：对话响应是 P0、不可降级）。

### 4.2 当前生效角色（手动切换唯一入口）

* 日常装配 = `activePack` 完整装配（persona + rules + skills + strategy 键）——**唯一日常形态**。
* 手动切换 = 现有 `switchRolePack(name)`，语义不变（含键，完整切换）。**门面与 IPC 协议无需改动**（选择对象只有角色包，没有"组"选择项）。

### 4.3 表层装配（仅会议内）

```
非会议：装配 = activePack 完整装配
会议任务项（声明 rolePack = 组长或组员）：
  表层 = 该角色 persona + rules + skills（设定记忆全量）
  键   = activePack 的 strategy（恒为组长）
```

* **skills 加载跟随任务项角色**：`manifest.skills` 的角色激活判断改为跟随"本轮装配视角"（会议内），否则组员技能正文读不到。
* **工具面恒为组长**：capabilities 白名单永远来自 `activePack`——组员只能"说"（视角/知识），工具执行永远走组长。若某组员需要专属工具，应手动切换为组长（完整切换）。
* **组员发言 = 视角性意见，不是完整能力**：键不切意味着组员的身份与行为配置可能错配（例：翻译组员的发言用的是组长写作者的 temperature 等键）——会议定位是"多视角征求意见"，不是"以该角色执行任务"。**需要某角色的完整能力（键 + 工具）时，应手动切换该角色**（完整切换），而不是用会议。
* **`summaryFocus` 恒为组长**（已知取舍）：会议记忆按组长视角过滤沉淀，其他视角要点靠 recall 双通道兜底。

* **装配驱动点（2026-08-29 步粒度补强）**：表层装配由 `refreshAssemblyForRolePack(rolePack?)` **单一收口**（SSOT 单函数），两个驱动点共用：
  * **步入口（复杂任务步序列，权威）**：`runStepSequence` 每步开始前按该步（pending）`rolePack` 刷新——一次会议各步按本步角色**真灌成员文档**（"真意见"），而非全部步共享入口人格/组长；
  * **prepare 期（简单任务续跑 / event 路径）**：闭包入口按 active 步 `rolePack` 刷新——无步序列时生效；复杂任务路径下被步入口覆盖（冗余无害，见 [方案-会议步粒度硬切换](../../tasks/方案-会议步粒度硬切换-20260829.md) §4.1）；
  * **步内多轮不重复刷新**（防抖动）：装配源读「正要跑的 pending 步」而非 active 步（解"首轮无 active 步 → 硬切换不触发"缺口）。

### 4.4 组（组长附属的会议名单）

```
数据：rolePackTeams: { leader: string; members: string[] }[]
```

* **组长 = 组的定义者**：一个角色包**只能是一个组的组长**（组长身份唯一，宿主校验）；一个角色包可被**多个组**引用为组员（引用共享）。
* **成员名单非空**：至少 1 个组员；组员被删光 → 该组失效（仅影响会议，不影响日常）。
* **成员数量上限（② 组队规格，2026-08-29）**：组员 ≤ 4（5 人组上限 = 队长 1 + 组员 4）。UI 勾选层 + 宿主保存校验 + 内核 `validateTeams` warning 三处一致（超限不阻塞装载，超出部分不参与会议）。
* 引用不存在的包 → warning（不阻塞）；**组员失效 → 会议时缺员跳过 + warning**；**组长失效 → 该组失效**（选择走 §4.1 兜底）。
* **非会议时段组员零作用**（不加载、无切换入口；UI 仅展示"组员：B/C/D（小组会议用）"）。
* **组长 = 会议默认汇总者**：会议汇总项不声明 `rolePack` 时按 `activePack`（组长）装配——键恒为组长，汇总自然以组长视角收口，这是键不切的必然结果，非额外职责。

### 4.5 小组会议（任务表应用，用户发起 · LLM 组织 · loop 执行）

**定位**：会议**不是内核概念**。内核只提供"任务级表层覆盖"能力（`PlanStep.rolePack`）；会议是宿主/LLM 用既有任务表对该能力的一次应用。无会议引擎、无会议状态、无会议工具。

```
触发：用户自然语言（"小组会议，讨论 XX"）→ LLM 识别 → 调用既有 task_table_write 生成任务表
编排（LLM，零内核代码）：
   N 项任务，每项声明 rolePack = 组长或组员（议题 + 该成员视角）
 + 汇总任务（不声明 → 按 activePack = 组长装配）
执行（loop 既有闭环，逐项）：
   步入口按任务项 rolePack 刷新表层装配（§4.3：表层换、键不换；prepare 期兜底，服务续跑/event 路径）
   ★ 不改 activePack → 无切换、无需"还原"
收尾：汇总任务以组长视角收口；当前生效角色自始未变
```

**为什么落点在任务表层而不是 loop 层**：

* **改 loop = 给执行闭环开洞**——违反"执行闭环是 Agent 最小完整单元"（single-truth-source-mindset §11.3）。
* **挂 `PlanStep` = 往既有挂载点生长**——任务表本就由 LLM 经 `task_table_write` 维护、每次迭代 LLM 调用前注入上下文、状态写入收口在 `SessionManager.updatePlanStepStatus`。"LLM 组织任务清单"是既有能力，零新增。

**实施前提**：

* **① `task_table_write` 工具参数须扩展**——steps 支持可选 `rolePack` 字段（当前仅 `description`）。否则 LLM 无法声明任务角色。
* **② 组/成员清单须暴露给 LLM**——装配时向 system prompt / 工具描述注入「组长 + 组员名单」，否则 LLM 只能编造角色名。

**护栏**：

* **范围校验（边界前置）**：`rolePack` 必须 ∈ {组长} ∪ {组员}。越界 → 忽略该覆盖 + warning（防 LLM 幻觉角色名）。
* **成员数是编排约定，不是内核上限**：宿主在系统提示给建议值（建议 ≤5，控制 token 成本）；内核不截断。
* 用户发起、显式触发，非自动行为（不破坏专注模式）。
* **步粒度边界**：工具面恒锁组长（`setChatOptions` 恒读 activePack 策略，B1）；仅步入口换前缀、步内多轮不重复（B2）；loop 零改动（会议不进执行闭环）。
* **不改变角色选择状态**：不改 `activePack`、不开新状态面。（会议写 N+1 轮历史与沉淀记忆——那是闭环的固有产物。）
* 观点仅为视角输入，最终决策权在用户。

### 4.6 兜底（内核兜底契约包）

| 层 | 来源 | 性质 |
| --- | --- | --- |
| `builtinFallbackRole ?? BUILTIN_FALLBACK_PACK` | 内核 `role-packs/` 下**兜底契约包**（领域无关、最小、名字由内核常量锁定） | 必有；随内核分发，构建期同步 + 校验 |

* 宿主可覆盖名（品牌化）；覆盖值须存在，否则回退内核常量；覆盖值**应当**是领域无关兜底包（**约定而非校验**——内核无法判定内容，守不住的承诺不写成硬要求）。
* 现有三个示例包（小说助手/文档设计师/方案设计师）是**领域示例**，不可顶替兜底（"兜底角色是写小说的"荒谬 + 示例改名即断裂）。兜底契约包与示例包**同目录但性质不同**（示例可删，契约包不可删——宿主 UI 禁删 + 构建期校验）。
* **校验前移**：构建期 existsSync（缺即构建失败）；运行时仍缺失 → 无 persona 运行 + warning（§4.1）。

## 五、配置承载（内核装配参数）

```ts
/** 组（宿主装配级）：组长角色包 + 组员名单。会议名单容器，非选择对象。
 *  组长身份唯一（一个角色包只能是一个组的组长）；组员可被多组引用。
 *  成员名单非空；组员仅会议参与，不用于日常。 */
rolePackTeams?: { leader: string; members: string[] }[];

/** 激活的角色包（宿主装配级，既有键，语义扩展）：宿主持久化的用户选择。
 *  解析链第一层（§4.1）——失效落兜底包（不再回退 items[0]）。 */
activeRolePack?: string;

/** 程序级内置兜底角色（可选）：覆盖内核常量 BUILTIN_FALLBACK_PACK；须指向存在的包。 */
builtinFallbackRole?: string;
```

**内核常量**：`BUILTIN_FALLBACK_PACK`（兜底契约包名，名字即契约，改名须走 ADR）。

**任务项扩展（`PlanStep`，进 checkpoint → schemaVersion 须升版）**：

```ts
interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  order: number;
  /** 会议用：该任务项的表层装配角色（组长或组员）。仅会议内临时生效，不改 activePack。 */
  rolePack?: string;
}
```

## 六、纯净迁移（SSOT，不考虑兼容旧代码）

开发期直接废弃：**删除字段与机制，不留 deprecated 标记、不提示迁移、无兼容链路**。validator 未知键机制天然忽略旧字段。

### 6.1 删除清单

| 项 | 位置 |
| --- | --- |
| `RolePackMeta.exclusiveWith` | `src/role-pack/types.ts` |
| `parseExclusiveWith` / `checkExclusiveSymmetry` / `isExclusiveBetween` | `src/role-pack/rolePackManager.ts` |
| `validateExclusiveWith` / `MAX_EXCLUSIVE_WITH` / 已知键 `exclusiveWith` | `src/role-pack/validator.ts` |
| **autoSwitch 及自动匹配全链**：`autoMatch` / `tryAutoMatchRolePack` / `matchRolePackByLlm` / `stickyLocked` / `resetSticky` / `AUTO_MATCH_THRESHOLD` / `strategyOverride` 的 autoSwitch 语义 | `rolePackManager` / `seed/prepare.ts` / `contextPreparer.ts` / `assembler.ts` / `strategyResolver` / `types.ts` |
| 示例包 `exclusiveWith` 字段 | `role-packs/小说助手` `文档设计师` `方案设计师` |
| §11.2「可叠加」属性 | `architecture_philosophy_rules` + `role-pack-spec.md`（随规则对齐 + ADR） |

> **说明**：v0.10-v0.12 关联组设计（组内流转 / stickyAnchor / selectGroupMember / leader / defaultSelection / userFallbackRole / 任务级完整装配覆盖）**从未实施**，整体废弃，不列逐项删除。VSCode 宿主长期 `autoSwitch=off`（只用手动切换），删除自动匹配能力无损失。

### 6.2 新增清单

| 项 | 位置 |
| --- | --- |
| `AgentOptions.rolePackTeams` / `builtinFallbackRole`；**`activeRolePack` 既有键，语义扩展为解析链第一层**（§4.1） | `src/agent/types.ts` |
| 选择解析单链（§4.1）+ `activePack` 唯一状态（§4.0） | `src/role-pack/rolePackManager.ts` / `seed/prepare.ts` |
| **会议机制**：`PlanStep.rolePack` + `task_table_write` 参数扩展 + 组/成员清单注入 + 表层装配分支（§4.3：**prepare 期 + `runStepSequence` 步入口**，skills 加载跟随装配视角）+ 范围校验 | `src/agent/types.ts` / `builtinTools.ts` / `seed/prepare.ts` / `seed/orchestrator.ts` / `assembler.ts` |
| 内核兜底契约包 `<BUILTIN_FALLBACK_PACK>/` + 常量 | `role-packs/` / `src/role-pack/constants` |
| 组数据校验（组长唯一 / 名单非空 / 引用悬空 warning） | `src/role-pack/rolePackManager.ts`（装配时校验） |

### 6.3 实施步骤（S0→S8）

| 步 | 内容 | 备注 |
| --- | --- | --- |
| S0 | **兜底契约包**：`role-packs/<BUILTIN_FALLBACK_PACK>/`（manifest + persona + rules，领域无关）+ 常量；宿主 `copyRolePacks()` 加构建期 existsSync 校验 | 兜底是机制底线，先于所有解析逻辑 |
| S1 | 删除互斥字段与机制（§6.1 1-3） | |
| S2 | **删除自动匹配全链**（autoSwitch / autoMatch / LLM 匹配 / 粘性 / 阈值常量）；接管 `load()/reload()` 默认激活路径为 §4.1 单链 | 默认路径不接管则单链被绕过 |
| S3 | 新增 `rolePackTeams` / `builtinFallbackRole` 装配参数；**`activeRolePack` 语义扩展为解析链第一层**（§4.0-4.4：activePack 唯一状态 + 单链解析 + 组数据校验） | |
| S4 | 装载后校验：组悬空 / 组长唯一 / 引用悬空 → warning（不阻塞装载）；兜底包存在性校验 | |
| S5 | **会议机制**：`PlanStep.rolePack` + `task_table_write` 参数扩展 + 组/成员清单注入 + prepare 期**表层装配**分支（skills 加载跟随装配视角）+ 范围校验 + **checkpoint schemaVersion 升版** | 内核到此无"会议"概念。**步粒度补强（2026-08-29）**：装配源从「active 步」扩为「prepare 期 + `runStepSequence` 每步入口读 pending 步 `rolePack`」——一次会议各步按本步角色真灌成员文档；工具面恒锁组长（`setChatOptions` 恒读 activePack），loop 零改动。详见 [方案-会议步粒度硬切换](../tasks/方案-会议步粒度硬切换-20260829.md) |
| S6 | 示例角色包清理（移除 `exclusiveWith`） | |
| S7 | 宿主接入：组管理 UI（建组/拉组员/成员排序）+ 组员名单展示（"小组会议用"标注）+ 选择持久化（沿用 globalState）+ 会议入口（提示 LLM 可用任务表组织会议） | **门面 `switchRolePack` 与 IPC 协议不变**（选择对象只有角色包） |
| S8 | 测试与文档 + 规则对齐：删自动匹配/exclusiveWith 用例，增单链兜底/表层装配/skills 跟随/范围校验用例；`role-pack-spec.md` 字段清理；§11.2 删除 + ADR；README 同步 | |

> **提交节奏**：S1-S5 作**单一批次提交**（每个 commit 必过质量门：tsc + eslint + vitest），不留"宿主不可用"的中间态。

### 6.4 校验与兜底

* 组引用不存在的包 / 组员悬空 → warning（不阻塞装载）；组员失效 → 会议时缺员跳过 + warning。
* **组长身份唯一**（一个角色包只能是一个组的组长）→ 宿主校验；组员引用可共享。
* 成员名单为空 → 组不成立（warning）。
* `activeRolePack` 指向不存在的包 → 落兜底包（warning）。
* `builtinFallbackRole` 覆盖值不存在 → 回退内核常量（warning）。
* 兜底包存在性 → 构建期硬校验；运行时缺失 → 无 persona 运行 + warning（§4.1）。

## 七、对齐与不变量

* ✅ 专注模式 §9：手动切换是常态（默认沉浸），小组会议由用户显式发起（切换是例外）。**无任何隐式切换。**
* ✅ 自然生长：组 = 组长角色包的会议名单（数据，非独立实体）；会议 = 任务表对"任务级表层覆盖"的应用（挂 `PlanStep`，不改 loop）。**无模式开关、无独立子域、无会议引擎、无自动流转。**
* ✅ SSOT：键恒来自 `activePack`、表层来自装配视角——**一个装配函数、两个输入**，不是两个真理源；选择解析单一函数（§4.1）；`activePack` 唯一状态（§4.0）；组数据归宿主（角色包零环境知识）。
* ✅ 内核领域无关不破坏：组/兜底包/表层覆盖都是装配参数与内核能力，不依赖任何领域。

## 八、已定案决策

| # | 决策点 | 定案 |
| -- | --- | --- |
| 1 | 切换 | **只能手动切换单一角色包**（完整切换，含键）。无 autoSwitch、无自动匹配、无自动流转 |
| 2 | 角色包分层 | **键（strategy）= 行为配置，恒来自 `activePack`；表层（persona/rules/skills）= 设定记忆，可临时覆盖**。键不随视角切换（防抖动） |
| 3 | 组 | **组长角色包的会议名单**（宿主数据 `{leader, members[]}`）；非选择对象、非独立实体。组长身份唯一，组员可多组引用 |
| 4 | 组员 | **仅会议参与，不用于日常**（无下拉切换、无手动指定成员机制）；非会议时段零作用 |
| 5 | 会议 | **用户发起 → LLM 用 `task_table_write` 组织任务表 → loop 逐项表层装配执行**；内核零会议代码。参与者 = 组长 + 组员 |
| 6 | 表层装配 | 会议任务项：表层换（persona/rules/skills + skills 加载跟随）、**键不换**（恒组长）。工具面恒组长；`summaryFocus` 恒组长（已知取舍） |
| 7 | 汇总 | 汇总任务不声明 → 按 `activePack`（组长）装配——键恒为组长的必然结果，非额外职责 |
| 8 | 兜底 | 单层：`builtinFallbackRole ?? BUILTIN_FALLBACK_PACK`（内核契约包）；构建期校验；运行时缺失 → 无 persona 运行 + warning（不装配失败） |
| 9 | 持久化 | 组与选择均宿主持久化（用户级），**不用 `.memora`**（= dataDir）；内核不持有跨会话选择 |
| 10 | 选择解析 | 单链：`activeRolePack → 兜底包`；落兜底一次性上报宿主（写回与否宿主定） |
| 11 | 状态面 | `activePack` 唯一角色状态；会议临时装配非状态（任务项级，用完即回） |
| 12 | 生长顺序 | 内核先落地（种子，S0-S5 单一批次），宿主自然生长（S7）；设计阶段不考虑兼容旧代码 |

***

> **关联**：architecture\_philosophy\_rules §9 专注模式 · §11 插卡模型（§11.2 可叠加待删除）· §10 配置文件是真理源 · §7 降级优先 · `role-pack-spec.md`《exclusiveWith》字段 · `task-driven-closed-loop.md`（任务表机制）· ADR-025 记忆×角色包边界（设定记忆归角色包，环境关系归宿主）

<br />
