# ADR-045 · 工作区只读模式：`toolReadonly` 单一总闸

> **状态**：✅ 已接受（实现待排期，台账条目 `READONLY-MODE-1`）
> **日期**：2026-11-04 **播种批次**：工作区只读模式设计核查 **来源**：只读事实核查（读取时 HEAD `73e91a4d`；`git diff --stat e1de60ae..HEAD` 仅动 `CHANGELOG.md` / `hosts/memora-vscode/README.md` / `tasks/archive/0.7.0-host.md`，`src/**` 零差异）

## 背景

需要一种「只读角色包」：它只允许读与回答问题，不允许改动磁盘。现有代码已经有一条**名字相同、语义相同**的闸，但它的覆盖面与合并方向都存在结构性缺口，直接拿去当「只读模式」会得到「看着锁上、实际能开」的假象。

盘点结论（均为代码实证，非推测）：

1. **闸只有一个执行落点**：`src/agent/toolRunner.ts:184-199`——
   `strategy.toolReadonly === 'readonly'` 时，凡全量工具定义中 `!toolDef.readonly` 的工具一律 denied，回执前缀 `[ERR:TOOL:READONLY_DENIED]`（`:191`、`:195`）。
2. **值只有一个来源**：`act.toolReadonly`（`src/role-pack/types.ts:78-79`），默认 `'full'`（`src/role-pack/strategyResolver.ts:64`，非法值也回退 `'full'`：`:261-263`）。
3. **有 16 个工具声明了 `readonly: true`，另有 10 个没有**（清单与行号见「决策」§5）。没有声明的工具全部落在写操作侧。
4. **合并方向是「override 赢」**：`src/role-pack/strategyResolver.ts:331` 为 `act: { ...base.act, ...override.act }`，没有「取更严」。
5. **校验不拦放松写法**：`src/role-pack/validator.ts:89-100` 对未知顶层键只 push `warning`（`UNKNOWN_TOP_LEVEL_KEY`），而 `valid` 判据 = 「无 error」（`:28-29`）⇒ 「写了就装不上」不成立。
6. **只读闸只管工具调用**：内核 turn 持久化、宿主自身写盘、MCP server 运行期行为都不经 `ToolRunner`（见「影响」§1）。

## 决策

**只读能力 = 一个总闸（`toolReadonly`）+ 一条默认值规则 + 一条合并规则 + 一条执行判据。不新增第二套枚举、不新增第二处判据。**

### 1. 默认值规则：未定义 = 全开，只读是显式否定

- 所有角色包工具类控制统一遵守「默认未定义 = 全开，只有明确禁止才关闭」。
- `toolReadonly` 未声明 ⇒ `'full'`（`src/role-pack/strategyResolver.ts:64`、`:261-263`）。
- 只读必须**显式**声明 `act.toolReadonly: 'readonly'`；它不是一个「默认值」。
- 反过来说：`'full'` 不等于「强制可写」，只是「不额外收紧」。

### 2. 三层取最严：系统默认 / 宿主运行时开关 / 角色包声明

三层只能收紧，**禁止出现「强制可写」态**——任何一层都不能把另一层已收紧的权限重新放开。

这里有一个必须在实现层修的现状缺口：三层目前靠 `mergeStrategy` 的普通展开合并，**override 会压过角色包的收紧声明**（`src/role-pack/strategyResolver.ts:331`）。实测路径：角色包 `readonly` + override 传 `full` ⇒ 最终 `full` ⇒ 锁失效。

**修法（唯一合法位置）**：把 `src/role-pack/strategyResolver.ts:331` 的 `act` 合并改为权限类字段「取更严」，判据为：

```
最终值 = 任一层出现 'readonly' ⇒ 'readonly'；否则 'full'
```

即 `'readonly' < 'full'`（按宽松度排序，取最小值）。该判据只在这一行落地，不复制到别处。

### 3. 判据唯一落点（红线）

- **执行拦截只在** `src/agent/toolRunner.ts` 的 `applyPrechecks`（`:184-199`）。
- **值唯一来源** `act.toolReadonly`。
- **不许**在 `ToolExecutor`、loop、宿主或角色包加载处再写一份「写类工具黑名单」——那等于第二处判据，两份语义必然漂移（本项目已有「措辞折叠」血训：判据分散后没有任何测试会红）。

### 4. 只读角色包不得有任何写入能力（含任务表）

