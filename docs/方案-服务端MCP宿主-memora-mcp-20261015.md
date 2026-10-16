# 方案：服务端 MCP 宿主（memora-mcp）—— 让 memora 成为被其他 agent 消费的记忆源

> 日期：2026-10-15 ｜ 类型：设计草案（先文档化闭合闭环，再写代码）
> 状态：**草案 / 待拍板** —— 尚未登记 `tasks/待完成任务.md`，尚未立 ADR（按项目纪律，新部署面须立 ADR）
> 关联：2026-10-12 战略报告（"内核 MCP 化 = 服务端护城河"论点）、`docs/未来迭代方案-探索.md` §四方向1（客户端 MCP / `D1-MCP`）

## 一、结论先给

**落点：当前仓库，新建 `hosts/memora-mcp/`（新宿主），不新开仓库、不塞内核。**

**"1 仓库 3 项目？"—— 不是 3 个项目，是 1 个产品（memora）的 1 个内核 + 2 个宿主（部署面）。** 仓库本来就是 monorepo 形态：`hosts/` 目录已为多宿主设计（现有 `hosts/memora-vscode`），MCP 只是 `hosts/` 下的第二个落地形态。发布面上是 3 个独立可发制品（2 个 npm 包 `@zooique/memora` + `@zooique/memora-mcp`，1 个 VS Code 插件 `memora`），但代码共享同一个内核、同一份 `.memora/` 存储格式——这正是"单一真理源"的工程红利，不是 3 份重复造轮子。

**最省风险的切法：只做只读搜索服务器，验证"真有别的 agent 来消费"这个假设。**（**2026-10-16 更新**：原文此处写「再投写 API」——写入能力已拍板放弃，只读即终态，见 `ADR-MCP-001` 决策 8。）

## 二、背景：MCP 其实是两个方向（先消除语义漂移）

本次讨论前，"MCP"被混用了。必须拆清：

| 维度 | 服务端 MCP（本方案） | 客户端 MCP（台账 `D1-MCP`） |
| --- | --- | --- |
| 是什么 | 新宿主 `hosts/memora-mcp`，把内核记忆能力**暴露出去** | memora **消费**外部 MCP 工具，补生态缺口 |
| 是不是新项目 | 新宿主（落在 `hosts/`） | 不是新项目，是对现有内核 + VS Code 宿主的能力增强 |
| 内核要改吗 | 只读 = 零改动；~~写 = 补一个受治理写 API~~ → **写方向已放弃（2026-10-16）**，故本方案内核改动为零 | 设计目标 = 零内核改动（探索稿"壳足够薄时 loop 无需感知 MCP 存在"） |
| 在台账？ | **从未进台账**（仅 2026-10-12 报告论点，漂在 SSOT 外） | ✅ 正式观察条目 |

⇒ 两个 agent 当初"MCP 排子 agent 前"比的是服务端 MCP（护城河论点）；本会话早前把 MCP 当客户端 `D1-MCP` 比，是概念混淆。本方案只处理**服务端 MCP**。

## 三、落点决策实锤（为什么是当前仓库 + hosts/）

第一性原理：服务端 MCP 本质是"部署面/宿主"——注入 provider 和存储，把内核的记忆能力暴露给别的 agent 消费，和 `hosts/memora-vscode` 同构（内核 = 机制，宿主 = 产品/部署）。同仓（而非新开仓库）的理由：开发期内核 + 宿主锁步演进（如日后 IO 装载层下沉内核时可直接联调），避免"跨 npm 包先发内核才能联调"的耦合税。**⚠ 订正**：此处原写「更硬的理由：缺口 G1 要求新增内核公开写 API」——2026-10-16 写入能力已放弃，该论据作废，但同仓结论不变（换成上面这条）。

发布形态：`npx @zooique/memora-mcp --db <dir>`，同仓按目录独立发版，不需要独立 git 仓库。

## 四、缺口实锤（按风险排序，全部代码验证）

