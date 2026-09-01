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
  "name": "doc-writer",
  "displayName": "文档设计师",
  "description": "技术文档设计角色包",
  "version": "1.0.0",
  "keywords": ["文档", "API", "教程"],
  "formatVersion": "1.0.0",
  "interactionType": "tool_assistant",
  "strategy": {
    "prepare": { "memoryRecall": "full", "contextAssembly": "hybrid" },
    "act": { "toolMode": "allow", "temperature": 0.3 },
    "reflect": { "handoff": "wait", "loopContinue": 2 },
    "global": { "tokenBudget": 12000, "stepBudget": 60 }
  },
  "capabilities": [
    { "capability": "file:write", "description": "写文件" },
    { "capability": "web:search", "description": "搜索" }
  ],
  "handoffPrompt": "你好，我是文档设计师，请告诉我你想设计什么文档。"
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
| `keywords`             | string\[] 或逗号串                 | 否  | 无                | 匹配词源（与 trigger 合并去重）；最多 20 个，单个 ≤50 字符                  |
| `trigger`              | string\[] 或逗号串                 | 否  | 无                | 触发词（精确/包含匹配，**非正则**）；与 keywords 合并；最多 20 个，单个 ≤50 字符    |
| `author`               | string                         | 否  | 无                | 作者/来源；≤200 字符                                           |
| `interactionType`      | `tool_assistant` / `companion` | 否  | `tool_assistant` | companion 触发全量强校验                                       |
| `aiIdentityDisclosure` | boolean                        | 否  | `true`           | companion 必须显式 `true`                                   |
| `minorProtection`      | `required`                     | 否  | `required`       | 未成年人保护钩子，仅支持 `required`                                 |
| `handoffPrompt`        | string                         | 否  | 无                | 被带入对话时预填的接手话术；≤2000 字符                                  |
| `skills`               | 对象数组                           | 否  | 无                | 技能白名单（`{ file, name?, description? }`）；不声明则全量扫描；最多 50 项 |
| `capabilities`         | 对象数组                           | 否  | `[]`             | 能力声明（`{ capability, description? }`）；最多 50 项            |
| `strategy`             | 嵌套对象                           | 否  | 全局默认             | L2 行为策略（见 §三）                                           |

> **content 零声明**：`persona.md` / `rules.md` / `skills/` 全部约定俗成，manifest **不注册内容路径**（防路径写错静默丢内容）。
>
> **字段上限 SSOT**：上表的数量/长度上限以 `src/role-pack/validator.ts` 为唯一真理源（`MAX_MATCH_WORDS` / `MAX_MATCH_WORD_LEN` / `MAX_MANIFEST_SKILLS` / `MAX_CAPABILITIES` / `MAX_HANDOFF_PROMPT_LEN` / `MAX_META_STRING_LEN`）。超限时校验报 error（开发期拒绝），运行时按上限截断兜底（宽容容错）。

### 2.4 rules.md 写法（ADR-025 档 3：规则语义对齐）

`rules.md` 是**确定性规则**——装载时全量注入 system prompt，不可丢失。解析支持常见 Markdown 写法（见 `rolePackManager.ts parseRules`）：

| 写法                                                    | 解析结果          | 示例              |
| ----------------------------------------------------- | ------------- | --------------- |
| **列表行**（`-` / `*` / `1.`）                             | 逐条成为规则（推荐写法）  | `- 不泄露用户密钥`     |
| **连续段落文本**                                            | 整段合并为**一条**规则 | 两行普通文字 → 一条完整规则 |
| **引用块**（`>`）                                          | 去 `>` 后按段落处理  | `> 修改前先询问用户`    |
| **标题**（`#`）/ **代码块** / **HTML 注释** / **表格** / **分隔线** | 不作为规则（段落边界）   | —               |

**推荐**：规则用**列表写**（每条一行，语义独立、可读性强）；长段说明自然写成段落，会被合并为一条完整规则。写作时避免把示例代码/表格塞进 rules.md（会被忽略）——需要代码/资源放 `skills/` 目录（渐进披露 L3）。

***

## 三、strategy 策略键（逐键填写指导）

### 3.1 prepare 组（回答前·认知）