- 判定方式即「不声明 `readonly` 的工具在只读态一律 denied」，无需维护黑名单。
- **用户已拍板：接受「任务表也禁」**——`task_table_write`（`src/agent/builtinTools.ts:693`）、`task_table_update`（`:733`）、`register_work`（`:923`）一并被只读闸拦掉。
- **理由（必须随判据一起留在 ADR 里，否则后人会当漏项「修」掉）**：只读角色包的定位是「只读 + 只回答问题」，它不需要把任务做完，也就不需要任务表与作品投影登记。把它们放行会让只读包获得「持久化进度/落盘登记」的写能力，与角色包定位矛盾。

### 5. 无 `readonly` 标记的工具清单（实测 10 个）

| 工具 | 定义行 | 备注 |
| --- | --- | --- |
| `write_file` | `src/agent/builtinTools.ts:585` | `diskWrite: 'path'`（`:592`） |
| `delete_file` | `src/agent/builtinTools.ts:619` | `diskWrite: 'path'`（`:622`） |
| `task_table_write` | `src/agent/builtinTools.ts:693` | 用户已拍板一并禁 |
| `task_table_update` | `src/agent/builtinTools.ts:733` | 同上 |
| `run_skill_script` | `src/agent/builtinTools.ts:788` | `diskWrite: 'opaque'`（`:795`） |
| `run_project_script` | `src/agent/builtinTools.ts:811` | `diskWrite: 'opaque'`（`:822`） |
| `run_command` | `src/agent/builtinTools.ts:844` | `diskWrite: 'opaque'`（`:856`） |
| `kill_command` | `src/agent/builtinTools.ts:882` | 无 `diskWrite` |
| `register_work` | `src/agent/builtinTools.ts:923` | `diskWrite: 'opaque'`（`:927`） |
| `run_code` | `src/agent/builtinTools.ts:386` | `diskWrite: 'opaque'`（`:391`） |

**更正记录（保留，不抹掉）**：核查初稿曾断言「`run_command` 是只读闸的漏网后门」。实测其定义**没有** `readonly: true`（`:844-880` 全段无该键），反倒**恰好会被只读闸拦住**；它是 `diskWrite: 'opaque'`，写能力真实存在，但只在非只读态生效。教训：判断「是否被闸拦住」必须看 `readonly` 声明，不能凭工具听起来危险就推定。

### 6. 宿主快速开关的形态 = 运行时 override，不改角色包文件

- 用户原始设想是「快速切换本质上就是改角色包配置」；讨论后改为走运行时 `strategyOverride`。
- **理由 1（资产洁净）**：角色包是可分享资产（内置 / 用户 / 项目三级，可下载可共享）。改角色包文件等于把一个宿主开关写进别人的包，分享出去就污染接收方。
- **理由 2（层级歧义）**：改「哪一级（builtin / user / project）」有歧义——同名角色包可能三级并存（加载顺序 `builtin → user → project`，后加载者胜，见 `src/role-pack/rolePackManager.ts:1264-1307`）。运行时 override 不落盘，天然没有「改哪份」的问题。
- **已知风险（必须登记）**：`strategyOverride` 目前是 **override 赢**（`src/role-pack/strategyResolver.ts:331`），没有「取更严」⇒ 快速开关在「取更严」未落地前会造成**放松**（见决策 §2 的修法）。开关落地必须先于或同版于「取更严」。
- **宿主现状（事实）**：宿主侧只有**展示**、没有切换——`rolesView.ts` 现有 chip「只读模式 / 完整工具」（`hosts/memora-vscode/src/webview/scripts/rolesView.ts:840-844`），`strategyOverride` 在宿主 `src/` 内零调用点。

### 7. 防延迟提权的两条结构判据（本 ADR 的核心）

**(1) 合并处取更严**（已述 §2）：改 `src/role-pack/strategyResolver.ts:331`，判据 =「任一层 `'readonly'` ⇒ `'readonly'`」。
实测反例（脚本次）：角色包 `act.toolReadonly: 'readonly'`、override 只传 `{ act: { toolReadonly: 'full' } }` ⇒ `mergeStrategy` 展开后 `full` ⇒ 锁失效。`strategyOverride` 是**部分策略**（`Partial<BehaviorStrategy>`：`src/agent/types.ts:566`、`src/agent/seed/types.ts:108`；装配链 `src/agent/agent.ts:232`、`:489` → `src/agent/seed/prepare.ts:84`），未传的**其他**字段继承 base（阶段内浅合并），但 `toolReadonly` 这个键一旦传了就是「后写覆盖」。

