# Memora 下一迭代设计 + v3.0.0 发布前 Go/No-Go

**日期**：2026-09-16
**工作流**：工作流 2（系统设计）+ 工作流 4（部署前检查）— 混合，因用户诉求「推进下一步迭代」同时覆盖「迭代怎么落」与「现在能不能发」
**参与成员**：Cody（代码审查师）· Archi（系统架构师）· Rex（SRE 工程师）· Tessa（测试专家）· Docu（技术文档师）
**主理人**：甄宇航（工程督导）

---

## 📌 TL;DR（执行摘要）

- **发布判定 = 🔴 CONDITIONAL NO-GO，4 项阻塞未清**（tag 占用 / 出口数字 / SEARCH-1 真机 / 门禁无实证）。
- **下一迭代方向 = 门禁所有权闭环**：往**既有** pre-push 钩子体填步骤 + 分层（fast/full）+ 补 `host:build` 与 `verify:dist-contract`，**不新增第四条通道**。
- **本轮最大的产出不是设计，而是勘误**：共查实 **5 处前提错误**（含主理人自己 3 处），其中 1 处是主理人据未经核实的前提发出的 🔴 误判，已撤回。
- 严重度分布：🔴 严重 0 项 / 🟠 高 3 项 / 🟡 中 8 项 / 🟢 低 3 项。
- 好消息：**7 笔既定提交早已落地并推送**，工作树干净，无「发包前先提交」类阻塞。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 整体评级 | 🟡 **有条件通过**（迭代设计可执行）/ 🔴 **v3.0.0 暂不发布** |
| 阻塞项数量 | **4**（全部为流程/验证类，**非**代码正确性） |
| 关键行动项 | **7** 条（见下） |
| 建议下一步 | ① 先清 4 项阻塞 → ② 同批落「门禁分层 + `host:build` + `verify:dist-contract`」→ ③ 再发 npm |

---

## 一、前提勘误（本轮最高价值产出）

> 五份成员产出中，**四份都先纠正了它拿到的问题前提**。这说明上一轮的需求/背景转述本身有错，比设计更值得先固化。

| # | 原陈述 | 复测结论 | 谁发现 / 谁复测 |
|---|--------|---------|----------------|
| **E1** | 「提交信息与提交内容不符（内核 4 步 vs 8 步），提交前必修」 | ❌ **假阳性，撤回**。`git show bbc1d1a6:scripts/local-ci.mjs` 的 `ALL_STEPS` = `kernel:typecheck/lint/test/**build** + host×3 + audit`（**无 `kernel:coverage`**）；`git show --name-only fda3621e` **含** `scripts/local-ci.mjs` → ①「内核 4 步」准确、③「新增 coverage 步」准确，**切分自洽** | 主理人自查 + Cody 独立复核 |
| **E2** | 「门禁三条通道**全不通电**」 | ❌ 不准。`.git/hooks/{pre-commit,pre-push,commit-msg,prepare-commit-msg}` **实存且活着**（`LEFTHOOK=0 → exit 0` 在 shim 第 7-9 行）；pre-commit **真在跑**（lint-staged + `tsc --noEmit`）。空的只是 **pre-push 钩子体** | Archi 提出 / 主理人 `Read .git/hooks/pre-commit` 复测 |
| **E3** | 「作者流程带 `LEFTHOOK=0`，故钩子必被绕过」 | ❌ **前提不成立**。成因是**环境能力缺失**（`2026-09-10.md:275` PowerShell 无法派生外部进程；`2026-08-08.md:331` 钩子跑不了 sh 子进程），**非怠惰**；`.git/hooks/pre-push` shim 活着 → 真实终端里钩子能跑 | Archi 提出 / 主理人**逐字复核两处引用属实** |
| **E4** | Archi 称 `memory/2026-09-12.md:145` 佐证「pre-push lefthook 实际执行」 | ❌ **引用不存在**。该行讲 `BUILTIN_TOOLS` 常量表；该文件全文 `lefthook\|pre-push` **0 命中** | 主理人复测（沿用上轮纪律：成员 file:line 引用须逐条复测） |
| **E5** | brief 把「未提交改动」列为发包冻结项 | ❌ **已过期**。`git status -sb` = `## main...origin/main`，`rev-list --left-right --count origin/main...HEAD` = `0  0` → 7 笔提交**已落地并推送**，工作树仅剩 `tasks/` 下 8 份未跟踪过程文档 | Rex 提出 / 主理人 `git` 只读复测 |
| **E6** | brief 未提 tag 状态 | ⚠️ **新发现**：`git tag v3.0.0` **已被占用**（annotated，2026-08-22，指向 `c429cba7`，注「仅打标不发布」）→ `git describe` = `v3.0.0-647-gfda3621e`，**tag 落后 HEAD 647 个提交** | Rex |

