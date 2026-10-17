# 归档模式顺延缺口 · 工作报告核实与修复拍板

**日期**：2026-10-17
**工作流**：工作流 1（全面代码审查）+ 工作流 2（系统设计，缺口修复方案 ADR）
**参与成员**：Cody（代码审查师）/ Archi（架构师）/ Tessa（测试专家）
**核实对象**：批次三（canContinueWithoutInput 接线）+ 批次四（setArchiveMode 接线）工作报告，HEAD = `e74f3f1f`

---

## 📌 TL;DR（执行摘要）

- **报告核销结果**：原报告自述的「4 项已验证无缺口」**全部属实**；P0/P1 缺口**属实**；但 P2 台账告警的**成因描述失实**（台账确实改过 3 行，告警真因是脚本判「diff 文本含 ID」而新增行是子条目、字面不含该 ID）。
- **P0 定性被修正**：不是「文案谎报」，而是**「半成品接线」**——四处承诺文案（package.json description / settingsPanel:1630 / HTML:1868 / protocol:513-514）**都已按最终正确语义写好了**，缺的只是内核 `setArchiveMode` 那一步「暂存 + 补执行」。内核已有成熟契约（`reloadConfig`），且宿主自己已在正式依赖它。
- **严重度分布**：🔴 严重 2 项 / 🟠 高 5 项 / 🟡 中 7 项 / 🟢 低 3 项。
- **阻塞性**：🔴 两项均**不阻塞已推送代码**（门禁 16/16 全绿、已双推），但 P0-2 属**用户可见的假成功**，须在下个宿主版本发布前修完。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 整体评级 | 🟡 **有条件通过**——已落地代码质量达标（门禁全绿、数字精确对账），但存在 2 项 🔴 缺口须修 |
| 阻塞项数量 | 0（不阻塞当前已推送状态）／ 2 项须在宿主下版发布前修完 |
| 关键行动项 | 5 条（内核 A2 实施 / 宿主假成功修复 / 补测 + 变异靶标 / 台账带伤清理 / F1 单开） |
| 建议下一步 | 采纳 ADR-041 方案 A2：内核沿用 `reloadConfig` 推迟-补执行契约，宿主 0 行代码，四处文案原地变真 |

---

## 🔍 审查发现（按严重度排序）

### 🔴 严重（2）

| # | 类别 | 文件:行 | 问题描述 | 建议修复 | 来源 |
|---|------|---------|---------|---------|------|
| 1 | 契约未兑现 | `src/agent/agent.ts:1485-1492`；宿主 `package.json:157` / `settingsPanel.ts:1630` / `:1868` / `protocol.ts:513-514` | **半成品接线**：内核 `setArchiveMode` 只改内存态 `#config.archiveMode`，无暂存、无补执行；而四处承诺文案已按「对话结束后生效」写死。内核 `reloadConfig`（`:1665-1674`）同为改 `#config` 却有完整「暂存+抛错+轮终补执行」契约，且宿主 `extension.ts:492-496` 已正式依赖该契约对用户承诺 | 采纳 ADR-041 方案 A2：把 `setArchiveMode` 对齐 `reloadConfig` 契约 | Cody + Archi |
| 2 | 假成功 / 静默失败 | `hosts/.../settingsPanel.ts:1621-1624` | `const agent = await this.ensureAgent(); if (agent) {...}` —— agent 为空时 `applied` **恒 true** ⇒ 用户收到「已切换归档模式」成功提示，而**运行时什么都没做、且零报错**。`ensureAgent()` 共有 3 条 `return undefined` 路径（`:501-517`） | `applied` 初值改 false，仅在实际调用成功时置 true；补 agent 为空的降级分支 | Tessa |

### 🟠 高（5）

