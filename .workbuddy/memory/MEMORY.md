# 项目长期记忆（memora）

## 架构与质量基线
- 内核 `src/`（零 native/三方依赖，仅暴露 `"."`，不可深导入）；宿主 `hosts/memora-sprite/`（Electron 40 + electron-builder 26）。
- 内核同步铁律：改内核后从 sprite 目录跑 `npm run sync-memora`（`hosts/memora-sprite/scripts/sync-memora.mjs`）编译并 cpSync 进 `node_modules/memora`（非软链）。EPERM 偶发（残留句柄）重试即过；以「同步完成 ✓」或 exit code 判成败，`| tail` 吞退出码。另：内核根 `npm run build`（tsc 并发写盘）亦偶发同类 EPERM，每次不同随机文件（疑实时扫描持锁），Defender 排除项因无管理员权限不生效；改用**有界重试循环**（`for i in $(seq 1 15); do npm run build; if grep -q EPERM 则 sleep 2 重试; done`）可破——已验证第 2 次即过。
- 质量门 = `tsc --noEmit` + `eslint --max-warnings 0` + `vitest run`。版本：宿主/内核独立，发版只升宿主。
- **测试并行度不对称（2026-08-30 实测）**：宿主 `npm test` 带 `--no-file-parallelism`，内核 `npm test` **不带**。
  后果：内核并发跑会随机 flake（已见 `agent.test.ts > memory.snapshot().working`），单独跑或加 flag 均绿。
  判 flake 的标准动作：先单独重跑该文件；仍不稳再 `--no-file-parallelism` 跑全量（耗时 4m→9m，翻倍）。
  **不要在并发跑出的红灯上直接归因代码**，也不要为了让并发过而改代码。
- 已知环境性红灯：`src/llm/__tests__/llmIntegration.test.ts` 3 例（真实网络 LLM，`describe.skipIf(!hasApiKey)` 判定有 key 但调用失败），非代码缺陷。

## 内核/宿主边界
- kernel 仅 `{baseUrl, model, apiKey}`；provider 名解析、默认值、local/cloud 策略全归宿主。拒绝 preset 表。

## 上下文窗口真理源（2026-08-30 萧然定案，勿回改）
- **唯一真理源 = 用户每个 LLM 配置里填的 `LlmProviderConfig.contextWindow`**（vscode 宿主）。不填 → 内核兜底 `DEFAULT_MAX_CONTEXT_TOKENS = 120_000`。**无全局封顶**，用户对自己填的数负责。
- **设计铁律**：窗口解析归宿主（内核契约不含 provider 配置），内核只消费单一数字 `maxContextTokens`，不认 provider/用户双层来源。
- 内核公式已收口为单参 `resolveContextWindow(window?: number)`：传 per-LLM 值即采用（无封顶），`undefined` 回退 120K。**原两参 `(providerWindow, userMax)` + `min` 封顶分支已删除**（2026-08-30 收口提交 `1647ed1d`）。
- ADR-029 已全量收口：frontmatter、决策点3、L31、L61 旧设计均已改为单源表述（旧两参签名加「已废弃」注），与代码一致（2026-08-30 收口提交 `1647ed1d`）。

