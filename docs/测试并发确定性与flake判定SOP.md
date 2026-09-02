# 测试并发确定性与 flake 判定 SOP

> **SSOT**：本文件是内核测试并发策略与 flake 判定的唯一权威。配置侧声明见 `vitest.config.ts` 的 `fileParallelism` 注释。
>
> **适用边界**：内核（`@zooique/memora`）纯逻辑库，100 个测试文件（`src/**/__tests__/*.test.ts`）。宿主（vscode）各自的 vitest 配置不在本文件范围，但 flake 判定思想通用。

## 1. 当前并发策略（显式声明）

- **文件级并发保持开启**（`vitest.config.ts: fileParallelism: true`，即 vitest 默认）。
- 含义：vitest 在多个 worker 进程**并行跑不同测试文件**；单文件内测试仍可并发。
- **为什么开**：跨文件并发是本地与 CI 速度的主要来源。全量并发约 4 分钟，若禁用（`--no-file-parallelism`）翻倍至约 9 分钟。
- **代价（已知）**：跨文件共享态竞争会引发偶发 flake（见 §2）。这是**速度换确定性**的取舍，团队选择保速度、用 SOP 兜底，而非默认序列化。

## 2. 已知 flake 根因（对抗式实锤）

| 测试 | 现象 | 根因 | 是否缺陷 |
| --- | --- | --- | --- |
| `agent.test.ts:190` `memory.snapshot().working 应反映 AgentLoop 当前消息数` | 仅**并发**跑随机红；单独跑 / 加 `--no-file-parallelism` 全量均绿 | 跨文件共享态竞争（同工作区 `.memora` / 单例未隔离，时序敏感） | **否**（flake，非逻辑缺陷） |
| `llmIntegration.test.ts` ×3 | 需真实 LLM 网络 + API 凭据，沙箱无凭据→失败 | 真实网络集成测试，环境缺凭据 | **否**（环境缺失，非代码） |
| `roundRefLifecycle.test.ts` ×2 | 基线偶发失败（与报告环境一致） | 基线脆弱，非本次改动引入 | **否**（基线，非回归） |

> **判定铁证**：`agent.test.ts` 在并发下失败数波动（子集 2 / 全量① 9 / 全量② 5），通过数随运行浮动 → 为 flake 非回归。

## 3. flake 判定 SOP（三步，勿跳步）

**原则：并发红灯先不归因代码、先不碰代码。**

1. **记录**：记下失败测试名（如 `agent.test.ts > memory.snapshot().working`）与「是否并发跑出」。
2. **隔离重跑**：`npx vitest run src/agent/__tests__/agent.test.ts`
   - **绿** → flake 确诊（跨文件竞争），走 §4 缓解，不追代码。
3. **全量确定性筛查**（步骤 2 仍不稳时）：`npx vitest run --no-file-parallelism`
   - **绿** → 确认跨文件竞争类 flake，结案为 flake。
   - **仍红** → 可能为真回归，转入正常排错（读错误、定位根因、一次性修复、修复后重跑验证）。

> **判定公式**：并发红 + 隔离绿 = flake（非代码缺陷）；隔离也红 = 真回归。

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
- ❌ **勿把「retry 绿」当「已修复」** —— retry 只证明 flake，仍须按 §3 核实是否真回归。

## 6. 配置落点

- `vitest.config.ts`：`fileParallelism: true`（显式声明策略意图，= vitest 默认，行为零变更）＋ 注释指向本 SOP。
- `package.json`：`"test": "vitest run"`（不带 `--no-file-parallelism`，保持并发加速）。
- CI（`.github/workflows/build.yml` 三处 `npx vitest run` / `kernel-ci.yml` `npm test`）：保持并发；偶然红按 §3 重跑判定，不盲目 revert。

> 本 SOP 对应 `tasks/待完成任务.md` **T5**。对抗式实锤：grep 确认 `agent.test.ts:190` 为唯一内核跨文件共享态 flake；全仓 100 测试文件无 `fileParallelism`/`pool`/`retry` 配置；CI 三处均无 `--no-file-parallelism`。