**系统性教训（建议入规则）**：
1. **凡涉「提交 / 文件 / 版本现状」的判定，必须跑 git 只读命令取证**，不得引用第三方叙述（含上一轮总结、台账文字）。E1/E5 皆因此致错。
2. **成员报告的 file:line 引用须逐条复测**——E4 之外，E3 的两处引用经复测**属实**，说明该纪律能区分「引用错」与「结论错」，两者处置不同。

---

## 二、下一迭代架构设计（工作流 2）

### 2.1 新增缺口（Archi 挖出，主理人已独立确认为实锤）

> **8 步门禁里没有 `host:build`。**
> `ALL_STEPS` = 内核 typecheck/lint/test/coverage/**build** + 宿主 typecheck/lint/**test** —— **宿主从不被构建**。而宿主 bundle（内联内核 `dist/`）才是用户实际在 VS Code 里运行的东西。
> → **`ci:local` 全绿可以与「宿主 bundle 陈旧」并存**。这正是项目自己记录过的「未改宿主 TS ≠ 未影响宿主 dist」陷阱，门禁对它**零覆盖**。
> 与 Tessa 的第 ⑥ 项（coverage 闸门只挂 dev-only 脚本）**同根**：门禁覆盖的边界画在了「源码可测性」，而非「用户实际运行物」。

### 2.2 分层门禁（推荐方案 E）

分层判据（推断，基于实测）：**J1** 输入可被 staged 集合限定；**J2** 单步 ≤30s（实测内核 `tsc` 23.0s / `lint` 17.0s，宿主 `tsc` 11.8s / `lint` 9.8s 全过；内核 `test` 98s、宿主 `test` 119s **出局**）；**J3 失败可归因本次改动** —— 决定性依据：`vitest.config.ts:26` 自记已知跨文件 flake，**测试进 pre-commit 必出假红，而假红直接诱发 `--no-verify`**。

| 档 | 构成 | 上限 | 挂载 |
|---|---|---|---|
| **fast** | lint-staged(staged .ts) + 内核 `tsc` + 宿主 `tsc` | ≤60s（p50 45s） | `pre-commit` |
| **full** | 现 8 步 + `host:build` + `verify:dist-contract` = **10 步** | ≤8min | `pre-push` |

**优于替代方案**：① 只挂 full（≈8min，**长默认路径本身就是绕过诱因**）；② pre-commit 另写内联命令（产生**第二份步骤清单 = 并列**）；③ 只留痕不挂钩子（不解决「谁触发」）。
**关键约束**：步骤定义**仍只在 `local-ci.mjs`**，钩子只当触发器（新增 `--preset=fast|full`），零重复定义。

### 2.3 抗绕过（诚实结论）

**不追求强制，追求「① 默认路径便宜 ② 绕过可被外部发现」。**
论证：本地钩子**物理不可强制**（`LEFTHOOK=0` / `--no-verify` / 直接删钩子）；本项目绕过先例的成因是**环境能力缺失而非怠惰**（见 E3）→ 当道德问题修必败；唯一真强制＝服务端 CI，而作者已否决 → **把「强制」一词从设计里删掉，不给假承诺**。

**唯一的杠杆**：`local-ci.mjs:157` 已落盘日志，**只在日志头加 4 行** `head / tree / preset / steps`（**不新增脚本、不新增服务**）→ 「全绿」从口头自证变成「**存在一份 `tree=X` 的 full 档日志**」；绕过一次即**无收据**，Go/No-Go 清单一行比对即可抓出。
> **自觉不可观测，缺口可观测。**

### 2.4 `verify:dist-contract` 契约

- **读**：内核 `dist/**` 汇总内容哈希；宿主 `dist/extension/extension.js`；构建期写入 `dist/extension/.build-stamp.json`。
- **断言**：① `stamp.kernelDistHash === 当前内核 dist 哈希`（宿主 dist 相对内核 dist 新鲜）；② 宿主**实际 import 的内核导出符号集**（扫 `hosts/memora-vscode/src` 里 `from '@zooique/memora'` 的导入名）逐个经 **esbuild ascii 大写 hex 转义**后在 bundle 中命中 —— **不硬编码业务字段名**（硬编码会腐烂）。
- **失败语义**：exit 1 并打印「陈旧：期望 hash=x 实得 y」或「缺符号：`partialReadFiles(\u53EA…)`」；dist 缺失时 `--allow-absent` 出声跳过（防全新 clone 误红）。
- **挂载**：full 档第 10 步（紧跟 `host:build`）；fast 档不跑（依赖 fresh build）。

> ⚠️ **Tessa 对「搜字符串」的正本清源（主理人已实测复现）**：esbuild `charset:'ascii'` **只转义字符串字面量，注释保留 UTF-8** → 裸 `includes(中文)` **双向失真**：注释命中 = **假绿**；仅存于字面量的词 = **假红**。实测宿主 bundle：`中断` 53 命中 / `任务进度` **0** 命中 / `\u4E2D` 转义 129 处。→ 契约实现**必须转义感知**（查询串先按 ascii 转义再匹配，或改 `import(dist)` 运行时 probe），**禁裸 `includes(中文)`**。

### 2.5 ADR-032（拟落 `.trae/decisions/ADR-032-gate-ownership-loop.md`，031 已占用）

- **Context**：CI 自动触发被作者否决；`local-ci.mjs` 无触发器；覆盖率闸门曾长期无链路。
- **Decision**：恢复 `lefthook.yml` 的 pre-push **钩子体**，体内容 = `npm run ci:local --preset=full`；pre-commit 加 `--preset=fast`；步骤 SSOT 锁定 `local-ci.mjs`。
- **Consequences**：+ 默认路径便宜 / 绕过留缺口 / 覆盖宿主 dist 陈旧；− 须把 `kernel-ci.yml` 头注记为「已停用，等价物见 local-ci」。
- **Alternatives**：恢复 Actions（否决）／pre-commit 跑全量（假红）／独立门禁服务（复杂度）。
- **嫁接 vs 并列（诚实结论）**：本轮**是嫁接** —— 接活既有触发器 + 复用既有步骤体，不新增第四条通道。但须承认：`local-ci.mjs` 与 `kernel-ci.yml` 两份步骤清单**是上一轮引入的既成并列**，本轮只做收口标注，**不再扩大**。

### 2.6 明确不做（预支复杂度）

恢复 Actions 自动触发；三档 / 增量缓存（turbo·nx）；按 staged 静态推断受影响测试；门禁看板与告警；bundle 全导出符号熔断（tree-shaking 会误红）；钩子防篡改自检；再抬覆盖率阈值；徽章数字自动化生成脚本。

---

## 三、门禁测试策略（工作流 2 附：负面控制）

### 3.1 如何证明「门禁真会拦」（核心）

> 当前状态：**「会不会拦」无法证明**。`ci:local` 全仓仅命中 `package.json:49` 自身 → 无触发者；脚本自身不在任何门内（D4）；两处守卫其一为弱守卫。

**触发时机只能用真 git 事件证**：违规入 staged → **真跑 `git commit`** → 断言 `exit≠0` **且** `git rev-parse HEAD` **未前进**。fast/pre-commit 与 full/pre-push **须分别用 commit / push 触发**。
**有效性走 `testing_rules.md §5.5` 三态**：注入违规 → 红 → 还原 → 绿；再「拿掉该断言 → 绿」证明**红在该断言**。
**已知逃逸**：`LEFTHOOK=0` 即 exit 0（shim 第 7-9 行）、`--no-verify` 亦可绕；CI 触发已注释 → **无 server-side 兜底**。

### 3.2 `verify:dist-contract` 的负向可证性（5 组变异）

| # | 变异 | 期望 | 证明什么 |
|---|---|---|---|
| 1 | 改 `src` 加一个会进 bundle 的标记、**不重编** | 必红 | 契约方向正确 |
| 2 | `npm run build` 后 | 转绿 | 非恒红 |
| 3 | **删掉**「dist 含 F」那条断言 | 转绿 | §5.5#3，红落在该断言 |
| 4 | 手改 dist 中转义串一位 hex | 必红 | 非靠注释字面蒙过 |
| 5 | `git checkout HEAD -- hosts/.../dist`（旧 dist + 新 src） | 必红 | **若不红 → 契约方向写反** |

### 3.3 fast 档**必漏**（须在文档写明）

① 覆盖率闸门（40s+ 且需 clean）；② **跨模块间接回归**（`--changed` 只跑直连；**宿主软链内核 → 改内核必 full**）；③ **build / dist 契约**（fast 不 build → **dist 陈旧全盲**）；④ 宿主 476 用例。

### 3.4 现有守卫缺口（对照 §5.1–§5.5，仅报实读确认）

| # | 位置 | 缺口 |
|---|---|---|
| ① | `roundStore.test.ts:411-495` | 三闭环齐（`:473/:483/:494`），但**同处一个 `it` 串行** → 主断言 `hits` 先红则后三条**不执行**，**不能独立报警**（违法 §5.2） |
| ② | 同上 `:412` | `roots` 硬编码 → §5.5 四组**无可复现载体**（仅注释称「实测暴露」）→ 无法对合成 fixture 做变异自证 |
| ③ | `metrics.test.ts:577-593` | **§5.5#1 不成立**（写成硬编码常量仍绿，`:588` 自认）→ 该维度为**假闸门** |
| ④ | 同上 `:591` | `expect(...).toBe(0)` 属 §4「只断言取值、不证行为」；团队称 `llmCaller.test.ts` 已守「会否递增」，但本文件**无 file:line 锚点** → 不可追溯 |
| ⑤ | `scripts/local-ci.mjs` | 不在 tsc / lint 任何门内（见 4.4） |

**主理人裁决（两成员判断相反处）**：主理人上一轮曾把 `metrics.test.ts:577-593` 评为「质量加分」，Tessa 判为「假闸门」。**裁决：两者各对一半** —— 它是**真守卫但覆盖面窄**：「删掉出闸行」这类变异会被 `tsc(TS2741)` + 该断言**双重捕获**（上一轮变异验证实测），故**不是**假闸门；但它在 **§5.5#1 维度确实失效**（硬编码常量无感），且**未声明为源码扫描型却按源码扫描型评价**是评价口径之误。**处置：保留该守卫、补 ③④ 两项（喂违规批次 → 计数 0→1），并在注释里明确它是「契约型弱守卫」而非扫描型。**

---

## 四、代码审查发现（工作流 1 片段）

### 4.1 三笔已推送提交的风险（只能靠后续提交修正）

| # | 级 | 类 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|---|
| 1 | 🟠 | 正确性 | `local-ci.mjs:120-123` | 超时只 `child.kill('SIGKILL')` 杀 shell；`shell:true` 下 npm/vitest **孙进程不被杀** → 孤儿/僵尸，15min 超时不完备 | later：POSIX `detached`+`kill(-pid)`；Windows `taskkill /PID /T /F` |
| 2 | 🟠 | 覆盖链路 | `local-ci.mjs:57` + `kernel-ci.yml:74-87` | **coverage 闸门只挂 dev-only 脚本**，CI 仍只跑 typecheck/lint/test/build → 「接上真会跑的链路」**仅对手动 ci:local 成立** | later：CI 增 `test:cov`，或文档明示「闸门 = 本地人工」 |
| 3 | 🟡 | 可维护性 | `local-ci.mjs:125-126` | `d.toString()` 按 utf8 解码，Windows 中文多为 CP936 → 日志乱码（英文 stats 正则不受影响） | later：按 locale 解码或文档注明 |
| 4 | 🟡 | 正确性 | `vitest.config.ts:50` | 83→88 本身安全（实测缓冲 4.35 点），但**论证循环**（`testing_rules.md:36` 称「文档是配置的描述」，config 又称「以文档为准」=互相引证），且**四阈值不等比**（lines/stmts 留 ~10 点、functions 仅 4 点）→ **体系不自洽** | 二选一：实测为 SSOT 统一留 ~5 点；或以文档为唯一 SSOT 同步四值 |
| 5 | 🟡 | 可维护性 | `local-ci.mjs:157` | 每次新日志、无轮转 → 堆积 | 可选：留最近 N 份 |
| 6 | 🟢 | 安全 | `local-ci.mjs:115/:157` | **无注入面**：命令全字面常量；`--from` 仅与固定 id 比对、**从不进命令**；日志路径 = ROOT+时间戳 | **不修** |
| 7 | 🟢 | 正确性 | `projectSearchProvider.ts:274,339-341` | `LoadedText` 穷尽性 **OK**（非 switch，`if(kind==='unreadable')` 收窄保护；加第三 kind 漏字段会 TS 报错） | **不修** |

### 4.2 三条主理人提出缺陷的最终判定

| 项 | 判定 | 依据 |
|---|---|---|
| **D1** 提交信息与内容不符 | ❌ **撤回（非缺陷）** | 见 E1 |
| **D2** 台账缺记 | ✅ **成立，需补** | `已完成任务.md` 仅 `:7` 一条 09-16（`:76` 是 09-15）；全文对 `local-ci`/`ci:local`/`pairingGuardFires` **0 命中**；审查报告（未跟踪）在库但**结论未入账** → 违红线「报告入库 ≠ 结论入账」 |
| **D3** 出口数字过期 | ✅ **成立，且是已推送的最实缺陷** | `README.md:9` / `README.en.md:9` = `3082`、`CHANGELOG.md:7` = `3082`、`kernel-ci.yml:11` = `2337` vs 实测 **3100**。`已完成任务.md:76,90` 记明 09-15 已从 3025 → 3077 → **现为第 5 次复发** |
| **D4** 新脚本不在门内 | ✅ **成立，但修法不完整** | `eslint.config.mjs:7` = `**/*.ts` + `package.json:47` = `--ext .ts`（**flat config 下 `--ext` 失效，实际由 `files` 决定**）→ `.mjs` 双不匹配；`tsconfig.json:30` include = `src/**` → 亦不类型检查。**修法须覆盖根目录 `commitlint.config.mjs` / `eslint.config.mjs`**（原修法只加 `scripts/**/*.mjs`，不完整）。建议**单开一 block 用默认 parser**，勿塞进含 `tsparser` 的对象 |

**D3 修正补充（Cody 补漏，主理人采纳）**：原修法只点了 `README.md:9`/`README.en.md:9`/`CHANGELOG.md:7`，**遗漏 `README.md:8` / `README.en.md:8` 的 `coverage-90%` 徽章**（同为硬编码）。→ 硬编码徽章共 **4 处**。

### 4.3 明确「不建议修」（否决过度修正，主理人采纳）

| 项 | 理由 |
|---|---|
| `local-ci.mjs` 未进 `package.json#files` 白名单 | dev-only 惯例；消费者 `npm install` 不装 devDeps，`test`/`build`/`lint` 在安装包里同样失败。**真正要守的边界是 `main`/`types`/`exports` 三处指向 dist**，`npm pack` 已验中靶 |
| `.workbuddy/tmp/` 日志路径 | 安全且 `.gitignore:40` 已覆盖 |
| `LoadedText` 判别联合改 switch | 非缺陷，勿强改 |
| 历史过程文档残留 `oversizedSkipped` | 时点快照，勿回改 |
| 徽章数字自动化生成脚本 | 本轮手工同步即可（预支复杂度） |

