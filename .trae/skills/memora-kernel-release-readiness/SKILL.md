---
name: memora-kernel-release-readiness
description: 在 memora 双包架构（内核 @zooique/memora + VS Code 宿主）中，改动内核 src 后验证发布就绪度。当用户要改内核源码并准备提交/发版，或问「还差什么才能发布 / 可以发版了吗」时使用。覆盖五条铁律（宿主 dist 同代、台账状态须 git 实证、发布边界=files 白名单、新增测试须变异验证、假红先数 AssertionError）、执行顺序、提交分工、tag 命名与判定标准；亦用于跨内核/宿主 dist 的契约一致性核验与发版就绪度审计。
agent_created: true
---

# memora 内核改动 → 发布就绪度验证

> 设计依据：派生判定律（宿主 dist 代际由内核产物决定）+ 发布边界 = `files` 白名单 + 台账状态须 git 实证。

## 何时用

- 改了 `src/**`（内核源码）后，准备提交或发版
- 用户问「发布前还差什么」
- `verify:dist-contract` 报「宿主 bundle 与内核 dist 不同代」

## 铁律一：宿主 dist 必须跟着内核重建

**宿主 bundle 内联内核代码**（esbuild 打包 `file:../..`），所以改内核 src → 内核 dist 与宿主 dist 会**不同代** → `verify:dist-contract` 直接失败（发布门禁挂）。

```
顺序：内核 build → 宿主 build → 复验契约。不可颠倒。
```

### 子陷阱：宿主 `tsc` 读的是**内核 dist 的类型**，不是内核 src

宿主依赖写 `"@zooique/memora": "file:../.."` → 类型解析走内核 `package.json#types` → **内核 dist 的 `.d.ts`**。
因此**改内核 `src/` 新增/改名任何导出后，若不先重建内核 dist，宿主 `tsc` 会报假错**：

```
error TS2551: Property 'xxx' does not exist on type 'Foo'. Did you mean 'yyy'?
```

这不是宿主代码错，是宿主在看**旧内核类型**。**别去改宿主代码迁就它**——先重建内核 dist，再跑宿主 tsc。
（2026-09-22 实测：内核新增 `SkillManager.listAvailable()` 后宿主 tsc 报假错，重建内核 dist 即 EXIT=0。）

### 子子陷阱：内核 `AgentChunk` 联合**扩员**时，宿主的表现更隐蔽

宿主按 `chunk.type === '新字面量'` 分发时，旧 dist 会让该比较**无类型重叠**：

```
error TS2367: This comparison appears to be unintentional because the types have no overlap.
```

**但只在真跑了宿主 tsc 时才报**——若宿主侧只跑了 vitest（esbuild 剥类型、不查类型），
新分支会静默走不到（永远 false），表现为「宿主行为对、类型错」这种最难查的组合。

→ **纪律：内核给 `AgentChunk` / `ProcessEvent` 联合加成员后，宿主 tsc 是必跑项**，且顺序必须是
内核 build → 宿主 tsc。别以 vitest 全绿当作跨包一致性的证据。

（2026-09-23 实测：新增 `iteration_boundary` chunk，宿主 `chatPanel.ts` 新增分支——内核 build 前
宿主 tsc 报 TS2367，build 后 EXIT=0。）

### 铁律一附则：非发版场景不必清 dist

第 4 步的 `rmSync dist` 是**发版纪律**（防旧文件残留进包）。若本次只是「为宿主类型同步」而 build、
且没有删除任何内核源文件，可**直接 `tsc -p tsconfig.build.json` 覆盖**，省一次全量重编。
一旦本次删过文件 / 准备发版 → **必须清**。

### 铁律一补：full 档已内置这条链，只有手工链路才需手跑

`kernel:build` 之后紧跟 `host:sync`（`pnpm install --offline` 重链宿主镜像），两者都在 `scripts/local-ci.mjs` 里定义——**步数不在任何文档里写死**（历史上技能写「8 步」而门禁已 20 步，漂移过一次）。

- 跑 full 档 ⇒ 该链自动完成，不用手工。
- 走 fast 档 / 手工切片 ⇒ 必须按「内核 build → 宿主 `install --offline` → 宿主重编译 → 契约闸门」手跑。
- 漏刷的后果：宿主 test / build / 契约可能因加载旧内核而「同根红」（2026-10-16 实锤：漏刷一次 5 红，重链后三处全绿）。

## 铁律一之三：给流加 chunk 前，先问「它会出现在终态之后吗」

内核 `AgentChunk` 是一条**带时序契约的流**：宿主与测试多处依赖「**终态 chunk 是末条**」——
例：宿主 `paused` 分支收到即 `break`（该分支注释有 2026-09-22 实证），测试大量断言 `chunks.at(-1).type` 为 `done`/`paused`。