| 键                      | 类型 / 枚举                      | 合法区间            | 默认       | 含义                                             | 示例              |
| ---------------------- | ---------------------------- | --------------- | -------- | ---------------------------------------------- | --------------- |
| `memoryRecall`         | `full` / `limited` / `none`  | —               | `full`   | 记忆召回模式                                         | `"limited"`     |
| `understandingConfirm` | `off` / `echo` / `confirm`   | —               | `off`    | 理解确认模式：off=直接生成 / echo=复述不等待 / confirm=预检停顿后确认 | `"confirm"`     |
| `memoryRecallPercent`  | number                       | `0.0 ~ 1.0`     | `0.4`    | 记忆摘要层占剩余预算上限百分比（cap 非 quota）                   | `0.3`           |
| `minFallback`          | 整数                           | `0 ~ 100`（0=关闭） | `2`      | 语义召回不足时补足最近记忆的条数                               | `5`             |
| `summaryFocus`         | string                       | `1 ~ 500` 字符    | 无        | 提炼视角：决定 round-summary「值得记什么」                   | `"聚焦架构决策与接口契约"` |
| `contextAssembly`      | `fixed` / `query` / `hybrid` | —               | `hybrid` | 上下文装配策略                                        | `"hybrid"`      |
| `recallConfidence`     | number                       | `0.0 ~ 1.0`     | `0.6`    | 召回相似度阈值（越大越严格）                                 | `0.7`           |
| `summaryRecall`        | `on` / `off`                 | —               | `on`     | 摘要是否参与召回                                       | `"off"`         |

### 3.2 act 组（回答中·行动）

| 键                    | 类型 / 枚举                       | 合法区间               | 默认          | 含义            | 示例                |
| -------------------- | ----------------------------- | ------------------ | ----------- | ------------- | ----------------- |
| `toolMode`           | `allow` / `block`             | —                  | `allow`     | 是否允许工具调用      | `"block"`         |
| `temperature`        | number                        | `0.0 ~ 2.0`        | `0.7`       | 生成随机性         | `0.3`             |
| `outputLimit`        | 整数                            | `1 ~ 65536`（token） | `4096`      | 单轮回答长度上限      | `8192`            |
| `streaming`          | `streaming` / `non-streaming` | —                  | `streaming` | 输出方式          | `"non-streaming"` |
| `toolStepLimit`      | 整数                            | `0 ~ 100`（0=无限制）   | `20`        | 单轮工具调用步数上限    | `30`              |
| `providerRouting`    | `auto` / `fixed`              | —                  | `auto`      | Provider 路由策略 | `"fixed"`         |
| `inputInterrupt`     | `allow` / `block`             | —                  | `allow`     | 执行中是否可接受新输入   | `"block"`         |
| `multiStepReasoning` | `auto` / `manual`             | —                  | `auto`      | 多步推理模式        | `"manual"`        |
| `toolReadonly`       | `full` / `readonly`           | —                  | `full`      | 工具操作范围        | `"readonly"`      |
| `toolApproval`       | `auto` / `confirm`            | —                  | `auto`      | 工具批准模式        | `"confirm"`       |

### 3.3 reflect 组（回答后·沉淀）

| 键              | 类型 / 枚举                 | 合法区间           | 默认       | 含义                                                                      | 示例       |
| -------------- | ----------------------- | -------------- | -------- | ----------------------------------------------------------------------- | -------- |
| `summary`      | `on` / `off`            | —              | `on`     | 是否生成轮次摘要                                                                | `"off"`  |
| `handoff`      | `wait` / `loop` / `end` | —              | `wait`   | 结束衔接模式                                                                  | `"loop"` |
| `loopContinue` | 整数                      | `0 ~ 10`（0=关闭） | `0`      | 本问答闭环**执行过工具步**（多轮执行闭环）后自动自审查最多 N 轮；纯文本一遍问答不触发；审查应答为满意短确认（如"无需修改"）时立即终止 | `2`      |
| `userFollowup` | `ask` / `silent`        | —              | `silent` | 用户追问策略                                                                  | `"ask"`  |

### 3.4 global 组（跨阶段·全局）

| 键               | 类型 / 枚举                      | 合法区间                 | 默认                                    | 含义            | 示例                          |
| --------------- | ---------------------------- | -------------------- | ------------------------------------- | ------------- | --------------------------- |
| `askOn`         | 数组（元素见下）                     | 1\~4 个元素             | `[ambiguity, decision, missing_info]` | 主动提问触发场景（可组合） | `["ambiguity", "decision"]` |
| `askLimit`      | 整数                           | `1 ~ 10`             | `3`                                   | 每轮主动提问次数上限    | `2`                         |
| `errorHandling` | `retry` / `degrade` / `stop` | —                    | `retry`                               | 异常处理策略        | `"degrade"`                 |
| `tokenBudget`   | 整数                           | `0 ~ 1000000`（0=不限制） | `200000`                              | 每轮总 token 上限  | `120000`                    |
| `stepBudget`    | 整数                           | `0 ~ 500`（0=不限制）     | `50`                                  | 每轮工具步数上限（软上限） | `60`                        |
| `taskLoopLimit` | 整数                           | `0 ~ 100`（0=关闭）      | `10`                                  | 外部任务驱动循环步数上限  | `20`                        |

> `askOn` 元素枚举：`ambiguity`（模糊）/ `decision`（需决策）/ `missing_info`（缺信息）/ `confirm`（需确认）。
> `userFollowup` 须为 `ask` 时 `askOn`/`askLimit` 才生效。

***

