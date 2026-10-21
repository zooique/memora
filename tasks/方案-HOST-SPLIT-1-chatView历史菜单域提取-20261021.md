# 方案-HOST-SPLIT-1-chatView历史菜单域提取-20261021

> 性质：HOST-SPLIT-1 P2 序列 chatView 第 2 刀（域外置范式第 2 刀，沿用计划栏刀范式）。
> 判据：收敛三件套（域边界可枚举 / 有测试兜底 / 搬出降 ≥40 行）缺一即停。
> 红线：export 面零删改 · 不补掩护 · 不把红说成假红 · 不借拆分顺便优化 · 拆文件≠拆通道 · 常量 SSOT · 运行时常量不进协议大文件。

## 一、现状分析

### 1.1 全局点击处理跨域判定（本刀前置梳理，用户指定先行）

**chatView 内共 3 处 `document.addEventListener('click', …)`**：

| 位置 | 归属域 | 判定逻辑 | 与历史菜单关系 |
|---|---|---|---|
| L6737（匿名） | 计划栏（上一刀已外置） | `isExpanded() && !containsTarget(e.target)` → `collapse()` | 无 |
| L6752（具名 `onDocumentClick`） | 示例 chips（输入域） | `closest('.suggestion-chip')` → 回填输入框 | 无 |
| L6768（匿名） | 过程流（折叠意图闩） | `closest('summary')` → `details.dataset.userToggled='true'` | 无 |

**🔴 订正上一轮预判（措辞折叠自查）**：上一刀方案 §1.5 写「历史菜单域：与全局点击处理跨域耦合」——经本轮逐行核对，**该断言过虑**。三处 document click 监听**没有一个处理历史菜单**；历史菜单的开合 / 外部点击收起 / Escape / 条目点击委托**全部由 `initDropdowns`（`components/dropdown.js`，treedd 组件）管理**，历史域在 document 级**零监听**。真实情况是「历史域与全局点击无耦合」，非「有耦合需先拆解」。

**历史菜单的真实跨域面（3 处，全是调用面，非时序面）**：

| # | 位置 | 内容 | 处置 |
|---|---|---|---|
| 1 | `handleMessage` L5939-5946 | `session_list_data` → `renderHistoryMenu`；`chat_archive_mode` → 写 `currentArchiveMode` + 读 `lastSessionList.length` 决定是否重渲染 | 改调窄接口；「有数据才重渲染」判断**收进域内**（吸收跨域读） |
| 2 | `updateSessionControlsLock` L3104-3105 | 锁域直写 `newSessionBtn.disabled` / `historyBtn.disabled` | **零改动**（锁域持 view 引用写 disabled，域外置不影响；不经容器转手 = 不造第二写入面） |
| 3 | `historyBtn` click L6719-6727 | 打开浮层时重置视图 + 清词 + 请求列表 | 监听**留 view 原位置**，内部改调 `openFresh()` |

**唯一时序敏感点**：`historyBtn` 同元素双监听器（chatView 的刷新 L6719 + treedd 的开合，initDropdowns L6777 注册）。DOM 同元素监听按注册顺序同步执行。处置 = `historyBtn` 监听**留 view 原位置不搬** → 顺序零变化（此为本刀监听器归属判据的由来，见 §2.3）。

### 1.2 域边界枚举表（判据①）

| 类别 | 内容 | 现位置 |
|---|---|---|
| 状态（5） | `sessionListView` / `sessionSearchQuery` / `lastSessionList` / `lastArchivedIds` / `currentArchiveMode`（归档模式运行时真值，仅 keepBtn title 消费，单写单读属本域） | L6513-6533 |
| 函数（6） | `fmtRelativeTime`（仅 renderHistoryItem 两处调用，随迁；台账 L963 已登记「与 helpers 版语义不同勿合并」）/ `renderHistoryMenu` / `setSessionListView` / `matchesSessionSearch` / `renderHistoryView` / `renderHistoryItem` | L6498-6701 |
| DOM（5，随域入 deps） | `historyMenu` / `historyTabRecent` / `historyTabArchived` / `historyArchivedCount` / `historySearch` | L136-142 |
| 监听随域搬 | `historyTabRecent/Archived` click ×2、`historySearch` input ×1 | L6706-6713 |
| **留 view** | `historyBtn` click（调 `openFresh`，时序敏感）；`renameSessionBtn` / `newSessionBtn` click（标题条按钮属会话导航域，非历史菜单，原样不动） | L6715-6727 |
| 外部依赖 | `vscode.postMessage`（`session_list` / `restore_session` / `archive_session` / `delete_session` 四型）→ 注入窄函数；`getIconSvg`（icons，直接 import） | — |
| 类型 | `SessionSummaryDto` 本地接口（形状契约 = protocol `session_list_data.sessions`，指针注释）；`ArchiveMode` 从 `@zooique/memora` import（同 chatView L28 纯类型导入，esbuild 剥离） | — |

