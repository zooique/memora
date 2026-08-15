# 三层对齐迭代方案 — 以内核设计为种子自然生长

> 状态：已实施（4 方向全部落地，typecheck + 60 测试 + compile 通过）
> 日期：2026-08-15
> 关联：[plugin-alignment.md](./plugin-alignment.md)（内核→插件功能对齐）、[ui-redesign.md](./ui-redesign.md)（UI 重设计）、[ADR-VC-001](../../../.trae/decisions/ADR-VC-001-vscode-plugin-host.md)
> 设计哲学：**以 memora 内核为种子，插件功能对齐内核，UI 展示对齐插件功能**——三层逐层对齐，不重复造轮子、不凭空加功能，只让 UI 长出现内核已有能力对应的展示。
> 定位：本方案是 plugin-alignment / ui-redesign 收尾后的**第二轮迭代**，聚焦「内核有种子能力、UI 未对齐生长」的 4 个断点。不新增 ADR、不改内核架构，全部改动在现有三层分层上自然生长。

---

## 一、三层对齐审视结论

### 1.1 主干已对齐（上一轮迭代成果）

| 层 | 对齐项 | 状态 |
|---|---|---|
| 内核 → 插件 | AgentOptions 全注入（provider/storage/sessionStore/webSearch/messages/preExecutionCheck/tracer/permission/allowedPaths） | ✅ |
| 内核 → 插件 | AgentChunk 全量镜像进协议（text/tool/selfReview/handoff/retry/paused/error） | ✅ |
| 内核 → 插件 | 会话级事件全绑定（sessionError/sessionResumeFailed/.../memoryAdded） | ✅ |
| 插件 → UI | 协议消息全量被 webview 消费（chatView switch 全覆盖） | ✅ |
| 插件 → UI | 指标 getMetrics → postMetrics（4 项）、中文消息 CHINESE_MESSAGES | ✅ |

### 1.2 断点（内核有种子能力，UI 未对齐生长）

| # | 断点 | 内核种子 | 插件/UI 断点 |
|---|---|---|---|
| 1 | **角色包多包机制未用** | RolePackManager 支持多包 + `activate()` 切换 + 粘性匹配 + 互斥切换；切角色 emit `personaSwitched{from,to}`（agent.ts 5 处） | 只带 doc-review 1 包；身份条只读无切换；**personaSwitched 未绑定** → 内核自动切角色 UI 不刷新（真实链路断裂） |
| 2 | **thinking 阶段未对齐** | yield `thinking{phase: recalling/processing/archiving}`（agent.ts L544/L550/L606 等） | 协议无 thinking 消息；UI 用 `status` 笼统显"思考中"（对 ui-redesign 排雷雷-1 的演进：从笼统 status → 真实 phase） |
| 3 | **指标面板不完整** | AgentMetrics 含 llm tokens / decay 衰减 | postMetrics 只透 4 项，且默认隐藏 |
| 4 | **composer 附加能力 chip 未实施** | webSearch 已注入；内核 `toolWhitelist` 支持按角色包 capabilities 过滤工具（"换角色→工具集切换"） | footer 无联网开关 chip（ui-redesign §4.1 ④ 已设计未落地） |

> 断点 1 最值得优先：根目录 `role-packs/` 已有 5 个现成兼容角色包（代码助手/写作助手/技术文档工程师/翻译助手/项目总监，manifest 均为 1.0.0 文件夹形态），是 memora「角色包承载定位」种子的现成扩增来源。

---

## 二、迭代方案（按层对齐，按 ROI 排序）

### 方向 A：角色包多包对齐（最高 ROI，种子能力最强）

**目标**：插件从「单一 doc-review 角色」长成「多角色可切换」，且 UI 身份条与内核角色状态实时对齐。

#### A1 绑定 personaSwitched —— 修复真实链路断裂（最小改动）
- **层**：插件功能（chatPanel）+ UI（chatView）
- **动作**：
  - `chatPanel.ts`：`bindAgentNoticeEvents()` 处补绑 `agent.on('personaSwitched', ...)`，将 `{from,to}` 转发为协议消息 `chat_role_pack`（复用现有消息，仅角色名变化）。
  - `chatView.ts`：已消费 `chat_role_pack` 更新身份条；内核自动切换时身份条即时刷新（无需新增协议类型）。
