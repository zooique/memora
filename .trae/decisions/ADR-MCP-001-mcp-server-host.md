---
alwaysApply: false
description: MCP 服务器作为 memora 内核宿主（第三个部署面、面向其他 agent 消费记忆）—— SSOT 委托边界 + 只读切片 + stdio 传输 + 放弃写入能力（含交原材料变通方案一并否决）
---

# ADR-MCP-001 · MCP 服务器作为 memora 内核宿主

> **状态**：✅ 已接受（**范围限于只读切片，且写入能力已明确放弃**：本 ADR 确立「MCP 服务器是第三个宿主」及其 SSOT 委托边界与传输形态；**写能力已决议放弃**，见决策 8——含「交原材料 + 统一提炼」变通方案一并否决，本宿主**不再是内核写 API 缺口的消费方**）
> **日期**：2026-10-16
> **依赖**：[ADR-VC-001](./ADR-VC-001-vscode-plugin-host.md)（VS Code 插件宿主，本 ADR 的工程组织沿用其决策 6）、[ADR-002](./ADR-002-storage-layer.md)（IMemoryStorage 抽象）、[ADR-021](./ADR-021-memory-conflict-supersede-write-path.md)（写路径取代模型）、[ADR-039](./ADR-039-public-export-surface-admission.md)（公共导出面准入）
> **定位**：MCP 服务器作为 memora 内核宿主（第三个部署面，**面向其他 agent** 而非人类）
> **设计文档**：[docs/方案-服务端MCP宿主-memora-mcp-20261015.md](../../docs/方案-服务端MCP宿主-memora-mcp-20261015.md) ｜ **台账条目**：`tasks/待完成任务.md` §MCP-SERVER-1

## 背景

memora 的记忆此前**只有一个消费面**：人通过 VS Code 插件用（[ADR-VC-001](./ADR-VC-001-vscode-plugin-host.md)）。2026 年 MCP 成为 AI 工具集成的事实标准，出现第二个消费面——**其他 AI agent 通过 MCP 协议读取本机 `.memora/` 记忆库**。

同许诺的产品价值：把 memora 从「人用的写作助手」扩展到「本机所有 agent 共享的记忆基础设施」——一份 `.memora/` 多个本地 agent 共用。此前该方向**只存在于战略报告论点中、游离于 SSOT 之外**（台账 `MCP-SERVER-1` 登记动因已记此反模式）。

引发 GETSHAPE 的取舍：这是**新能力**还是**现有能力的重新暴露**？答案是后者——记忆本身已存在且由内核治理，本决策要定的只是「用哪种部署面把它交出去」。

## 决策

### 决策 1：架构定位——第三宿主（部署面），面向 agent 而非人类

- 与 sprite（历史参考宿主）、VS Code 插件同级，都是**宿主**；
- 差异在**消费者**：插件 = 人类经 UI；MCP 服务器 = 其他 AI agent 经 MCP 协议；
- **不跑 LLM 回合**：MCP 服务器不含 Agent 闭环，它只是「存储 + 协议适配层」。记忆由插件那边产生，此处负责交出去。

### 决策 2（本 ADR 核心）：SSOT 委托边界——宿主不得重仲实现检索语义

| 委托给内核（宿主直接 import 已导出物） | 宿主自持 |
|---|---|
| 检索 / 分词 / accessedAt 排序 / 软删除过滤 → `InMemoryStorage` | 「读 `memories.json` → 解析 → 灌入」薄层（约 40 行） |
| 读档白名单校验 / 旧档字段清洗 → `parseMemory` | MCP Server 装配、工具定义、CLI 参数 |
| **取代状态判据** → `hasActiveSuperseder` | 传输与发布形态 |

**为什么不复用 VS Code 宿主的 `workspaceStorage.ts`**（实证，勿再提议）：

- 它确实零 vscode 依赖，但 `hosts/memora-vscode/src/extension/host/workspaceStorage.ts:25` **import 了宿主内部 `./atomicWriteSync.js`**；
- ⇒ 跨宿主 import：MCP 作为 npm 包发布后，vscode 宿主源码不在包内，直接崩；
- ⇒ 复制一份：与内核形成第二套 Map+分词+排序，**两边漂移后同一份 `.memora/` 在插件和 MCP 里搜出不同结果**。这是「并列而非嫁接」，明违 [ADR-018](./ADR-018-css-scoping-convention.md) 以降的一贯判据。

**正解**：用内核 `InMemoryStorage` 作运行时容器——检索语义回到单一实现，宿主只剩 IO 装载。**零内核改动**。

