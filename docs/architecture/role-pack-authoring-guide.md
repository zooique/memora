# 角色包作者填写指南（manifest.json 实操）

> **面向对象**：为 memora 及其宿主编写角色包（role pack）的开发者。
> **定位**：本指南回答「manifest.json 怎么写、每个键填什么、填错了会怎样」；中立规范见 [role-pack-spec.md](./role-pack-spec.md)（面向所有 Agent 实现的契约）。
> **区间 SSOT**：所有数值键的上下限以 `src/role-pack/strategyKeys.ts` 为唯一真理源，本表与之一致；如需调区间只改源码常量，并同步本表。

***

## 一、manifest.json 结构速览

角色包 = 一个文件夹 + `manifest.json`（唯一核心控制文件）+ 内容文件（约定俗成，不注册路径）：

```
角色包名/
├── manifest.json        # ★ 元数据 + strategy 策略 + capabilities + skills 白名单
├── persona.md           # 角色身份设定（可缺省，缺省则无身份仅靠策略驱动）
├── rules.md             # 确定性规则（列表逐条 / 段落合并一条，见 §二.4）
└── skills/              # 技能目录（动态扫描，新增技能只写文件即可）
```

`manifest.json` 最小可用示例：

```json
{
  "name": "plain-designer",
  "displayName": "白话方案设计师",
  "description": "白话方案设计角色包",
  "version": "1.0.0",
  "formatVersion": "1.0.0",
  "interactionType": "tool_assistant",
  "strategy": {
    "prepare": { "summaryFocus": "以方案设计视角提炼要点" },
    "act": { "toolMode": "allow", "temperature": 0.3 },
    "reflect": { "selfReview": 1 },
    "global": { "contextLimit": 0, "stepBudget": 60 }
  },
  "capabilities": [
    { "capability": "file:write", "description": "写文件" },
    { "capability": "web:search", "description": "搜索" }
  ],
  "handoffPrompt": "你好，我是白话方案设计师，请告诉我你想解决什么模糊想法或痛点。"
}
```

***

## 二、顶层字段（元数据 + 合规）

| 键                      | 类型                             | 必填 | 默认               | 说明                                                      |
| ---------------------- | ------------------------------ | -- | ---------------- | ------------------------------------------------------- |
| `name`                 | string                         | ✅  | 无                | 唯一标识（缺失则用文件夹名兜底）；≤200 字符                                |
| `displayName`          | string                         | 否  | `name`           | UI 展示名，缺省回退 `name`；≤200 字符                              |
| `description`          | string                         | 否  | 无                | 角色包描述；≤200 字符                                           |
| `version`              | string                         | 否  | 无                | 建议 semver（`1.0.0`）                                      |
| `formatVersion`        | string                         | 否  | `1.0.0`          | 声明则须 semver；版本迁移见规范 §五                                  |
| `author`               | string                         | 否  | 无                | 作者/来源；≤200 字符                                           |
| `interactionType`      | `tool_assistant` / `companion` | 否  | `tool_assistant` | companion 触发全量强校验                                       |
| `aiIdentityDisclosure` | boolean                        | 否  | `true`           | companion 必须显式 `true`                                   |
| `minorProtection`      | `required`                     | 否  | `required`       | 未成年人保护钩子，仅支持 `required`                                 |
| `handoffPrompt`        | string                         | 否  | 无                | 被带入对话时预填的接手话术；≤2000 字符                                  |
| `skills`               | 对象数组                           | 否  | 无                | 技能白名单（`{ file, name?, description? }`）；不声明则全量扫描；最多 50 项 |
| `capabilities`         | 对象数组                           | 否  | `[]`             | 特权能力声明（`{ capability, description? }`）；最多 50 项；`[]` = 仅默认常驻工具 |
| `strategy`             | 嵌套对象                           | 否  | 全局默认             | L2 行为策略（见 §三）                                           |

> **content 零声明**：`persona.md` / `rules.md` / `skills/` 全部约定俗成，manifest **不注册内容路径**（防路径写错静默丢内容）。
>
> **字段上限 SSOT**：上表的数量/长度上限以 `src/role-pack/validator.ts` 为唯一真理源（`MAX_MANIFEST_SKILLS` / `MAX_CAPABILITIES` / `MAX_HANDOFF_PROMPT_LEN` / `MAX_META_STRING_LEN`）。超限时校验报 error（开发期拒绝），运行时按上限截断兜底（宽容容错）。