→ 新增的信号/进度类 chunk **必须有条件地落在终态之前**（典型判据 =「路由结果仍是 `'continue'`」），
否则 = 在 `done`/`paused` 之后再塞一条 → 破坏宿主 break 语义 + 一批既有断言转红。

2026-09-23 实测：`iteration_boundary` 初版「无条件 yield」→ 6 个既有用例红；改为「仅当将继续下一轮」后全绿。

**推论**：既有测试里「末条 = 终态」的断言**不是装饰**，是宿主收场判定的代理哨兵。
它们转红时，先去读宿主对终态的分支处理，**别直接改断言**。

## 执行顺序（本环境实测可用命令）

`npx` 报 `env: 'bash': No such file`（EXIT=127）→ **一律用 `node` 直跑，不用 npx**。
（2026-09-26 更正：`ls` / `head` / `tail` / `sed` / `grep` 实测**均可用**——旧记「Bash 缺 coreutils」
不准确；但管道会吞退出码造成假绿，仍按本节末的告诫办。）

全部命令以 `cd <repo> &&` 起始；`node` 一律用 PATH 上的版本，**不在文档里钉死绝对路径或版本号**（旧写法 `N=.../22.22.2-3/node.exe` 已因版本下线而失效，2026-10-27 订正）。

1. **内核类型检查**：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`（须 EXIT=0）
2. **内核 lint（改动文件）**：`node node_modules/eslint/bin/eslint.js <files> --max-warnings 0`
3. **内核测试**：`node node_modules/vitest/vitest.mjs run`（**本容器实测 ≈371s，务必用 background**）
   - **跑完先按铁律五判假红**（数 `AssertionError`），别被 timeout 红误导成回归。
   - 基线**随改动漂移，引用前实测**；不要照抄历史数字。报基线须同时给「文件数 + 跳过文件/用例数 + 并行/串行」。
   - 新增测试数 = 与上次基线的差值，可用于自检「断言是否真跑起来了」。
4. **内核 build（清 dist + 编译，两步缺一不可）**：
   `node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})"` 然后
   `node node_modules/typescript/bin/tsc -p tsconfig.build.json` 然后
   `node node_modules/tsc-alias/dist/bin/index.js -p tsconfig.build.json`

   > `prepublishOnly` 已内置清 dist（`node -e fs.rmSync`），不必另装 `rimraf`——`npx rimraf` 在无 bash 环境会 EXIT=127。

   ⚠️ **漏掉 `tsc-alias` 会伪造一批「内核缺陷」假象**（2026-10-04 实踩，差点误判）：
   `tsc` 只编译、**不解 `@/` 路径别名**，产物里保留 `from '@/agent/agent.js'`。
   宿主加载该产物时抛 `Cannot find package '@/agent/agent.js'`，**且宿主 `tsc --noEmit`
   会冒出一批与本轮改动毫不相关的类型报错**（当时 101 行 `TS7006 implicitly any`
   + `RoundView` 的 `interactiveInputs`/`assistantLog` 可选/必填冲突）——
   这些**全部是 dist 缺 alias 的假象**，补上第二步后宿主 tsc 归零。
   **判别信号**：报错集中在**你没碰过的文件**、且内容是「类型突然变窄 / 回调参数变 any」
   ⇒ 先怀疑 dist 构建不完整，别去改那些文件。
   同理**别把「本轮改动让报错变多」当结论**——用 `git worktree add <tmp> HEAD` 建只读
   对照树跑一遍同样命令比较行数（本轮实测 HEAD 413 行 vs 工作树 101 行 ⇒ 本轮实际**减少** 312 行）。
5. **宿主 build（必做，见铁律一）**：`cd hosts/memora-vscode && node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})"` 然后
   `node ../../node_modules/typescript/bin/tsc -p ./` 然后 `node esbuild.config.mjs`
6. **契约闸门**：`cd <repo> && node scripts/verify-dist-contract.mjs`（须 ✅ 同代 hash）
7. **发布边界死链闸门**（local-ci full 已含全仓 `docs:links:repo` + `terminology:check` + `rules:refs` + `format:check`；**步数以 `scripts/local-ci.mjs` 为准，本技能不写死**——历史教训：技能里写过「14 步」而实际已变；但「随包 markdown 链接到包外文件」的**越界检查**（[B] 类）是发布模式特有，full 档不覆盖，仍须单跑）：`node node_modules/tsx/dist/cli.mjs scripts/check-publish-links.ts`
8. **宿主测试**（串行，约 100s，用 background）：`cd hosts/memora-vscode && node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --no-file-parallelism`
   - 基线同上：**引用前实测**，勿照抄。
   - ⚠️ 宿主 eslint **忽略 `__tests__`**：显式传测试文件会报 `File ignored` 并让 `--max-warnings 0` 失败——这是预期行为，不是缺陷，别去改配置。

