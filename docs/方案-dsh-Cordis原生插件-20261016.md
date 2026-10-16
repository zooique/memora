# 方案：dsh（DeepSeek Harness）Cordis 原生插件 —— memora 以插件形状能做到什么程度

> 日期：2026-10-16 ｜ 类型：评估 + 设计草案（探索期 S1：先落 `docs/` 验证，不预写 ADR、不占编号）
> 状态：**探索中 · 未排期** —— 台账条目 `tasks/待完成任务.md` §DSH-1（观察）；用户尚未拍板投入
> 关联：`ADR-MCP-001` 决策 8（MCP 形态的写入放弃 + 论据边界）｜ 台账 §MCP-SERVER-1（只读切片已落地）｜ 台账 §D1-MCP（客户端 MCP，另一方向）
> 实锤来源：2026-10-16 对 GitHub `deepseek-ai/deepseek-harness` 仓库本体的调研（全文见 `.workbuddy/memory/2026-10-16.md` §dsh 调研）；本文档引用其结论，未做二次验证的事项已逐条标注

## 一、结论先给

**1. 能做到什么程度：以 Cordis 原生插件形态，memora 可覆盖 L1-L6 六层能力面——比 MCP 形态多出四层（自动注入 / 会话互操作 / 事件 / UI 投影），其中 L2 自动注入是质变。**

**2. 但当前不投。** 排序：先用主战场（Claude Code / Cursor + `hosts/memora-mcp`）真机验证「模型/agent 到底愿不愿意用记忆」——这个风险在两条路上同源，且 MCP 那条已验证到「只差真机接入」。dsh 是 developer preview 期（官方明示破坏性兼容变更），先把主战场跑出结论，再决定往 dsh 投 300 行还是 600 行。

**3. 一个必须记住的边界**：MCP 形态「放弃写入」的三大论据（触发 / 归属 / LLM）**在插件形态下全部失效**——dsh 基础设施把三者都补齐了。若未来启动 dsh 方向，**写入必须重新拍板**（重议程序见 §六）；但「重议」≠「自动恢复写」，当前「不写」仍是全方向默认态（§六给出判据框架）。

**4.（2026-10-16 晚补充）写入的真实门槛已探明**：dsh 侧三环（触发 / 提炼 / 落盘）都有解，但**与 vscode 宿主双开时会有静默覆盖丢失**（探针实证，见 §6.3）——危险源在 vscode 侧的覆盖写，**无纯 dsh 侧解法**。⇒ 结论收敛为：**写入缓行，先做只读档**；存储层并发改造是两个方向的共同前置，值得单独立项。

## 二、先消除四个「MCP / 插件」的混淆

此前不同批次把不同东西都叫过「MCP」，先拆清。本文档只处理第四行：

| # | 方向 | 是什么 | 状态 |
| --- | --- | --- | --- |
| 1 | **服务端 MCP**（`hosts/memora-mcp`） | memora 记忆**被别的 agent 读**（stdio 只读快照）| 已落地只读切片，待真机接入验证 |
| 2 | **客户端 MCP**（台账 `D1-MCP`） | memora **消费**外部 MCP 工具 | 观察（升档 = 宿主 0.1.0 + 内核 5.0.0 落完后拍板） |
| 3 | **dsh 的 MCP overlay**（捷径） | 在 dsh 里挂 `packages/mcp`，把 1 号或任何 MCP server 暴露为 `mcp__<server>__<tool>` 原生工具 | dsh 现成能力，~20 行 yml 即接——但只换到 L1 |
| 4 | **dsh Cordis 原生插件**（本文档） | 以 dsh 插件形状（非 MCP 桥接）把 memora 记忆接进 dsh | 本文档评估 + 设计；未拍板 |

**1 号与 4 号不互斥、可组合**：dsh 用户即使没有原生插件，也能用 3 号捷径消费 1 号（拿到 L1）。4 号是升级形态，换 L2-L6。

## 三、dsh 是什么（调研实锤，来源见文档头）