---

## 五、v3.0.0 发布前 Go/No-Go（工作流 4）

### 5.1 检查清单

| 组 | 检查项 | 状态 | 依据 | 阻塞 |
|---|---|---|---|---|
| 门禁 | GitHub CI 触发 | ❌ | `kernel-ci.yml:32-39` 注释；**仓库内无 release workflow**（仅 kernel-ci + dependabot） | 否 |
| 门禁 | pre-push 测试 | ❌ | `lefthook.yml:33-36` 注释（**钩子体为空，触发器在**） | 否 |
| 门禁 | `npm run ci:local` 在 HEAD 留全绿日志 | ❌ 未跑 | `local-ci.mjs`（无触发器） | **是（B4）** |
| 代码 | 工作区干净 | ✅ | `git status`：源码 0 改动，仅 8 份未跟踪 `tasks/*` | 否 |
| 代码 | 改名无残留 | ✅ | `oversizedSkipped` 在 `src/` 与宿主 `src/` 均 0 命中 | 否 |
| 代码 | dist 与 HEAD 一致 | ⚠️ | 含新字段（`dist/project-search/types.d.ts`）＝一致；但含 416 个 `__tests__/*` 条目而 `tsconfig.build.json:7` 排除之 → **非 `npm run build` 产物**（历史残留）。`prepublishOnly` 会重建，**不污染发布包** | 否 |
| 文档 | 出口数字 | ❌ | 4 处硬编码徽章 + `CHANGELOG.md:7` + `kernel-ci.yml:11` | **是（B2）** |
| 文档 | 出货死链 `npm run docs:links` | ⚠️ 未跑 | `check-publish-links.ts` 已备 | 否（建议跑） |
| 边界 | `files` 白名单 12 项齐备 | ✅ | 12 项在磁盘均存在 | 否 |
| 边界 | 真实 tarball | ✅ | `npm pack --dry-run --ignore-scripts` = **964 文件 / 1.4MB**；`main`/`types`/`exports` 命中 `dist/index.js` + `.d.ts` | 否 |
| 边界 | `scripts/` 不在包内 | ✅ N/A | 见 4.3 | 否 |
| 边界 | 发布须在**真实终端** | ⚠️ | `prepublishOnly` = `rimraf dist` → 安全层拦 `rm -rf` 类调用，**不可在本 agent 沙箱执行** | 否（操作约束） |
| 真机 | SEARCH-1 S1+S2 重载验证 | ❌ 未跑 | `待完成任务.md:65` | **是（B3）** |
| 真机 | CTX-1b / VERIFY-1 / FAIL-1 | ❌ 未跑 | `:61` / `:53`（明写「非阻断项」）/ `:52`（环境阻塞） | 否 |
| 台账 | 审查结论转台账 | ❌ | `grep tasks/`：仅未跟踪报告自身命中 | 否 |
| 标签 | `git tag v3.0.0` | ❌ **新发现** | 已存在（annotated，2026-08-22，指向 `c429cba7`）；`git describe` = `v3.0.0-647-gfda3621e` | **是（B1）** |
| 规则 | **`legacy-contract-audit-rules.md` §7 四条逐行核对** | ✅ **2026-09-24 补挂**（原清单漏此行） | §7.1「挂载节律」要求本清单含此项，09-16 提案至 09-24 **未执行**。本轮已核对：四条结论均「维持登记（非结案）」，写入 §7 表格末列「上次核对」；同步已登记入台账 3.0.0 区。**核对恒强制、结案需触发**（四条到期 2026-11-14，第 4 条无到期日） | 否 |

