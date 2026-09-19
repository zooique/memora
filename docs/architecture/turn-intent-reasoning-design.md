# Turn 意图理解与模型思考展示设计（探索中）

> **状态**：探索中（2026-09-13）——可逆设计，先落 `docs/` 验证，不占 ADR 编号、不改决策 README 索引；验证稳定、被真实场景复现消费后按需固化为 ADR。
> **版本归属**：3.1.0 增强包（3.0.0 已就绪，不受本设计影响）。
> **阶段进度**：A（reasoning 采集展示）/ B（Turn 起始策略指令）/ C（回收 understandingConfirm）**均已实施**（2026-09-13）；真机验证待真实 LLM 环境。
> **土壤来源**：Plan-and-Execute / Pre-Act / Think Tool 模式、Anthropic thinking / Fable 5 prompt 指南、Open WebUI reasoning 折叠实践、Claude Code Plan Mode 剖析（搜索于 2026-09-13，详见关联）。

## 一、背景与目标

两个独立诉求，分开治理：

1. **思考透明化**：OpenAI 兼容协议（deepseek 等）用 `delta.reasoning_content` 流式发送"思考"，memora 当前丢弃——采集并在 UI 折叠块展示。
2. **turn 起始行为约束**：每个新 turn 以"行为边界"引导替代"直接想+调工具"——需要信息先调查、复杂任务用任务表、简单问题直接答（约束式提示，非步骤脚本）。

配套诉求：回收角色包开放键 `prepare.understandingConfirm`（off/echo/confirm）——由内核自定决策取代。

## 二、现状核实（2026-09-13 实测）

| 项 | 现状 |
| --- | --- |
| SSE 解析 | [openaiCompatible.ts](../../src/llm/openaiCompatible.ts) 只取 `delta.content` + `tool_calls`，`reasoning_content` 丢弃 |
| LlmChunk | [llm/types.ts](../../src/llm/types.ts) 仅 content/toolCalls/finishReason/usage，无 reasoning 字段 |
| loop 第一步 | [loop.ts](../../src/agent/loop.ts) `runIterationLoop` → `handleIteration` 直接"想+调工具"，无意图理解/策略决策 step |
| understandingConfirm | 开放键，唯一消费 = [strategyResolver.ts](../../src/role-pack/strategyResolver.ts) `assembleRolePack` 注入 persona prompt 指令；**2 个示例角色包实际配置 `confirm`**（白话方案设计师/共鸣小说家；方案设计师/文档设计师已于 0ba12c55 退役，原小说助手更名共鸣小说家） |
| confirm 通道重叠 | `askOn['confirm']` + `ask_user` 工具已机制级承载"需要用户确认"；understandingConfirm.confirm 是绕过该真源的裸 prompt 指令（**带伤，见 §四**） |
| narrate 机制 | 已存在（2026-09-02）：工具轮行动叙述，**平铺展示**（纯文本块直展，v1.8 step 分型；结束后随过程收进任务过程折叠块）、不进正文，**落盘进 `Round.processEvents`**（roundStore.ts 联合类型为真源），含首轮回抽（withdrawn 瞬态）——"策略叙述"的现成载体 |
| 过程事件落盘 | **已存在**（[process-event-log-replay-design.md](./process-event-log-replay-design.md)）：运行时过程事件（thinking/tool_*/narrate/self_review/metrics）缓冲后附到 `Round.processEvents` 落盘，重载按序重放重建 UI（对标 Claude Code JSONL 事件日志）——**reasoning 落盘 = 扩展该机制，非新存储** |

## 三、排雷结论（对初版方案的批判性检查）

