# 精灵设定模块联动改动 —— 结论真实性评估

> 评估方法：以 `git diff --cached`（全部已暂存）为唯一事实源，逐条对照结论中的「6 个问题 / 6 个文件 / 9 行明细表」。
> 工作区分支 `main`，当前暂存改动 **16 个文件**（+417 / −48）。

## 一、总体判定

| 维度 | 结论 | 实测 | 判定 |
|---|---|---|---|
| 6 个问题的技术实质 | 均存在对应修复 | 全部能在 diff 中找到 | ✅ 真实 |
| 「本次共改动 6 个文件」 | 6 个 | 实际 **16 个**（13 源文件 + 3 测试） | ❌ 严重失实 |
| 「一次修复追溯」明细表 | 列 9 个文件 | 实际 13 个源文件，漏 4 个 | ⚠️ 不完整 |
| 表格中 9 行的具体描述 | — | 逐行可在源码核实 | ✅ 全部属实 |

**一句话结论：技术结论（做了什么、为什么）真实可信；但「文件数量 / 改动追溯」部分与 git 事实不符，存在自我矛盾（正文说 6 个、表格列 9 个、实际 16 个）。**

---

## 二、6 个问题逐条取证

### 问题 1 — 写入路径错误 ✅ 真实
- `src/agent/assembler.ts`：新增 `configFileStore = configDir ? new FileStore(configDir) : null`，`ConfigManager` 的 `writeConfigFile` 回调由 `pctx.fileStore.write`（项目级 `.memora/`）改为 `configFileStore.write`（config 级目录）。
- 根因叙述（写入 projectPath/.memora/ 而非 configDir）与代码注释一致。

### 问题 2 — LLM 误用 write_file ✅ 真实（两层防线均在）
- 防线 A（描述层）：`src/agent/builtinTools.ts` 的 `write_file` description 追加「不要用于创建角色/技能/规则文件，请使用 create_persona / create_skill / create_rule 工具」。
- 防线 B（拦截层）：`src/agent/builtinToolHandlers.ts` 新增 `CONFIG_DIRS = {personas, skills, rules}`，在 `writeFile` 前拦截首级目录命中者并返回错误提示。

### 问题 3 — 缺少 create_rule 工具 ✅ 真实
- `hosts/memora-sprite/src/sprite/tools.ts`：新增 `CREATE_RULE_TOOL` 定义 + `createRuleHandler`，并扩展工厂 `createConfigHandler` 的 `type` 为 `'persona'|'skill'|'rule'`；`AgentRef` 类型改用 `ConfigSuggestion`（为问题 4 的 metadata 铺路）。
- `hosts/memora-sprite/src/index.ts`：`registerTool(CREATE_RULE_TOOL, createRuleHandler)`。
- 「两阶段错误处理」属实：确认写入（阶段 1，失败即报错）与热重载（阶段 2，busy 时降级为「对话结束后自动加载」提示）拆为两个 try/catch。

### 问题 4 — frontmatter 元数据缺失 ✅ 真实
- `src/memory/types.ts`：`Memory` 新增 `metadata?: Record<string, string>`。
- `src/agent/managers/configManager.ts`：`ConfigSuggestion` 新增 `metadata?`，构造 `Memory` 时透传 `metadata: suggestion.metadata`。
- `src/memory/store.ts`：`serializeFm({...标准字段, ...memory.metadata})` 合并到 frontmatter。
- 补充事实：不仅是「合并」，工具侧（`tools.ts`）把原先拼进 content 正文的 `description/keywords` 改道到 metadata（frontmatter），避免 body 噪音。

### 问题 5 — 对话创建角色不实时加载 ✅ 真实（pendingConfigReload）
- `src/agent/agent.ts`：
  - 新增 `private pendingConfigReload = new Set<string>()`（~L173）。
  - `reloadConfig` 在 `chatLockManager.isBusy` 且 `source` 存在时 `add(source)` 并抛错（~L1071）。
  - `chat()` 的 `finally` 块释放锁后清空集合并逐个补执行 `reloadConfig`（~L440）。
  - `close()` 中 `pendingConfigReload.clear()` 防止 re-init 残留（~L1206）。