| # | 类别 | 文件:行 | 问题描述 | 建议修复 | 来源 |
|---|------|---------|---------|---------|------|
| 3 | 同族既有谎报 | `src/agent/agent.ts:534`（唯一调用点）vs `:680-693` | `flushPendingConfigReload` **只挂在 `chat()` finally**，第二条 turn 出口 `resumeExecution()` 的 finally 无 flush；而同段注释自称「两处 turn-end 清理统一为 clearPlanOnTurnEnd（单一收口点）」——SSOT 意图在、flush 没跟上 ⇒ **连 `reloadConfig` 自己的顺延承诺在「暂停→继续」路径上今天也是空的** | 补 `resumeExecution()` finally 挂点（**只补 chat() 一处一律打回**） | Archi + Cody 独立互证 |
| 4 | 行为退化（批次三引入） | `hosts/.../chatPanel.ts:3341-3343` / `:3619-3634`；内核 `loop.ts:446` | `postTurnUpdate` 在 `for await` **之前**采快照，此刻 `isInAutonomousStep=false`、plan 未生成 ⇒ 采到 `canContinue=false`；流内唯一重投影点是离散事件，`step_boundary` 分支**不**调 `postTurnUpdate`，内核 `isInAutonomousStep` 标注「宿主零消费」且无对应事件 ⇒ **多步轮整轮隐藏暂停按钮**（改前缺省 true 恒显） | 单开一笔：内核加 `canContinueChanged` 事件（与 `archiveModeChanged` 同型）→ 宿主订阅后重投影 | Cody |
| 5 | 台账真源自伤 | `tasks/待完成任务.md:449-450` / `:444` | L449 与 L450 **逐字节重复**（实测 `lines[448]==lines[449]→True`）；L444「在册废弃项：**零**」与 L449 内「同批新登记 `loadSessionMessages`…登册备 6.0.0 清」**直接矛盾**。门禁步骤 15 抓到「ID 未同步」软信号却漏掉台账内部重复/失实——典型的「因错误的原因告警」 | 删重复行 1 条 + 订正 L444 在册废弃项 | Cody |
| 6 | 测试为谎报背书 | `hosts/.../settingsPanelArchiveMode.test.ts:167-169` | 用例断言 `toContain('对话结束后生效')`——**只断言提示文本**，无一条断言「对话结束后真的生效」。绿的测试反而给未兑现承诺背书 | 随修复改为真实兑现断言（见补测清单 P0-1/P0-2） | Cody + Tessa |
| 6b | 🟠 测试 busy 造法锚在判据私有字段（**已由 🟡 升级为 🟠**） | `src/agent/__tests__/agent.test.ts:1786-1801` | 用例以 `internals.chatLockManager._chatBusy = true` 注入造 busy + 直查 `agent['pendingConfigReload']`；而 `chatLockManager.ts:27-28` `get isBusy() { return this._chatBusy; }` ⇒ mock 与判据实现**同生共死**。**升级理由**：一旦「assertNotBusy 家族级统一改 `_flowActive`」那条 ADR 落地，这批 mock **必然**失效（不是「可能」），且照抄写法的新用例可能「因错误的原因通过」 | 新用例必须驱动真实 `chat()`/`resumeExecution()` 持锁造 busy，禁止注入私有字段 | Tessa + Cody |

### 🟡 中（7）