### 2.4 rules.md 写法（ADR-025 档 3：规则语义对齐）

`rules.md` 是**确定性规则**——装载时全量注入 system prompt，不可丢失。解析支持常见 Markdown 写法（见 `rolePackManager.ts parseRules`）：

| 写法                                                    | 解析结果          | 示例              |
| ----------------------------------------------------- | ------------- | --------------- |
| **列表行**（`-` / `*` / `1.`）                             | 逐条成为规则（推荐写法）  | `- 不泄露用户密钥`     |
| **连续段落文本**                                            | 整段合并为**一条**规则 | 两行普通文字 → 一条完整规则 |
| **引用块**（`>`）                                          | 去 `>` 后按段落处理  | `> 修改前先询问用户`    |
| **标题**（`#`）/ **代码块** / **HTML 注释** / **表格** / **分隔线** | 不作为规则（段落边界）   | —               |

**推荐**：规则用**列表写**（每条一行，语义独立、可读性强）；长段说明自然写成段落，会被合并为一条完整规则。写作时避免把示例代码/表格塞进 rules.md（会被忽略）——需要代码/资源放 `skills/` 目录（渐进披露 L3）。

### 2.5 技能使用引导（persona/rules 里明确"何时用"）

> **推荐（2026-09-13 双锚点结论）**：角色包每内置一个 `skills/*.md`，都应在设定文本（persona.md 工作流程 / rules.md 纪律）里为它补一处**「使用时机」引导**——明示「什么情况使用这个 skill」。

**为什么**：技能元数据虽由内核从 `skills/` 目录自动注入（L1 清单，即技能三级渐进披露的「目录扫描」层；完整三级模型见仓库内 `docs/architecture/role-pack-skills-progressive-disclosure.md`，非随包文档），但那是扁平 name+description；LLM 的"何时调用"判断若只靠猜 description 是脆弱的。把触发场景写进 persona/rules，调用决策由**场景契约**驱动。能力定义仍以技能文件为唯一真理源，设定文本只写"何时用"、不复述怎么做。

**写法示例**（取自共鸣小说家）：
- persona 工作流程挂到对应阶段：`阶段6 大纲与成文（…+ dialogue-craft + …）——对白即行动、带潜台词`
- rules 写成触发式纪律：`- 伏笔必须回收：…（用 foreshadow 维护埋点清单：埋得轻、收得重、埋收必对）`

**覆盖完整性（强推荐自查）**：收录后逐个核对——每个内置 skill 在 persona/rules **至少有一处**标注使用时机（**引用须用反引号包裹技能名**，形式见 §2.6）。未标注的技能会沦为"存在但永不调用"的僵尸技能（共鸣小说家最初 5 个技能零引用即此缺口；白话方案设计师曾 6/6 全部零引用）。内核已由 `src/role-pack/__tests__/builtinPackCoverage.test.ts` 自动守卫：扫描 `role-packs/*/skills/*.md`，任一技能在所属包 persona/rules 零引用即红；**反向**（引用指向不存在的技能 = 改名残留的悬空引用）同由此守卫拦截。

**命名避撞（约定，非校验项）**：技能名避免与 manifest `strategy` 策略键**语义重复**（例：技能 `self-review` 与 `reflect.selfReview`）。二者运行时完全隔离，但同名近义会让作者与 LLM 分不清「设定内容」与「行为开关」。此类冲突是语义层的，**字面校验抓不到**（技能名 kebab-case 与策略键 camelCase 永不相等，同名检测会是永远绿的装饰性断言），故仅在此约定，不进 `validator`。

### 2.6 技能引用规范（设定文本里怎么「点名」技能）

> **规范（2026-09-14 定稿）**：设定文本（`persona.md` / `rules.md`）里引用技能时，**用反引号把技能名括起来**——例如 `foreshadow`、`dialogue-craft`。这是技能引用的**唯一合法形式**。

**为什么要有「形式」约束**：技能名是**契约**——它既是文件名（`skills/<name>.md` 或 `skills/<name>/SKILL.md`），又是设定文本里的引用名。改名（例：`self-review` → `craft-review`）若不改引用，就留下**悬空引用**。要让悬空引用可被机器发现，引用就必须有**确定性形式**——自然语言里的裸 kebab 词（如 `local-first`）与技能名无法区分，正则必然误判。