**(2) 放松写法升级为 error 级校验**：`src/role-pack/validator.ts` 现状对未知顶层键只 `warning`（`:89-100` 的 `UNKNOWN_TOP_LEVEL_KEY`），`valid = 无 error`（`:28-29`）⇒ 在 manifest 里写一个「放松权限」的自造键（或写非法枚举值）**照样装得上**。须把「权限类字段的放松写法」升级为 `error`，使 `valid=false` ⇒ `RolePackManager` 跳过装载（`src/role-pack/rolePackManager.ts:776-784`）。TOP-LEVEL 已知键集合见 `src/role-pack/validator.ts:41-55`。

**(3) 加载顺序埋雷（结构性风险，非即时提权）**：加载顺序 `builtin → user → project` 且**后加载者胜**（`src/role-pack/rolePackManager.ts:1264-1307`；同名覆盖见 `:1288-1296`，顺序写反保项目版见 `:1282-1286`）。而项目级角色包目录 `.memora/role-packs` **AI 可写**：
- 目录定义：`hosts/memora-vscode/src/extension/host/userAssets/projectScope.ts:53-59`（`join(resolveProjectDataDir(workspace), 'role-packs')`）；
- 写面判据放行：`src/security/pathGuard.ts:354-363` 的基准根含项目根，`.memora` 不在 `BLOCKED_PATTERNS`（`:45-82`）；`write_file` 的唯一路径闸是 `guardPathOrThrow`（`src/agent/builtinToolHandlers.ts:732-733`）；
- 已有事实：LLM 没有专用「角色包写」工具，只能 `write_file` 逐文件写；当前**也没有切换工具**（角色包只能手动切换，`src/agent/agent.ts:1653-1669`）。
⇒ 因此现状是**埋雷不是即时提权**：AI 能写同名项目级包顶掉用户级只读声明，但要生效仍需用户手动切换。该风险登记在案，不在本轮解决。

### 8. 能力白名单陷阱（只读包想保留上网时的失能点）

- `capabilities` 非空但全部映射不到工具（例如只写 `llm:summarize`）⇒ `resolveCapabilityTools` 返回 `[]`（`src/role-pack/capabilityMap.ts:44-57`；`llm:summarize` 映射为空数组，`:52`）⇒ `applyRolePackToolExposure` 把 `toolWhitelist` 设为 `[]`（`src/agent/agent.ts:1837-1844`）⇒ `[]` 是 truthy，`list` 用 `[].includes(name)` 过滤特权工具 ⇒ **特权工具全过滤**（`src/agent/toolExecutor.ts:944-948`）。这与「未定义 = 全开」**相反**。
- 只读包若要保留上网，必须**显式**列 `web:search` / `web:fetch`（`src/role-pack/capabilityMap.ts:21-36`）。
- `DEFAULT_EXPOSED_TOOLS`（`src/agent/toolExecutor.ts:493-524`）是常驻集，**不受 `toolWhitelist` 影响**（`:944-948` 先 `exposed` 后白名单）⇒ 只读包仍会看到只读工具，符合预期。

## 理由

- **单一判据优于工具黑名单**：只读的语义是「不许写」，而写是属性（`readonly` 缺失），不是名单。名单会随新增工具过时，属性不会。
- **默认全开 + 显式否定**：与仓内既有的 `contextLimit: 0` / `stepBudget: 0` 同构——「未声明」用中性值承载，避免把「没写」解释成「禁止」造成误伤。
- **三层取最严**：权限系统的失败方向必须朝「拒绝」，否则任何一层的疏忽都会变成放松。
- **override 不落盘**：宿主开关是运行时意图，不是资产内容；写进角色包会污染分享面，且三级同名的歧义无法消解。
- **任务表也禁**：只读包的职责边界决定了它不需要把活干完；留下任务表写能力等于给它一个「持久化进度」的后门。

## 替代方案

| 方案 | 放弃原因 |
| --- | --- |
| 给只读包硬编码一份「写类工具黑名单」 | 这是第二处判据，与 `readonly` 声明双源，新增工具必然漏配且无测试报警 |
| 在 `ToolExecutor` / loop / 宿主各加一层拦截 | 同上；且「措辞折叠」类错误无人能验证覆盖面 |
| 用「改角色包文件」实现宿主快速开关 | 污染可分享资产；三级同名时无法确定改哪一份；落盘还会让开关跨会话存留 |
| 把 `toolReadonly` 默认值设为 `'readonly'` | 违反「默认未定义 = 全开」，会让所有既有角色包与未配置场景当场失能 |
| 把「默认未定义 = 全开」解释成「只读也要全开」 | 混淆「未声明」与「显式禁止」两个语义层；只读是后者，必须显式声明 |

## 影响

### 1. 已知边界：只读闸拦不住的四类（如实登记，不写成「全拦截」）