### 5.2 阻塞项与**可验证的**解除判据

| 编号 | 阻塞项 | 解除判据 |
|---|---|---|
| **B1** | tag 已被占用（落后 HEAD 647 提交） | 拍板并留痕：`git tag -f v3.0.0` + 强推 + 删/重建 Release，**或**另打新 tag。判据：`git rev-parse v3.0.0^{commit}` == HEAD |
| **B2** | 出口数字过期（第 5 次复发） | `README.md:8,9` / `README.en.md:8,9` / `CHANGELOG.md:7` 全部同步（coverage → 实测值、tests → **3100**）。判据：`grep -rn "3082\|coverage-90" README* CHANGELOG.md` → **0 命中**。**tarball 不可变，发出去就永久错** |
| **B3** | SEARCH-1 真机复验 | 重载 VS Code 后 5 条逐条过：多词放宽 / 零命中+缺口双事实 / 失败不称「未找到」 / 大文件前段可命中+后段上报 / 不可读不静默 |
| **B4** | 门禁无实证 | `npm run ci:local` exit=0 且 10 段日志全 exit=0。判据：`.workbuddy/tmp/local-ci-*.log` 存在且头部含 `tree=` / `head=` |

> **两位成员对 #4 标题相反的处理**：Archi 判 `CONDITIONAL NO-GO`（含真机复验积压），Rex 判「有条件 Go」（把 CTX-1b/VERIFY-1/FAIL-1 列为非阻断，依 `待完成任务.md` 的自述定性）。**主理人裁决：取 NO-GO** —— 理由：① B1（tag 占用）是 Rex 自己发现、Archi 未覆盖的**硬性流程阻塞**，任何一方都无法豁免；② B2 一经发布**不可逆**；③ B3 两者**都**列为阻塞。同时**采纳 Rex 的非阻断分类**（CTX-1b / VERIFY-1 / FAIL-1 不阻断，依据是台账自述「VERIFY-1 非阻断项」「FAIL-1 环境阻塞」）。