| 缺口 | 现状证据 | 性质 |
| --- | --- | --- |
| **写记忆 API（原编号 G1，已弃用）** | 内核无脱离回合的写记忆公开 API：`grep remember/writeMemory/addMemory` 在 `agent.ts`/`index.ts` 零命中；`MemoryGovernance` 只有 `deduplicate/detectConflicts/sourceHealth/suggest`（`memoryGovernance.ts:25-62`），**无 write**；写路径全在 loop 内 `roundSummaryGenerator` | **事实仍成立，但已无消费方**：2026-10-16 写入能力已放弃，本宿主不再排期。若要另立项目使用，须走治理（dedup/conflict/supersede），不能裸 `storage.insert`（会绕开 3-track-1-port）。⚠ 原编号 G1 与项目既有 `G1-G21`（共鸣小说家角色包缺口，已落地）**同名不同物**，勿再用 G1 指代 |
| **G2 存储实现** | 内核只 ship `InMemoryStorage`（`src/memory/inMemoryStorage.ts:19`）；VS Code 宿主 `workspaceStorage.ts`（259 行）实为 **JSON 文件存储**（`memories.json` + 内存 Map + 原子写），且**零 vscode 依赖**（只 import `node:fs`/`node:path` + `@zooique/memora`），`better-sqlite3` 全仓无声明 | 真·未建但**几乎可复用**：MCP 宿主只需薄封装指到任意 `.memora/` 目录（此前"绑 VS Code 需重写"判断已证伪） |
| **G3 传输层** | 全仓 src/hosts 无 MCP 代码（命中全是 node_modules 误伤） | 0% 建。需 MCP server（stdio）+ 工具定义 + SDK 依赖——SDK 破内核零依赖，故**必在宿主层，不在内核** |
| ~~**G4 headless 启动**~~ | `Agent` 构造要 storage+sessionStore 等；无"纯存储无 LLM"启动范本 | **已无消费方**（原为「无 LLM 宿主把 storage + 新写 API 挂到 `.memora/` 路径」而设；写入方向 2026-10-16 已放弃）。⚠ 这些 G 编号系本探索稿自建，勿与项目既有 `G1-G21`（共鸣小说家）混用 |
| **G5 设计/发布** | 新部署面按项目纪律要 ADR | 新 |

## 五、体量评估（量化，不靠嘴说）

实测硬数字（本会话 grep/wc 验证，非估）：

| | VS Code 插件（`hosts/memora-vscode`） | MCP 宿主（`hosts/memora-mcp`，只读切片） |
| --- | --- | --- |
| 文件数 | **127** 个 TS | ~5–8 个 |
| 总行数 | **60,171** 行 | **~300–500 行** |
| UI 占比 | **74%**（44,531 行 webview） | **0%** |

差距几乎全在 UI。MCP 宿主要写的就两块：① 存储复用 `workspaceStorage.ts`（259 行 JSON 实现，VS Code-free，仅薄封装指目录）；② 新增 MCP server 传输 + 工具映射 + headless 启动（`@modelcontextprotocol/sdk`，~200–400 行）。
⇒ **MCP 宿主 ≈ VS Code 宿主的 0.5–1%**，大头（UI、VS Code 集成、LLM 编排）全部不需要。

## 六、MCP 和插件到底什么区别

同内核、同 `IMemoryStorage`、可共享同一 `.memora/` 存储。区别在五点：

1. **消费者**：插件 = 人类经 VS Code UI；MCP 服务器 = 其他 AI agent 经 MCP 协议。
2. **跑不跑 agent（最根本）**：插件 = 跑完整 LLM 回合（记忆在此经总结产生）；MCP 服务器 = 不跑 agent，仅为存储/协议适配层。
3. **UI**：插件 44k 行 webview；MCP 零 UI。
4. **角色**：插件 = 终端产品（人用 memora 写码）；MCP = 基础设施（memora 记忆被别的 agent 读/写）→ 即 2026-10-12"从竞争翻转为被消费"护城河论点的落地形态。
5. **记忆产生语义**：插件记忆由 agent 总结生成；MCP 写入口是外部 agent 直接写（走治理但无 LLM 总结，质量语义不同，是真要设计的取舍）。