| # | 类别 | 文件:行 | 问题描述 | 建议修复 | 来源 |
|---|------|---------|---------|---------|------|
| 7 | 两个真相无标记 | `settingsPanel.ts:1635`；`protocol.ts:1215` | `archive_mode_status` 回推的是**入参 mode**（不在 `if (applied)` 内），与内核实际状态零耦合；协议无 `applied`/`pending` 字段 ⇒ 繁忙失败时下拉已切新值、运行时仍旧值，UI 结构上无法标记待生效。**注**：Archi 判定不引入标记——生效回执由既有 `archiveModeChanged` 事件承担（`chatPanel.ts:1400-1407` 推 notice） | 维持偏好口径 + 依赖事件回执；或补 `applied` 字段（待裁定） | Cody 🟡 / Archi（不引入） |
| 8 | 姐妹路径静默失效 | `hosts/.../extension.ts:525-547` | 用户在 VS Code 原生设置 UI 直接改 `memora.archiveMode` ⇒ 装配期已过则运行时永不生效，**连 notice 都没有**（比繁忙路径更隐蔽，且下拉还回显持久值制造「已生效」错觉） | 补 `onDidChangeConfiguration` 的 archiveMode 分支，对齐既有 `syncDisabledSkills` 范式 | Cody |
| 9 | 因错误的原因通过（温床） | `hosts/.../chatPanel.ts:3045-3062`（`runFlow` catch） | `runFlow` 把 `postTurnUpdate` 内任何 TypeError 统一降级为一条 `error` 消息 ⇒ 抛出点若在 try 内（`:3343` 之前、`:3661`），**整条流被静默截断而测试仍绿**。实证：`chatPanelInput.test.ts` 的补桩**大概率不会转红**（断言只查 `resumeExecution` 调用次数），即该文件的补桩是**未被 red→green 实证的预防性补桩** | 补「整条流未静默中断」断言（P1-1）；CHANGELOG 措辞收紧为「已在 X/Y 个文件实测转红」 | Tessa |
| 10b | 结构性守卫缺失 | `hosts/.../chatPanel.ts:2676`（严格）vs `:2687`、`:3967`（宽松 `?.()`） | 同一 `postTurnUpdate` 内并存两套互相矛盾的约定：严格（`isPausePending`/`canContinueWithoutInput`）与宽松（`getPendingInterjections?.()`，注释还明写「测试桩可能缺该方法——缺则跳过」）。**无任何守卫钉住「哪些 agent 方法是宿主强制依赖」** | 新增 agent 强制依赖面守卫（P1-2） | Tessa |
| 11 | 守卫覆盖率不足 | `tokensClosure.test.ts` + `scripts/count-token-refs.mjs` | 实测 `styles/` 共 **1770** 处 `var()` 引用，守卫只盯 **257** 处 → **覆盖率 14.5%**；最大族 `sp-`（548 处，31%）**零守卫**；批次四新增 5 处引用只有 1 处（`--line-solid`）进了门。另有「族内互换失明」（`--sp-2`→`--sp-5` 计数不变）等 6 条绕过路径 | 登记技术债：家谱化 + 单真源 + 补六大未登记族 | Tessa |
| 12 | 台账告警误报 | `scripts/verify-ledger-receipt.mjs:22-23` | 告警为真但**成因与原报告描述不符**：`e4c5cb40` 确实改了台账（`3 +++`）；真因是脚本判「区间内 diff 文本含该 ID」，而新增的三行是 DEPRECATE-1 的**子条目**、字面不含 `DEPRECATE-1`，ID 行（L442）未改也不在 diff 上下文内 | 台账补注记（保持观察态 + 记录本批关联）或 amend 去掉 ID 引用 | Cody（修正原报告） |
| 13 | 同实双源 | `src/agent/agent.ts:431`（惰性 getter）vs `:479`（静态快照）+ `seed/orchestrator.ts:263` | `ArchiveCoordinator` 拿惰性 getter（热更新真实生效），`SeedOrchestrator` 拿静态快照且 `createPostInitComponents` 只在 `init()` 调一次 ⇒ **切换后 trace span 永久错报归档模式**。不影响用户可感功能，但属同一事实两个真源 | 改为惰性 getter 与 coordinator 对齐（约 5 行 + harness 一处） | Archi |

### 🟢 低（3）

| # | 类别 | 文件:行 | 问题描述 | 建议修复 | 来源 |
|---|------|---------|---------|---------|------|
| 14 | 冗余可选链 | `hosts/.../chatPanel.ts:2687` | `this._agent?.getPendingInterjections?.() ?? []` —— 该方法在 `agent.d.ts:261` 是**必需成员**，`?.()` 属冗余掩护，与「宿主侧禁加 `?.()` 掩护」纪律不一致。**注**：报告重点关注的 `:2676` 的 `?.` **合规**（只短路 `_agent==null`，不掩盖方法缺失——实证：28 例红正是「agent 非空、方法缺失 ⇒ 照抛」） | 去掉 `?.()` | Cody |
| 15 | 缺省分散（观察） | chatView:2507/2514/5330 + turnUiState:155 + chatPanel:2676 | 缺省 `true` 分散在 5 处。契约单点在 `protocol.ts:1355`，五处为同一缺省的不同落点；现有测试各自守住，暂无实际风险，仅提示后续改缺省值需五处同改 | 不改，记账 | Cody |
| 16 | 拒收不复位 UI | `hosts/.../settingsPanel.ts:1610-1613` | 非法值被拒后**不回推** status；webview 侧有发送守卫 ⇒ 只能来自 DOM 篡改，可达性极低。但「拒了却不复位 UI」与「按钮只宣告真实能力」纪律同族 | 顺手在拒收分支补一次 `loadArchiveModeStatus()`（1 行） | Cody |

