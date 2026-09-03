# Memora 工具面补全路线（第一版 / 未来）

> **定位**：设计文档（探索期，未定案）——记录内核「提交给 LLM 的工具面」的设计薄弱点与补全路线，分「第一版必须补齐」与「未来实现」两类，供第一版落地决策与后续实现对齐。
> **原则**：对照 2026 大厂工具生态（Claude / OpenAI / Gemini）自查；**抄思想不抄机制**——工具扩展遵循 memora 既有范式（接口注入 + 条件暴露 + 零依赖 + 降级优先），不照搬大厂平台机制。
> **状态**：§三 第一版必须补齐；余下为未来实现（可逆规划，未固化 ADR；验证稳定后按[探索期决策沉淀机制](../../.trae/rules/exploration-decision-sedimentation-rules.md)升格）。
> **关联**：[mvp-scope.md](mvp-scope.md)（MVP 工具边界）· [harness-borrowing-assessment.md](../harness/harness-borrowing-assessment.md)（工具执行前拦截收敛）· [role-pack-skills-progressive-disclosure.md](role-pack-skills-progressive-disclosure.md)（技能渐进披露）

---

## 一、工具面现状

[builtinTools.ts](../../src/agent/builtinTools.ts) 全部工具归四域：

| 域 | 工具 | 暴露方式 | 设计定位 |
|---|---|---|---|
| 记忆/技能 | `search_memories` / `trace_summary` / `read_skill` / `read_resource` / `run_skill_script` / `list_resources` / `list_skills` | 始终可用（技能三件套渐进披露） | 核心域，设计最完整 |
| 本地文件 | `read_file` / `write_file` / `list_dir` | 始终可用 | 路径白名单 + 写入二次确认 |
| 任务执行 | `task_table_write` / `task_table_update` | 始终可用 | 多 turn 任务编排驱动 |
| 外部信息 | `web_search` / `web_fetch` / `run_code` | **条件性**（宿主注入对应 provider 才暴露，独立导出 `WEB_SEARCH_TOOL` / `WEB_FETCH_TOOL` / `RUN_CODE_TOOL`） | 搜索→抓取闭环 + 通用计算底座（第一版补齐落地） |

**工具面哲学**：全部是「自包含能力」（读自己、写自己、搜自己记忆），唯一连接外部世界的是 `web_search` / `web_fetch` / `run_code` 三个条件工具——其中 `web_search` 只返回摘要、`web_fetch` 读取正文（成对构成搜索→抓取闭环）、`run_code` 提供通用计算/验证底座。

---

## 二、与 2026 大厂工具生态的对照

| 能力 | memora | Claude | OpenAI | Gemini | 判定 |
|---|---|---|---|---|---|
| 搜索 | `web_search`（snippet） | Web Search（citations + 动态过滤） | Web Search | Google Search（grounding） | 已具备，缺配套抓取 |
| **抓取正文** | ❌ | Web Fetch | — | URL Context | **P0 补齐** |
| **通用代码执行** | ❌（仅技能绑定脚本） | Sandbox | Code Interpreter | Code Execution | **P0 补齐** |
| 文件/记忆/任务 | 完善 | 各有差异 | 各有差异 | 各有差异 | 已具备 |
| 工具按需检索 | ❌（全量常驻 prompt） | Tool Search（600+ 工具场景） | ToolSearch | — | 架构预留 |
| 结构化输出保证 | 手搓 `parseLlmJson` | Structured Outputs | structured outputs | structured outputs | 架构预留 |
| 副作用分级审批 | 二值 `readonly` + 写确认 | per-tool approval | tool approval | — | 架构预留 |
| MCP 连接 | ❌ | MCP | Hosted MCP | MCP Server | 暂缓 |
| Computer Use / 浏览器 | ❌ | Computer Use | CUA | Computer Use | 暂缓 |
| 图像 / 多模态 | ❌（纯文本） | — | Image Gen | 原生图片 | 暂缓 |

---

## 三、第一版必须补齐

> 两条均为「连接外部世界」能力，与既有范式完全同构（接口注入 + 条件暴露 + 降级优先），不引入新机制、不破坏零依赖边界。

### 3.1 `web_fetch` —— 搜索→抓取闭环（P0，已落地）

**缺口**：`web_search` 只返回标题 + snippet，模型拿到结果却读不到正文——「网络为土壤」的养分被切断 90%。

**落地设计**：
- 新增 `IFetchProvider` 接口（与 `IWebSearchProvider` 同构），宿主注入后**条件性暴露** `web_fetch` 工具（独立导出 `WEB_FETCH_TOOL`，仿 `WEB_SEARCH_TOOL`）。
- 工具语义：`url` 必填 + `limit?`（截断字符数）；执行链路 = 抓取 → 正文清洗（去 HTML/脚本/样式）→ 截断 → 回填上下文。
- 幂等标记：`idempotent`（读操作，登记入 `BUILTIN_TOOL_IDEMPOTENCY`）。
- 失败降级：静默降级（对齐哲学 §6「降级优先」），不阻塞主流程。
- **组合语义**：`web_search` 给出候选 URL，`web_fetch` 读正文——两者成对构成「搜索→抓取」闭环。
- **实现**：`src/web-fetch/`（`IFetchProvider` 接口 + `FetchWebFetchProvider` 零依赖默认实现 + `safeFetch` 超时保护包装）；`toolExecutor.ts` 新增 `web_fetch` 分支（URL 协议白名单 + 长度上限 + 结果净化）；`index.ts` 导出接口/实现。