| # | 雷 | 对策 |
| --- | --- | --- |
| R1 | **understandingConfirm 不是死键**：3 个示例角色包实际配置 `confirm`，直接回收会静默丢失"复述确认"行为 | 探索期**不动角色包**（用户拍板，2026-09-13）；定案时一次性迁移对齐（Part 3） |
| R2 | **validator 对未知策略键是 warning+忽略**（键级渐进）——若定案后角色包仍声明已删键，不报错但静默失效 | 这是 validator **既有**宽容机制（非为回收新写），不算带伤；定案时角色包同步迁移消除残留，**不为兼容写任何新代码** |
| R3 | **reasoning 流式语义**：若每个 chunk 带全量累积值 → O(n²) 拼接 + 宿主重复渲染 | reasoning 走**增量**（每 chunk 只带新增片段），消费侧自行累积（与 content 同构） |
| R4 | **AgentChunk 新增类型 = 协议变更**：需同步 IPC 通道治理（100/130 阈值）、宿主渲染、过程事件回放 | reasoning 走**现有 ProcessEvent 落盘机制**（新增 `type: 'thought'` 成员，随 Round 重放重建）——不落独立存储、不新建回放路径（process-event-log-replay-design 明确"新增事件类型只需扩展折叠区小节 + ProcessEvent union 成员"） |
| R5 | **prompt 软约束的固有风险**：LLM 可能在不该啰嗦的场景输出叙述，无 tool_calls 时不会被 narrate 分类拦截，污染正文 | 接受软约束定位：指令是**边界引导非步骤脚本**（约束式极简）；单元测试只覆盖注入正确性，行为验证靠人工/集成 |
| R6 | **内核固定指令 vs 角色包自由度**：创作类角色（如共鸣小说家）可能反感"策略决策叙述" | 指令收敛为**边界式约束**：只画"何时调查/何时规划"的行为边界，不强制输出模板、不写步骤脚本；输出形态由 LLM 裁量（对齐 Anthropic"目标+约束"指南） |
| R7 | **内核固定指令 vs 角色包边界规则（R1）**："怎么做事"归角色包，指令可能被判定越界 | 边界论证：本指令是**内核 turn 结构语义**（同 loop 的 step 边界、selfReview 注入），非角色包设定记忆 |
| R8 | **现有测试断言**：loop/agent 测试可能断言 systemPrompt 或 personaPrompt 内容，注入新段会挂 | 改动前 grep 断言点；新增用例只断言"指令注入存在" |
| R9 | **非 reasoning 模型的降级**：普通模型 `chunk.thought` 恒 undefined | 宿主折叠块空则不渲染，自然降级，无需特判 |
| R10 | **usage 与 reasoning 合并边界**：deepseek 的 reasoning_content 在 `choices.delta` 内，正常走 content 分支 | 解析放 `choices.delta` 分支，与 content 并列，不碰 usage 独立 yield 路径 |
| R11 | **reasoning 不回写记忆的约束点**：必须在 llmCaller/loop 层拦截，不拼进 fullContent、不进 appendAssistant、不进 round-summary 输入；但**进 ProcessEvent（展示轨）** | 实现约束写入 Part 1：双轨分离——正文轨（assistantMessage）与记忆轨（round-summary）**永不碰 reasoning**，展示轨（processEvents）承载 |
| R12 | **3.0.0 发布窗口**：改动不得影响 3.0.0 | 全部改动标 3.1.0；3.0.0 发布不阻塞 |

## 四、不带伤自检（legacy-contract-audit 反模式三题）

**自问三题**：① 从零设计会这样写吗？② 去掉"兼容旧 XX"这层，核心是否完整？③ 是否在 SSOT 之外另开手写通道？

| 检查点 | 判定 |
| --- | --- |
| **回收 understandingConfirm.confirm** | **本方案的动机正是消除带伤**：confirm 语义在 `ask_user`（机制级真源）之外另开了裸 prompt 手写通道（命中判别 ③），且与 `askOn['confirm']` 同语义双实现（命中判别 ①）。回收 = 收敛到 ask_user 单一通道，不是新造伤 |
| **回收的落地方式** | **硬删 + 定案时角色包同步迁移**，不留"认识该键但不消费"的软废弃兼容代码（那才是带伤：为兼容旧配置多绕一层）。validator 不新增任何逻辑 |
| **Part 1 reasoning 通道** | 从零设计会这么写（增量流式 + 独立通道），无兼容层 |
| **Part 2 策略指令** | 内核固定段、不开放键、不强制输出模板——不造旋钮、不复制通道 |
| **Part 3 迁移映射** | 探索期不动（不产生"一边改设计一边改角色包"的来回抖动）；定案时一次性对齐，无历史折衷残留 |

## 五、决策点拍板（程序员心智模型，2026-09-13）

### D1：reasoning 是否在工具调用间回传模型 —— **不回传（展示-only）**

- 自问三题：① 回传只在"多步工具推理连续性"场景生效（增强非正确性）② 去掉回传，采集+展示仍完整 ③ 回传需改 assistant 消息构造，且是 Provider 特异行为（deepseek 支持，通用 OpenAI 兼容协议不保证）——补丁信号。
- 思考连续性由上下文（历史消息 + 工具结果）承载，不回传不破坏闭环。
- v3.1.0 只做采集+展示；"回传"入观察区，真实场景需要时再评估。

