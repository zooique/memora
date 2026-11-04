# ADR-046 · 角色包权限面收敛：不用工具名禁用表、能力小标不按钮化、入口收敛为一枚 pill

> **状态**：✅ 已接受（实现待排期；**版本待定**）
> **日期**：2026-11-04 **播种批次**：角色包权限面收敛核查 **来源**：对「能力小标可点 + 工具名布尔禁用表」设想的对抗性评估（只读实测，HEAD `e0d152fa`）

## 背景

用户提出两套设想：① 把输入框底部的能力小标拆成「每个能力一个可点按钮」，彩色=激活、点灰=禁用；② 进一步把角色包的工具控制从「`capabilities` 白名单」换成「工具名 + 布尔」的禁用表，默认未定义 = 全开，靠按钮翻转布尔值。

核查结论：**底层判据只有两套**（执行面 `toolReadonly` 单闸、暴露面 `capabilities` 白名单），而 UI 入口设想已排到四个（只读开关、权限档位、能力按钮、永久写包）——**控件数量超过底层判据数量**，是过度设计的典型征兆。但现状确有既存缺陷，需要修根因；修根因不等于换一套权限模型。

实测事实（2026-11-04）：

1. **零需求样本**：仓库内置 3 个角色包全无只读声明——`memora助手` 无 `capabilities`、无 `strategy`（`toolReadonly` 缺省 `'full'`）；`共鸣小说家` 只声明 `web:search`、`act.toolReadonly: 'full'`；`白话方案设计师` 声明 `web:search` + `llm:summarize`、`act.toolReadonly: 'full'`。用户级角色包目录（`%APPDATA%\Code\User\globalStorage\zooique.memora-vscode\role-packs`）**存在但为空**；项目级 `.memora/role-packs` **不存在**。
2. **三态被两处折叠 + 一处判空**：解析层非数组一律返回 `[]`（`src/role-pack/rolePackManager.ts:224-240`）；装配层 `capabilities: pack.capabilities ?? []` 且 `RolePackAssembly.capabilities` 为必填数组（`src/role-pack/strategyResolver.ts:489-490`、`src/role-pack/types.ts:278-279`）；应用层按 `length > 0` 判空（`src/agent/agent.ts:1840-1842`）⇒「没写」与「显式空」全链折叠，关掉最后一个能力会反转成「全开」。
3. **`capabilities` 映射有空洞**：`web:search → web_search`、`web:fetch → web_fetch`、`code:execute → run_code`、`llm:summarize → []`（`src/role-pack/capabilityMap.ts:21-52`）⇒ 声明了 `llm:summarize` 的包会得到空白名单，特权工具全关。
4. **execute 侧不校验暴露面（静态可证）**：`ToolExecutor.execute()` 不读 `toolWhitelist`，`this.list.find(...)` 只用于参数修正（`src/agent/toolExecutor.ts:1052-1055`）；`default` 只对未注册工具报错（`:2020-2079`）；loop 侧亦无暴露检查（`src/agent/loop.ts:2165-2356`）；自定义工具始终暴露（`src/agent/toolExecutor.ts:923`）⇒ 已注册但未暴露的工具被显式调用时仍会执行。
5. **工具名是跨包契约**：宿主 `toolNameMap` 的键集合须与内核工具清单双向闭合（`hosts/memora-vscode/src/webview/helpers/toolNameMap.ts:11-14`，守卫测试读内核源码）；工具名进入宿主渲染与任务表分支。工具名可改，但改名会让清单静默失效。
6. **manifest 结构变更的门很松**：未知顶层键只 `warning`，`valid = 无 error`（`src/role-pack/validator.ts:28-29`、`:89-100`）⇒ 新字段在旧内核上「装得上但不生效」；宿主 `roles_save` 只携带 `strategy`（`hosts/memora-vscode/src/shared/protocol.ts:582`），保存实现只替换 strategy 段（`hosts/memora-vscode/src/webview/panels/settingsPanel.ts:795-839`）⇒ UI 写了也落不了盘。

## 决策

### 1. 否决「能力小标 → 每个能力一个可点按钮」