**验收**：宿主注入 provider 后 LLM 可读任意网页正文；未注入时工具不暴露（零依赖边界保持）。✅ 已通过（tsc 零错误 + 5 测试文件 122 用例全绿）。

### 3.2 `run_code` —— 通用代码执行（P0，已落地）

**缺口**：`run_skill_script` 绑定技能（脚本须随技能声明），无通用「模型写代码 → 沙箱执行 → 结果回上下文」能力——缺计算 / 数据处理 / 验证底座。

**落地设计**（内核保持零依赖）：
- 内核**不内置**沙箱执行器，新增 `ICodeExecutionProvider` 接口由宿主注入，条件性暴露 `run_code` 工具（与 web 侧注入同构）。
- 复用 `run_skill_script` 的子进程沙箱基础（语言白名单 + 超时，语义对齐技能脚本）。
- 工具语义：`language` + `code` 必填；源码**不进入**上下文，仅执行结果返回（与技能脚本同契约）。
- 幂等标记：`non-idempotent`（可能有副作用，走补偿机制）。
- 边界：执行器能力（语言 / 资源 / 网络）由宿主 provider 决定，内核只定义契约。
- **实现**：`src/code-exec/`（`ICodeExecutionProvider` 接口 + `safeExecuteCode` 超时保护包装）；`toolExecutor.ts` 新增 `run_code` 分支（language/code 长度上限 + 结果净化 + 三态格式化）；`index.ts` 导出接口/实现。

**验收**：宿主注入执行器后 LLM 可执行代码并回填结果；内核侧无新增运行时依赖。✅ 已通过（同 §3.1）。

---

## 四、设计层面的本质薄弱点（治理项，非单个工具）

| # | 薄弱点 | 现状 | 方向 |
|---|---|---|---|
| 1 | 信息获取「只搜不抓」 | ~~`web_search` 仅返回 snippet~~ → 已由 `web_fetch` 补全 | §三 3.1（已落地） |
| 2 | 通用计算 / 执行缺失 | ~~仅技能绑定脚本~~ → 已由 `run_code` 补全 | §三 3.2（已落地） |
| 3 | 工具面无增长上限 | 全部工具定义常驻 prompt，宿主注入一多即挤爆 | 工具注册层预留「发现 / 检索」设计空间（§五） |
| 4 | 摘要 JSON 契约靠 LLM 自觉 | `parseLlmJson` 解析 + 兜底重试，无平台级 schema 保证 | 契约版本化 + 平台 structured outputs（§五） |
| 5 | 工具副作用只有二值 | `readonly` 布尔 + `write_file` 二次确认，粒度不够 | per-tool 分级审批（§五） |

---

## 五、未来实现（暂缓 / 触发条件）

| 能力 | 为什么暂缓 | 触发条件（满足即提级） |
|---|---|---|
| 工具按需检索（Tool Search 意识） | 第一版工具少，常驻 prompt 够用 | 工具定义常驻 token 占比超阈值 / 宿主注入工具数 > N |
| 结构化输出保证 | 当前 `parseLlmJson` + 兜底可用 | 摘要契约失效率上升 / 接入平台级 structured outputs |
| 工具副作用分级审批 | 现有 `readonly` + 二次确认覆盖本地文件域 | 出现连接外部系统（邮件 / 日历 / 支付）等写副作用工具 |
| MCP 连接 | 与「零依赖可嵌入」定位冲突；宿主注入工具可替代 | 出现必须连外部系统的真实场景，且宿主注入成本 > MCP |
| Computer Use / 浏览器交互 | 非内核职责（宿主层） | 宿主出现需要网页交互的落地场景 |
| 图像 / 多模态工具 | 内核纯文本定位 | 业务侧出现图像消费需求（宿主注入，如效果图场景） |

---

## 六、与既有文档的关系

| 文档 | 关系 |
|---|---|
| [mvp-scope.md](mvp-scope.md) | MVP 工具边界（write / read / web_search）是本路线第一版的底座；`web_fetch` 是对 `web_search` 行的自然补全 |
| [harness-borrowing-assessment.md](../harness/harness-borrowing-assessment.md) | 工具执行前拦截（`preExecutionCheck` 三态）是「副作用分级审批」的未来落点 |
| [role-pack-skills-progressive-disclosure.md](role-pack-skills-progressive-disclosure.md) | 技能 L3 脚本沙箱是 `run_code` 的复用基础 |
| [structured-fidelity.md](structured-fidelity.md) | 摘要 JSON 契约（`{summary, type}`）的版本化治理归属 |