### D2：策略决策指令放内核固定段 vs 角色包可配 —— **内核固定段（约束式边界，非步骤脚本）**

- 角色包可配 = 再造旋钮，与"回收 understandingConfirm"自相矛盾（回收一个又造一个，逻辑不通）。
- 主流实证（2026-09-13 搜索）：Anthropic 官方指南主张"目标+约束而非步骤脚本"（脚本化指示降低输出质量）；Claude Code 默认 Tool-Use Loop 无强制规划 step，Plan Mode 为用户主动切换；业界共识为"开放式 agent 用 LLM 规划（prompt），固定流程才用代码硬编码"。故指令**不写"先理解→再分类→再行动"脚本**，只画"何时该查/何时该规划"的行为边界，输出形态由 LLM 裁量。
- 单一真理源：一处定义（systemPrompt 固定段），不开放键。

### D3：策略叙述复用 narrate vs 独立通道 —— **复用 narrate；reasoning 独立通道**

- 借力生长：narrate 已完整（行动前叙述 + **平铺展示** + 不回正文 + 回抽），策略叙述与其语义同构，嫁接而非并列。
- **"平铺展示"正是 narrate 的形态**：策略叙述"我先查一下资料"以 narrate 平铺在对话流（纯文本直展），用户所见即"直接文字展示"；narrate 的真正价值不在"放哪"，而在"**算不算正文**"——它不进 assistantMessage（不污染最终回答/摘要），只是过程轨迹。
  - **例（为什么"算不算正文"重要）**：用户问"对比 A/B 方案"——
    - 走普通 text：最终回答 = "我先查一下资料。根据查询结果，A…B…"——"我先查一下"混进答案，round-summary 也把它当对话内容记下；
    - 走 narrate：对话流平铺显示"我先查一下资料"（可见但不进正文），工具调用后最终回答 = "根据查询结果，A…B…"——答案干净，摘要干净。
- reasoning 独立：语义（模型思考 vs 行动叙述）、来源（`delta.reasoning_content` vs `delta.content`）、展示样式均不同，不混入 narrate。

## 六、方案细节

### Part 1：reasoning 采集与折叠展示（①，低风险先行）

改动链（自底向上）：

```
LlmChunk.thought（增量片段）
  ↑ SSE 解析：choices.delta.reasoning_content → chunk.thought
  ↑ llmCaller.callWithRetry：累积 fullReasoning，逐 chunk 透传
  ↑ AgentChunk 新增 { type: 'thought'; content: string }
  ↑ 宿主 consumeFlow：reasoning chunk → events[] 缓冲（与 narrate 同路径）
  ↑ 流结束 → 附到 Round.processEvents 落盘（ProcessEvent 新增 type: 'thought' 成员）
  ↑ 重载 → 按 seq 重放 → 折叠块"思考中"重建（与运行时同一渲染函数）
```

实现约束（R11）：
- `fullContent` 只拼 `chunk.content`，**reasoning 永不拼入** → 不进 appendAssistant（正文轨）、不进 round-summary 输入（记忆轨）——CoT 污染防护。
- reasoning 走**展示轨**：进 `Round.processEvents`（新增 `type: 'thought'`，`payload: { content }`），随 Round 生命周期（删 round 即删、分叉即共享、截断即覆盖），**不落独立存储**（对齐 process-event-log-replay-design 单文件内聚）。
- 超长防护：`payload.content` 超长截断（对齐现有 `tool_args` 截断先例，常量 + 省略标记）；首期存原文，观察区记录"是否降级摘要"。
- 与 narrate.withdrawn 无关：reasoning 本就不进正文，无首轮回抽需求。

### Part 2：Turn 起始策略指令（②，prompt 层行为约束）

systemPrompt 固定段注入（内核定义，不开放键；D2 边界论证见 R7）。**约束式极简提示**——只画行为边界（何时该查、何时该规划），不教步骤（不写"先理解→再分类→再行动"脚本）：

```
## Turn 起始策略
需要外部信息时，先调用工具调查再回答，不要凭记忆猜测；
任务需要多步推进时，使用任务表工具规划执行；
简单问题直接回答。
```

