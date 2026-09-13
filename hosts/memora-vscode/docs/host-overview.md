# Memora VS Code 插件 · 宿主对齐与 UI 演进总览

> 定位：本文件是 `hosts/memora-vscode/docs/` 的**单一事实入口**——收敛历史上 plugin-alignment / alignment-iteration / host-alignment-v2 / ui-redesign 四份方案文档的**已落地结论与设计纪律**，剥离方案过程噪点（排雷表、ROI 分层、实施顺序等过程性内容已归档至 `tasks/`）。
> 当前 UI 视觉审查见 [ui-growth-review.md](./ui-growth-review.md)（常驻，随 UI 迭代更新）；目录结构见 [directory-structure.md](./directory-structure.md)。
> 内核契约基线：ADR-VC-001（插件 = 第二个、更薄的宿主）。

---

## 一、三层对齐模型（主干已闭合）

插件以 memora 内核为种子，逐层自然生长，不重复造轮子、不凭空加功能：

```
内核能力  →  插件功能（协议/装配）  →  UI 展示
（机制）        （策略：采集/落盘/渲染）   （长出内核已有能力对应的展示）
```

**已对齐事实**（grep/测试实锤，非方案预期）：

| 层 | 对齐项 | 状态 |
|---|---|---|
| 内核 → 插件 | `AgentOptions` 全注入（provider / storage / sessionStore / webSearch / messages / preExecutionCheck / tracer / permission / allowedPaths） | ✅ |
| 内核 → 插件 | `AgentChunk` 全量镜像进协议（text / tool / selfReview / handoff / retry / paused / error），`recall` / `question_pending` / `thinking` / `done` / `aborted` **不收入协议**（已被事件通道覆盖，避免双通道） | ✅ |
| 内核 → 插件 | 会话级事件全绑定（sessionError / sessionResumeFailed / … / memoryAdded / personaSwitched / rolePackSwitchLocked） | ✅ |
| 内核 → 插件 | `preExecutionCheck` 注入（放行语义，收敛版不做参数审计——工具信息已由工具卡片 + tracer span 覆盖，避免三重冗余） | ✅ |
| 内核 → 插件 | `VscodeTracer`（实现 `ITracer`）注入，每轮 `postMetrics()` 推送；指纹/指标只读不写 sessionStore，默认不落盘 | ✅ |
| 内核 → 插件 | `CHINESE_MESSAGES` 注入，内核默认英文 UI 提示全中文化 | ✅ |
| 插件 → UI | 协议消息全量被 webview 消费（chatView switch 全覆盖） | ✅ |
| 插件 → UI | 角色包多包机制：**2 个内核出厂角色包**（白话方案设计师 / 小说助手）构建期从内核 `role-packs/` 同步打入 dist（宿主不自持源，2026-08-24 机制化单一真理源），身份条角色下拉切换（复用 dropdown capsule 变体），角色切换事件（`rolePackSwitched` → `chat_role_pack` 协议消息，chatPanel.ts:615-629）实时对齐 | ✅ |
| 插件 → UI | thinking 阶段真实 phase（recalling / processing / archiving）替代笼统 status | ✅ |
| 插件 → UI | composer 附加能力 chip（角色包 capabilities 驱动的联网指示） | ✅ |
| 插件 → UI | 指标面板（Tokens / 记忆摘要 / 工具失败等）折叠区展示 | ✅ |

**角色包清单（出厂自带，2 个）**：白话方案设计师 / 小说助手。定位由维护于内核 `role-packs/` 的 manifest 声明（宿主构建期经 esbuild 从内核同步，单一真理源——宿主不再自持副本），内核 `RolePackManager` 自动扫描激活，插件不自定性（ADR-VC-001 决策）。

---

## 二、UI 视觉重构（已落地，2026-08-15 定稿）

`ui-redesign.md` 的设计目标已全部实现（验收清单全过），当前代码形态：