- GitHub `deepseek-ai/deepseek-harness` 真实存在（22,346 commits，最后提交 2026-10-15，MIT）；npm `@deepseek-ai/dsh` 0.2.0-rc.2（仓库内 0.2.1-alpha.4）——**developer preview，官方明示破坏性兼容变更**，文档自承 "official documentation is still under construction"。
- 底座是 Cordis（`cordiverse/cordis`，9.2k star；作者 shigma＝Koishi 生态）——「Agent = Model + Harness，一切皆插件」。
- 工程纪律与 memora 高度同构：TS + pnpm workspace、strict linker、publint、build record、lefthook、vitest。
- **dsh 没有 memory 包**（52 个 packages 全查）：只有 `session` / `session-query`（SQLite FTS5）/ `storage` / `context` / `compaction` / `attachment`。官方引用的 3 个 memory MCP 全是知识图谱/实体型，官方原文直言 reference memory「不提供 embeddings、自动摘要、冲突解决、遗忘策略」⇒ **「治理型记忆」这个位是空的**，即 memora 的差异化空间。

## 四、插件形状实锤（从一等公民包 `tool-todo` 逆推）

| 要素 | 实证 |
| --- | --- |
| 导出形状 | 函数/namespace 插件：导出 `name` / `inject` / `apply`，**禁 default export**（否则 Loader 的 `unwrapExports` 塌缩丢 `inject`——有 postmortem 0001 为证） |
| 配置 | 插件导出 `Config` 接口 → 自动生成 config-catalog；yml 挂载行 `- name: '...'` + `config: {...}` |
| 工具 | `ctx.tools.register(defineTool({...}))`，返回 disposer；模型只看见 name/description/parameters（白名单投影）；**强制 output JSON Schema**；可选 `timeoutMs` / `isConcurrencySafe` / `presentCall` / `presentResult`（card 渲染意图：generic/terminal/diff/**search**/read/web） |
| 权限 | `tools/pre-execute` 瀑布线（allow/deny/cancel/ask）+ 单调 ToolGuard + `tools/post-execute`（accept/replace/block） |
| 服务注册 | `ctx.<key>`（`ctx.sessionQuery` / `ctx.sessionReferenceResolver` / `ctx.fileReferences`）可被其他插件消费；`ctx.sessionProjections` 注册 UI 投影（todo 的任务面板即此路） |
| **context 组** | `packages/context` 定位原文：「add model-visible context to each request **without defining any tool**」；`agent-instructions` 实证机制 = 监听 **`agent/pre-step`** 事件，在首个 eligible step 把 baseline fold 进 entering batch；载体是 **sourced `user/message` 事件** ⇒ 持久化 / 回放 / 被 compaction 一起压缩；有 `maxBytes` 预算 + SHA-1 digest 去重 + **touch 驱动刷新**（无 watcher）；KV-cache 友好（append-only） |

## 五、能力阶梯：插件比 MCP 多出四层

| 层 | 能力 | MCP 形态 | Cordis 插件形态 |
| --- | --- | --- | --- |
| L1 | 工具 | 平级 | 平级，且多 output schema 强校验 + search card 原生渲染 + timeoutMs |
| **L2** | **自动注入** | ❌ 等模型自觉调工具 | ✅ `agent/pre-step` 事件**自动注入**，不等调用 |
| L3 | 会话互操作 | ❌ 碰不到 dsh 内部 | ✅ 可调 `ctx.sessionQuery`（SQLite FTS5 读会话史）；可注册自有服务被别人消费 |
| L4 | 事件 | ❌ 无事件通道 | ✅ 订阅 `turn/end` / `tools/result` → 命中率统计、检索日志 |
| L5 | UI 投影 | ❌ 无 UI | ✅ `ctx.sessionProjections` + presentResult 的 search card |
| L6 | 存储 | 读 `.memora` 快照 | 同左（内核零依赖直读）或对接 dsh storage |