1. **内核 turn 持久化**：`roundStore.save` / checkpoint / 记忆摘要在 turn 后处理写盘，不经 `ToolRunner`（写点：`src/agent/messageHistory.ts:341`、`:371`、`:445`、`:484`、`:556`、`:579`、`:694`）。
2. **宿主自身写盘**：角色包策略保存（`hosts/memora-vscode/src/webview/panels/settingsPanel.ts:853`）、zip 导入（`hosts/memora-vscode/src/extension/host/userAssets/zipImport.ts:715-722`、`:911`）、图片摄取（`hosts/memora-vscode/src/extension/host/imageIngest.ts:110`）——非 LLM 工具调用，不经过闸。
3. **MCP 工具按各 server 自报的 `readOnlyHint`**：定义里 `diskWrite` / `readonly` 与 server 声明同源（`hosts/memora-vscode/src/extension/host/mcp/toolRegistry.ts:290-314`）⇒ server 说只读就放行，闸无法证伪。
4. **已连接的 MCP server 进程自身运行期行为**：闸只拦「LLM 发起的那次工具调用」，不拦 server 内部行为。

### 2. 可执行验收判据

| # | 判据 | 跑法 / 观测点 | 通过标准 | 备注 |
| --- | --- | --- | --- | --- |
| V1 | 只读态下 10 个无 `readonly` 工具全部 denied | `npx vitest run src/agent/__tests__/toolRunner.test.ts`（新增用例：逐个名字喂 `strategy({toolReadonly:'readonly'})`） | 每个结果 `status === 'blocked'` 且 `text` 含 `[ERR:TOOL:READONLY_DENIED]`；前缀契约另见 `src/__tests__/toolFailurePrefixGuard.test.ts:239` | 现测试已有单工具样本（`toolRunner.test.ts:65-74`），需补齐 10 个 |
| V2 | `readonly` + override `full` 仍 denied | `npx vitest run src/role-pack/__tests__/strategyResolver.test.ts`（新增用例：`mergeStrategy`/`resolveActiveStrategy` + 断言最终 `resolveToolReadonly(...) === 'readonly'`） | 最终值 `'readonly'` | **前提：需先落地「取更严」（决策 §2）**；未落地时该判据必红，属预期 |
| V3 | 未定义工具控制 ⇒ 特权工具照常可用（回归） | 同上测试文件 + `resolveToolReadonly({})==='full'` | `'full'`，且 `toolWhitelist === null` 时 `run_code` 等特权工具出现在 `list` | 防止把默认全开关死 |
| V4 | `capabilities` 只写 `llm:summarize` ⇒ 特权全关（把陷阱钉成测试） | 新增/追加 `capabilityMap` 或 `agent` 装配测试：`resolveCapabilityTools(['llm:summarize'])` 与 `setToolWhitelist([])` 后的 `list` | 返回 `[]`；`list` 中特权工具为空、常驻集仍在 | 不靠注释提醒，靠测试钉死 |
| V5 | 变异验证 | 删掉某工具的 `readonly: true`（如 `read_file`）或删掉「取更严」那一行后重跑 V1/V3 | 对应测试**变红**；恢复后**变绿** | 新增测试必须做变异验证（仓内既有铁律） |

### 3. 排期

**待定，由发版节奏决定。** 内核候选 5.6.0（**非承诺版本号**）；宿主侧 UI 开关随宿主那一版走（现称 0.8.0，**同样待定**）。先写死版本号会绑住手。仓内 `hosts/memora-vscode/CHANGELOG.md:12` 最新条目为 **0.7.0**，**无 0.8.0 条目**（0.8.0 目前只是口头编号，未登记）。

### 4. 不在本轮做（明确划界，防后世误读为漏项）

- `noOverwriteRoots` 按 DEPRECATE-1 到 6.0.0 退役（本轮不碰）。
- 用户级资产写保护**不承诺**（代码执行面仍可绕过只读闸）。
- MCP `readOnlyHint` 不可信**不解决**（只登记为已知边界，见 §1 第 3 条）。

## 何时回顾

- 新增任何内置工具时：必须确认它是否需要 `readonly: true`，否则默认被视为写工具（`src/agent/builtinTools.ts:559` 起）。
- 修改 `mergeStrategy` / `strategyOverride` 形状时：重验「三层取最严」与 V2 变异。
- 角色包新增「权限类字段」时：重验 validator 的 error 级判据（决策 §7(2)）。
- 宿主新增写盘入口（导入/摄取/设置保存）时：重验「已知边界」清单是否需要更新。
- 若未来给 AI 增加「切换角色包」工具：项目级同名覆盖将从业余埋雷升级为**即时提权路径**，必须重新评估本 ADR。