**三条约定**：

1. **技能名 = kebab-case**（小写字母 / 数字 / 连字符），且与文件名（单文件形态 `skills/x.md`）或目录名（文件夹形态 `skills/x/SKILL.md`）严格一致。**改名 = 破坏性变更**，须同步全部引用。
2. **引用形式 = 反引号包裹技能名**，可出现在任意语境：
   - persona 工作流程：阶段6 大纲与成文（`outline-expand` + `dialogue-craft` + …）
   - rules 触发式纪律：伏笔必须回收——埋得轻、收得重（用 `foreshadow` 维护埋点清单）
3. **保留字规则**：`persona.md` / `rules.md` 里**反引号包裹的 kebab 词一律判定为技能引用**——所以这两个文件里不要反引号包裹非技能标识（如 `local-first`、`role-pack-spec`），需要提到时写普通文本。

**双向守卫**（`src/role-pack/__tests__/builtinPackCoverage.test.ts`；两个方向**共用同一个引用提取器**，SSOT）：

| 方向 | 断言 | 防的是 |
| --- | --- | --- |
| 正向 | 每个内置技能至少被引用一次 | 「存在但永不调用」的僵尸技能 |
| 反向 | 每条引用都指向真实存在的技能 | 改名后残留的**悬空引用** |

**行业依据（2026-09-14 外部调研）**：Anthropic 官方 Skill authoring best practices 要求 `name` 只用小写字母 / 数字 / 连字符，并指出**一致的命名让技能更容易被引用与讨论**；Agent Skills 规范（agentskills.io）要求 `name` **必须与父目录名一致**；社区约定进一步把已发布的技能名当作 **API 契约——改名属 semver-major 变更**。本规范即把该契约收敛为「引用必须可机器校验」。

***

## 三、strategy 策略键（逐键填写指导）

### 3.1 prepare 组（回答前·认知）

> **阶段2（2026-09-09，memory-tool-recall-design）注记**：本组 6 个召回键 `memoryRecall` / `memoryRecallPercent` / `minFallback` / `contextAssembly` / `recallConfidence` / `summaryRecall` 已**整体退役**——记忆纯工具化召回后，prepare 无自动注入消费端，6 键与解析函数/常量一并移除。记忆检索改由 `memory_search` 工具触发（`source` 过滤承接 `summaryRecall` 语义）；上下文装配恒为 hybrid。**召回保底机制亦已彻底退役**（2026-09-10 剪枝：`DEFAULT_MIN_FALLBACK` 随 `recall()` 召回编排一并删除，见 memory-tool-recall-design 补记）。**记忆层 cap 常数 `DEFAULT_MEMORY_CAP_RATIO` 亦已于 2026-09-10 删除**（G39 P2-2：自动注入退役后无约束消费者）——现行预算模型无记忆维度。**`understandingConfirm` 亦已回收（2026-09-13，turn-intent-reasoning-design Part 3）**——confirm 并入 `askOn['confirm']`/ask_user 通道，echo 由内核 Turn 起始策略覆盖，不再作为开放键。本组现存 1 键：

| 键                      | 类型 / 枚举                      | 合法区间            | 默认       | 含义                                             | 示例              |
| `summaryFocus`         | string                       | `1 ~ 500` 字符    | 无        | 提炼视角：决定 round-summary「值得记什么」                   | `"聚焦架构决策与接口契约"` |

### 3.2 act 组（回答中·行动）

| 键                    | 类型 / 枚举                       | 合法区间               | 默认          | 含义            | 示例                |
| -------------------- | ----------------------------- | ------------------ | ----------- | ------------- | ----------------- |
| `toolMode`           | `allow` / `block`             | —                  | `allow`     | 是否允许工具调用      | `"block"`         |
| `temperature`        | number                        | `0.0 ~ 2.0`        | `0.7`       | 生成随机性         | `0.3`             |
| `outputLimit`        | 整数                            | `1 ~ 65536`（token） | `4096`      | 单轮回答长度上限      | `8192`            |
| `toolStepLimit`      | 整数                            | `0 ~ 100`（0=无限制）   | `20`        | 单轮工具调用步数上限    | `30`              |
| `providerRouting`    | `auto` / `fixed`              | —                  | `auto`      | Provider 路由策略 | `"fixed"`         |
| `multiStepReasoning` | `auto` / `manual`             | —                  | `auto`      | 多步推理模式        | `"manual"`        |
| `toolReadonly`       | `full` / `readonly`           | —                  | `full`      | 工具操作范围        | `"readonly"`      |