---

## 🏗️ 架构决策（ADR-041 摘要，Archi 出品）

### 决策：方案 A2（内核沿用 `reloadConfig` 推迟/补执行契约）

**被否决的 A1（宿主侧补偿）**：内核事件面无任何「轮已收场/已空闲」事件（`roundSummaryGenerated` 是后台异步产物、`sessionArchived`/`configReloaded` 是各自业务产物）。宿主只剩两条路，都是 SSOT 反面——轮询 `agent.isBusy`（复制判据）或新增「turnSettled」事件（同一事实两个出口，必然漂移）。且挂 `chatPanel` 的 `done` chunk 不可行：那是渲染面而非状态权威，且存在多条 turn 路径，漏一条即原样复刻本缺口。

**被否决的 B（改文案降级）**：① 会与兄弟设置打架——同一宿主里 `memora.disabledSkills` 即时生效、`reloadSkills` 自动顺延、`searchEngine` 才需重载窗口，把 archiveMode 降到最低档没有技术理由；② 成本反而更高（改 3 处文案 + 1 处分支 + 3 处注释）；③ **用写文档迁就实现的缺口，正是「不带伤」明令禁止的方向**。

### 判据与单点（SSOT 核心）

| 问题 | 结论 |
|------|------|
| 「对话结束/非 busy」判据真源 | `chatLockManager.isBusy`——同源实证：`assertNotBusy`(`:1765`)、`reloadConfig` 守门(`:1667`)、宿主 `agent.isBusy`(`:2018-2020`) 三处读它，`extension.ts:471-472` 明写「判据同源」 |
| 补偿为何不重判 | 补偿点 `flushPendingConfigReload`(`:534`) 在 `chat()` finally 中位于**强制 `release()` 的下游** ⇒ 到达该点 `isBusy===false` 是**结构事实**，无需再判。零新增判据/事件/消息/公开 API |
| 为何不用 `_flowActive` | 区分两个问题：「有没有流消费者」（`requestPause` 空闲守卫 → 用 `_flowActive`）vs「有没有正在进行的轮」（`assertNotBusy` 全家族 → 用 `isBusy`）。`setArchiveMode` 属后者；若改锚会与 `setProvider`/`switchProject`/`rebuildComponents` 制造新不对称 |
| 暂存 vs 运行时比对 | 完全在内核内部闭环，且 `setArchiveMode` 自身幂等（`:1488` `if (prev===mode) return;`）⇒ 补执行点直接再调一次，同值天然 no-op（连事件都不触发，无幽灵提示）。**零新增协议消息** |
| 补偿挂点形态 | 沿用内核既定范式：补执行逻辑只有一份方法，挂在 `chat()`(`:534`) 与 `resumeExecution()`(`:680-693`) 两个既有 finally 上——与 `clearPlanOnTurnEnd` 的双挂点形态一致（注释明写「单一收口点」） |

### 边界与失效模式

