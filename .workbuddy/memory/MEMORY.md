# 项目长期记忆（memora）

## 架构与质量基线
- 内核 `src/`（零 native/三方依赖，仅暴露 `"."`，不可深导入）；宿主 `hosts/memora-sprite/`（Electron 40 + electron-builder 26）。
- 内核同步铁律：改内核后从 sprite 目录跑 `npm run sync-memora`（`hosts/memora-sprite/scripts/sync-memora.mjs`）编译并 cpSync 进 `node_modules/memora`（非软链）。EPERM 偶发（残留句柄）重试即过；以「同步完成 ✓」或 exit code 判成败，`| tail` 吞退出码。
- 质量门 = `tsc --noEmit` + `eslint --max-warnings 0` + `vitest run`。版本：宿主/内核独立，发版只升宿主。

## 内核/宿主边界
- kernel 仅 `{baseUrl, model, apiKey}`；provider 名解析、默认值、local/cloud 策略全归宿主。拒绝 preset 表。

## SSOT 单一真理源约定（收敛结论，勿回改）
- source→子目录映射：`src/memory/sourcePaths.ts` 唯一（SOURCE_TO_DIR/sourceToDir/resolveSourceFilePath）。宿主严禁硬编码 `'personas'/'rules'/'skills'`。
- 配置名校验：`utils/strings.ts` isValidConfigName（字符集 `[\p{L}\p{N}_-]`，长 100）；宿主 `shared/inputValidation.ts` 同规则，契约测试锁一致；改规则须两端+测试同步。
- 检查点 SSOT：`checkpoint.x=` 写回仅 `sessionManager`；状态机是状态真理源，检查点仅投影（createCheckpoint 投影 status/error）；resume/recover 从 stateMachine 投影。
- 暂停 pending：`stateMachine.pendingPause` 唯一判据；loop.pauseRequested 仅控生成器挂起时机（非平行真理源）。ChatLockManager token 校验防 race。
- 执行流消费：`consumeExecutionStream` 收口 chat/resume/handleNonChat；finally 中 cancelPendingPause+clearPauseRequest。落盘收口 touchCheckpoint/flushCheckpoint（脏标记）。
- 挂载物卸载：clearPlan 卸 plan/roundLog；pauseMeta 由 setPauseMeta(undefined) 卸；consecutivePauseTimestamps 进程内不入检查点。
- **反复病灶（对称的另一半没写完）**：增删/读写/翻转归零改动须答「反方向在哪」；有 add 无 evict、void 调 async generator、缓存失效漏一个入口皆此类。

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