- **零样本**：3 个内置包全 `'full'`、用户目录空、项目目录不存在。没有真实只读问答包，就不为一个设想改写交互契约。
- **「点灰」只能表达隐藏，表达不了禁用**：能力是暴露面（LLM 看得见什么），不是执行面（能不能执行）。把「灰」读成禁用会让用户以为写操作已被锁住，而 `execute` 侧根本没有暴露校验（见背景 §4）。
- **前提是整条三态链修复**：当前「关掉最后一个能力 ⇒ 全开」是真实反转（见背景 §2）。控件先上、语义后修，等于把缺陷做成按钮。

### 2. 否决「工具名 + 布尔禁用表」替换 `capabilities`

- **不是白名单的对偶**：`capabilities: ["web:search"]` 的语义是「只开 web_search」；默认开的黑名单要表达它，必须把其余全部工具逐个列为 `false`——清单随工具新增而漏，无法表达「未来工具默认关」。
- **漏列即放行**：新工具默认进入所有旧包。现状下无 `capabilities` 的包会暴露新工具、有 `capabilities` 的包不会；换成黑名单后**两类旧包都会静默获得新工具**，且没有任何测试会红。
- **execute 侧无校验**（背景 §4）：禁用表只能影响提示面，不能兑现「禁用即不可执行」的承诺。
- **ADR-045 已列为放弃方案**：`ADR-045` 替代方案明写「给只读包硬编码一份写类工具黑名单」= 第二处判据、新增工具必然漏配（`.trae/decisions/ADR-045-readonly-mode-single-gate.md` §替代方案）。
- **可分享资产不能绑实现细节**：能力名是中立的（`capabilityMap` 头注明写「不绑具体实现」），工具名是 memora 当前实现；写进 manifest 会让角色包无法跨实现复用。

### 3. 否决「同一控件承担临时与永久两种语义」

同一个按钮，一半场景只改会话、一半场景静默改写可分享的项目级文件——用户无法从界面分辨后果。永久编辑留在角色包设置（仅 user / project，内置包只提供「复制到用户目录」）；运行时控件只写会话覆盖、不落盘。

### 4. UI 收敛：一枚 pill + popover，内部承载全部权限分区

- **真源分层 ≠ 控件增殖**。底层只有两套判据，界面只保留**一枚**可点 pill（Row 2，`hosts/memora-vscode/src/webview/panels/chatPanel.ts:4413-4417`）；点开 popover（复用 `webview/components/dropdown.ts`），内部三区：**只读 / 能力 / 档位**。
- 能力小标保持**只读展示**，不得做成每能力按钮；pill 是唯一入口。
- 不新增整行：Row 2 `min-height` 18px（`hosts/memora-vscode/src/webview/styles/chatStyles.ts:1549`），24×24 命中区只抬高 6px；相邻命中区间距 ≥ 4px（对齐 `--sq-lg: 24px` token 与 WCAG 2.5.8）。
- 冲突判据：档位里的「全部自动」是**派生断言**，必须由合并后的实际权限推导（数据源 `capability_badge.strategyHint.toolReadonly`，`chatPanel.ts:768-776`、`protocol.ts:1234`）；`toolReadonly='readonly'` 或 `toolMode='block'` 时禁用「全部自动」并给文案；包自带只读时只读区为展示态「包锁定 · 不可解除」。

### 5. 三态语义（红线）

`capabilities` 的三种状态**必须全链可区分**：

| 形态 | 语义 | 暴露结果 |
| --- | --- | --- |
| 缺省（`undefined`） | 不收紧 | 全开（`toolWhitelist = null`） |
| 显式 `[]` | 显式零特权 | 仅常驻集 |
| 非空数组 | 白名单 | 常驻集 + 映射命中项 |

**三处必须同批改，漏一处即复发**：① 解析层保留 `undefined`（`rolePackManager.ts:224-240`）；② 装配层 `RolePackAssembly.capabilities` 改为可选并删除 `?? []`（`strategyResolver.ts:489-490`、`types.ts:278-279`）；③ 应用层按 `undefined` 判空而非 `length > 0`（`agent.ts:1840-1842`）。**点名吞状态的坑**：装配层的 `?? []` 会把解析层刚修好的三态再折叠一次，只改解析层等于没改。