- 依据（主流实证，2026-09-13 搜索）：Anthropic 官方 prompt 指南明确"步骤脚本式指示会降低输出质量，应给目标+约束让模型自行规划步骤"、"长规则清单会锚定旧行为"；Claude Code 默认即 Tool-Use Loop（无强制规划 step），Plan Mode 是**用户主动切换**的模式，非每轮硬编码。意图理解与 A/B/C 分档是 LLM 天然能力，无需指令化。
- **记忆引导不重复（排雷）**：memora 已对"先回忆"做了两处软引导——`search_memories` 工具描述触发词（涉及过往决定/历史事实/用户偏好/项目背景/不确定时优先调用）+ loop"记忆回想"无条件注入。Part 2 指令**不重复写"先回忆"**（三处软引导重复 = 带伤"同语义多实现"）；本指令"需要外部信息时先调用工具调查"已天然涵盖"需要历史 → search_memories"。
- 历史背书：记忆召回曾尝试"首轮工具面硬收窄"（结构性强制先搜记忆），2026-09-11 因实现缺陷+预支复杂度砍除、保留软引导（[memory-tool-recall-design.md](./memory-tool-recall-design.md)）——与"约束式边界、非硬机制"同向，佐证本指令定位。
- 策略叙述复用 narrate 通道（D3）：LLM 在工具轮前本就倾向输出"我先查一下"，以 narrate **平铺展示**、不进正文（LLM 叙述不由指令强求，仅边界引导）。
- 位置待定：`buildSystemPromptPrefix`（[assembler.ts](../../src/agent/assembler.ts)）或角色包 persona 尾部；实现时按装配顺序择一，**单点注入、无第二副本**。

### Part 3：回收 understandingConfirm（③）——**已实施（2026-09-13）**

**实施动作**：硬删键 + 3 个示例包同步迁移（小说助手删键；方案设计师/文档设计师 askOn 加 `'confirm'` 后删键）；validator 零改动（未知键 warning+忽略属既有机制）。清理面已覆盖：`UnderstandingConfirm` 类型、`resolveUnderstandingConfirm`、默认值与键规则、`assembleRolePack` 注入段、3 个 manifest、schema、role-pack-spec / authoring-guide / 开放键指南 / 策略键消费矩阵 / 接入指南 / role-pack-creator SKILL 模板 / README。

**回收语义**：

| 语义 | 去向 |
| --- | --- |
| `echo`（复述不等待） | 由 Part 2 边界指令覆盖（需要时自然输出策略叙述），删除 |
| `confirm`（复述并等待确认） | 并入 `askOn['confirm']` + ask_user 工具通道（机制级真源），删除 |

迁移映射（定案时同步执行）：
- 共鸣小说家（原小说助手）：askOn 已含 `confirm` → 仅删 understandingConfirm 键，行为由既有 ask_user 通道继续承载（包随更名，原 manifest 路径已不适用）。
- 方案设计师 / 文档设计师：askOn 加 `'confirm'` 后删键（行为从"每轮必复述确认"变为"需要时提问确认"——对设计协作场景更合理：模糊时对齐、清晰时直接推进）。两包随后于 0ba12c55 退役，其设计方法论与文档编排由白话方案设计师吸收承接。

清理面（定案时）：`UnderstandingConfirm` 类型、`resolveUnderstandingConfirm`、`prepare.understandingConfirm` 默认值与键规则、`assembleRolePack` 注入段、3 个 manifest、schema 与文档（role-pack-spec / authoring-guide / 开放键指南 / 策略键消费矩阵 / role-pack-creator SKILL 模板 / README）。

**不带伤约束**：硬删 + 同步迁移，**不写软废弃兼容代码**（validator 不新增逻辑；回收后仍声明该键的角色包走 validator 既有"未知键 warning+忽略"宽容，属既有机制，非为回收新写）。

**不回收**：`userFollowup` / `askOn` / `askLimit`——有 ask_user 机制级消费，真实承载，不属于同等情况。

## 七、测试策略

| 层 | 用例 |
| --- | --- |
| SSE 解析 | mock 含 `reasoning_content` 的流，断言增量解析与 tool_calls 并存时序 |
| LlmChunk | 类型含 reasoning 字段（类型测试） |
| llmCaller | 累积透传；断言 reasoning 不拼入 fullContent（CoT 防护） |
| AgentChunk | reasoning chunk 透传（loop 测试） |
| ProcessEvent | 新增 `type: 'thought'` 成员 + 截断常量；宿主缓冲 → 附 Round 落盘 → 重放重建（对齐 process-event-log-replay-design 的 diff 对齐完成定义） |
| prompt 注入 | 断言 systemPrompt 含 "Turn 起始策略" 段（注入正确性；LLM 是否遵守属软约束，不单测） |
| 回收（定案时） | strategyResolver / strategyKeys / types / validator 测试移除或改写；3 个示例包迁移后校验通过（无 warning） |
| 回归 | 全量 vitest 绿；IPC 协议测试通过（R4，100/130 阈值余量核算） |