**正确性硬约束**：召回**必须**经 `hasActiveSuperseder` 过滤。`supersededBy` 指向的替代物可能被任何移除路径清掉（悬空），此时旧摘要应回退为当前版本（语义见 ADR-021 与 `supersedeResolve.ts`）。漏掉这道过滤 = 把「已被更新版本覆盖的旧结论」当当前事实喂给外部 agent——**这是本切片唯一会静默出错的地方**，故以 `npm run smoke` 留了可执行断言（被取代不可召回 / 悬空回退可见）。

### 决策 3：只读边界——首切片只读，且由**结构**而非约定保证

- 首切片只暴露读能力（`list_memory_sources` / `search_memories` / `get_memory_by_id` / `get_memories_by_source`）；
- `ReadOnlyFileStore` **不暴露** `upsert / delete / restore / purge / touch`——外部拿不到这些 API。约定会腐化，结构性缺失不会；
- 不做 `touch`：本 Store 是纯内存容器、**不落盘**，刷新 `accessedAt` 随进程退出消失，只会制造「已记录使用轨迹」的假象；
- **写路径依赖内核尚无「脱离回合的受治理写 API」**（须走 dedup/conflict/supersede，**禁止裸 `storage.upsert`**，会绕开 3-track-1-port 治理）。**2026-10-16 已拍板放弃写入能力**（见决策 8）⇒ 该内核缺口对本宿主**不再有消费方**。

### 决策 4：传输——stdio，而非 HTTP

memora 是 **local-first**：记忆落在用户本机 `.memora/`。stdio 让服务器作为 agent 的**子进程**跑在本机，直接读本地文件——记忆不出网、不需要端口与鉴权隧道。

**代价（诚实边界，非缺口）**：没有公网 URL ⇒ **只有本机 agent**（Claude Code / Cursor / Cline / Roo / VS Code Copilot）能接入，**云端 / 远程 API 类 agent 触不到**。`stdio` 服务器在 MCP 生态中的登记形态是「用户拉取包后本地运行」，而非托管服务。

### 决策 5：工程组织——沿用 ADR-VC-001 决策 6，但发布面不同

沿用部分（与 VS Code 宿主一致）：

- **物理布局**：同仓库 `hosts/memora-mcp/`（利于开发期内核+宿主锁步改）；
- **依赖方式**：开发期 `file:../..` 指向内核（**不用 `npm link`**，同 ADR-VC-001 决策 6 理由：符号链接致重复依赖实例）；
- **git 可拆**：目录边界清晰，需独立分发时在该目录单独初始化 git 即可。

差异（务必注意，勿照抄 vscode 宿主）：

| | VS Code 宿主 | MCP 宿主 |
|---|---|---|
| 内核依赖位 | **devDependency**（esbuild 把内核 dist 内联打包进插件 bundle，运行时无需独立依赖） | **dependency**（`node dist/index.js` 直接 `import`，必须真实存在） |
| 发布目标 | VS Code Marketplace | **npm**（`@zooique/memora-mcp`）+ MCP 官方 Registry 登记 |
| 运行形态 | VS Code 扩展进程 | 任意 MCP client 拉起的子进程（`npx -y …`） |

**发布期**：依赖须从 `file:../..` 切换为 `^<version>`——`file:` 协议**不可发布到 npm**（README「发布前必改」与台账已挂此阻塞项）。

### 决策 6：协议形状由 SDK 拥有，不自拟

工具定义与返回体**直接 `import type { CallToolResult, Tool }`**，不自拟等价 interface。

实证教训：初期手写的 `interface ToolResult { content; isError? }` 在接入真 SDK（1.32.x，其 `ServerResult` 联合含 task 增强结果变体）时立即 TS2345。手写「等价」结构 = 第二份真理源，**协议升级即静默漂移**——与决策 2 是同一个错误的两种表现。

### 决策 7：分发——npm 包 + 官方 Registry 登记，无服务托管

- 发布载体 = npm（同内核双远端 push 纪律）；
- 可发现性 = 官方 MCP Registry（`registry.modelcontextprotocol.io`，**仅存元数据**，包体在 npm）经 `mcp-publisher` 登记 `server.json`，下游市场自动同步；
- **不提供托管服务**——那会要求记忆出本机，违背决策 4。

### 决策 8：放弃写入能力——「交原材料 + 统一提炼」变通方案一并否决

**定性表述（对外一律照此讲）**：`.memora/` 的**权威记忆由插件宿主维护**，MCP 服务器只提供**读快照**。MCP **不写记忆，也不投递待提炼的原材料**。

**判据**：记忆的类型契约只能由一条链产出。

- 插件侧写入必经 `RoundSummaryGenerator.generate()`（`src/agent/managers/roundSummaryGenerator.ts:158`）：LLM 判「值不值得记」→ 浓缩 → 分类 `summaryType` → 打 `materialFingerprint` → 跑 `supersedeSimilar` 取代检测；
- MCP 侧无 LLM 提炼环节 ⇒ 即便走同一个 `upsert`，产出的是**另一类条目**；
- ⇒ 不对称的不是「能不能落盘」，而是「**谁有资格造一条记忆**」。后者只能有一个答案。