## 七、分发与接入（2026-10-15 WebSearch 实锤）

memora 是 local-first → **stdio 传输** → 跑在用户本机，无远程 URL。

- **发布载体 = npm**：`@zooique/memora-mcp`，沿用内核 npm 发布 + gitee/github 双 push（`package.json` 已有 `prepublishOnly` → `build` 链路，宿主照抄）。
- **可发现性 = 官方 MCP Registry**（`registry.modelcontextprotocol.io`，2025-09 预览、2026 已是规范索引，只存元数据，包体在 npm）→ `mcp-publisher` CLI 提交 `server.json`（声明 `mcpName` + stdio `packages` 块），下游市场（Glama / cursor.directory / VS Code MCP 画廊 / GitHub MCP registry / Cline）自动同步。
- **关键约束（对抗式纠正大众误解）**：stdio 服务器"不可从 registry URL 触达"——其他 agent 接入的是**用户本机起的一个 npx 进程**，不是某个公网地址。⇒ 只有**本地 agent**（Claude Code / Cursor / Cline / Roo / VS Code Copilot）能接入；**云端 / 远程 API 类 agent 触不到用户 `.memora/`**。
- **接入动作在用户侧**：在其 agent 的 MCP 配置加 `mcpServers` 块 / `claude mcp add`，指向本地二进制 + 其 `.memora/` 目录。

## 八、护城河论点据此收窄但更真实

2026-10-12"被所有 agent 消费"据此修正：不是"被所有 agent"，而是"**被用户机器上所有本地 agent 消费 → 一份 `.memora/` 多 agent 共享**"。这恰好是 memora 已有（跨工作区 + 治理记忆）相对 `@remem-ai/remem` 等 local-first memory MCP 的差异化点。仍须回验"Tier 3 空位是否被占"。

## 九、对抗式审查（反驳我自己）

| 反驳 | 回应 |
| --- | --- |
| "新开仓库更干净，免得内核改动影响插件" | 反驳无效：内核改动面极小（**写方向已于 2026-10-16 放弃，原「内核改动只有 G1」作废**），只读切片零内核改动；同仓宿主能锁步测，跨仓库反而要"先发内核再联调"，耦合税更高。仓库本就是 `hosts/` monorepo。 |
| "一上来就做写，功能才完整" | 真成本成立，但正确缓解是**只读切片先验需求**——若没 agent 来连，写更不必投。（**2026-10-16 更新**：写入能力已拍板放弃，「证真再上」不再适用——只读即终态，见 `ADR-MCP-001` 决策 8） |
| "云端 agent 连不上，护城河不成立" | 部分成立 → 这是真边界，不是 bug。护城河收窄为"本地多 agent 共享记忆"，2026 本地 agent（Claude Code / Cursor / Cline / Roo）是 agent 活动主战场，收窄后仍有价值。要服务云端 agent 需另建远程桥（超出本方案）。 |
| "直接做成远程 HTTP MCP 服务" | 反驳：破 local-first，记忆要出本机，安全/同步成本高，且和托管 memory MCP 直接红海竞争。stdio 本地是最小风险切法。 |

## 十、落地方案（只读切片优先）

### 10.1 目录与包
- 新建 `hosts/memora-mcp/`，`package.json` 名称 `@zooique/memora-mcp`，加 `bin` 入口（`memora-mcp`）、`files`、`mcpName` 字段。
- 依赖：`@zooique/memora`（内核）、`@modelcontextprotocol/sdk`（破零依赖，故在宿主层）。

### 10.2 复用存储
- 直接复用 `hosts/memora-vscode/src/extension/host/workspaceStorage.ts` 的 JSON 实现（VS Code-free），薄封装把根目录指到任意 `.memora/`。

### 10.3 MCP 工具（只读）
- `search_memories(query, limit)` → `IMemoryStorage.search`
- `get_memory_by_id(id)` → `IMemoryStorage.getById`
- `get_memories_by_source(source)` → `IMemoryStorage.getBySource`
- 直接吃 `IMemoryStorage` 原语（`memoryInspector.ts:138` 证实 `search/getById/getBySource` 是 headless 基元）；**不走 `MemoryInspector`**（其构造要 `loop+history`，`memoryInspector.ts:103-107`）。