## 上下文占用指示器（④ 预算可视化，2026-08-30 定案，契约勿回改）
- **单一真理源 = 内核 `ContextOccupancy`**（contextPreparer 经 `loop.recordOccupancy` 在 prepare 期写入，tracer 经 `getMetrics().context.occupancy` 透出）。宿主 `protocol.ts context_occupancy` 仅透传，webview `updateContextOccupancy` 仅渲数，**两端永不重算**。
- `ContextOccupancy`（真实用量）与 `ContextBudget`（caps 预算）**同源于 prepare、互补不重复**：前者各段实际 used（角色包基础/对话/记忆/输入锚/输出预留/空闲），后者上限。
- 占位条常驻输入区（隐藏至首轮流式结束收到 `context_occupancy`），hover 出分层明细；`free = max(0, total − Σ各段)`，非负收敛。
- `chatPanel.postContextOccupancy` 每轮**无条件**推（独立于 dev 开关 `memora.showMetrics`）。
- ADR-030 锁定契约「内核算 → 宿主传 → webview 渲」。改动须保持此边界：新增段只在内核加字段 + protocol 转发 + webview 渲，不在宿主/webview 算。
- **⚠️ 历史会话轻量版占用（2026-08-31 引入，2026-09-01 已修复 + ADR-030 已含增补段）**：宿主 `chatPanel.postHistoryOccupancy()` 自己读持久化消息经内核 `estimateTokensMessages` 求和再组装 `estimateOccupancy`（宿主侧第二条计算路径，与 ADR-030「不另立占用计算路径」表面冲突，但 ADR-030 增补段已批准「无快照时的降级重算」，且该路径 token 估算/组装全部复用内核纯函数，非第二份实现）。
  - 修复史：**2026-09-01 圆环 0% bug** —— 占用补推原只钉在 `setAgent`，懒装配（ensureAgent / 重启·侧栏图标）路径漏推。已收口进装配后统一收口点 `refreshAfterAssemble`（原 `refreshRoleInfoAfterAssemble`），两入口共用，质量门 328 绿。
  - 残留已知项：`rolePackBaseTokens` 冷启动取 0（无 prepare 记录）属诚实降级，首轮 prepare 后自动修正；内核未暴露 system prompt token，需新内核 API 才能取真值（留作独立决策）。

## SSOT 单一真理源约定（收敛结论，勿回改）
- source→子目录映射：`src/memory/sourcePaths.ts` 唯一（SOURCE_TO_DIR/sourceToDir/resolveSourceFilePath）。宿主严禁硬编码 `'personas'/'rules'/'skills'`。
- 配置名校验：`utils/strings.ts` isValidConfigName（字符集 `[\p{L}\p{N}_-]`，长 100）；宿主 `shared/inputValidation.ts` 同规则，契约测试锁一致；改规则须两端+测试同步。
- 检查点 SSOT：`checkpoint.x=` 写回仅 `sessionManager`；状态机是状态真理源，检查点仅投影（createCheckpoint 投影 status/error）；resume/recover 从 stateMachine 投影。
- 暂停 pending：`stateMachine.pendingPause` 唯一判据；loop.pauseRequested 仅控生成器挂起时机（非平行真理源）。ChatLockManager token 校验防 race。
- 执行流消费：`consumeExecutionStream` 收口 chat/resume/handleNonChat；finally 中 cancelPendingPause+clearPauseRequest。落盘收口 touchCheckpoint/flushCheckpoint（脏标记）。
- 挂载物卸载：clearPlan 卸 plan/roundLog；pauseMeta 由 setPauseMeta(undefined) 卸；consecutivePauseTimestamps 进程内不入检查点。
- **反复病灶（对称的另一半没写完）**：增删/读写/翻转归零改动须答「反方向在哪」；有 add 无 evict、void 调 async generator、缓存失效漏一个入口皆此类。
- **反复病灶 · 补推型改动的落点（2026-09-01 第三次踩）**：凡「装配后 / 切换后 / 加载后需补推的数据」，必须挂进该事件的**唯一收口点**，严禁在 `setAgent` / `ensureAgent` / 各命令入口各钉一份。vscode 宿主既有收口点 = `chatPanel.refreshRoleInfoAfterAssemble()`（自注：setAgent 与 ensureAgent 懒装配共用本入口，杜绝某条路径漏推）。2026-08-31 把占用兜底钉进 setAgent 而绕过它 → 懒装配路径漏推 → 重启后圆环 0%。判定口诀：**新增补推前，先 grep 该事件是否已有收口点**。