### 6. 执行侧：暴露面不是安全边界

- 真正的安全边界仍是 `toolReadonly`（ADR-045 单闸）；`capabilities` 只控制 LLM 可见的工具面。
- 若要堵「模型调用未暴露工具」，在**执行入口**做**独立单点判据**，不得并入白名单判据（那是两个轴）。
- 该判据动手前必须先定边界：列出 loop 在进 executor 前自行处理的工具（`compress_context` / `remember_intel` / `ask_user` 等）与自定义工具，确认不误伤常驻集；边界未写清不动手。

### 7. 不做清单

- 不做能力按钮化；不做工具名布尔禁用表进 manifest；不做同控件双语义；不做「永久编辑」写进内置包；不新增第二份权限判据。
- 不做「每能力一个开关」的 UI；能力开关若将来有真实需求，另立 ADR 并先解决 `CAP-TRISTATE-1`。

### 8. 落地顺序约束（不是实施步骤）

三态修复（P-1）先于任何能力 UI；执行侧加固（P0）可与 UI 无关地独立落地；只读运行时覆盖落点（P1）先于 pill 的只读分区；pill（P2）最后。具体拆分与验收归台账，本 ADR 只定顺序与边界。

## 理由

- **控件数不得超过判据数**：每多一个入口就多一份「界面宣称 vs 实际行为」的漂移面，且没有测试会红。
- **属性优于名单**：只读与写是工具属性，不是可枚举名单；名单会随新增工具过时。
- **默认语义必须清晰**：「未声明 = 不收紧」与「显式空 = 禁止」是两层语义，折叠即制造反转。
- **可分享资产保持中立**：能力名跨实现，工具名绑实现；manifest 只写前者。
- **临时与永久必须分开**：用户必须能从界面分辨「这次会话」与「改了别人的包」。

## 替代方案

| 方案 | 放弃原因 |
| --- | --- |
| 能力小标拆成每能力按钮 | 零需求样本；「点灰」表达不了执行面禁用；前提是三态全链修复 |
| 工具名 + 布尔禁用表替换 capabilities | 不是白名单对偶、漏列即放行、execute 侧无校验、ADR-045 已否决、绑定实现细节 |
| 同一控件承担临时与永久 | 用户无法分辨后果；永久档会静默改写可分享资产 |
| 把只读塞进能力表 | 只读是整体否定，无法用逐工具布尔穷举；且会与 `toolReadonly` 形成第二真源 |
| 为三态另造一套新能力模型 | 现有 `capabilities` 语义可承载，另造=第二真源 |

## 影响

### 1. 对既有实现

- `capabilities` 的公开类型（`RolePackAssembly.capabilities`）会从必填数组变为可选，需同步内核导出面与宿主 DTO；这是**语义修复**，不是新能力。
- 三态修复会改变「显式 `[]`」的行为：从「全开」变为「仅常驻」。仓内 3 个内置包无人写显式 `[]`（实测），故无既有包受影响。
- 宿主 `roles_save` 与设置保存路径本轮**不扩写**；pill 只写会话覆盖，避免新增协议通道。

### 2. 已知边界（如实登记）

- 即使执行侧加固落地，自定义工具与 MCP 工具的执行行为仍按各自注册面判定；本 ADR 不承诺「未暴露 = 不可执行」的全局封闭。
- 只读闸拦不住内核 turn 持久化、宿主自身写盘、MCP server 运行期行为（沿用 ADR-045 影响 §1）。
- pill 的只读分区依赖 `READONLY-RUNTIME-1` 的落点定案；落点未定前只做展示态。

## 何时回顾

- 出现第一个真实「只读问答」角色包样本时：重评能力 UI 是否值得做。
- 新增任何内置工具时：确认它是否需要 `readonly: true`，并检查是否需要在能力映射中登记。
- 修改 `capabilities` 解析 / 装配 / 应用任一层时：重跑三态四用例与变异验证。
- 新增宿主权限入口或协议消息时：回到「控件数 ≤ 判据数」自查，禁止再造第二个入口。
- 若未来要给 AI 增加「改角色包能力」工具：本项目级角色包写面风险会被放大，必须重新评估本 ADR 与 ADR-045。