- **补偿失败（补执行点仍 busy，可达）**：长任务 >180s ⇒ 锁超时自动释放但流仍在跑 ⇒ 新轮已获锁 ⇒ 老 frame 的 `release(myToken)` 因 token 不匹配 no-op ⇒ 到达补执行点仍 busy。**策略：仅在成功后清槽，失败保留 + `logger.warn` 顺延到下一个安全点**（现有 `flushPendingConfigReload` 是「先 clear 再尝试」，失败即永久丢失，属同族谎报，建议一并改）。
- **🔴 时序缺陷（R1 新发现，必带修复）**：守卫用 `isBusy` + 补执行滞后联手的产物——t=10s 用户切 manual ⇒ busy ⇒ `stash='manual'` 并抛错；t=200s 锁 180s 超时自动释放（`chatLockManager.ts:47-61`，不中断流）⇒ `isBusy=false`；用户再切回 full ⇒ 守卫放行、`#config` 立即变 `'full'`，但 **stash 里仍躺着旧的 `'manual'`**；轮终 flush 应用 `'manual'` ⇒ **静默覆盖用户最后一次选择**，并产生「先提示已切 full、轮终又冒一条 manual」的双提示。
  ⇒ 处置：`setArchiveMode` 在**非 busy 成功路径上无条件清槽**（不只是「同值时清槽」），1 行，使「任何一次即时应用都令暂存作废」，末次为准语义得以成立。
- **驳回「补应用时机改锚 `_flowActive`」**（Archi R1）：落点 `flush`(`agent.ts:534`) 位于 `_flowActive=false`(`agent.ts:527`) **之后** ⇒ 该落点上两条判据**同时为 false**，改锚不产生任何行为差异（no-op）；且 `_flowActive` 是 private（`agent.ts:178`），全 `src/` 无任何 public 出口 ⇒ 宿主侧根本锚不了。
  ⇒ 判据真源仍为 `ChatLockManager.isBusy`。科迪发现的「180s 舱门虚掩」是**守卫**缺陷（约束「何时暂存」），不约束「何时补应用」，两者不可混淆。
- **中途多次改偏好**：单槽覆盖、末次为准，无需队列（与 VS Code 设置「后写覆盖」语义一致）；改回原值时走幂等 return，不发事件不弹提示。
- **Agent 被 close/重建/重载窗口**：`close()` 已清 `pendingConfigReload`(`:1933`)，新增槽同处清理；**兜底安全网天然存在**——偏好已即时落盘（Global），装配期必然重读注入 ⇒ 用户偏好永不丢失。
- **两个真相收敛**：不引入「待生效」标记。生效回执 = 既有的 `archiveModeChanged` 事件 → `chatPanel.ts:1400-1407` → notice。且 `loop.ts:1344-1345` 表明暂停时流即终止、`chat()` finally 执行 ⇒ **顺延只发生在流式产出期间**，窗口比预想更短。

### 不带伤自检

- 无新增零消费出口（改动全在既有方法内，不新增 public 成员）。
- **两处必须同步改否则制造新谎报**：① `setArchiveMode` JSDoc 现写「对话进行中**禁止切换**」(`:1483`)，加暂存后失真，须改写；② `flushPendingConfigReload` 兼管归档后方法名失真，须更名（建议 `flushPendingAtTurnEnd`，现无测试按名引用 ⇒ 改名安全）。
- ⚠ **最大测试风险**：`agent.test.ts:1782-1853` 既有用例直接查私有字段（`agent['pendingConfigReload'].has(...)`）。若新用例照抄或直调私有 flush，**即使把 finally 挂点整行删掉测试仍全绿**。

### 改动面清单

| # | 文件 | 改动 | 规模 |
|---|------|------|------|
| 1 | `src/agent/agent.ts` | 新增 `pendingArchiveMode: ArchiveMode \| null` 槽位（紧邻 `:183`） | ~4 行 |
| 2 | `src/agent/agent.ts:1482-1492` | `setArchiveMode` busy 分支改**暂存 + 抛错**（与 `reloadConfig` 逐字一致：抛错是「已排期」的传输方式，**不是**「暂存而不抛错」）；**非 busy 成功路径无条件清槽**（R1 新增，消除时序覆盖缺陷）；**同步改写 JSDoc**（去掉「对话进行中禁止切换」失真表述，显式注明 180s 锁超时语义）<br>⚠ **清槽落点硬约束**：必须写在 `assertNotBusy` **之后、幂等 `if (prev === mode) return;`（`:1488`）之前**。若写在变更分支之后，用户「改回当前值」会走幂等出口直接 return，stale 暂存照样在轮终覆盖（这是时序缺陷最易复现的路径）。**review 判据：清槽写在幂等 return 之后即判漏** | ~13 行 |
| 3 | `src/agent/agent.ts:567-582` | flush 更名 `flushPendingAtTurnEnd`，前置归档补执行（**成功才清槽，失败保留 + warn**） | ~15 行 |
| 4 | `src/agent/agent.ts:680-693` | `resumeExecution()` finally **补挂 flush**（必需） | ~1-2 行 |
| 5 | `src/agent/agent.ts:1933` | `close()` 增加 `pendingArchiveMode = null` | ~1 行 |
| 6 | `src/agent/__tests__/agent.test.ts` | 3 组用例 + 4 个变异靶标（见下） | ~60-80 行 |
| 7 | 宿主 | **0 行**（三处文案原地为真） | 0 |
| 8 | （可选 P2·必1）`agent.ts:479` + `seed/types.ts:74` + `seed/orchestrator.ts:263` + harness | seed 依赖改惰性 getter，消双源 | ~8 行 |