### 10.4 headless 启动
- 无 LLM：解析 `--db <dir>`，挂 storage 到 `.memora/`，起 stdio server。

### 10.5 发布
- `npm publish`（双 push）+ `mcp-publisher` 登记官方 registry + README 写 `claude mcp add` / `mcpServers` 安装片段。

## 十一、未决开放问题（动手前须答）

1. **2026 生态真就绪？** 本地 agent 会不会真的来连一个 local memory server？（只读切片可边做边验）
2. **Tier 3 空位是否被占？** `@remem-ai/remem` 等 local-first memory MCP 是否已占"多 agent 共享同一本地记忆库"这个位？memora 的差异化（跨工作区 + 治理型记忆）是否够锋利？
3. ~~**写 API 的语义**：外部 agent 直接写（无 LLM 总结）的记忆质量如何治理？是否要限来源 / 限写入面？~~ → **已决并关闭（2026-10-16，用户拍板「明确放弃写入，只保留读」）**。判据 = 记忆的类型契约只能由一条链产出，MCP 侧无 LLM 提炼 ⇒ 即便走同一 `upsert` 也是另一类条目；不对称的是「谁有资格造一条记忆」。**「交原材料 + 统一提炼」变通方案一并否决**——真正卡住的是机制不是能力：① 触发（外部 agent 提示词不受控 ⇒ 大概率零调用）② 归属真值（无 roundId/sessionName，编造即伪造溯源）③ 视角（无角色包 `summaryFocus`，同原料炼出另一种东西）。**⚠ 论据订正**：曾以「提炼需宿主注入 LlmProvider」作论据，已证伪——`LlmProvider` 已导出（`src/index.ts:88`）且 MCP SDK `Server.createMessage()`（`sampling/createMessage`）可反向借 agent 的模型，配置面障碍不存在。**🔴 接了比不接更危险**：二等记忆形似（同 source/summaryType/materialFingerprint）神不似，会骗过 supersedeSimilar / roundSummaryLoader 防渗入 / 分轨召回。**定性**：`.memora/` 权威记忆由插件宿主维护，MCP 只提供读快照。**详见 `ADR-MCP-001` 决策 8**（本文件为探索期草稿，写能力以 ADR 为准；**本缺口已无消费方、不排期**）。**⚠ 论据边界（2026-10-16 补，防拿失效论据推理）**：上述三大论据（触发/归属/LLM）**只在 MCP 形态成立**——若未来以「dsh Cordis 原生插件」形态接入（台账 `DSH-1`），三论据全部失效、写入须重新拍板（≠自动恢复写；重议程序见 `docs/方案-dsh-Cordis原生插件-20261016.md` §六）。

## 十二、下一步（待拍板）

1. **补 SSOT**：把"服务端 MCP"从报告论点登记成 `tasks/待完成任务.md` 正式条目（别重蹈 GOAL-DRIFT-1"看起来活的却不在台账"）。 ✅ 已完成（`MCP-SERVER-1`）
2. **立 ADR**：新部署面按项目纪律须立 ADR（`docs/architecture/decisions/`）。 ✅ 已完成——真源为 `.trae/decisions/`，编号 `ADR-MCP-001`（**注意：本条原写的 `docs/architecture/decisions/` 为空、不是真源**）
3. **脚手架只读切片**：`hosts/memora-mcp/` 最小骨架，用实物流验证护城河假设。 ✅ 已完成（tsc 零错 + `npm run smoke` 9/9）
4. ~~**前置依赖**：5.0.0 内核发版~~ → 仍成立但已非阻塞：只读切片零内核改动，可先发；写方向已放弃，原「5.0.0 先行」的强绑定解除。
5. **真机接入验证**（当前唯一剩余）：用某个本地 agent 实际连上并检索——验证目的已收窄为「确认真有人来读」（写入已放弃，不再据此决定是否投内核写 API）。