- **验收**：角色包粘性匹配/显式激活切换后，UI 身份条角色名与内核 `activeName` 一致。

#### A2 打入多角色包 —— 扩增种子（产品选「扩展为多角色」）
- **层**：插件内置资源（src/extension/role-packs/）
- **动作**：从根目录 `role-packs/` 复制 2-3 个与插件定位互补的通用角色包（如 写作助手 / 技术文档工程师 / 翻译助手）到 `src/extension/role-packs/`（esbuild 已自动复制到 dist）。保留 doc-review 作为出厂默认（首个激活）。
- **验收**：插件侧栏启动后扫描到多角色包，`RolePackManager.activeName` 为 doc-review，`listMeta()` 返回全部。

#### A3 身份条角色切换入口 —— 显式切换（主动可见）
- **层**：UI（chatView + chatPanel + chatStyles）
- **动作**：
  - 协议新增 `WebviewToExtensionMessage`：`{ type: 'chat_set_role_pack'; name: string }`。
  - `chatPanel.ts`：处理该消息 → 调 `agent.rolePackManager.activate(name)`（或经 Agent 公开方法）→ 推送 `chat_role_pack` 刷新身份条。
  - `chatView.ts` + `chatStyles.ts`：身份条角色名旁加切换下拉（复用 `dropdown.ts` capsule 变体），列出当前角色包；点击即切换。
- **验收**：身份条可切换角色包，切换后内核 system prompt 前缀刷新，UI 身份条同步。

### 方向 B：thinking 阶段可视化（中等 ROI，AI 原生"途中展示"）

**目标**：把内核 `thinking{phase}` 真实阶段对齐到协议 + UI，让思考折叠块显示"召回/处理/归档"而非笼统"思考中"。

- **层**：协议（protocol.ts）+ 插件功能（chatPanel consumeFlow）+ UI（chatView + chatStyles）
- **动作**：
  - `protocol.ts`：新增 `ExtensionToWebviewMessage`：`{ type: 'thinking'; phase: 'recalling' | 'processing' | 'archiving' }`。
  - `chatPanel.ts` `consumeFlow`：补 `thinking` chunk 分支 → post `thinking` 消息。
  - `chatView.ts`：`thinking` 分支更新思考折叠块 label（recalling→"召回记忆中"、processing→"处理中"、archiving→"归档记忆中"）；`done` 时收敛折叠。
- **约束**（自然生长，不推翻 ui-redesign 排雷雷-1）：雷-1 曾决定 thinking 不收入协议（用 status 覆盖）。本轮是**演进**而非推翻——status 仍负责"进行中/结束"状态机，thinking 只补充"进行中处于哪个阶段"的细化，二者职责分离、不冲突。
- **验收**：生成中思考折叠块按内核 phase 显示阶段文案；`prefers-reduced-motion` 生效。

### 方向 C：composer 联网开关（中等 ROI，有可行性约束）

**目标**：输入区加"联网搜索"开关 chip。**可行性约束**：内核 `ToolExecutor.toolWhitelist` 为 private 且仅 getter（无公开 setter），web_search 暴露由`角色包 capabilities → 工具集`范式控制。故给出两条路径，推荐低侵入：

- **路径 C1（推荐，零内核改动）—— 由角色包能力声明控制**：联网能力由角色包 manifest `skills[].capability` 声明（声明 `web:search` 则有联网，不声明则无）。composer 的联网 chip 作为**当前角色包联网能力的可见指示**（已声明则点亮、可点按切换角色包），而非独立运行时开关。契合内核"换角色→工具集切换"范式。
  - 层：UI（chatView + chatStyles）+ 插件功能（chatPanel 透传角色包 capabilities）
- **路径 C2（需内核小改动）—— 动态开关**：内核给 `ToolExecutor` 增加 `setWebSearchEnabled(boolean)`（改 `toolWhitelist`），插件 UI 开关调用。打破"薄壳装配"边界，需先评审是否值得。
- **验收（C1）**：联网提示随角色包能力声明显示；无联网能力的角色包不显示联网 chip。