---

## 🧪 测试覆盖评估（Tessa 出品）

### 盲区 1：批次四 6 例为何没暴露「偏好永不应用」

根因：**6 例断言全部落在「偏好层 + 消息层」，无一条碰到「运行时真相层」**。四个致命点：

| 致命点 | 证据 |
|--------|------|
| A. 回显与状态零耦合 | `settingsPanel.ts:1635-1642`：`this.post({type:'archive_mode_status', mode})` **不在 `if (applied)` 内**，`mode` 是入参 ⇒ 「忙不忙、真没真切换」断言输出完全一致，永远不可能发现缺口 |
| B. 替身无运行时读口 | `settingsPanelArchiveMode.test.ts:50-61` 的 `agentStub()` 只有 `setArchiveMode/on/off`，**没有 `getArchiveMode()`**（内核有：`agent.ts:1497-1499`）⇒ 物理上无法断言运行时真相；全仓宿主侧 `getArchiveMode()` 消费为 **0** |
| C. 繁忙场景是手写 Error | `:152-154` 手抄文案的普通 Error，未用内核真实 `chatBusyError` 契约 ⇒ 内核若改成不抛错，6 例仍 100% 绿而文案变成赤裸谎言 |
| D. 全是单拍 | 无「① 繁忙拒切 → ② 对话转空闲 → ③ 再观察」的第二段，而缺口正活在这条时间线上 |

### 盲区 2：补桩是否真会红（`?.` 语义实证）

`node -e` 实测：`agent undefined → true`（`?.` 短路）；`has method → false`；**`lacks method → THROW TypeError`** ⇒ 「替身缺方法即抛错」在 JS 层面成立。

但**「会抛」≠「会红」**，抛出后被吞的位置决定真假：

| 测试文件 | `turn_update` 断言数 | 缺桩时是否红 | 判定 |
|---------|-------------|-------------|------|
| `chatPanelPauseProjection` | 2 | **必红** ✅ | 经 `onSessionResumed`(1295) 同步穿透到 2676 |
| `chatPanelHistory` | 15 | 大概率红 ✅ | 大量用例依赖末条 turn_update / replay / pendingQueue 帧 |
| `chatPanelInterject` | 9 | 大概率红 ✅ | FIFO 时序比较（`:141/157/178`），缺失即 -1 |
| `chatPanelSummaryFailure` | 0 | 红，但**因错误的原因** ⚠ | 守的是「摘要 Handler 注册」（抛出点 3343 在注册点 3802 之前）而非暂停判据 |
| `chatPanelInput` | 0 | **大概率仍绿** ❌ | `runFlow` catch(3057) 吞掉并截断整条流；断言只查 `resumeExecution` 调用次数 ⇒ **该文件的补桩没有守卫价值** |

⇒ 报告/CHANGELOG 中「替身缺方法即抛错 ⇒ 4 个文件都要补桩」的表述**至少有 1 个文件未获 red→green 实证**，措辞应收紧。

### 盲区 3：tokensClosure 守卫可靠性

