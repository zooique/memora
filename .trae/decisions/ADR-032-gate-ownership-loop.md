# ADR-032 · 门禁所有权闭环（本地钩子接管闸门：分层 + 单一定义 + 收据）

> **状态**：✅ 已接受
> **日期**：2026-09-16 **播种批次**：模式 A v1
> **来源**：2026-09-16 工程保障审查《闸门归属与 v3.0.0 Go/No-Go》
> （`deliverables/engineering-assurance/gate-ownership-and-v300-gonogo-2026-09-16.md`）

## 背景

四件事同时成立，才构成「门禁失效」这个真问题（单独任一件都不够）：

1. **触发端空缺**：`kernel-ci.yml:32-39` 的 push / pull_request 触发自 2026-08-27 起被注释，仅剩
   `workflow_dispatch`；`lefthook.yml` 的 pre-push 钩子体亦被注释。
   （注：`.git/hooks/` 下的钩子**是活的**，`pre-commit` 确实在跑 lint-staged + tsc —— 空的只是 pre-push 体。）
2. **执行端无触发器**：`scripts/local-ci.mjs` 是事实上的门禁，但全仓仅 `package.json:49` 自引用
   → 「跑没跑」在机制上不可验证，「全绿」只能口头自证。
3. **覆盖边界画错**：8 步里**没有 `host:build`**，而宿主 `dist/extension/extension.js`（esbuild 内联内核
   `dist/` 的单文件 bundle）才是用户在 VS Code 里实际运行的东西 → **「门禁全绿」与「宿主 bundle 陈旧」
   可以并存**。这与「覆盖率闸门只挂 dev-only 脚本」同根：门禁边界画在了**源码可测性**，而非**用户实际运行物**。
4. **脚本自身不在门内**：内核 `scripts/*.mjs` 与根目录 `.mjs`（`commitlint.config.mjs` / `eslint.config.mjs`）
   不被任何 lint 覆盖 —— `files: ['**/*.ts']` 不匹配 `.mjs`，而 `package.json` 的 `--ext .ts`
   在 flat config 下**不生效**（覆盖范围实际由 `files` 决定）→ 双不匹配。

## 决策

1. **回填既有 `pre-push` 钩子体**作为触发器；**不新增第四条通道**（不恢复 Actions 自动触发、不建门禁服务）。
2. **分层**：
   - `pre-commit` → `--preset=fast`（内核 `tsc` + 宿主 `tsc`）；`lint-staged`（staged `.ts`）留在钩子里就地修复。
   - `pre-push` → `--preset=full`（10 步）。
3. **步骤定义唯一收口在 `scripts/local-ci.mjs`**；`lefthook.yml` 只传 `--preset`，**禁止复制步骤清单**
   （复制即产生第二份「要跑什么」的清单 = 并列）。
4. **补两步**（8→10）：`host:build`（`npm run compile`，产出用户实际运行物）+
   `verify:dist-contract`（断言宿主 bundle 与内核 dist **同代**）。
5. **每次运行落盘收据**（`when / preset / head / tree / dirty / steps`）—— 见下「抗绕过」。

## 理由

- **判定「谁触发」必须先于「跑什么」**：有步骤体无触发器 = 门禁有实现但不会跑。
- **分层判据（J1/J2/J3）**：
  - J1 输入可被 staged 集合限定；
  - J2 单步 ≤30s（实测：内核 `tsc` 41.0s / 宿主 `tsc` 37.6s / 内核 lint 17s / 宿主 lint 9.8s；
    内核 `test` 98s、宿主 `test` 119s **出局**）；
  - J3 失败可归因本次改动 —— 决定性依据是 `vitest.config.ts:29` 自记的已知跨文件 flake：
    **测试进 pre-commit 必出假红，而假红直接诱发 `--no-verify`**。
- **fast 档刻意不含全量 lint**：`lint-staged` 只扫 staged 文件，足够；把全量 lint 塞进 fast 会突破时间预算。
- **内核 `tsc` 不再单独挂在钩子里**：fast 档已含 `kernel:typecheck`（同一条 `npm run typecheck`），
  单列即重复 → 收敛给 preset（这是「嫁接而非并列」在本 ADR 的最小落点）。

## 抗绕过：不承诺强制（诚实结论）