| 设计项 | 落地形态 | 位置 |
|---|---|---|
| 身份/角色整合 | 顶部 AI 身份弱标签 `.msg-ai-label` + footer 只读角色徽章 `.role-badge`（演进为更克制方案，非侧边头像） | chatStyles.ts |
| 日期分隔 | 跨天合并 `.date-divider`（居中灰字 + 两侧细线，aria-hidden） | chatStyles.ts |
| 思考折叠块 | `.thought-block` + 三阶段轨迹 `.thought-block__trace`（过程性降级，不落库不重放） | chatStyles.ts |
| 空态引导 | `.empty-suggestions` 示例提问 chips（点击填入输入框） | chatStyles.ts |
| Composer | 模型选择器 + 角色徽章 + 工具权限徽章 + 发送（footer 左右分组 space-between） | chatStyles.ts |
| 工具卡片 | 状态左边框色（running/success/failed）+ 成功折叠为单行胶囊 `.tool-card--capsule` | toolCard.ts |
| 配置面板 | 顶栏统计 `.stat-bar` + 分区标题 `.group-title`（激活/其他 Provider） + 卡片图标 `.cfg-icon` | configStyles.ts |
| 设计令牌 | `tokens.ts` L2 语义令牌 SSOT（`--surface-thought` 等新增），组件层零裸值 | tokens.ts |

**视觉纪律（延续至今，不可破）**：IDE 原生极简（直角/小圆角/克制配色/高信息密度，跟随 `--vscode-*`）；纯 DOM 手写工厂，不引框架；令牌即契约（裸值只出现在 `tokens.ts`）；不改协议、不重写架构、自然生长。

---

## 三、功能生长出的 UI 增量（8/15 之后，已对齐内核新能力）

| 组件 | 触发的内核能力 | 形态 |
|---|---|---|
| 会话标题条 `.session-title-bar` | 会话管理（改名/新建/历史） | 常驻顶部，身份锚 |
| 主活动条 `.activity-bar` | 会话异常 / 低扰 info | 常驻，error/info 分级 |
| 断点续跑横幅 `.checkpoint-banner` | 软暂停持久化检查点 | 临时，可续跑/关闭 |
| 任务看板 `.plan-board` | task_table_write/update（H4） | 临时，N/M 进度 |
| 主动提问条 `#clarifyBar` | needClarify / questionPending | 等待用户输入 |
| 记忆治理区 `.governance` | 记忆清理（cleanup，G4；记忆无衰减语义） | 统计卡 + 操作 |
| 后台模型通道 `.cfg-bg` | 独立 backgroundProvider（G5） | 配置子视图分区 |
| Embedding 配置 `.embedding-cfg` | 向量检索（G1） | 折叠区 |
| 写入审批开关 `.security-*` | 二次确认（H0） | toggle |
| 技能选项卡 | 全局技能池（2026-08-22 新增） | 卡片列表 |

> 这批增量组件各自克制，但**彼此缺乏统一的布局编排纪律**——这是 [ui-growth-review.md](./ui-growth-review.md) 当前审查的对象（顶部状态区层级协议、令牌裸值收敛等 P0/P1/P2 整改项）。

---

## 四、设计纪律总纲（四份旧方案收敛后的不可变基线）

1. **薄壳装配**：宿主只做注入 / 转发 / 渲染，不重复实现内核逻辑（tracer 只采集展示不埋点，事件流只转发不改造 chunk 语义）。
2. **单一真理源**：协议消息类型集中在 `shared/protocol.ts`，extension 与 webview 共用，字段命名与内核 chunk 同源防漂移。
3. **机制/策略分离**：内核给机制（事件流 / tracer 埋点 / getMetrics），宿主做策略（采集 / 落盘 / 展示）。
4. **不重复造轮子**：身份条切换复用 dropdown capsule；角色切复用现有协议；工具状态色复用 `--status-*` 令牌；同源信息不三重记录。
5. **有界 + 可选**：指纹 / 指标只读不写 sessionStore，落盘可开关（默认关闭）。
6. **激进对齐，不保留兼容层**：开发期无存量用户，协议层一次性与内核全量对齐，不做旧版补丁。
7. **自然生长**：面向现有结构增量改造；三次以上重复才提取组件，不提前抽象。
8. **UI 视觉纪律**：IDE 原生极简 + 令牌即契约 + 纯 DOM 不引框架 + 不改协议不重写架构。

---

## 五、历史归档索引（过程性内容已迁出 docs/）

| 原文档 | 状态 | 收敛去向 |
|---|---|---|
| plugin-alignment.md（2026-08-15） | 已落地，方案过程冗余 | 实施结论并入 §一；排雷表/ROI 分层/实施顺序归档 tasks/ |
| alignment-iteration.md（2026-08-15） | 已落地，第二轮迭代 | 断点闭合结论并入 §一/§二；迭代顺序归档 tasks/ |
| host-alignment-v2.md（2026-08-18） | 功能对齐清单，已吸收 | Tier A-F 实施结论并入 §一；路线图归档 tasks/ |
| ui-redesign.md（2026-08-15） | 视觉定稿，已落地 | 落地形态并入 §二；验收清单/实施顺序归档 tasks/ |