**L2 是回答「能做到什么程度」的核心**：插件形态下记忆可以**自动注入**，不用等模型自觉调用。「MCP 形态最要命的障碍是触发机制缺失」——在插件形态下直接被消解。

## 六、🔴 写入论据边界（本节是台账 DSH-1 与 ADR-MCP-001 补记的正文）

### 6.1 三大论据为何只在 MCP 形态成立

「明确放弃写入」拍板（2026-10-16）的三大论据，在插件形态下的命运：

| 障碍 | MCP 形态 | Cordis 插件形态 |
| --- | --- | --- |
| 触发 | 等模型调工具 ⇒ 大概率零调用 | ✅ `agent/pre-step` / `turn/end` 事件**自动触发** |
| 归属 | 外部 agent 无 `roundId` / `sessionName`，编造即伪造 | ✅ dsh session 体系给真值（`ctx.sessionQuery` / session log） |
| LLM | 无提炼（订正后：能力有、机制无） | ✅ `packages/llm` 提供 llm 服务；内核 `LlmProvider` 已导出可直接嫁接 |

⇒ **若启动 dsh 方向，写入须重新拍板**——旧论据一条都用不了，将来若重开，理由得整套换新。

### 6.2 重议程序（本节新增，补台账缺口）

「重议」不是「重新论证一遍旧理由」，须满足以下前置 + 新判据：

**前置条件（全部满足才开议）**：

1. dsh 方向已实际启动（用户拍板投入，≥ L1 切片落地）；
2. 主战场真机验证已确认「agent 愿意用记忆」——写入前先证明读取需求真实存在；
3. dsh 脱离破坏性预览期，或用户明确接受 preview 期返工成本。

**新判据（与 MCP 形态论据完全不同的一套）**：

1. **归属真值可获取性**——dsh session 体系能否为「一条记忆」提供与 memora 现有 `source` 5 值兼容的溯源标识（`roundId` 等价物），不新增类型扩展；
2. **视角可得性**——dsh 侧能否拿到等价于角色包 `summaryFocus` 的「这轮该记什么」的视角；拿不到则走「只写原始素材、由插件宿主统一提炼」还是「不写」二选一，不允许第三态混入治理链；
3. **一等/二等记忆不混链**——任何 dsh 侧写入物若与 `RoundSummaryGenerator` 产出**形似神不似**（同 `source`/`summaryType`/`materialFingerprint` 而不同机制），必须被治理链可分辨，否则重蹈「骗过 supersedeSimilar / roundSummaryLoader 防渗入」的覆辙（ADR-MCP-001 已实证该风险）。

**评判记录落点**：若开议，结论落台账 DSH-1 条目 + 新 ADR（届时另立，不占用现有编号）。

### 6.3 双宿主共享写入评估（2026-10-16 探针实证）

**问题（用户原话场景）**：dsh 装了 memora 插件，问答结束后写记忆到项目 `.memora/`，运行时也能搜记忆，且这份记忆还能被 memora-vscode 插件读取——是否可行？

**把「写入」拆成四环，逐环判定**：

| 环 | 判定 | 依据 |
| --- | --- | --- |
| 触发（问答收尾） | ✅ 可行 | dsh `turn/end` 事件 |
| 提炼（判值 + 浓缩 + 分类 + 打指纹 + 取代检测） | ✅ 可做，**须内核扩 1 处导出** | `RoundSummaryGenerator`（319 行）依赖极简——构造只需 `LlmProvider` + `IMemoryStorage`（均已导出），取代/去重方法均为类内私有 ⇒ **导出这一个类即完整**。走 ADR-039 导出面准入评估。**禁 dsh 侧重写第二套提炼**（类型契约分裂，ADR-MCP-001 决策 8 已实证风险） |
| 落盘（写 `memories.json`） | ✅ 可做（自持薄层 = 已登记薄并列债务从读扩到写） | JSON 存储「下沉内核」未被否定但被推迟（ADR-MCP-001 替代方案表）；dsh 侧自写「读-改-写」薄层 |
| **与 vscode 双开共存** | ❌ **不可行（实锤）** | 见下 |