## 八、边界与观察区

- **不回传 reasoning**（D1）——观察区：多步工具推理连续性是否在真实场景受损，受损再评估回传（改 assistant 消息构造，Provider 特异）。
- **reasoning 落盘超长**——首期原文+截断（对齐 tool_args 先例）；若真实思考远超截断或存储膨胀明显，再评估"摘要式落盘"（对齐 Anthropic summarized thinking）。
- **prompt 软约束**——Part 2 边界指令不保证 LLM 完全遵守；若真实场景频繁出现"该查不查/该规划不规划"或叙述污染正文，再评估加强（正文侧检测策略叙述——复杂，暂不做）。

## 九、关联

- [legacy-contract-audit-rules.md](../../.trae/rules/legacy-contract-audit-rules.md)（不带伤自检 §四）
- [memory-role-pack-boundary.md](./memory-role-pack-boundary.md)（边界论证 R7）
- [memory-tool-recall-design.md](./memory-tool-recall-design.md)（记忆软引导现状 + 硬收窄砍除历史，Part 2 记忆引导不重复的实证依据）
- [process-event-log-replay-design.md](./process-event-log-replay-design.md)（reasoning/narrate 落盘与平铺展示依据）
- [策略键消费矩阵.md](../策略键消费矩阵.md)（understandingConfirm 条目，定案时同步）
- [role-pack-spec.md](./role-pack-spec.md) / [role-pack-开放键指南.md](../role-pack-开放键指南.md)（开放键文档，定案时同步）
- 土壤来源：Plan-and-Execute（CSDN 实战 / arXiv 2605.14290）、Pre-Act（arXiv 2505.09970）、Think Tool 模式（bswen）、Anthropic Thinking + Fable 5 prompt 指南（目标+约束 vs 步骤脚本）、Claude Code Plan Mode（inside-claude-code 剖析 / OpenReplay）、Open WebUI reasoning、代码编排 vs LLM 规划（dev.to，2026-09-13 搜索）

## 十、实施拆解（2026-09-13）

> 分阶段落地，每阶段独立提交 + 突变验证。阶段 A/B 为 3.1.0 增强；阶段 C（Part 3 回收）属定案期收尾，**本拆解不实施**（探索期不动角色包，见 Part 3）。

### 阶段 A：Part 1 reasoning 采集 → 落盘 → 重放 → 渲染（低风险纯加法）——**已实施（2026-09-13）**

> 验证结果：内核 tsc 零错 + 宿主 tsc 零错；内核全量 2932 绿、宿主全量 442 绿、协议守卫 2 绿；新增用例 6 个（SSE 解析 2 / llmCaller 透传 1 / chatView 渲染 2 / chatPanel 落盘截断 1）。真机验证（deepseek 思考折叠块 + 重启重放 + round-summary 无思考）待真实 LLM 环境执行。

