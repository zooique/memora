---
name: "memora-kernel-release-readiness"
description: "内核（src/）改动后的 npm 发布就绪度验证流程：三条铁律 + 手工核查清单（自动门禁步数以 scripts/local-ci.mjs 为真源）+ 提交分工。触发场景：内核源码有改动准备发 npm 正式版时；用户问『可以发版了吗/发版前要做什么/发版就绪度审计』；跨内核/宿主 dist 的契约一致性核验。"
---

# 内核发布就绪度验证（memora-kernel-release-readiness）

> 内核（`src/`）任何改动落地后、`npm publish` 前，按本流程做发版就绪度验证。
> 设计依据：派生判定律（宿主 dist 代际由内核产物决定）+ 发布边界 = `files` 白名单 + 台账状态须 git 实证。

## 三条铁律（违反即带伤发布）

1. **宿主 dist 必随内核重建**：内核 `build` 不清 `dist`（旧产物残留）；宿主 bundle 若由旧内核代际构建，`verify:dist-contract` 会比较宿主 bundle 与内核 dist 的同代 hash——**不同代 EXIT=1 卡发布**。顺序：内核重建 dist → 宿主重编译 → 再跑契约闸门。
2. **台账状态不可信**：「待提交/待发布」等台账状态一律 `git log` 实证——历史多次出现台账标「待提交」实为早已入库（git log 一查便知）。流水账状态会过期，git 历史才是真源。
3. **发布边界 = `files` 白名单**：新增任何文件先核对 `package.json` `files`（`dist` + 显式清单）。不在白名单内的文件**不进包**（无风险）；在机敏感/无关文件也绝不临时加入白名单。用 `npm pack --dry-run` 核对实际打进包的清单。

## 验证环节（手工核查清单）

> 自动化门禁（类型/lint/测试/构建/格式/术语/引用/死链）的步骤清单**唯一定义处 = `scripts/local-ci.mjs`**（`--preset=full`）——它自身声明「步数由运行时打印，注释不写死」，故**本技能不写死门禁步数**（历史上出现过技能写「8 步」而门禁已 14 步的漂移）。
> 下列为**门禁之外的人工补充核查**，按顺序执行，任一项失败即定位修复后重跑：

1. **类型检查**：`npm run typecheck`（tsc --noEmit，EXIT=0）。
2. **Lint 门**：`npm run lint`（eslint --max-warnings 0，零警告通过）。
3. **全量测试**：`npm run test`（内核）+ `npm run test --prefix hosts/memora-vscode`（宿主）——零失败（内核有 skipped 属正常，注明数量）。
4. **变异验证（针对性）**：对改动核心逻辑做「临时移除 → 目标断言变红 → 恢复 → 绿」验证，证明测试断言**真的锁住行为**而非路过；同时确认其余用例不受影响。
5. **重建内核产物**：先删 `dist/` 再 `npm run build`（发布脚本 `prepublishOnly` 已内置 `node -e fs.rmSync` 清 dist，`npx rimraf` 在部分环境 EXIT=127 不可依赖）。
6. **契约闸门**：`npm run verify:dist-contract`——宿主 bundle 与内核 dist **同代 hash**（输出 hash 一致 + 导出符号核验通过）。
7. **随包文档死链**：`npm run docs:links`（随包 markdown 无死链）。
8. **发布边界核对**：`npm pack --dry-run` 查看实际文件清单，与 `files` 白名单对照，确认无越界、关键产物（dist、README、LICENSE、随包 docs）齐全。

## 提交分工（chunk 建议）

一次内核发布前常有多类改动，按类型拆分提交，保持历史可读：

- **内核代码 + 测试**：`fix(module): 一行式说明为什么`（feat/fix + 变更的模块名）。
- **发布脚本/配置**：`chore(release): prepublishOnly 去 npx 依赖` 等纯构建链改动。
- **文档 + 台账**：`docs(...)`：方案文档（探索期/定档期分档：纯评估可逆决策归 `docs/`，定案不可逆才走 ADR）+ 台账登记（状态以 git 实证为准）。

## 已知坑（对抗式核查清单）

- 🔴 **仓库血训：Windows 上 Bash 执行 git 写操作会污染索引**（曾致 `tasks/` 十余文件被误标删除，纯 ASCII 路径同样触发）——发布链命令忌用 Bash 流，用 `node -e` 原生实现或 PowerShell 直接命令。
- `npx` 子进程在无 bash 环境 EXIT=127（`/usr/bin/env: 'bash': No such file`）——发布脚本宁可 `node -e` 原生。
- **描述/注释同步缝隙**：改动工具描述或改公开 API 名时，须 grep 全库引用——含宿主 `hosts/`、`tsconfig` `include` 之外的脚本（历史教训：`searchHybrid` 改名漏改宿主验证脚本与 dist，发布包带旧名运行时崩）。改完描述后宿主的引用性注释（如执行器头部「工具描述『如 X、Y、Z』」）也要同步。
- 发布前 `npm publish` 的 dist 必须以本次改动为准——**确认 `npm run build` 已重建**，否则发布包不含最新改动（build 不清 dist，易携旧产物）。

## 验收门槛

全绿 + 契约同代 + 测试零失败 + 变异验证通过 + 包清单核对无误 = 就绪。剩「发布动作」本身（publish / package / tag）由用户确认后执行。

## 发布动作链（publish 后必打 tag）

`npm publish` 成功后：`git tag memora@<版本> && git push origin memora@<版本>`（如 `memora@3.0.0`）。tag 格式 = `<包名>@<semver>`，**禁裸 `v` 前缀**（与扩展 tag 撞车，存量裸 v tag 冻结不改）——定案见 [ADR-033](../../decisions/ADR-033-dual-version-line-and-tag-scheme.md)。