**探针实证**（临时测试：两个 `WorkspaceStorage` 实例 = 两个进程的内存视图，全链真实类、真实落盘、跑完已删除）：

```
PROBE-DISK-IDS: ["base-1","from-vscode"]   ← dsh 写的 from-dsh 从磁盘消失
PROBE-DSH-SURVIVES: false                  ← 静默覆盖实锤
PROBE-A-SEES-DSH: false                    ← vscode 运行中看不到（load 仅在启动一次）
```

**根因（代码可证）**：`WorkspaceStorage.save()` = 内存 Map **全量序列化覆盖写**；`load()` 仅宿主启动调用一次（`assemble.ts:302`）；零重读、零锁、零版本号。**这份存储是「单写者」设计的**——全部代码在「vscode 宿主是唯一写者」的假设下成立。第二个写者（dsh）出现后：

- dsh 写一条 → vscode 后续**任意一次写操作**（新对话产生记忆 / 删除 / touch）→ 把 dsh 写的条目**整体抹掉**（vscode 的内存快照里没有它）；
- 反向不可见：vscode 运行中永远看不到 dsh 写的（不重读）；dsh 侧即使「每次写前重读」也只能自保、救不了上面的覆盖。

**修复选项**（关键结论：危险源在 vscode 侧的覆盖写，**没有任何纯 dsh 侧方案能防**）：

| 方案 | 本质 | 代价 |
| --- | --- | --- |
| A. vscode 侧改「写前重读 + 合并」 | 单写者 → 乐观多写者 | 改 vscode 宿主；**合并冲突缺判据**（`Memory` 无「修改时间」字段，软删除/指针冲突无仲裁字段）；内存视图刷新（fs.watch）否则 UI 仍不可见 |
| B. 单写者 + 旁路收集（dsh 写侧路文件、vscode 消费） | ≈ ADR-MCP-001 决策 8 已否决的「交原材料」变体 | vscode 新增消费入口 + 第三落盘契约；时效延迟 |
| C. 一写者一文件（dsh 写 `memories.dsh.json`，读时合并两份） | 从结构上消除写冲突 | vscode 读路径改造 + 跨文件 supersede/删除语义定义；**架构最干净**（读时合并幂等，无 lost update） |
| D. 不做写（只读） | 维持单写者 | 零（放弃「dsh 写」） |

**「错峰纪律」的诚实评估**：dsh 写时 vscode 关、vscode 开着时 dsh 只读——严格错峰下**不丢**（任一时刻只有一个写者）。但**无法机器兜底**：探测「vscode 在场」的信号不存在——`.memora/.lock` 由内核 `LockManager` 管理，但**vscode 宿主对它零消费**（宿主侧命中的 `chatLockManager` 是角色包切换锁，另一个东西）。⇒ 纪律靠人守，静默丢失风险自担 ⇒ **不作为推荐形态**。

**为什么不把 JSON 改成「追加写」（2026-10-16 追问的排除论证，防重复探讨）**：