### 1.3 为何选历史菜单域（判据②③核验）

- **测试兜底最全**：`chatView.test.ts` 历史用例 10+（L3700-3877 连续区），断言全走 `dispatch({type:'session_list_data'…})` 真实消息路径 + `#historyMenu` DOM 查询，**零私有符号**（上一刀方法论：穿透风险先 grep，此处实证无）。
- **行数**：迁出约 216 行（L6498-6713）+ handleMessage 净减 3，接线约 +12 ⇒ view 净降约 **200 行** ≫ 判据③（≥40）。
- **反依赖最少**：跨域面仅 §1.1 的 3 处调用面；对比技能/引用域（与 `append`/`sendMessage` 强耦合，约 430 行）与指标域（与 `metrics` 分支耦合），本域自足性最好。

## 二、目标模块设计

### 2.1 新模块 `webview/scripts/historyMenuView.ts`

```typescript
/** 会话条目形状契约 = protocol session_list_data.sessions（结构化兼容，协议演进时同步） */
export interface SessionSummaryDto { sessionId: string; title: string; updatedAt: string;
  keyTopics?: string[]; summary?: string; messageCount?: number }

export interface HistoryMenuViewDeps {
  document: Document;
  menuEl: HTMLElement;            // #historyMenu 条目容器
  tabRecent: HTMLButtonElement;   // #historyTabRecent
  tabArchived: HTMLButtonElement; // #historyTabArchived
  archivedCountEl: HTMLElement;   // #historyArchivedCount
  searchInput: HTMLInputElement;  // #historySearch
  postMessage: (msg: { type: 'session_list' | 'restore_session' | 'archive_session' | 'delete_session'; sessionId?: string }) => void;
}

export interface HistoryMenuView {
  renderMenu(sessions: SessionSummaryDto[], archivedIds: string[]): void; // 数据入口
  setArchiveMode(mode: ArchiveMode): void; // 内含「有数据才重渲染」判断（吸收原 L5946 跨域读）
  openFresh(): void;  // historyBtn 打开时调：回默认分组 + 清词 + 请求列表（「重新开始浏览」语义）
}

export function createHistoryMenuView(deps: HistoryMenuViewDeps): HistoryMenuView
```

设计要点：

1. **状态封装不外泄**：5 个状态全进工厂闭包，view 侧零持有；
2. **函数名零改名**（承前刀惯例），内部 6 函数原样平移；
3. **`openFresh` 吸收 historyBtn click 体的三步动作**（`setSessionListView('recent')` + 清 `sessionSearchQuery` + 清 `historySearch.value` + 请求列表）——这是本刀唯一的新聚合面，动作顺序与原监听体逐行一致；
4. **不注入 `log`**：原域无失败日志调用点；
5. **`setArchiveMode` 的「无数据不重建」判断收进域内**：原 `handleMessage` L5946 `if (lastSessionList.length > 0) renderHistoryMenu(...)` 依赖跨域读 `lastSessionList`，域外置后该读不可达 ⇒ 判断随状态迁入（注释随迁），`handleMessage` 分支退化为单行调用。

### 2.2 监听器归属判据（本刀新立，供后续域沿用）

> **判据：监听器挂的元素归谁所有，监听器就归谁。**

- tab ×2 / search 元素**专属历史域**（无其他域消费）→ 监听随域搬进容器（元素级监听，无 document 级时序敏感）；
- `historyBtn` 归 view（treedd trigger + 锁域写 disabled，两个消费者都在 view）→ 监听留 view 原位置；
- `renameSessionBtn` / `newSessionBtn` 属会话导航域（虽注册在历史代码区）→ 本刀不碰；
- **document 级监听一律不搬**（三处现存的归属各自的域，历史域零 document 监听，无需处理）。

