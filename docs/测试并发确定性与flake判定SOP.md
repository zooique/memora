# 测试并发确定性与 flake 判定 SOP

> **SSOT**：本文件是内核测试并发策略与 flake 判定的唯一权威。配置侧声明见 `vitest.config.ts` 的 `fileParallelism` 注释。
>
> **适用边界**：内核（`@zooique/memora`）纯逻辑库 —— 根 vitest 配置纳入内核 `src/**/__tests__/*.test.ts` **+ 1 个跨包守卫**（`hosts/memora-vscode/src/shared/__tests__/protocolGuard.test.ts`，纯源码解析、无宿主运行时依赖）。**include 判据 SSOT = `vitest.config.ts`**；文件数与通过数随改动漂移，勿在本文件写死数字。宿主 `webview/__tests__` 已于 2026-09-19 收敛出根 include（此前双 include 致 webview 全套跑两遍并拖慢根门禁），一律归宿主 vitest 独立跑（`host:test`）；宿主其余测试各自配置不在本文件范围，但 flake 判定思想通用。

## 1. 当前并发策略（显式声明）

- **文件级并发保持开启**（`vitest.config.ts: fileParallelism: true`，即 vitest 默认）。
- 含义：vitest 在多个 worker 进程**并行跑不同测试文件**；单文件内测试仍可并发。
- **为什么开**：跨文件并发是本地与 CI 速度的主要来源。**实测（2026-09-14，提交 e771d262）：并行 57s，串行（`--no-file-parallelism`）136s ≈ 2.4x**。（此前版记「约 4 分钟 / 约 9 分钟」，已按实测校正。）
- **代价（已知）**：跨文件共享态竞争会引发偶发 flake（见 §2）。这是**速度换确定性**的取舍，团队选择保速度、用 SOP 兜底，而非默认序列化。
- **宿主 `host:test` 已是串行（2026-10-27 订正事实）**：`hosts/memora-vscode/package.json` 的 `test` 脚本自带 `--no-file-parallelism`（独立包配置，非本 SOP 管辖），故 `local-ci` 无需再加；「host:test 是否也改串行」一题**前提不成立**，不另设改动。

## 2. 已知 flake 根因（对抗式实锤）

| 测试 | 现象 | 根因 | 是否缺陷 |
| --- | --- | --- | --- |
| `agent.test.ts` > `memory.snapshot().working 应反映 AgentLoop 当前消息数` | 仅**并发**跑随机红；单独跑 / 加 `--no-file-parallelism` 全量均绿 | 跨文件共享态竞争（同工作区 `.memora` / 单例未隔离，时序敏感） | **否**（flake，非逻辑缺陷） |
| `llmIntegration.test.ts` ×3 | **配好凭据后真跑**，偶发 `MemoraError: 对话繁忙`（实测两次并行：一次 3 红、一次全绿；单文件复跑绿） | **文件内共享态**：3 个 `it` 共享 `beforeAll` 创建的 agent，chat 结束后仍有后置后台任务（测试内 `await setTimeout(2000)` 即等它）→ 前一个 it 未收尾时下一个撞 `ChatLockManager.isBusy`；并行负载放大该时序窗口。**非跨文件共享锁**——`ChatLockManager` 是纯实例级字段（无模块级单例） | **否**（测试自身共享态，非生产缺陷——生产为单会话串行） |
| `roundRefLifecycle.test.ts` ×2 | 基线偶发失败（与报告环境一致） | 基线脆弱，非本次改动引入 | **否**（基线，非回归） |
| `toolExecutor.test.ts` > `background=true → 立即返回 taskId` | 仅**并行**跑失败：`EBUSY: resource busy or locked, rmdir '…/memora-cmd-proj-XXXX'` | 临时目录删除与其它 worker 争用；串行（隔离复跑或 `--no-file-parallelism` 全量）**必绿** | **否**（环境 I/O，非逻辑缺陷） |
| `toolExecutor.test.ts` > `★ 已终态的**失败**任务 → kill 回传 status=ok` | 仅**并行**跑失败：`Test timed out in 5000ms`（**非** `AssertionError`） | 本容器文件系统删除慢（见 §3 根因归因，2026-09-26 三组对照实测）+ 并行负载；串行 357ms 通过 | **否**（超时型假红，判法见 §3） |
| **（宿主侧）** `codeExecutor.test.ts` > `支持 javascript/js/nodejs/node，不支持其他语言返回明确提示` | full 档 `host:test` 步偶发 `Test timed out in 5000ms`（**非**断言失败）；按 §3 隔离复跑该文件 6/6 全绿，其中本用例 **1424ms** 通过 | 同属本容器环境慢 + 并行负载（该次 full 的 `environment` 项达 75.40s，加载被拖慢） | **否**（超时型假红）。判红前先看是 `Timeout` 还是 `AssertionError`，并按 §3 隔离复跑 |
| `agent.test.ts` > `memory.snapshot()` ×2 | **`Hook timed out in 10000ms`**（`afterEach` 的 `agent.close()` + 3× 递归 `rmSync`）——单文件隔离重跑仍红，放宽 hookTimeout 后 **101/101 全绿** | 环境 I/O 慢（本环境全量耗时约为参考环境 7 倍），非逻辑缺陷 | **否**（环境性能型假红，判法见 §3「超时型假红」） |