1. **JSON 数组格式做不到真追加**——记忆对象**可变**（`deletedAt` 删除/恢复、`accessedAt` 使用轨迹、`supersededBy` 取代指针、upsert 同 id 覆盖，全是改旧条目）；数组格式下「改中间一条 = 重写整个文件」。连「末尾追加」都不是追加——要在 `]` 前插入 `,{...}` = 定位文件尾 + 改写末尾字节，非原子、双进程互踩。⇒ 要追加必须换格式。
2. **换成事件日志格式（JSONL append-only）= 换物理层根契约**：vscode 宿主 / memora-mcp 的「顶层 JSON 数组」读取链全适配 + 引入重放 / 检查点 / compaction（压缩动作本身又是全量重写，且与 append 并发是经典难题）/ 冲突仲裁（并发事件重放顺序仍需规则，只是把「写时覆盖」搬成「重放裁决」）。且它**只解决「写端并发新增」，不解决「读端可见性」**（vscode 仍不重读）。代价与收益倒挂 ⇒**半解**。
3. **正解是换引擎，而非手搓追加**：SQLite 的 WAL（Write-Ahead Log）就是「追加写」的工业化形态，天然带多进程锁 + 事务。此事架构**早有预留**：ADR-002 明写「SQLite 由宿主各自实现持久化」「Node.js 内置 sqlite 稳定时（可提供 NodeSqliteStorage 实现）」；`WorkspaceStorage` 自注释「最小可用实现……可换 SQLite 等更强实现」（VSCode 宿主选 JSON 是「图轻量」的部署选择，非架构定论；早年弃同款方案的理由是「不想背 native 编译依赖」，Node.js 自 22.5 起内置 `node:sqlite` 后该理由已消失）。⇒ 与方案 A/C 并列为存储层升级候选，**首选换引擎**（A/C 是「保留 JSON 格式」前提下的补丁）。

**顺带澄清的既知设计边界**：`supersedeSimilar` **刻意仅同 session**（类内注释明示，「与语义近似取代……刻意仅同 session」）——dsh 与 vscode 的 session 命名空间不同 ⇒ 跨宿主取代本就不会发生（同一主题两条记忆会淤积、互不取代）。此缺口与台账「跨 session 取代语义缺口」遗留项同族，**写入真要落地时须一并设计**。

**分档结论**：

- **档 1（推荐，即可做）**：只读 + 搜 + L2 注入。零内核改动、零存储风险——模式已被 `memora-mcp` 验证。
- **档 2（不建议）**：dsh 写 + 错峰纪律。探测兜底不存在，静默丢失自担。
- **档 3（真共享写）**：存储层并发改造（方案 A 或 C 择一）——内核级工程，值得**单独立项**；且一旦做了，memora-mcp 的「交原材料」否决理由（多进程 append + 内核无 CAS）**同样解锁** ⇒ 它是 dsh 写入与 MCP 原材料两个方向的**共同前置**。

## 七、设计方案骨架（若做，非当前任务）

若方向启动，最小切片的形态（一切以 §八 未验证项验完再定稿）：

| 件 | 内容 | 量级（粗估） |
| --- | --- | --- |
| 包骨架 | `name` / `inject` / `apply` + `Config` 接口（yml 可挂载）| ~50 行 |
| 工具面 | 4 个只读工具 = memora-mcp 现有 4 个（`search_memories` 等）映射到 `ctx.tools.register(defineTool)`；检索委托内核 `InMemoryStorage`，取代过滤经 `hasActiveSuperseder`（SSOT 同 `MCP-SERVER-1`）| ~150 行 |
| L2 注入 | `agent/pre-step` 监听：按预算取记忆 → fold 进 entering batch（载体 user 消息）| ~100 行 |
| 预算 | `maxBytes` 守卫：用内核已导出 `estimateTokensMessages` 包单条消息估算（见 §九·3 订正）| ~30 行 |
| 测试 | vitest 同构；沿用 memora-mcp 的 `smoke.mjs` 真往返模式 | ~200 行 |
| **合计** | | **~300-600 行 + 测试** |

**内核零改动**（四个出口 `InMemoryStorage` / `parseMemory` / `hasActiveSuperseder` / `LlmProvider` 均已导出）；工程纪律与 dsh 同构（pnpm / vitest / lefthook）。

## 八、硬边界与未验证项（诚实登记，动工前先验）

