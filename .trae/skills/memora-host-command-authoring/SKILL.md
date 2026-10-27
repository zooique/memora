---
name: memora-host-command-authoring
description: 在 memora 双包架构（内核 @zooique/memora + VS Code 宿主 hosts/memora-vscode）中新增或修改**宿主命令**（contributes.commands / registerCommand）时使用。覆盖四条硬规则：判据必须与内核守门同源（禁事后字符串分类）、内核 reloadConfig 忙碌态只暂存带 source 的请求、extension.ts 属零测试覆盖区、改宿主 src 后必须重建 dist 并复验同代契约。当你要加一个 Memora 命令、或要改 extension.ts 里的命令分支时加载。
---

# memora 宿主命令实现规范（硬规则 + 实证锚点）

> 起因（2026-09-22 实锤）：给宿主加 `memora.reloadSkills` 命令时，因「无参调用 + 通用 catch」
> 导致**用户的重载请求在对话中被静默丢弃**，且提示语把「根本没尝试」写成「失败」。
> 本文把踩过的坑固化成规则，避免下一个命令重犯。

## 规则 1 —— 判据必须与内核守门**同源**，禁止事后字符串分类

内核用某个判据拒绝你时，宿主侧**先查同一个判据**，不要 `try/catch` 之后按错误文案/`title` 分类。

| 反模式 | 正解 |
|---|---|
| `catch (err) { if (err.message.includes('对话繁忙')) ... }` | `if (agent.isBusy) { ... }` |

理由：`chatBusyError` **无专属 code**（`src/utils/errors.ts:113` → `configError('对话繁忙', ...)`，`category='config'`），
匹配 `title`/文案属**脆弱耦合**（改文案即静默失效）。
而 `Agent` 上的公开判据与守门读的是**同一个数据源**：

- `get isBusy(): boolean`（`src/agent/agent.ts:1834`）→ 读 `chatLockManager.isBusy`，
  与 `reloadConfig` 的守门（`agent.ts:1494`）**同一个 field** ⇒ 判据同源。

**通用做法**：动手前先 `grep` 内核那个守门的位置，看它读什么，然后在 Agent 上找对应公开 getter。
找不到公开 getter 才考虑其他方案（并优先考虑给内核补一个，而不是在宿主匹文案）。

## 规则 2 —— 内核 `reloadConfig` 在对话中**只暂存带 source 的请求**

`src/agent/agent.ts:1492-1501`：

```ts
async reloadConfig(source?: string) {
  if (this.internals.chatLockManager?.isBusy) {
    if (source) {                        // ← 只有带 source 才暂存
      this.pendingConfigReload.add(source);
    }
    throw chatBusyError('重载配置');      // ← undefined（全量）不暂存
  }
  ...
}
```

- 补执行消费点：`flushPendingConfigReload()`（`agent.ts:514-526`）——turn 结束后
  `for (const src of pending) await this.reloadConfig(src)`，并 emit `configReloaded`。
- 实证测试：`src/agent/__tests__/agent.test.ts`
  - `:1833` 对话繁忙时 `reloadConfig('persona'|'skill')` **应暂存**（通过）
  - `:1848` 对话繁忙时 `reloadConfig()` **无参数不暂存**（通过）

⇒ **所以**：宿主命令若想「对话中点了也不丢」，必须**分两次带 source** 调用：

```ts
if (agent.isBusy) {
  await Promise.allSettled([agent.reloadConfig('skill'), agent.reloadConfig('rolePack')]);
  vscode.window.showInformationMessage('技能重载请求已提交；若对话仍在进行，将在对话空闲时自动生效');
  return;
}
const result = await agent.reloadConfig();   // 空闲路径才用一次全量
```

- `allSettled`：忙碌态两次都会以 `chatBusyError` 结束（守门发生在**任何 IO 之前**），属预期路径。
- 返回值形状恒为 `{ skill: number; rolePack: number }`（任意 source 都返回此形状，未请求的一侧为 0）。
- **措辞须对两种时序都成立**：判据为真后锁可能瞬间释放（此时两次调用真的立即生效）
  ⇒ 不要写「将在对话结束后生效」，写「已提交；若对话仍在进行，将在空闲时自动生效」。

## 规则 3 —— `extension.ts` 是**零测试覆盖区**，别以为 tsc 绿就等于行为对

`hosts/memora-vscode/src/extension/extension.ts` 是激活入口，**宿主测试套件对该文件零覆盖**
（命令注册分支没法在现有 harness 里跑）。⇒

- 改完只能靠 `tsc --noEmit` + `eslint` + **产物实读** + **内核不变量测试**兜底。
- **必须实测**：这类改动要写进实测清单（例：特意在「对话进行中」点一次该命令）。
- 不要为了「有测试」而硬造 mock `vscode` 模块的重测——成本高、覆盖窄，收益不抵复杂度。
  如实记录「无自动化守卫」比造一个假绿的测试更负责。

## 规则 4 —— 改宿主 `src/` 后必须重建 `dist` 并复验同代契约

宿主 `dist` 是**构建产物**（`package.json#scripts.compile` = 清 dist → `tsc -p ./` → `node esbuild.config.mjs`）。
命令注册与资产复制都发生在构建期 ⇒ **不改 src 只改 dist 之类的手工修补会在下次 compile 被清掉**。

```bash
# 1) 重建（内含 rmSync dist → tsc → esbuild）
cd hosts/memora-vscode
node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})"
node ../../node_modules/typescript/bin/tsc -p ./
node esbuild.config.mjs          # 输出 kernelDistHash

# 2) 复验「宿主 bundle 与内核 dist 同代」
cd ../..
node scripts/verify-dist-contract.mjs
```

- **内核 `src/` 改过就必须先重建内核 dist 再重建宿主 dist**（宿主 bundle 内联内核代码）。
- 命令声明在 `hosts/memora-vscode/package.json#contributes.commands`，**不进 dist**（dist 只有 bundle）。
- 验证命令真进了产物：`grep` `dist/extension/extension.js` 里的命令 id 与分支文案。

## 本环境命令（Windows / 缺 coreutils）

```bash
cd "$(git rev-parse --show-toplevel)/hosts/memora-vscode"
node ../../node_modules/typescript/bin/tsc --noEmit -p ./
node ../../node_modules/eslint/bin/eslint.js . --max-warnings 0      # 注意：宿主 eslint 忽略 __tests__
node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --no-file-parallelism
```

- **不要用管道**（`| tail` / `| grep` 不可用，coreutils 缺）。
- 显式把 `__tests__` 下的文件传给宿主 eslint 会报 `File ignored` 并让 `--max-warnings 0` 失败（**属预期**，跑 `eslint .` 即可）。
- 多行内联 `node -e "..."` 易被 shell 吃掉引号 ⇒ 优先用 Grep/Read 工具核对，或写成临时脚本文件。