### 5.3 回滚

- **已发 npm 后**：立即 `npm deprecate @zooique/memora@3.0.0 "<原因>"`（3.0.0 **不宜 unpublish**）→ 发 `3.0.1`，必要时 `npm dist-tag add/rm`。`npm unpublish` 仅发布后 **72h 内**可行，超时只能发补丁版（npm 政策）。
- **代码回滚**：`git revert`（HEAD=`fda3621e`），**禁 force-push**。
- **宿主不受影响**：esbuild 内联内核 dist 软链、**不走 registry** → 内核回滚不牵连宿主；宿主 `private: true`，重编 dist 即回滚，零版本成本。
- **发布前**：未打 tag 即停手，成本为零。

### 5.4 发版后即验（T+0）

① 临时目录 `npm i` 后 `import('@zooique/memora')` 键数非空；② `node_modules/@zooique/memora/dist/index.js` 存在；③ 建引用 `.d.ts` 的小文件跑 `tsc --noEmit`（types 可解析）；④ `tar -tzf` 确认包内**无** `dist/**/__tests__`；⑤ CJS 冒烟 `require(...)` **预期失败**（exports 无 require 条件，ESM-only）——若文档未声明即算**文档缺陷**；⑥ 确认 `pino` 为 optional peer、未阻塞消费者。