1. **Host/Client 双聚合**：dsh 分两个聚合程序，服务接口按 key declaration-merge，跨侧要 `@Remote` / `@RemoteScope` + Typert 生成投影，复杂度陡增。memora 幸运地只需 Client 侧（读 `.memora` + 注册工具 + pre-step 注入）——落在简单侧。
2. **⚠ `ctx.fs` 归属未验证（第一优先）**：`ctx.fs` 是 Host 侧服务，插件内读文件**走 node fs 还是走 `ctx.fs` 策略门**未验证——若是策略门，可能需跨侧声明，复杂度评估要改。
3. **⚠ `agent/pre-step` 能否读到「当前用户输入」未验证（第二优先，见 §九·1）**：这决定 L2 是「按查询注入相关记忆」还是「只会话开头注入一次静态基线」——二者价值差一个数量级。
4. **preview 期**：0.2.x，官方明示破坏性兼容变更——任何投入都可能返工，是排序建议（§十）的主要依据。
5. **compaction 影响**：注入走 user 消息进 history ⇒ 会被压缩，必须自带 `maxBytes` 预算（内核已有底子，见 §九·3）。

## 九、设计缺口（动工前须答，按优先级）

1. **注入粒度与时点（设计核心，未验证）**：`agent-instructions` 的实证形态是「首个 eligible step 注入 baseline（静态）」。「每请求注入**相关**记忆」依赖 pre-step 事件载荷能否读到当前请求上下文——**未验证**。若不能，L2 退化为「会话开头注入记忆库概览/最近 N 条」，价值大减。**这是动工前第一件要验的事**（探针实验即可）。
2. **刷新机制语义**：「touch 驱动刷新」存在，但刷新时点（每 turn？每 step？）未细究——决定注入是「一次基线」还是「滚动更新」，影响 KV-cache 友好性。
3. **预算实现（本次已订正，降级为「语义直白化」）**：曾判断「`estimateTokensText` 未导出 ⇒ 要么扩内核导出面要么并列副本」——**订正**：`estimateTokensText` 是**刻意**不挂公共面（`src/index.ts:28` 注释），但已导出的 `estimateTokensMessages` 接收 `EstimableMessage[] = { content: string }`，**把待估文本包成单条消息即可**；且对单条文本两函数**公式同源、结果同值**（逐条求和才产生取整差异，单条无此问题）。⇒ **零内核改动可达成预算**。可选优化：5.0.0 批次顺手导出 `estimateTokensText` 让 API 语义更直白（届时走 ADR-039 导出面准入）。
4. **与 memora-mcp 的复用边界**：4 个工具的实现逻辑（读档 → 过滤 → 检索）与 `hosts/memora-mcp` 同构，但**不能跨宿主 import**（ADR-MCP-001 决策 2 同款判据：`readOnlyFileStore.ts` 含宿主内部依赖）。选项：各自自持薄层（现状）或届时下沉内核统一导出（与「IO 装载层下沉」同一批，见 ADR-MCP-001 替代方案表）。

## 十、工作量与排序（触发表）

| 形态 | 量 | 换到 |
| --- | --- | --- |
| MCP overlay（捷径） | ~20 行 yml | L1 |
| **Cordis 原生插件** | **~300-600 行 + 测试** | **L1-L6 全部** |

**排序建议（本次评估结论）**：不现在做。启动触发表（满足任一即复评）：

1. 主战场真机验证拿到「确有 agent 来读」的正反馈（迁移价值得到初步证实）；
2. dsh 脱离 preview 或用户对 dsh 生态明确投入（接受返工风险）；
3. §八·2 / §八·3 两个未验证项被任一探针实验提前解开（届时评估可再压缩）。

## 十一、待拍板点（当前仅登记，不动作）

1. **是否启动 dsh 方向**（含最小探针）；启动前先答 §九·1（pre-step 能否读当前输入）——它决定值不值得投；
2. **若写入重议**（届时，非现在）：走 §六·2 重议程序，结论另立 ADR；
3. 插件包名 / 发布归属（`@zooique/*` 命名空间下，细节非阻塞）。

## 十二、本次对既有文档的补记（SSOT 联动）

- 台账 `DSH-1`（新增）：本方向登记 + 论据边界 + 缺口；
- `ADR-MCP-001` 决策 8：补「论据边界」注记（三大论据仅 MCP 形态成立）；
- `docs/方案-服务端MCP宿主-memora-mcp-20261015.md` §十一：补边界指针（一行，防未来会话拿失效论据推理）。