> **判定铁证**：`agent.test.ts` 在并发下失败数波动（子集 2 / 全量① 9 / 全量② 5，历史观测），通过数随运行浮动 → 为 flake 非回归。
>
> **时效校正（2026-09-14 双向实测，提交 e771d262）**：并行 **117 files / 3006 passed / 1 skipped / 0 failed**（57s），串行 `--no-file-parallelism` **同数字**（136s）→ 上表三类 flake **本次均未复现**。其中 `llmIntegration` 已有「两次并行一红一绿」的实证 = **偶发确认**；另两类**一次全绿 ≠ 消失**（flake 本为偶发，**勿因单次全绿删除登记**）。**同时校正**：本表上一版将 `llmIntegration` 失败归因为「沙箱无凭据」→ **该结论成立于配置凭据之前，已过期**。

## 3. flake 判定 SOP（三步，勿跳步）

**原则：并发红灯先不归因代码、先不碰代码。**

1. **记录**：记下失败测试名（如 `agent.test.ts > memory.snapshot().working`）与「是否并发跑出」。
2. **隔离重跑**：`npx vitest run src/agent/__tests__/agent.test.ts`
   - **绿** → flake 确诊（跨文件竞争），走 §4 缓解，不追代码。
3. **全量确定性筛查**（步骤 2 仍不稳时）：`npx vitest run --no-file-parallelism`
   - **绿** → 确认跨文件竞争类 flake，结案为 flake。
   - **仍红** → 可能为真回归，转入正常排错（读错误、定位根因、一次性修复、修复后重跑验证）。