---

## 六、规则层改稿（工作流 5 片段）

### ① `legacy-contract-audit-rules.md §7` 补「复查节律 7.1」

> §7 有登记、无消费机制，本条即 §3「僵尸声明」在规则层的复现。故每条候选**必须**带**登记日期**与**复查触发条件**，缺一不得登记。

| 项 | 约定 |
|---|---|
| 登记日期 | 精确到日；真机现象取首观测日，其余取登记日 |
| 复查触发 | 满足任一即复查：① 到期（默认登记 + 60 天）② 事件（信号再现 / 依赖项变动 / 版本切档） |
| 复查动作 | **复现 / 收敛 / 降级回 docs / 回退** 四选一，写结论并更新本行；样本不足无法定类时取「降级回 docs」并注明缺口，**不得停留原状** |
| 挂载节律 | 随 **v3.0.0 发版前 Go/No-Go 检查清单**执行：发版前逐行核对触发条件，到期行强制结案 |

§7 表格增列 `登记日期 / 复查触发`。

### ② `legacy-contract-audit-rules.md §3` 写明僵尸声明**判据层级**

> **僵尸声明判据的层级**：判据落点在**内核公开导出面**，非端到端消费面。字段进入公开导出面（`AgentMetrics` 等经 `src/index.ts` 导出的类型 + 公开读方法）即算「活」——「能否被读到」在内核可判定，宿主是否消费归 **D4「宿主生长缺口」**（宿主有权不消费）。**未进入任何公开导出面、仅内核内部自增/派生 = 仍为僵尸**（无人能读的「假出闸」）。