**本地钩子在物理上不可强制**：`LEFTHOOK=0`（`.git/hooks/pre-commit` shim 第 7-9 行 → `exit 0`）、
`git commit --no-verify`、直接删除钩子，都能绕。而**本项目绕过先例的成因是环境能力缺失而非怠惰**
（`memory/2026-09-10.md:275`：PowerShell 无法派生外部进程；`memory/2026-08-08.md:331`：钩子跑不了 `sh` 子进程）
→ 把它当道德问题去修必然失败。唯一真强制 = 服务端 CI，而自动触发已被作者否决。

**故本 ADR 明确不追求强制，只做两件事**：
1. **默认路径便宜** —— fast 档挂在 commit、full 档挂在 push（push 频率远低于 commit）；
2. **绕过可被外部发现** —— `local-ci.mjs` 本来就在落盘日志，本 ADR 只在日志头加 6 行收据
   （不新增脚本、不新增服务）。「全绿」由此从口头自证变成「**存在一份 `tree=X` 的 full 档日志**」：
   **绕过一次即无收据**，发布前检查清单一行比对即可发现。

> **自觉不可观测，缺口可观测。**

## 替代方案

| 方案 | 放弃原因 |
| ---- | -------- |
| 只挂 full 档（不做分层） | ≈8min 的默认路径**本身就是绕过诱因**（长路径 → `--no-verify`） |
| pre-commit 里另写内联命令（不调 local-ci） | 产生**第二份步骤清单 = 并列**，两处必然漂移 |
| 恢复 GitHub Actions 自动触发 | 作者已否决；且 CI 不含 coverage 与 `host:build`，等价物仍要本地补 |
| 只留日志不挂钩子 | 不解决「谁触发」，等于维持现状 |
| 独立门禁服务 / 三档 / 增量缓存（turbo·nx） | 预支复杂度；当前 10 步规模用不上 |

## 影响

- `lefthook.yml`：pre-commit 增 `gate-fast`、去重复的内核 tsc；pre-push 回填 `gate-full`。
- `scripts/local-ci.mjs`：增 `--preset`、`host:build`、`verify:dist-contract`、收据；超时改为**杀整棵进程树**
  （原实现只 `child.kill()` shell，`shell: true` 下 npm/vitest 孙进程不被杀 → 孤儿）。
- 新增 `scripts/lib/dist-hash.mjs`（内核 dist 内容哈希，**单一实现**）与 `scripts/verify-dist-contract.mjs`。
- `hosts/memora-vscode/esbuild.config.mjs`：构建期写 `dist/.build-stamp.json`。
- `kernel-ci.yml`：头注标明「自动触发已停用，等价物见 `npm run ci:local`」。
- **既成并列（须承认）**：`local-ci.mjs` 与 `kernel-ci.yml` 两份步骤清单是**上一轮引入的**既成并列，
  本 ADR 只做收口标注，**不再扩大**。

## 已知局限（发版前须复核）

1. **fast 档实测 78.6s（2026-09-16，本环境冷跑）> 设计预算 60s**。原预算基于「内核 tsc 23.0s / 宿主 tsc 11.8s」，
   与本次实测（41.0s / 37.6s）差异显著 —— 环境差异或并发负载所致，**须在作者真实终端复测后再定稿数字**。
   J2 的「单步 ≤30s」判据在本环境下**不成立**，分层依据因此弱化，但「测试/覆盖率不进 fast」的结论不变。
2. `verify:dist-contract` 的符号面断言只覆盖「宿主源码 import 自内核**且被用到**」的名字，
   不做内核全量导出面比对（未使用的 import 会被 esbuild tree-shake，查它会假红）。
3. 收据中 `tree` = `HEAD^{tree}`，**不含未提交改动**；故 `dirty` 字段必须在场，
   否则脏树上的全绿会被误读为 HEAD 的全绿。

## 何时回顾

- 若 fast 档在真实终端稳定 > 90s → 重新评估是否把 `host:typecheck` 移出 fast（仅留内核 tsc）。
- 若出现「收据齐全但门禁仍失效」的实例 → 说明收据字段不足以定位，须补跑环境指纹（Node/pnpm 版本）。
- 若恢复 GitHub Actions 自动触发 → 本 ADR 的触发器部分让位，但 `host:build` / `verify:dist-contract`
  与步骤单一定义的约束**仍然有效**。