> **判定公式**：并发红 + 隔离绿 = flake（非代码缺陷）；隔离也红 = 真回归。
>
> **超时型假红（环境性能 · 第三类，2026-09-24 实证补）**：失败信息为 `Hook timed out in Nms` /
> `Test timed out` 而**非断言失败**时，先怀疑环境 I/O 慢，勿直接归因代码。典型形态：
> `afterEach` 里 `agent.close()` + 递归 `rmSync` 删临时目录（`agent.test.ts` 的 memory.snapshot 块）。
> **诊断**：`vitest run --hookTimeout=120000 --testTimeout=120000 <file>`——转绿即确诊环境性能，
> 既非回归也非跨文件竞争。实测佐证：同一份代码在默认 10s 下 2 红，放宽后 101/101 全绿。
> ⚠️ 这两个参数**仅作一次性诊断**，不得写进 `vitest.config.ts` / `package.json`——那是改判据，不是修问题。
>
> **⚠️ 本诊断的适用边界（2026-10-07 补 · 两个参数分管两类超时）**：
> `--hookTimeout` 管 `Hook timed out`、`--testTimeout` 管 `Test timed out`，**两者各自有效**。
> ⚠️ **唯一的失效场景**：`Test timed out` 且该用例**自带内联 timeout**
> （`it('…', fn, 30_000)` 第三参 / `describe` 第四参）—— 此时**内联值优先级高于 CLI**，
> `--testTimeout` **静默无效**：不报错、不提示，只是没生效。执行者会以为诊断做了，实际没做。
> ⚠️ 反之**「用例带内联 timeout」本身不等于失效**：`Hook timed out` 归 `--hookTimeout` 管，
> 与内联 test timeout 无关（实测 `hostIntegration.test.ts` 带内联仍因放宽而转绿）。
> **实测佐证**：同批 3 条红，`hostIntegration` / `allowedPaths` 放宽后**转绿**（确诊环境慢），
> 而 `projectSearchProvider.test.ts:549`（无 Hook 超时、只有内联 test timeout）**仍红**
> ⇒ 未确诊、亦未排除，结论开放。
> **动手前先识别**：`grep -rE '\}, [0-9_]{4,}\);' src hosts/memora-vscode/src --include='*.test.ts'`
> ——有命中**且**该用例报 `Test timed out` 时，本诊断不适用。实测规模约 **50 处**
> （内核 40 / 宿主 10；2026-10-07 实测，重算用上面那条 grep）。确需确诊该形态者，
> 走「改判据」流程（带观测 + 退出条件），**不得**为跑绿而随手放宽内联值。
> **机制归属（为何不能就地放宽）**：内联 timeout 同时承载两种目的 ——「被测代码自身的超时契约」
> 与「诊断旋钮」。二者共用同一个参数 ⇒ 为诊断临时放宽会**同时削弱被测约束**。
>
> **首选判据（2026-09-26 补，成本最低、无需改任何参数）**：**先数 `AssertionError` 的条数。**
> 在失败日志里 grep `AssertionError` ——**条数为 0 且失败信息全是 `timed out`** 即环境假红，
> **可以直接结案，不必进隔离复跑**；条数 > 0 才可能是真回归，转 §3 步骤 2。
> 辅助信号：**两次跑失败集合不同**（同一 commit、同一命令，红者换了一批）亦指向假红。
>
> **根因归因（2026-09-26 三组对照实测，纠正旧归因）**：慢的**不是**文件级代码、**不是** safe-delete
> shim，而是**运行容器的文件系统删除路径**。同脚本 150 文件、仅换环境变量的对照：
> 原样 / `CODEBUDDY_SAFE_DELETE_ENABLED=0` / `NODE_OPTIONS=`（完全不加载 shim）→ 同步 `unlinkSync`
> 分别 **104.8 / 74.1 / 78.2 ms/文件**，三组同量级、无质变 ⇒ 与 shim 无关
> （shim 的 `shouldBypassSafeDelete` 对 `os.tmpdir()` 本就 bypass）。
> 两个形状特征锁定「外部串行化」而非磁盘：① **写 1.3–1.7 ms/文件、删 ~78 ms/文件**（不对称）；
> ② **并发 32 路删除降到 29.6 ms/文件**（可摊薄 = 单点串行队列）。
> ⇒ 本环境「跑得完 compile / 全量测试」的判据不是速度，而是上一条的 `AssertionError` 计数。
> **真实开发终端无此现象**（实测 `npm run compile` 顺利通过），故**不得据此改仓库任何东西**。

## 4. 缓解选项（按成本升序）

| 选项 | 命令 / 做法 | 成本 | 适用 |
| --- | --- | --- | --- |
| (a) 重跑 | SOP §3 步骤 2 | 0 | 默认；绝大多数 flake 在此确诊 |
| (b) 诊断全量 | `vitest run --no-file-parallelism` | 慢（2x） | 步骤 2 不稳时确认根因 |
| (c) CI 加固（可选） | vitest `test.retry: N` 失败文件自动重跑 | 偶发重试开销 | 降低 CI 偶发红；**retry 后仍红须当真回归，勿盲目 merge** |