## 四、数值键区间总表（内核统一上下限）

> 所有开放给角色包填写的**数值键均有上下限**，由内核统一控制（SSOT：`src/role-pack/strategyKeys.ts`）。
> **下限**防负值/零值语义错误，**上限**防资源失控（token/步数/轮数）或业务荒谬值。

| 键                     | 下界   | 上界      | 越界行为（validator） | 越界行为（运行时）          |
| --------------------- | ---- | ------- | --------------- | ------------------ |
| `memoryRecallPercent` | 0    | 1       | error           | 回退默认 `0.4`         |
| `minFallback`         | 0    | 100     | error           | 回退默认 `2`           |
| `summaryFocus`        | 1 字符 | 500 字符  | error           | 回退 undefined（通用浓缩） |
| `recallConfidence`    | 0    | 1       | error           | 回退默认               |
| `temperature`         | 0    | 2       | error           | 忽略不注入              |
| `outputLimit`         | 1    | 65536   | error           | 忽略不注入              |
| `toolStepLimit`       | 0    | 100     | error           | 回退默认 `0`（无限制）      |
| `loopContinue`        | 0    | 10      | error           | 回退 `0`（关闭）         |
| `askLimit`            | 1    | 10      | error           | 回退默认 `3`           |
| `tokenBudget`         | 0    | 1000000 | error           | 回退默认 `200000`      |
| `stepBudget`          | 0    | 500     | error           | 回退默认 `50`          |
| `taskLoopLimit`       | 0    | 100     | error           | 回退默认 `10`          |

***

## 五、校验行为（填错了会怎样）

| 情况                                    | 级别      | 行为                     |
| ------------------------------------- | ------- | ---------------------- |
| 缺失 `name` / `formatVersion` 非法        | error   | 校验不通过（当前装载器警告降级，不拒绝装载） |
| 枚举键取值不在枚举内                            | error   | 校验不通过；运行时归位内核默认        |
| 数值键越界（超出上下限）                          | error   | 校验不通过；运行时回退内核默认/忽略     |
| 未知顶层键 / 未知策略阶段 / 未知策略键                | warning | 警告并忽略，不阻塞装载（键级渐进）      |
| `capabilities` 格式非法（非 `域:动作`）         | error   | 校验不通过                  |
| `trigger` 误用正则语法（`/pattern/i`）        | warning | 会被当字面关键词，无法匹配任何输入      |
| companion 缺 AI 身份/未声明 minorProtection | error   | 校验不通过                  |
| companion 正文含虚拟亲属/伴侣红线词               | error   | 拒绝装载                   |

> 数值键越界报错信息会带合法区间提示，如：
> `strategy.global.tokenBudget 取值 999999 不符合约束，合法区间 [0, 1000000]`

***

## 六、键的落实状态（哪些声明生效）

| 状态          | 含义          | 键             |
| ----------- | ----------- | ------------- |
| **已消费（冻结）** | 内核真实读取并影响行为 | 上述 §三 全部 28 键 |

> 全部策略键现均已落地，无纯预留死键：`understandingConfirm` 经 `assembleRolePack` 注入 persona prompt 行为指令（off=直接答 / echo=复述不等待 / confirm=复述并等待确认）。`costBudget` 因内核无定价能力、宿主无执行者已于 2026-08-28 撤键（无消费者的策略键不保留）。诚实化声明见 `src/role-pack/types.ts` `BehaviorStrategy` 注释。

***

## 七、常见错误与修正

| ❌ 错误写法                                              | ✅ 正确写法                                           | 原因                    |
| --------------------------------------------------- | ------------------------------------------------ | --------------------- |
| `"outputLimit": 999999`                             | `"outputLimit": 8192`                            | 越上界 `65536`，防输出失控     |
| `"tokenBudget": -100`                               | `"tokenBudget": 120000`                          | 负值非法，应为 `0 ~ 1000000` |
| `"loopContinue": 999`                               | `"loopContinue": 3`                              | 越上界 `10`，防无限自审查       |
| `"trigger": ["/文档/i"]`                              | `"trigger": ["文档"]`                              | trigger 不支持正则，会被当字面词  |
| `"capabilities": [{"capability": "WriteFile"}]`     | `"capabilities": [{"capability": "file:write"}]` | 能力名必须 `域:动作` 小写格式     |
| `"strategy": { "prepare": { "unknownKey": true } }` | 去掉该键                                             | 未知键 warning + 忽略，不生效  |

***

## 八、参考

* 中立规范（跨实现契约）：[role-pack-spec.md](./role-pack-spec.md)

* 示例角色包（结构参考，不参与分发）：[role-packs/](../../role-packs/README.md)

* 区间常量 SSOT：`src/role-pack/strategyKeys.ts`

* 运行时解析与兜底：`src/role-pack/strategyResolver.ts`

* 格式校验器：`src/role-pack/validator.ts`