与上一刀「监听器一律留 view」的差异说明：计划栏刀保守是因为其浮层交互挂 document 级监听；本刀历史域监听全挂专属元素、且元素本身随域移交，留 view 反而制造「元素在容器、监听在 view」的劈叉。判据从「一律留」精化为「随元素所有权」。

### 2.3 注释处置（并入本刀，三分法）

| 位置 | 处置 | 依据 |
|---|---|---|
| `renderHistoryMenu` 头 JSDoc（L6535-6551，17 行：treedd 协作 / 分组形态 / 视图重置时机） | **随迁容器**（这是本域最核心的设计论证，一条不删） | §2-C 必留 |
| `renderHistoryView` 的日期分组 JSDoc（L6585-6594） | **随迁**（sessionId 前缀 = 日期真源、组头非 item 的键盘导航理由） | §2-C |
| `renderHistoryItem` 的 span-not-button / 归档模式文案理由 | **随迁**（真伤教训） | §2-C |
| `fmtRelativeTime` 头注「重复 3 次再提取 helper」 | **随迁**（规则豁免的已知态登记，台账 L963 在册） | §2-C |
| 状态行注释（L6512-6526） | **随迁**（字段级，每条都是为什么） | 用户规则 3.4.1 |
| L6717-6721 historyBtn 注释 | **拆两半**：「treedd 管交互 / 本层管数据」的协作论证随 `openFresh` 进容器；「视图重置挂打开时机不挂数据下发」一句留 view（指向容器内 renderHistoryMenu 注释） | §2-B |

编号锚（FD-3-A / ADR-024 等）一律保留。

## 三、改动文件清单

| 文件 | 动作 |
|---|---|
| `src/webview/scripts/historyMenuView.ts` | **新建**（约 280 行） |
| `src/webview/scripts/chatView.ts` | 迁出 L6498-6713；handleMessage 两分支改窄接口；historyBtn click 体改 `openFresh()`；DOM 引用区 5 个引用改传 deps（`renameSessionBtn`/`newSessionBtn`/`historyBtn` 引用保留） |
| `eslint.config.mjs`（宿主） | chatView 闸门 `max: 7585` → 实测自报值（只降不升） |
| `tasks/待完成任务.md` | 状态行 / 体量表 / 闸门清单 / 收据子项 |
| 本方案文档 | §七 实施完成回填 |

**零改动**：`shared/protocol.ts`、全部测试文件（穿透实证无私有符号）、`components/dropdown.js`（treedd 开合监听不动）。

## 四、不提取的归档（防重复论证）

1. **`renameSessionBtn` / `newSessionBtn`**：标题条按钮，触发 `rename_request` / `new_session`，属会话导航域（与锁域共变），不属历史菜单。注册在历史代码区只是物理相邻。
2. **`updateSessionControlsLock` 的两行 disabled 写**：锁域消费面，经容器转手 = 给锁域造第二写入路径，零收益。
3. **`__historyOnSelect` 回调（L6780）**：initDropdowns 的参数，动作 = 纯 postMessage，不读历史域状态，留 view 原位。
4. **`fmtRelativeTime` 并入 helpers**：台账 L963 已判「语义不同勿合并」+「重复 3 次再提取」豁免在册，本刀不推翻。
5. **treedd 组件（`components/dropdown.js`）**：通用下拉组件，多域共用（模型选择器 / 历史 / Skill），非本域私有。

## 五、后续演进路径（只登记，不承诺）

| 序 | 域 | 行数 | 前置 |
|---|---|---|---|
| 第 3 刀候选 | 指标 / 上下文占用域 | ~300 | 与 `metrics` 消息分支耦合 |
| 第 4 刀候选 | 技能 / 引用域 | ~430 | 与 `append`/`sendMessage` 强耦合，或需先拆 |

每刀仍按三件套判定。

## 六、验证计划

### 6.1 前置基线

- 目标测试基线：本轮已跑 `chatView.test.ts` 457 passed（计划栏刀收据）；
- 闸门自报：max 临时置 1 跑 lint 取「File has N lines」。

### 6.2 新增测试

**预期为零**（断言全走真实消息路径与 DOM 查询，实证零私有符号）。

### 6.3 变异验证