> **Docu 的独立收紧（主理人采纳，优于原口径）**：补「假出闸」一条，堵住「导出即算活」被滥用的缝。已核实 `AgentMetrics` 经 `src/index.ts` 公开导出、`getMetrics()` 公开。如此 `pairingGuardFires`（本轮出闸）与 `emptyResponseCount`（早已出闸）**判据同源**，且不与 D4 冲突。

### ③ 覆盖率阈值 SSOT 归属正名

替换 `vitest.config.ts:46-50` 的注释：

```ts
        lines: 80,
        // 覆盖率判据以本文件为 SSOT（机器只执行此处的量）。functions 由 83 恢复到 88：
        // 88 是 testing_rules.md §3 标注的「1.0 发布阈值」（原始意图），83 系 99edf24c 漂移；
        // 实测 92.27%（2026-09-16），置 88 留约 4.3 点缓冲。
        functions: 88,
```

替换 `testing_rules.md:36`：

```markdown
> 阈值的判据 SSOT = `vitest.config.ts` 的 `coverage.thresholds`（机器只执行此处的量）；本表与之同源对齐，冲突时以 config 为准并回填本表。
> 本表「1.0 发布阈值」是**意图来源**：提升 config 阈值属「改判据」动作，须带观测 + 退出条件后方可落 config。
```

> **原病**：把「自称『非目标』的描述性文字」当作「以它为目标」的依据 —— **引文与结论反向**。新表述明确「config = 判据 SSOT」，并把 88 的正当性归「恢复 1.0 原始意图 + 实测缓冲」，**禁止以描述性文字自我授权**，杜绝同类矛盾再犯。

---

## ✅ 行动清单（按优先级排序）

| # | 行动 | 负责角色 | 紧急度 | 预期完成 |
|---|------|---------|--------|---------|
| 1 | **拍板并处置 `v3.0.0` tag 冲突**（`git tag -f` 强推 + 重建 Release，或另打新 tag） | 作者 | **P0** | 发布前必办 |
| 2 | **同步 4 处硬编码徽章 + `CHANGELOG.md:7` + `kernel-ci.yml:11`**（tests→3100；建议 coverage 徽章改无数字静态） | Docu 供稿 / 作者落盘 | **P0** | 发布前必办 |
| 3 | **跑 `npm run ci:local` 留全绿日志**（10 步含 `host:build` + `verify:dist-contract`） | 作者 | **P0** | 发布前必办 |
| 4 | **SEARCH-1 S1+S2 真机复验**（5 条判据逐条过） | 作者 | **P0** | 发布前必办 |
| 5 | **落 ADR-032 + 门禁分层**：`lefthook.yml` pre-push 体回填、`local-ci.mjs` 加 `--preset=fast\|full`、日志头加 `tree/head/preset` | 下一迭代第一批 | P1 | 发版后立即 |
| 6 | **补 `host:build` + `verify:dist-contract`**（8→10 步），并按 §3.2 五组变异做负向可证 | 下一迭代第一批 | P1 | 发版后立即 |
| 7 | **补 D2 台账 09-16 条目** + **D4 补 `scripts/**/*.mjs`（含根目录两个 `.mjs`）** + 修守卫缺口 ①③④ | 下一迭代第二批 | P1 | 发版后 |
| 8 | 落规则层三处改稿（§7.1 复查节律 / §3 判据层级 / 覆盖率 SSOT） | Docu 稿已备 | P2 | 可随 #7 |
| 9 | 修 `local-ci.mjs` 超时孤儿进程（`taskkill /T` 或 `detached`+`kill(-pid)`） + 日志轮转 | 下一迭代第三批 | P2 | 按需 |