批次四的 `line-` 70→71 **是对的**（实测与脚本双证一致）。但守卫覆盖率仅 **14.5%**（1770 处 `var()` 只盯 257 处），批次四新增 5 处引用只有 1 处进门；另有「族内互换失明」等 6 条绕过路径。

### 补测清单

| 优先级 | 用例 | 断言要点 |
|--------|------|---------|
| **P0-1** | 繁忙拒切 → 空闲后偏好须自动补应用 | 替身加 `getArchiveMode` 真值口 + busy 开关两拍驱动：第 1 拍后仍是 `'full'`；**第 2 拍后必须 `'manual'`（现状必红）** |
| **P0-2** | 繁忙拒切不得谎报 | notice 须含「偏好已保存」且 **`not.toContain('已切换')`** |
| **P0-3** | `archive_mode_status` 语义钉死 | 由 ADR 裁定后二选一（偏好口径须带未生效标记 / 运行时口径则 busy 时推 'full'） |
| **P0-4** | `ensureAgent()` 返回 undefined 不得谎报 | 不得出现「已切换归档模式」notice |
| P1-1 | 流驱动用例须断言「整条流无静默中断」 | `expect(posted.some(m=>m.type==='error')).toBe(false)` + 有 turn_update |
| P1-2 | agent 强制依赖面守卫 | 严格清单 `{sessionManager.status, isPausePending, canContinueWithoutInput}`；宽松 `{getPendingInterjections}`；错位即红 |
| P1-3 | 繁忙用例须对接内核真实错误契约 | 用 `chatBusyError` 形状，非 busy 的 Error 不得套用顺延文案 |
| P1-4 | `archiveModeChanged` 事件链路（当前覆盖 0） | 成功 → chatPanel 推 notice；繁忙 → 不 emit |
| P2-1 | 下拉封闭枚举被篡改 → 不发送 | 注入 `<option value="evil">` 后断言不发送 |
| P2-2 | 计数守卫家谱化 + 单真源 | test import script 的 FAMILIES；补六大未登记族 |

### 变异靶标（四个，缺一不可）

① 删 busy 分支的暂存行 → 红；② 删 `chat()` finally 挂点 → 红；③ **删 `resumeExecution()` finally 挂点 → 必须红**（最易漏测）；④ 改 flush 时机语义 → 红。
**硬性要求**：用例必须**驱动一次真实 `chat()`/`resumeExecution()` turn**，不得注入私有字段、不得直调私有 flush。

---

## ✅ 行动清单（按优先级排序）

| # | 行动 | 负责角色 | 紧急度 | 预期完成 |
|---|------|---------|--------|---------|
| 1 | 实施 ADR-041 方案 A2：内核 `setArchiveMode` 对齐 `reloadConfig` 契约（含 resumeExecution 挂点、flush 改造+更名、close 清槽、JSDoc 改写）+ 4 个变异靶标 | Archi（架构师） | P0 | 本批 |
| 2 | 修复 `settingsPanel.ts:1621-1624` 假成功（agent 为空时 applied 恒 true）+ 顺办 F9 拒收回推 | Cody（代码审查师） | P0 | 本批 |
| 3 | 补测 P0-1/P0-2/P0-4 + 替身加 `getArchiveMode` 真值口；P1-3 对接内核真实错误契约 | Tessa（测试专家） | P0 | 本批 |
| 4 | 清理台账真源自伤（`tasks/待完成任务.md` 删 L449/450 重复行 + 订正 L444 在册废弃项）+ DEPRECATE-1 注记 | 主理人 / Docu | P1 | 本批 |
| 5 | F1（canContinue 流内无刷新通道）单开一笔：内核加 **无值** `canContinueChanged` 事件（仅「变了，请重拉」的 ping，值仍由宿主 `canContinueWithoutInput()` 拉取）→ 宿主订阅后重投影。**已证伪的修法**：复用 `step_boundary` 重投影无效（`inAutonomousStep` 在 `loop.ts:2400` 工具跑完即复位，而 `step_boundary` 在 `loop.ts:1532` 迭代结束才产出 ⇒ 到达时已是 false） | 待拍板 | P1 | 下一批（紧随，不 parked） |
| 6 | F4（设置 UI 改值静默失效）补 `onDidChangeConfiguration` archiveMode 分支，对齐 `syncDisabledSkills` | 待拍板 | P1 | 下一批 |
| 7 | 登记技术债：tokensClosure 覆盖率 14.5% 家谱化 + 单真源 | 待拍板 | P2 | 观察 |
| 8 | F3（180s 锁超时致 assertNotBusy 舱门虚掩）另立 ADR | 待拍板 | P2 | 观察 |