- 结论的 race-condition 论证与代码一致：补执行发生在当前对话 finally；若新对话已持锁，`reloadConfig` 会再次因 busy 暂存到新对话集合。

### 问题 6 — 对话下拉菜单不刷新 ✅ 真实
- `hosts/memora-sprite/src/electron/renderer/renderer.ts`：`onConfigFilesChanged` 回调中 `if (payload.type === 'persona') void personaController.loadPersonaList();` 补刷新下拉菜单。
- 根因叙述（下拉只订阅 `personaChanged` 切换事件，创建/删除不触发）与代码注释一致。

---

## 三、文件追溯失实（核心 falsity）

### 数量矛盾
- 结论正文：「本次对话共改动 **6** 个文件」
- 结论表格：列了 **9** 个
- git 实际：**16** 个（`git diff --cached --stat`）

### 表格遗漏的真实源文件（4 个）
| 文件 | 改动 | 对应结论中的哪条 |
|---|---|---|
| `src/agent/builtinTools.ts` | write_file 描述排除三类 | 问题 2 防线 A（未在表格列出） |
| `src/memory/types.ts` | `Memory.metadata` 字段 | 问题 4 的类型层使能（未列） |
| `hosts/memora-sprite/src/electron/renderer/helpers/toolNameMap.ts` | `create_rule → 创建规则` 映射 | 问题 3 的 UI 名（未列） |
| `hosts/memora-sprite/src/electron/renderer/index.html` | 删除 add-memory 下拉里的 skill/rule/persona 选项 | 「排除记忆模块三类添加功能」的 UI 层（未列） |

> 注意：`index.html` 的删除是「排除记忆模块添加功能」这一总体目标真正实现的一部分，但结论只在 memoryPanelEvents.ts 一处体现，遗漏了 UI 同步改动。

### 未提及的测试文件（3 个，+232 行）
- `src/agent/__tests__/agent.test.ts` (+54)
- `src/agent/__tests__/builtinToolHandlers.test.ts` (+35)
- `hosts/memora-sprite/src/__tests__/sprite/tools.test.ts` (+143)

这些测试覆盖 write_file 拦截、pendingConfigReload、create_rule，是改动「被验证」的证据，但结论完全没提（既未说有测试，也未说无测试）。

---

## 四、对抗式审查：未被结论证伪、但需注意的点

1. **「自然生长 / 最小化改动」成立**：确实复用 `configFilesChanged` 事件、`chatLock` 释放时机、`loadPersonaList` 等既有机制，未新增模块。✅ 与结论一致。
2. **「向源头追溯」成立**：未用定时器轮询等补丁式方案，而是修写入路径 + 释放锁后补 reload。✅
3. **潜在未验证项（非结论错误，而是结论未覆盖）**：
   - 未运行测试套件确认行为（本报告为静态 diff 验证）。建议 `vitest` 跑上述 3 个测试文件实证。
   - `rule` 的 `reloadConfig` 是 no-op（configManager.ts 注释自陈），故 rule 依赖 `this.index.upsert` 同步 + 注入 AgentLoop，逻辑闭环成立，但「对话结束后自动加载」对 rule 而言仅是 SQLite/内存注入，不依赖 personaWatcher 文件扫描 —— 结论未区分 persona/skill 与 rule 在重载路径上的差异。
4. **工具描述层（防线 A）是软约束**：仅靠 prompt 文字，真正硬约束是 `builtinToolHandlers.ts` 的拦截；若 LLM 走其他写入路径（如 `edit_file` 未拦截）仍可能漏网 —— 结论未说明是否也覆盖了其它写文件工具。

---

## 五、结论

- **做了什么 / 为什么**：6 条结论的技术内容**全部真实**，映射到的源码、根因、设计权衡均可核实。
- **改了多少 / 追溯表**：**失实**。真实改动 16 文件，结论说 6、列 9，且漏列 4 个关键源文件与 3 个测试文件。
- **建议**：若此结论要进入 CHANGELOG / 提交说明，应更正文件清单为 16（或至少补列 builtinTools.ts / types.ts / toolNameMap.ts / index.html），并注明新增 3 个测试文件。