**「交原材料」变通方案为何也否决**（曾作为折中提出，本 ADR 明确否决）：

| 项 | 实证 / 说明 |
|---|---|
| **触发机制缺失（最要命）** | 插件侧每轮收尾**自动** fire-and-forget（`src/agent/seed/orchestrator.ts:281`），用户零操作；MCP 侧无对话循环，只能靠外部 agent **主动调工具**，而其提示词不受我们控制 ⇒ **大概率零调用** |
| **归属真值缺失** | 外部 agent 不持有 memora 的 `roundId` / `sessionName`；编造 = 伪造溯源，建第二套标识 = 又一次类型扩展（`source` 当前 5 值） |
| **视角缺失** | 插件侧按角色包 `summaryFocus` 决定「这轮该记什么」（`orchestrator.ts:278 resolveSummaryFocus`）；MCP 侧无角色包上下文 ⇒ **同一份原料炼出另一种东西** |
| 不解决时效 | 即使全部接通，生效仍取决于外部 agent 何时调；它不调，等于没写。该方案解决的是**类型对称**，不是**时效** |
| 三层新增代价 | ① `.memora/inbox/` 是第三种落盘契约，多进程 append，而内核无 CAS（整对象覆盖）；② 「启动时扫 inbox 批量提炼」是**新增入口**，不是调用现有函数；③ 上述标识/视角扩展本身就是内核改动 |

**为什么「给 MCP 接上 LLM 提炼」也不行**（2026-10-16 追查；含对先前错误论据的订正）：

订正——曾以「提炼需宿主注入 `LlmProvider` ⇒ 只能插件执行」作论据，**已证伪**：`LlmProvider` 本就导出（`src/index.ts:88`，唯一抽象方法 `chat()`），且 MCP SDK `Server.createMessage()`（协议方法 `sampling/createMessage`）可**反向借 agent 应用自己的模型** ⇒ MCP 侧无需自配 `baseUrl/model/apiKey`，写个约 40 行 `SamplingProvider extends LlmProvider` 即可嫁接。

⇒ 接入 LLM 只买到**「提炼的能力」**，买不到**「提炼的机制」**。机制三块（触发 / 归属 / 视角）全缺，且都不是"接个 LLM"能解决的。

**接了比不接更危险**：二等记忆会**形似**（同 `source: 'round-summary'` / `summaryType` / `materialFingerprint`）而**神不似**（无 focus、假归属、外部触发）⇒ 下游治理分辨不出——`supersedeSimilar` 会把它当同主题权威、`roundSummaryLoader` 的防跨会话渗入按 `sessionId` 过滤（对假归属不生效）、分轨召回按一等记忆对待它。**形似神不似混进治理链，比明标「只读」危险得多。**

**对内核写 API 缺口的处置**：决策 3 原写「缺口未落成前不做写」；决策 8 进一步——**写入能力已放弃，该缺口对本宿主不再有消费方**，不排期、不投。若要重开写入属**重新立项**，须另立 ADR 重议本决策，且须先证机制再接能力。

**因此**：写能力（含原材料）**已放弃，不落地、不排期**。不设重议触发；除非未来重新立项，并先拿到「外部 agent 真的愿意主动触发提炼」的实证。

## 考虑的替代方案

| 方案 | 放弃原因 |
|---|---|
| 复用 / 复制 `workspaceStorage.ts` | 见决策 2：跨宿主 import 会崩（Monotonic），复制则形成并列第二套算法。两者都不可接受 |
| 独立 git 仓库 | 破坏「内核+宿主锁步演进」能力；写路径需新增内核导出时会被迫「先发内核再联调」，耦合税高于收益。同已有 `hosts/` 布局惯例不符 |
| 把 JSON 文件存储下沉到内核统一导出 | **未被否定，但被推迟**：当前并列仅限 IO 装载层（算法层已共用内核），过早下沉会动 5.0.0 待发版本。收口触发见台账 `MCP-SERVER-1`「已知薄并列债务」 |
| 远程 HTTP（Streamable HTTP）MCP 服务 | 要求记忆出本机或建同步桥，违背 local-first 且直接跌入与托管型 memory MCP 的红海竞争 |
| 一上来同时做写能力 | 写 API 形态会先锁死后难改；应先以只读切片验证「真有 agent 来消费」假设。（原结论写「证真再投 G1」；2026-10-16 已拍板**放弃**写入，故不再有「再投」一说） |
| 深导入内核内部模块（`@zooique/memora/dist/...`） | 内核 `exports` 只暴露 `.`（见 package.json），深导入违反 [ADR-039](./ADR-039-public-export-surface-admission.md) 的导出面准入 |
| MCP 交原材料、由内核统一提炼 | 见决策 8：触发机制缺失（外部 agent 提示词不受控 ⇒ 大概率零调用）+ 归属真值缺失 + 视角缺失；不解决时效，且引入 inbox 新契约 + 外部源标识扩展三层代价。**2026-10-16 已拍板放弃写入，此路关闭** |
| MCP 自带 `{baseUrl,model,apiKey}` 自行提炼 | 已被证伪为**非必要**：MCP SDK `Server.createMessage()`（`sampling/createMessage`）可反向借 agent 应用自己的模型，无需自配凭据。真正的问题不是配置面，而是触发/归属/视角三块机制缺失（见决策 8） |