## 5. 禁区（勿做）

- ❌ **勿在并发红灯上直接归因代码缺陷** —— 先走 §3 判定。
- ❌ **勿为让并发过而改测试/生产代码** —— 掩盖竞争而非修复，真 bug 会被藏。
- ❌ **勿默认禁用文件并发**（`fileParallelism: false` 或把 `--no-file-parallelism` 写进 `package.json` test 脚本）—— 2x 慢，违反速度/复杂度守恒；(b) 仅作诊断手段，不进常驻脚本。
  - **✅ 已批例外（2026-10-27 · 用户拍板）**：`scripts/local-ci.mjs` 的 `kernel:test` 步**常驻** `npm run test -- --no-file-parallelism`。
    - 理由：full 档每跑必红上述 `toolExecutor` 2 条（假红，见 §2 表），**常驻红会让 full 的结论失去信号**；`local-ci` 是本地 pre-push 的最后一道统一口径，宁慢勿疑。
    - 代价**实测**（本环境，3026 用例，2026-10-27）：并行 135.65s / 串行 166.58s ⇒ **仅 +22%**，远小于本 SOP 记的历史 2.4x（2026-09-14 在另一规模下测，勿据历史倍数推当前代价）。
    - 边界：例外**只**覆盖这一步。`vitest.config.ts` 仍 `fileParallelism: true`、`package.json` 的 `test` 仍不带该参数 ⇒ 日常手工跑維持并行。
    - 🔴 若将来这一步的串行也出现红 ⇒ **那是真回归信号**，不得再放宽口径，按 §3 转入排错。
- ❌ **勿把「retry 绿」当「已修复」** —— retry 只证明 flake，仍须按 §3 核实是否真回归。
- ❌ **勿为绕过容器慢 I/O 而改测试的清理实现** —— 例如把 `rmSync` 换成异步/并发删除。实测（2026-09-26）
  并发 32 路只从 93.7 降到 29.6 ms/文件，收益有限；且该慢是本容器特有、真实终端无此现象，
  属「用代码掩盖环境」。判据 = §3 的 `AssertionError` 计数，不是删得快不快。

## 6. 配置落点

- `vitest.config.ts`：`fileParallelism: true`（显式声明策略意图，= vitest 默认，行为零变更）＋ 注释指向本 SOP。
- `package.json`：`"test": "vitest run"`（不带 `--no-file-parallelism`，保持并发加速）。
- **`scripts/local-ci.mjs` 的 `kernel:test` 步：常驻 `npm run test -- --no-file-parallelism`** —— §5「勿进常驻」的**已批例外**（2026-10-27 用户拍板，实测代价 +22%，详见 §5 该项批注）。**本 SOP 与那处注释互为引用，改一处必须同步改另一处**。
- CI（`.github/workflows/kernel-ci.yml` 的 `npm test`）：保持并发；偶然红按 §3 重跑判定，不盲目 revert。（上一版记「`build.yml` 三处 `npx vitest run`」——该 workflow 文件**已不存在**，2026-09-14 实测仅剩 `kernel-ci.yml`。）

> 对抗式实锤（2026-09-14 复核实测）：grep 确认 `agent.test.ts` 的 `memory.snapshot().working` 用例为唯一内核**跨文件共享态** flake（`llmIntegration` 属**文件内**共享态，另一类）；全仓测试文件（2026-09-14 实测 **117** 个，时点早于 webview include 收敛，当前数以 `vitest.config.ts` 为准）无 `fileParallelism: false`/`pool`/`retry` 配置（仅 `vitest.config.ts` 一处 `fileParallelism: true` 显式声明策略意图）；CI（`kernel-ci.yml`）无 `--no-file-parallelism`。**另**：本 SOP 为并发策略与 flake 判定的**唯一权威**，不依赖 `tasks/` 编号（原记「对应 T5」——该编号已不在台账，勿据它回溯）。