> **第 1–3 步与第 4 步的顺序**：若本次改了内核导出形状，**第 4 步（内核 build）必须先于任何宿主 tsc/测试**（见铁律一子陷阱）。
> ⚠️ **管道吞退出码**：`cmd | head` / `| tail` 时，退出码取自管道**尾端**，`cmd` 的失败会被吞成假绿。
> 过滤长输出时，要么直读原始输出，要么 `... | node -e "..."` 用 Node 脚本过滤（`ls`/`head`/`tail`/`grep` 本身可用，
> 但**别让它们当管道末端**去承接需要判读退出码的命令）。

## 铁律二：台账状态串不可信

`tasks/待完成任务.md` 里标「待提交」的条目**可能早已入库**（工作区操作会回退台账）。发版前必须复核：

```
git status --porcelain      # 真实工作区改动
git log --oneline -8        # 最近提交
git log --oneline -3 -- <file>   # 逐文件确认是否已提交
```

发现过期状态 → 订正台账（台账是 SSOT，状态错了等于撒谎）。

## 铁律三：发布边界 = package.json#files 白名单

新增 `docs/**` 未必随包。判断某文件是否进 npm 包：

```
读 <repo>/package.json 的 "files" 数组
```

不随包的文件无需过 `docs:links`，也不会影响发布包质量。

核对实际打进包的内容用 `npm pack --dry-run`（对着 `files` 逐项看：无越界、关键产物 `dist`/`README`/`LICENSE`/随包 `docs` 齐全）。**白名单不为了让某个文件进包而临时加**——敏感或无关文件尤其不行。

## 铁律四：新增测试必须做变异验证（本仓硬性约定）

测试**通过**不等于测试**有效**。新增护栏后，必须临时把被测逻辑改坏，确认**只有该护栏变红**，再恢复：

```
① 改坏（回退到修复前的缺陷态）
② 跑该测试文件 → 期望：仅新增用例红，其余全绿
③ 恢复 → grep 确认无残留（别只靠记忆，须字节级核对）
```

判定要点：
- 若**全绿** → 护栏没测到东西（假护栏）
- 若**全红** → 护栏太粗，无法定位（可能「因错误的原因通过」）
- 恢复后必须复核「变异已完全还原」：`node -e "console.log(fs.readFileSync(f,'utf8').includes('<变异文本>'))"` → 须 `false`

## 铁律五：本环境「假红」判定 —— 先数 AssertionError，再谈别的

本容器（AI 沙箱）的**文件删除有 ~78 ms/文件的串行开销**，会让带 `afterEach/afterAll rmSync`
清理的测试随机超时。**这是容器特性，不是代码缺陷，也不是你的真实开发终端。**
（2026-09-26 实测：`npm run compile` 在本容器 `ETIMEDOUT`，用户真实终端同一操作顺利通过。）

### 四步定性法（按成本升序，够用即停）

| # | 动作 | 判读 |
| - | --- | --- |
| 1 | **数 `AssertionError`**（失败日志里 grep） | **= 0 且失败全是 `timed out` → 环境假红，直接结案**；> 0 → 才可能真回归，进第 2 步 |
| 2 | 隔离复跑：`vitest run <file> --no-file-parallelism` | 转绿 / 失败数大幅下降 → 跨文件 IO 竞争放大，非代码 |
| 3 | IO 基准（写、删各 150 个文件计时） | **写 ≈1.5 ms/文件、删 ≈78 ms/文件** = 删除被外部串行化 |
| 4 | 三组对照（原样 / `CODEBUDDY_SAFE_DELETE_ENABLED=0` / `NODE_OPTIONS=`） | 三组同量级 ⇒ **排除 safe-delete shim 嫌疑** |

辅助信号：**同一 commit、同一命令，两次跑失败集合不同**（红者换了一批）→ 假红。

### 实测锚点（2026-09-26）

- 内核全量：**8 files / 11 tests failed | 2782 passed**，Duration **371s**；`AssertionError = 0`，
  8 次错误 = 7×`Hook timed out in 10000ms` + 1×`Test timed out in 5000ms`。
- 钩子体（涉事文件共性）= `await agent.close()` + `rmSync(recursive)` 清临时目录。
- 隔离复跑 4 个涉事文件：失败 **11 → 1**（残留那个仍是 hook timeout）。
- 删除策略对比（150 文件，ms/文件）：`unlinkSync` 104.8 / `rmSync recursive` 93.7 / `await unlink` 85.5
  / `promises.rm` 43.5 / **并发 32 路 29.6** —— 并发能摊薄 = 单点串行队列（非磁盘）。
- 三组对照（同步 `unlinkSync`）：原样 104.8 / 关 safe-delete 74.1 / 清空 `NODE_OPTIONS` 78.2 ms/文件。

### 禁区（做了就是造假绿或掩盖环境）