## 后果

### 正面

- **零内核改动**达成第二个消费面——验证了内核/宿主切分（ADR-002 `IMemoryStorage` 抽象）的红利：同一份记忆、多个宿主；
- 检索语义单一实现，不存在「插件搜到的和 agent 搜到的不一样」；
- 体量极小（宿主不含 UI，与插件体量结构差异见设计文档 §五），验证了何谓「薄壳 + 装配」。

### 负面

- **覆盖范围收窄**：只服务本机本地 agent，云端 agent 触不到 → 原「被所有 agent 消费」的战略表述须收窄为「被用户机器上所有本地 agent 消费」。此修正已落台账，避免后续误读覆盖面；
- **新增并列点**：IO 装载层（`memories.json` 读取）在两个宿主各有一份，属**已登记的薄债务**，须按台账触发条件收口；
- 生态假设未验证：是否有 agent 真来消费，尚未有真机证据（只读切片即为验证手段）。

### 后续行动

- [x] 落 `hosts/memora-mcp/` 只读切片脚手架 + 端到端冒烟（`npm run smoke`，含取代过滤断言）
- [x] 登记台账条目 `MCP-SERVER-1`
- [x] 立 ADR（本文件）
- [x] 决议**放弃**写入能力（决策 8）——原材料变通方案一并否决，内核写 API 缺口对本宿主不再有消费方（已同步台账 `MCP-SERVER-1`）
- [ ] **真机接入验证**：用一个本地 agent 实际连上并检索
- [ ] 回答开放争议（见下）——**写入方向已关闭，不再投内核写 API**

## 开放争议（未决，不在本 ADR 决策范围）

1. 2026 MCP 生态是否真就绪——本地 agent 会不会真的来连 local memory server；
2. Tier 3「local-first 治理型 memory server」空位是否已被同类产品占据；
3. ~~写能力语义：外部 agent 直写（无 LLM 总结）的记忆质量如何治理。~~ → **已决并关闭，见决策 8**：**放弃**写入能力，原材料变通方案一并否决。2026-10-16 用户拍板「明确放弃写入，只保留读」——本宿主不再是内核写 API 缺口的消费方，**不设重议触发**；若要重开写入属重新立项，须另立 ADR 且先证机制。

## 何时回顾

- 出现第二个消费本地 `.memora/` 的部署面时（届时决策 2 的 IO 装载并列应立即下沉内核）；
- 真机接入验证完成、且开放争议 1/2 有结论时——**注意：已无「作废只读边界」一说**（写入能力于 2026-10-16 明确放弃，见决策 8）；若要重开写入属**重新立项**，须另立 ADR，且须先证机制（外部 agent 真的愿意主动触发提炼）再接能力；
- 若用户反馈「云端 agent 也要读同一份记忆」——届时重议决策 4，可能需要额外的同步/桥形态（属新决策，不在本 ADR）。

## 引用

- 工程组织母本：[ADR-VC-001](./ADR-VC-001-vscode-plugin-host.md) 决策 6
- 存储抽象：[ADR-002](./ADR-002-storage-layer.md) ｜ 取代语义：[ADR-021](./ADR-021-memory-conflict-supersede-write-path.md)
- 导出面准入：[ADR-039](./ADR-039-public-export-surface-admission.md)
- 内核导出面：[src/index.ts](../../src/index.ts)（`InMemoryStorage` / `parseMemory` / `hasActiveSuperseder` / `IMemoryStorage`）
- 实现：[hosts/memora-mcp/src/readOnlyFileStore.ts](../../hosts/memora-mcp/src/readOnlyFileStore.ts)
- 提炼链（决策 8 论据，非内核公共面）：[src/agent/managers/roundSummaryGenerator.ts](../../src/agent/managers/roundSummaryGenerator.ts) ｜ 装配：[src/agent/assembler.ts](../../src/agent/assembler.ts) ｜ 触发：[src/agent/seed/orchestrator.ts](../../src/agent/seed/orchestrator.ts)
- 设计文档与台账：见本文件头部