### 3.3 reflect 组（回答后·沉淀）

| 键              | 类型 / 枚举                 | 合法区间           | 默认       | 含义                                                                        | 示例       |
| -------------- | ----------------------- | -------------- | -------- | ------------------------------------------------------------------------- | -------- |
| `summary`      | `on` / `off`            | —              | `on`     | 是否生成轮次摘要                                                                  | `"off"`  |
| `selfReview`   | 整数                      | `0 ~ 10`（布尔数字：0=关闭，>0 收敛为 1） | `0`      | 自审查开关（布尔数字，2026-09-12 定案）：**0=不自审查，正整数 >0 一律收敛为 1=自审查一次（大于 1 算 1）**。当且仅当本 turn **执行过工具步**（多 step）后做一次终审；纯文本一遍问答不触发；审查应答为满意短确认（如"无需修改"）时立即终止 | `1`      |
| `userFollowup` | `ask` / `silent`        | —              | `silent` | 用户追问策略                                                                    | `"ask"`  |

### 3.4 global 组（跨阶段·全局）

| 键               | 类型 / 枚举                      | 合法区间                 | 默认                                    | 含义            | 示例                          |
| --------------- | ---------------------------- | -------------------- | ------------------------------------- | ------------- | --------------------------- |
| `askOn`         | 数组（元素见下）                     | 1\~4 个元素             | `[ambiguity, decision, missing_info]` | 主动提问触发场景（可组合） | `["ambiguity", "decision"]` |
| `askLimit`      | 整数                           | `1 ~ 10`             | `3`                                   | 每轮主动提问次数上限    | `2`                         |
| `errorHandling` | `retry` / `degrade` / `stop` | —                    | `retry`                               | 异常处理策略        | `"degrade"`                 |
| `contextLimit`   | 整数                           | `0` 或 `120000 ~ 2000000` | 未声明→`0`（跟随 provider 窗口）                           | 角色包上下文上限（**推荐 0**）  | `0`                     |
| `stepBudget`    | 整数                           | `0 ~ 500`（0=兜底，非不限）  | `50`                                  | 每轮工具步数上限（0=走内核 maxIterations 兜底，无「不限」路径） | `60`                        |

> `askOn` 元素枚举：`ambiguity`（模糊）/ `decision`（需决策）/ `missing_info`（缺信息）/ `confirm`（需确认）。
> `userFollowup` 须为 `ask` 时 `askOn`/`askLimit` 才生效。
> `contextLimit` 为**角色包级**的上下文上限：与 provider 窗口**取小值**后成为**有效窗口**（截断 / 软上限 / 占用快照均按有效窗口计算），超限时在**截断层裁剪、不终止本轮**。三点须知：
> 1. **推荐填 0**（内置示例包即如此）：`0` 或未声明 = 不设额外上限，有效窗口 = provider 窗口；要整体缩小上下文规模也可直接调 provider 配置；
> 2. **典型用法**：provider 声明 1M，但某角色只需 300k → 该角色声明 `300000`，有效窗口取小值 300k，把模型能力留给真正需要的角色；
> 3. **只会取小、绝不放大**：声明值大于 provider 窗口时按 provider 窗口算；**终止职责归 `stepBudget`**，本键只管规模。

***

## 四、数值键区间总表（内核统一上下限）

> 所有开放给角色包填写的**数值键均有上下限**，由内核统一控制（SSOT：`src/role-pack/strategyKeys.ts`）。
> **下限**防负值/零值语义错误，**上限**防资源失控（token/步数/轮数）或业务荒谬值。

| 键                     | 下界   | 上界      | 越界行为（validator） | 越界行为（运行时）          |
| --------------------- | ---- | ------- | --------------- | ------------------ |
| `summaryFocus`        | 1 字符 | 500 字符  | error           | 回退 undefined（通用浓缩） |
| `temperature`         | 0    | 2       | error           | 忽略不注入              |
| `outputLimit`         | 1    | 65536   | error           | 忽略不注入              |
| `toolStepLimit`       | 0    | 100     | error           | 回退默认 `0`（无限制）      |
| `selfReview`          | 0    | 10      | error           | 回退 `0`（关闭）       |
| `askLimit`            | 1    | 10      | error           | 回退默认 `3`           |
| `contextLimit`         | 0    | 1000000 | error           | 回退内核兜底 `80000`      |
| `stepBudget`          | 0    | 500     | error           | 回退默认 `50`          |