| 编号 | 变异 | 预期 |
|---|---|---|
| M1 | `matchesSessionSearch` 恒 `return true` | 红（搜索过滤用例） |
| M2 | `renderHistoryView` 的 `inGroup` 判断去掉 archived 分支 | 红（留存区分组用例） |
| M3 | `setArchiveMode` 去掉「有数据才重渲染」守卫 | 待验证（空菜单重建是否有用例） |
| M4 | `openFresh` 去掉清搜索词 | 红（historyBtn 重置用例，若有） |
| M5 | `renderHistoryItem` 的 keepBtn `stopPropagation` 删除 | 待验证（委托打断是否被测） |

0 红 = 待验证假设，如实登记不预补。

### 6.4 契约不变式（拆完必须仍成立）

1. 分组切换是**前端过滤**（不回 host 请求）⇒ 两分组无归属漂移；
2. 视图重置只挂「打开浮层」，**不挂数据下发**（否则留存区里点「移回」被踢出分组）；
3. 数据下发（含归档/移回刷新）只按**当前视图**渲染；
4. 搜索无匹配 ≠ 分组为空（两种空态文案必须区分）；
5. 组头是**非 `.treedd__item`** 纯展示（键盘导航不跳组头）；
6. `chat_archive_mode` 后到 → **就地重渲染**按钮文案（仅当已有数据；无数据不重建空菜单）；
7. keepBtn / delBtn 用 **span**（button 内不可嵌套 button）；
8. `historyBtn` 上「先刷新数据、后开合浮层」的监听顺序**零变化**。

## 七、实施完成（2026-10-21 回填）

**域外置落地**：`webview/scripts/historyMenuView.ts` 新建（约 300 行），5 函数零改名平移 + 5 状态封装闭包；tab×2 click + searchInput input 监听随域注册；窄接口 3 面（`renderMenu` / `setArchiveMode` / `openFresh`）。`chatView.ts` **7585 → 7378（净降 207，闸门自报口径）**；`historyBtn` click 留 view 原位置、体改调 `openFresh()`；`handleMessage` 两分支（`session_list_data` / `chat_archive_mode`）改走窄接口；`ArchiveMode` 从 chatView 类型导入移除（注释登记迁移去向）；孤儿指针清算 1 处（`matchesSkillSearch` 注释改概念指针）。

**验证数据**：`tsc --noEmit` 双配置 EXIT=0；`npx eslint .` EXIT=0；目标测试 **457 passed（与基线一致，测试零改动）**；宿主全量 **84 文件 / 1467 passed / 2 skipped / EXIT=0**。闸门 `max-lines` 按「只降不升」定稿 **7378**（取数口径 = 闸门自报）。

**变异实测**（§6.3 预期 → 实测）：

| 编号 | 变异 | 预期 | 实测 |
|---|---|---|---|
| M1 | `matchesSessionSearch` 恒 `true` | 红 | **5 红**（搜索过滤 3 例 + 空态回显 2 例） |
| M2 | `inGroup` 去 archived 分支 | 红 | **4 红**（分组归属用例连坐） |
| M3 | `setArchiveMode` 去重渲染守卫 | 待验证 | **0 红 = 既有覆盖缺口**（空菜单重建无用例，迁移前同样无覆盖；如实登记不预补） |
| M4 | `openFresh` 去清搜索词 | 红（若有） | **1 红**（historyBtn 重置用例在） |
| M5 | keepBtn 删 `stopPropagation` | 待验证 | **1 红**（冒泡触发 `switch_session`，委托打断被测兜住） |

M4 变异范围实施中自纠：首版误把 `postMessage({type:'session_list'})` 一并删除（会污染归因），修正为只删清词两行。

**§6.4 不变式八条核验**：①②③④⑤⑦⑧ 全部成立（函数体零改名平移，逻辑逐行未动）；⑥ 成立（`setArchiveMode` 守卫原样随迁）。八条零新增违例。

**文件清单**：新建 `hosts/memora-vscode/src/webview/scripts/historyMenuView.ts`；修改 `hosts/memora-vscode/src/webview/scripts/chatView.ts`（净 −207）、`hosts/memora-vscode/eslint.config.mjs`（chatView 条目 7378 + 注释更新）、`tasks/待完成任务.md`（状态行 / 体量表 / 闸门清单 / 本收据）。