---

## ⚠️ 待完善 / 已知局限

- 泰莎对「chatPanelHistory / chatPanelInterject / chatPanelSummaryFailure 缺桩会红」为**静态推导**，受「不得修改文件」约束未做 mutation 实证；三处需实施者用「删桩行 → 跑该文件 → 还原」三分钟配方复核。
- F1（canContinue 刷新通道）由 Cody 发现、Archi 未在 ADR 中明确处置，本轮拍板为**单开一笔**，其方案（内核新增事件 vs 宿主 step_boundary 重投影）需另立 ADR 论证。
- 第 7 项「两个真相是否加 `applied` 字段」存在成员分歧（Cody 判 🟡 建议加；Archi 判定不加、依赖既有事件回执），本轮按 Archi 意见（不加），理由为「不新增协议字段 + 回执已由既有事件承担」。
- **「assertNotBusy 家族级统一改 `_flowActive`」这条单开 ADR 漏一个落点**（Cody 复核发现）：`reloadConfig` **不走** `assertNotBusy`，它有**内联判据** `agent.ts:1667 if (this.internals.chatLockManager?.isBusy)`。只改家族 ⇒ t∈[180s, 流结束] 窗口内出现「setArchiveMode 被拦/暂存、reloadConfig 即时应用」的两个闸门，SSOT 违例只是换了位置 ⇒ 该 ADR 须同时收编此处，建议抽内核私有 `isTurnActive()` 供两处共用。
- **F1 修复的门禁成本已确认**（Cody）：新增内核事件会触发 `publicMemberSurfaceGuard.test.ts:543-545` 冻结的 `AgentEventMap` 成员面 **必红**，须按 §3.2.1 定性后显式更新 EXPECTED；且 `src/utils/eventEmitter.ts:36`（名称映射）与 `:113`（payload 类型映射）**两处**都要登记，否则编译不过。反之 **A2 本身不触发公开面守卫红**——`setArchiveMode`(`:242`) 与 `getArchiveMode`(`:219`) 已在 EXPECTED 基线内。
- 本报告未覆盖真机验收（宿主 UI 下拉的实际视觉/交互），按项目惯例需单独一轮真机测试。

---

## 📚 数据来源 & 成员产出索引

- **Cody（代码审查师）**：7 项主张逐条核实（A 组 4 项全属实 / B1🔴 属实且定性修正为「半成品接线」/ B2🟡 属实 / B3 结论属实但成因失实）；独立发现 F1（canContinue 无刷新通道）、F2（台账重复+失实）、F3（assertNotBusy 180s）、F4（设置 UI 静默失效）、F5（测试固化文案）、F6（getArchiveMode 零消费）、F7（`?.()` 冗余）、F8/F9；新增 G1（resumeExecution 漏挂）、G2（测试 busy 造法锚私有字段）。
- **Archi（架构师）**：ADR-041 全文（方案 A2 拍板、判据单点分析、边界与失效模式、不带伤自检、8 项改动面清单）；附带发现 seed 静态快照双源（第 13 项）。
- **Tessa（测试专家）**：基线取证（88 + 475 passed 串行）；盲区 1（6 例四大致命点 + 最小必红用例）、盲区 2（`node -e` 实证 `?.` 语义 + 逐文件红/绿判定 + runFlow 吞异常温床）、盲区 3（守卫覆盖率实测 14.5% + 6 条绕过路径）；P0×4 / P1×4 / P2×2 补测清单 + 4 个变异靶标；**独立发现第 2 项 P0（ensureAgent 假成功）**。

---

> 本报告由工程保障团队 AI 协作生成，关键决策请由人类工程负责人复核。