***

## 五、校验行为（填错了会怎样）

| 情况                                    | 级别      | 行为                     |
| ------------------------------------- | ------- | ---------------------- |
| 缺失 `name` / `formatVersion` 非法        | error   | 校验不通过（当前装载器警告降级，不拒绝装载） |
| 枚举键取值不在枚举内                            | error   | 校验不通过；运行时归位内核默认        |
| 数值键越界（超出上下限）                          | error   | 校验不通过；运行时回退内核默认/忽略     |
| 未知顶层键 / 未知策略阶段 / 未知策略键                | warning | 警告并忽略，不阻塞装载（键级渐进）      |
| `capabilities` 格式非法（非 `域:动作`）         | error   | 校验不通过                  |
| companion 缺 AI 身份/未声明 minorProtection | error   | 校验不通过                  |
| companion 正文含虚拟亲属/伴侣红线词               | error   | 拒绝装载                   |

> 数值键越界报错信息会带合法区间提示，如：
> `strategy.global.contextLimit 取值 999999 不符合约束，合法区间 [0, 1000000]`

***

## 六、键的落实状态（哪些声明生效）

| 状态          | 含义          | 键             |
| ----------- | ----------- | ------------- |
| **已消费（冻结）** | 内核真实读取并影响行为 | 上述 §三 全部 16 键（prepare 1 / act 7 / reflect 3 / global 5） |

> 全部策略键现均已落地，无纯预留死键。`understandingConfirm` 已回收（2026-09-13，turn-intent-reasoning-design Part 3）：confirm 并入 `askOn['confirm']`/ask_user 工具通道，echo 由内核 Turn 起始策略指令覆盖——确认场景统一走 ask_user 单一通道，不再作为开放键。已撤键先例：`costBudget`（2026-08-28，内核无定价能力、宿主无执行者）、`taskLoopLimit`（2026-09-06，多 turn 编排删除 + 会议确定性预置退役后无常量消费方）、prepare 召回策略键族 6 键（2026-09-09 阶段2，记忆纯工具化召回后无自动注入消费端）、`toolApproval`（2026-09-11，审批链无执行方的展示性假承诺）、`streaming`（2026-09-11，写而不读的假旋钮——内核 provider 恒 `stream:true`）、`loopContinue`（2026-09-11，v0.13- 别名；安装基数 0 → 兼容防的是从未发生的场景，按版本契约分面「作者输入面可不兼容」删除）——**无消费者 / 无真实兼容对象的策略键不保留**。诚实化声明见 `src/role-pack/types.ts` `BehaviorStrategy` 注释。

***

## 七、常见错误与修正

| ❌ 错误写法                                              | ✅ 正确写法                                           | 原因                    |
| --------------------------------------------------- | ------------------------------------------------ | --------------------- |
| `"outputLimit": 999999`                             | `"outputLimit": 8192`                            | 越上界 `65536`，防输出失控     |
| `"contextLimit": -100`                               | `"contextLimit": 0`                               | 负值非法，应为 `0 ~ 1000000`；推荐 `0`（不限制） |
| `"selfReview": 999`                                 | `"selfReview": 1`                                | 越上界 `10` 非法；布尔数字语义下任意正整数只表示"自审查一次"，写 `1` 最清晰 |
| `"capabilities": [{"capability": "WriteFile"}]`     | `"capabilities": [{"capability": "file:write"}]` | 能力名必须 `域:动作` 小写格式     |
| `"strategy": { "prepare": { "unknownKey": true } }` | 去掉该键                                             | 未知键 warning + 忽略，不生效  |

***

## 八、参考

* 中立规范（跨实现契约）：[role-pack-spec.md](./role-pack-spec.md)

* 示例角色包（结构参考，不参与分发）：[role-packs/](../../role-packs/README.md)

* 区间常量 SSOT：`src/role-pack/strategyKeys.ts`

* 运行时解析与兜底：`src/role-pack/strategyResolver.ts`

* 格式校验器：`src/role-pack/validator.ts`