### 方向 D：指标面板补齐（低 ROI，可延后）

**目标**：透出内核 AgentMetrics 已采集但未展示的字段（llm tokens / decay 记忆衰减）。

- **层**：协议（protocol.ts）+ 插件功能（postMetrics）+ UI（chatView 指标渲染）
- **动作**：
  - `protocol.ts` `metrics` 消息扩展：`llmTokenIn/llmTokenOut`、`decayRunCount`。
  - `chatPanel.ts` `postMetrics()`：从 `agent.getMetrics()` 补齐字段。
  - `chatView.ts` 指标折叠区展示。
- **约束**：`memora.showMetrics` 默认隐藏不变（调试信息降噪）。
- **验收**：开启 showMetrics 后指标区显示 tokens / decay；默认仍隐藏。

---

## 三、实施顺序（按层渐进，每步独立可验证）

按「断点 1（角色包）→ 断点 2（thinking）→ 断点 4（连锁网）→ 断点 3（指标）」顺序，每层改动独立提交：

1. **A1 绑定 personaSwitched**（最小改动，先修真实断裂）
2. **A2 打入多角色包**（扩增种子，纯资源复制）
3. **A3 身份条角色切换入口**（协议 + 插件 + UI）
4. **B thinking 阶段**（协议 + consumeFlow + UI）
5. **C composer 联网指示**（C1 路径，走角色包能力声明）
6. **D 指标补齐**（协议 + postMetrics + UI）
7. **测试**：补 `chatView.test.ts` / `chatPanelHistory.test.ts` 分支用例，跑全量检查（typecheck + 测试）

> **实施记录（2026-08-15）**
> - A1：chatPanel 补绑 `personaSwitched{from,to}` → 转发 `chat_role_pack`（含 C1 联网能力），身份条实时对齐。
> - A2：从根目录 `role-packs/` 打入 写作助手 / 技术文档工程师 / 翻译助手 3 个角色包（保留 doc-review 默认）。
> - A3：协议新增 `chat_set_role_pack`（Webview→Host）+ `chat_role_packs`（Host→Webview）；chatPanel `pushRolePacks`/`handleSetRolePack` 调内核 `rolePackManager.activate`；chatView 身份条角色下拉（复用 dropdown capsule 变体，无列表自动隐藏）。
> - B：协议新增 `thinking{phase}`；consumeFlow 转发 thinking chunk；chatView 思考折叠块按 recalling/processing/archiving 显示真实阶段文案。
> - C：`chat_role_pack` 携带 `webSearch`（`currentRoleHasWebSearch()` 读角色包 capabilities 是否含 web:search）；composer 联网 chip 作为能力指示显隐（C1 路径，零内核改动）。
> - D：`metrics` 协议扩展 `llmTokenIn/llmTokenOut/decayRunCount`；`postMetrics` 补齐；chatView 指标区展示 Tokens 与记忆衰减。
> - 测试：chatView.test.ts 新增 thinking / 联网 chip / metrics / chat_role_packs 下拉共 4 个用例，全量 60 测试通过；compile 确认 4 个角色包复制进 dist。

## 四、边界与纪律

1. **以内核为种子**：只让 UI 长出「内核已有能力」对应的展示，不凭空加功能。
2. **三层逐层对齐**：内核能力 → 插件功能（协议/装配）→ UI 展示，每一层改动以对齐上一层为准。
3. **自然生长**：面向现有结构增量改造；三次以上重复才提取组件，不提前抽象。
4. **不重复造轮子**：身份条切换复用 `dropdown.ts` capsule 变体；角色切复用现有 `chat_role_pack` 协议；工具状态色复用 `--status-*` 令牌。
5. **薄壳装配**：不重复实现内核能力；方向 C 优先走零内核改动路径（C1），C2 需额外评审。
6. **克制**：thinking/指标均为轻量过程性/调试展示，不喧宾夺主；`prefers-reduced-motion` 生效。