---

## ⚠️ 待完善 / 已知局限

1. **本报告未做真机验证**：门禁、`verify:dist-contract`、`host:build` 均为**设计**，无一行实现，其耗时上限（fast ≤60s / full ≤8min）为**按实测数的预算，非实测值**。
2. **`metrics.test.ts` 的评价分歧未完全消解**：主理人裁决为「真守卫但覆盖面窄」，与 Tessa「假闸门」的标签差异源于**评价口径**（是否按源码扫描型标准衡量）。已按裁决处置，但该守卫的**真实拦截能力**只经「删出闸行」一种变异验证。
3. **3.0.0 是否已发 npm 未能联网核实**：Cody 明确标注该项无法验证。若**已发**，则 `oversizedSkipped` → `partialReadFiles` 属**破坏性变更需 major**；若**未发**则零成本。**这是二值分歧，发布前必须确认**。
4. **`git` 复测的边界**：主理人本轮所有 git 操作经 `D:/Runtimes/Git/bin/git.exe` **只读**执行（`status` / `show` / `log` / `rev-list`）；**未执行任何 git 写操作**（符合项目红线）。
5. **E4 的严重性需留意**：Architect 的一处 file:line 引用不存在，且该引用恰是**支撑其自身结论的反向证据**。其结论经主理人独立复测**仍成立**，但该模式（引用不实）与上一轮「选择性呈现」同族，**建议在规则层固化「成员 file:line 引用须逐条复测」**。
6. **未覆盖**：`src/llm`、`role-pack`、`webview` 的非重点守卫未逐条核；宿主 203 个 jsdom 用例未做质量评估；性能/包体积回归未测。

---

## 📚 数据来源 & 成员产出索引

| 成员 | 任务 | 关键产出 |
|---|---|---|
| **Archi**（系统架构师） | #1 迭代架构设计（并自认领 #4） | 3 处前提修正（E2/E3/E4）；**新缺口：8 步无 `host:build`**；分层门禁方案 E（fast ≤60s / full ≤8min）+ 抗绕过论证 + `verify:dist-contract` 契约 + ADR-032 草案；`CONDITIONAL NO-GO` 判定 |
| **Tessa**（测试专家） | #2 门禁负面控制测试策略 | **esbuild 转义正本清源**（主理人已实测复现）；真 git 事件负面控制三态；dist 契约 **5 组变异**；守卫缺口 ①②③④；fast 档必漏四项 |
| **Cody**（代码审查师） | #3 待提交改动 + 缺陷修法风险 | D1 撤回复核；7 项风险表（含超时孤儿进程 🟠、coverage 闸门只挂 dev-only 脚本 🟠）；**D3 补漏：4 处硬编码徽章**；D4 修法不完整（flat config `--ext` 失效）；**5 项否决过度修正** |
| **Rex**（SRE 工程师） | #4 v3.0.0 Go/No-Go | **新发现：`v3.0.0` tag 已占用（落后 647 提交）**；`npm pack` 实据（964 文件/1.4MB，`main`/`types`/`exports` 中靶）；回滚方案（deprecate → 3.0.1）；发版后 T+0 六项即验；**3 处 brief 订正** |
| **Docu**（技术文档师） | #5 规则层三处改稿 | §7.1 复查节律（含增列示意）；§3 判据层级**并独立补「假出闸」堵漏**；覆盖率 SSOT 正名（`vitest.config.ts` + `testing_rules.md:36` 可粘贴文本） |
| **主理人**（工程督导） | 编排 + 裁决 + 汇编 | 独立复测：`.git/hooks/*`、3 处 memory 行号、`git show bbc1d1a6:fda3621e`、宿主 bundle 转义实测、`rev-list` ahead/behind；**撤回自己的 P1-①**；裁决 #4 标题分歧与 `metrics.test.ts` 评价分歧 |

**一手复测工具与环境**：Bash（Git Bash，`D:/Runtimes/Git/bin/git.exe` 只读）+ 托管 Node 22.22.2；`git` 只读命令、`node -e` / `.cjs` 探针、Grep/Read 真 FS。

---

> 本报告由工程保障团队 AI 协作生成，关键决策请由人类工程负责人复核。
> 其中涉及发布判定的 4 项阻塞，**必须**由作者在真实终端逐项留证后解除；本报告不构成发布授权。