| # | 文件 | 改动 | 验证口径 |
| --- | --- | --- | --- |
| A1 | [llm/types.ts](../../src/llm/types.ts) `LlmChunk` | 加 `thought?: string`（注释：增量片段，对应协议 `delta.reasoning_content`；命名 thought 与路由 `TaskType='reasoning'`、既有相位 `type:'thinking'` 语义分离） | 类型测试 |
| A2 | [openaiCompatible.ts](../../src/llm/openaiCompatible.ts)（SSE 解析 ~L388-390） | 类型扩展 `delta.reasoning_content?`；解析分支：`if (choice.delta?.reasoning_content) chunk.thought = ...`（增量，与 content 并列；不碰 usage 独立分支） | mock SSE 含 reasoning_content 流 → 增量解析 + 与 tool_calls 并存时序 |
| A3 | [llmCaller.ts](../../src/agent/managers/llmCaller.ts)（流式循环 ~L265-281） | `if (chunk.thought) yield { type: 'thought', content: chunk.thought }` 实时透传；**fullContent 只拼 chunk.content**（CoT 防护）；LlmCallResult 不加 reasoning（流式已消费，中断不补发——瞬态展示） | 累积透传 + fullContent 不含 reasoning |
| A4 | [agent/types.ts](../../src/agent/types.ts) `AgentChunk`（narrate ~L49 附近） | 新增 `{ type: 'thought'; content: string }` + RoundTagged（注释：模型思考流，折叠展示、不进正文、落盘走 ProcessEvent） | 类型测试 |
| A5 | [roundStore.ts](../../src/memory/roundStore.ts) `ProcessEvent` union（~L169-211） | 新增 `\| { type: 'thought'; seq; ts; payload: { content } }`；截断常量 `MAX_THOUGHT_PAYLOAD_LENGTH`（SSOT 单点定义于宿主 chatPanel，落盘前截断防膨胀） | 类型测试 + 截断单测 |
| A6 | 宿主 [chatPanel.ts](../../hosts/memora-vscode/src/webview/panels/chatPanel.ts) `consumeFlow`（narrate 分支 ~L2477 附近） | 新增 `chunk.type === 'reasoning'` 分支 → `emitEvent('reasoning', { content })`（落盘前截断）；mergeProcessEvents/checkpointRound 自动支持新 union 成员 | 落盘 + 幂等合并（无重复） |
| A7 | 宿主 [chatView.ts](../../hosts/memora-vscode/src/webview/scripts/chatView.ts) | ① 运行时 process-flow：reasoning **折叠行** `.process-flow__reasoning`（`<details>`，与 narrate 平铺同 seq 插入，textContent 防注入）② `renderRoundBlock`（~L1079）：新增「§ 思考」小节渲染 reasoning 事件（finalize/重放共用） | 运行时折叠展示 + 重放重建一致 |
| A8 | 协议 | `process_event` / `replay_events` **复用**（ProcessEvent union 扩展自动传导），**不新增消息类型** → IPC 通道治理阈值（100/130）不变 | 协议测试通过 |

**阶段 A 出口**：tsc 零错误 + 全量 vitest 绿（声明层数/skip 口径）+ 真机验证——deepseek 对话思考折叠块显示；重启会话思考重放可见；round-summary 不含思考（CoT 防护实证）。

### 阶段 B：Part 2 Turn 起始策略指令（一行注入，低风险）——**已实施（2026-09-13）**

> 验证结果：内核 typecheck 零错 + assembler 29 绿（新增 2 用例）+ agent 目录 1386 绿（R8 风险解除——prompt 注入不破坏既有 mock 测试断言）；commit `7876d663` 已推送。注入位置定案：`buildSystemPromptPrefix` 时间戳后（注意力位），SSOT 常量 `TURN_START_STRATEGY_PROMPT` 单点消费。

| # | 文件 | 改动 | 验证口径 |
| --- | --- | --- | --- |
| B1 | [assembler.ts](../../src/agent/assembler.ts) `buildSystemPromptPrefix`（~L80-103） | 固定段追加（**内核固定、单点注入**，不开放键、不依赖角色包）：`## Turn 起始策略\n需要外部信息时，先调用工具调查再回答，不要凭记忆猜测；\n任务需要多步推进时，使用任务表工具规划执行；\n简单问题直接回答。` | 断言 systemPromptPrefix 含 "Turn 起始策略" |
| B2 | [assembler.test.ts](../../src/agent/__tests__/assembler.test.ts) | 新增断言（注入正确性；LLM 是否遵守属软约束，不单测） | 全量 vitest 绿 |

**阶段 B 出口**：真机验证——简单问题直接答（无多余叙述）；复杂问题工具调用前有"我先…"叙述（narrate 平铺可见）；涉及历史时 LLM 主动 search_memories（不新增引导，靠既有工具描述）。

### 阶段 C：Part 3 回收 understandingConfirm —— **已实施（2026-09-13）**

硬删键 + 3 个示例包迁移（确认场景统一走 ask_user 通道）+ 文档/schema/测试全量清理；内核 typecheck + 全量测试绿后提交推送。

### 风险与回滚

- 阶段 A/B 独立提交；异常 git 回退对应提交。
- 阶段 A 纯新增，非 reasoning 模型 `chunk.thought` 恒 undefined → 自然降级（R9）；reasoning 不进正文/记忆（R11 双轨隔离）。
- 阶段 B 注入 `buildSystemPromptPrefix` 影响所有会话，若真机行为异常（角色包不适配）→ 回退 B1 单提交。