## 审计/测试方法论（高信号）
- 判死代码须跨内核/宿主 grep（内核写宿主读易误判为死）。
- 注释即契约：行为性注释须 grep 验证，无路径支撑=撒谎。
- 收口优于补漏：外部直改被绕过路径 → 把写入收进拥有者（如 updatePlanStepStatus 收口）。
- tsc 与 vitest 不对称是防线：vitest(esbuild)不查类型，改完必跑 tsc。防回归测试须修复前红、修复后仍绿（临时中和生产分支验证）。
- 跨进程边界勿把 generator 作唯一入口（void 调 async generator=函数体不执行且 tsc 全绿）——提供自 drain 门面。
- 双写不同步判据：JSON 某字段恰为默认值而其他是真实值 → 必有两路径部分/完整写入，统一单一入口。

## UI/样式（sprite 侧，精简）
- 三层 token scope + 双主题 100% token 化；Component=单根 el+四件套，Manager 持有而非本身是。
- 占位符/空态/错误态用类修饰而非状态机；分母=0 是假事实。
- 硬编码色统计须排除 tokens.css；stylelint 跨文件 token 用 importFrom 绝对路径。

## 测试与集成
- vitest 不 type-check：抽象类仅 export type 时桩用 implements X+readonly 成员。
- 内核 Manager 只经真实 Agent 驱动（getter 返 |null 用 !）。
- mock 工厂是字面量对象，被 mock 类新增公开方法须手动补入；vi.mock 须覆盖所有被 import 的函数。

## 已定案特性
- Composer P4：chat 事件永不因 task 槽缺失触发 P4；P4 仅非 chat+停滞。
- 网络搜索：Bing 优先→DDG 备用，各 10s 超时；ok 无命中返 `[]`，全失败才抛。

## 发布/Git/事件
- 发布：Gitee 主仓→GitHub 私有镜像→Actions→memora-sprite-releases（RELEASE_TOKEN）；`v*` tag 触发。详见 tasks/发布流程-gitee-20260722.md。
- Git 红线：禁 Bash 写 git（POSIX 沙箱 FS 不同步）；走 PowerShell，阶段完成即 commit。
- 事件闭环：emit/on 双正则须匹配字面量+AGENT_EVENTS 常量；dangling 须核实宿主 IPC 旁路。

## 长期观察
- UI-MIXIN-OBS：ui.ts 行数阈值 1500。
- 检查点未来兼容：已于 2026-08-23 K1 落实 `SessionCheckpoint.schemaVersion`（v1，迁移映射空）+ `VectorStoreFile.version:1` 校验，旧「无 schemaVersion」判断已过时。仍缺 CAS（并发乐观锁），但内核 `IMemoryStorage` 接口不强制 SQLite，宿主同步实现下 CAS 非紧迫；多 Agent 并发写同一会话时才是真风险。
- recall 超时：双通道（vectorStore.search 异步 + storage.search 同步）已 try/catch 降级；JsonVectorStore.search 在内存跑余弦无 I/O 阻塞，embedding 层 EmbeddingOptions 已透传 signal/timeoutMs。O3「recall 超时保护」在同步存储+内存向量场景下基本不成立，可移出任务清单。

## 配置落点归类原则（vscode 宿主，2026-09-02 定案「四问」）
- 新增任何设置先定「主人」再写代码：①用户偏好（跨项目一致、要人改）→ configuration `memora.*` `ConfigurationTarget.Global`（providers/activeProvider/embedding/searchEngine/showMetrics/allowedPaths）；②秘密 → SecretStorage（apiKey，永不落 settings 文件）；③程序内部状态（角色包激活/会议/二次确认）→ globalState；④项目级安全/团队策略 → Workspace。
- 反例血训：searchEngine 曾落 Workspace（.vscode/settings.json）与 providers 的 Global 归类自相矛盾，2026-09-02 迁 Global + package.json `scope:"application"`（commit 44534972）；同批拍板 allowedPaths（目录白名单）= 机器级目录信任 → 一并 Global（commit 待落）。判定口诀：换项目还想一样吗→用户级；秘密吗→钥匙串；给人改吗→configuration；按项目不同/团队共享→Workspace。