- ❌ **不得改 `vitest.config.ts` 的 `hookTimeout` / `testTimeout`**（那是改判据）。
  `--hookTimeout=... --testTimeout=...` **仅可作一次性诊断**，不进配置、不进 `package.json`。
- ❌ **不得为绕过容器慢 IO 而改测试的清理实现**（`rmSync` → 异步/并发删除）。收益有限
  （并发也只到 29.6 ms/文件），且属「用代码掩盖环境」——真实终端无此现象。
- ❌ **不得在红灯上直接归因代码**（与 `docs/测试并发确定性与flake判定SOP.md` §3/§5 同源）。

> 判据 SSOT = `docs/测试并发确定性与flake判定SOP.md` §3「超时型假红」节；本处是它在发布流程里的入口。

## 提交环节（git 写操作走 PowerShell，AI 可直接提交）

**2026-09-28 复测更新**：旧结论「git 写操作不可行」已失效——PowerShell 已恢复派生能力，`git` 2.52.0 可在 PowerShell 内直接写操作。范式（详见 `git-commit-windows` 技能）：

1. 写 UTF-8 提交信息文件到 `.git/COMMIT_MSG_N.txt`（不会被 `git add` 误纳）
2. 预验：`node node_modules/@commitlint/cli/lib/cli.js --edit .git/COMMIT_MSG_N.txt`
3. PowerShell：`$env:LEFTHOOK='0'`（质量门已先行跑过 full 档，非裸 skip）→ `git add` **逐文件**（禁 `git add -A`）→ `git commit -F .git/COMMIT_MSG_N.txt` → 输出 `| Out-File -Encoding utf8` 落盘 → Read 复核
4. 再用 **Bash 只读** `git log -1 --format=%B | od -c` 独立校验中文字节（PowerShell 回显中文是 GBK 乱码，勿据此重提交）
5. 提交但不推送（用户自己 push）

Bash 仍只做只读 git（FS 错配红线不变）。

### 提交分工（chunk 建议）

一次发布前常混着多类改动，按类型拆提交，保持历史可读：

- **内核代码 + 测试**：`fix(<module>): 一行式说明为什么`。
- **发布脚本 / 配置**：`chore(release): ...` 纯构建链改动。
- **文档 + 台账**：`docs(...)`；状态以 git 实证为准（见铁律二）。

## 发版动作（自动 vs 手工）

| 动作 | 自动化程度 |
| --- | --- |
| 内核 `npm publish` | `prepublishOnly` 自动 `rmSync dist` + build（**已去 npx 依赖**，因为 npx 在本环境 EXIT=127） |
| 宿主 `npm run package` | `vscode:prepublish` → `npm run compile` 自动清 dist + tsc + esbuild |

顺序：内核先发 → 宿主后发 → 打 tag（不打标不发布）。

推 tag 即触发 `release.yml`：OIDC 免令牌**暂存发布** → 门禁过 + 本人 2FA 审批才真正上架。「`npm publish` 之后补 tag」是旧流程，已弃用。

> 本技能只管「**能不能发**」；「**怎么发**」（publish / package / tag 的具体动作）归 `memora-kernel-release` 技能。

### tag 命名（踩过就回不去）

- 内核 tag = **`vX.Y.Z`**（如 `v5.1.0`）；**不是** `memora@<版本>` —— 后者不触发 `release.yml`，等于静默不发版（见 ADR-033 决策 2「偏离原案」注释）。
- `release.yml` 的触发式必须是 **`v[0-9]*`**，**不能写 `v*`**：宿主 tag 以字母 v 开头（`vscode@0.3.0`），`v*` 会把它一起命中（2026-10-23 实测）。

## 已知坑（跨包改名 / 描述同步）

- **改公开 API 名或工具描述后，必须 grep 全库引用**：含 `hosts/`、`tsconfig` `include` 之外的脚本（历史教训：`searchHybrid` 改名漏改宿主验证脚本与 dist，发布包带旧名运行时崩）。
- 工具描述里「如 X、Y、Z」这类清单，宿主执行器头部注释也抄了一份 ⇒ 一并同步。
- 🔴 **Windows 上不要用 Bash 跑 git 写操作**：会污染索引（曾致 `tasks/` 十余文件被误标删除，纯 ASCII 路径同样触发）。发布链需要写操作走 PowerShell，或 `node -e` 原生实现。

## 判定标准速查

- 内核：changed files eslint EXIT=0 + 全量测试 0 失败 + build 成功
- 宿主：tsc 成功 + esbuild 成功 + **契约同代 hash** + 宿主测试 0 失败
- 发布包：`docs:links` 0 死链 + 台账无过期状态 + `files` 白名单确认（`npm pack --dry-run` 实核）
- 以上全过 = 就绪；剩「发布动作」本身（publish / package / tag）由用户确认后执行
