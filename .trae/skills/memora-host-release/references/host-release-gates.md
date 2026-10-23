# 宿主发布闸门（host-release.yml 蒸馏）

> 配套 `memora-host-release` 技能 Step 4。本文件是 `host-release.yml` 的**人类可读闸门表**，真源永远是仓库里的 workflow 文件。

## 触发

- 推送形如 `vscode@X.Y.Z` 的 tag（如 `vscode@0.2.0`）→ 触发 `host-release.yml`。
- **workflow_dispatch 手动预演（dry-run）**：从 main 触发，门禁全跑到打包为止，**不挂 Release**（上传步 `if: github.event_name == 'push'` 闸）；tag 一致性校验跳过（无 tag 上下文），可选 input `expected_version` 做版本断言。tag 前空跑一次提前暴露 CI 冷环境差异（0.2.0 两次首跑缺陷本可这样提前暴露，省「删 tag 重打」往返）。
- 与内核 `release.yml`（`v[0-9]*`，发 npm）**互不干扰**：ADR-033 双版本线，两轴门禁不同、产物不同、节奏有先后。

## 门禁链（按 workflow 顺序）

| # | 闸 | 校验内容 | 失败语义 |
|---|---|---|---|
| ① | tag ↔ 宿主 package.json 一致 | `TAG="${GITHUB_REF_NAME#vscode@}"` == `hosts/memora-vscode/package.json`.version | 打错 tag：市场与 Release 均不可同版本覆盖；请删 tag 重打，**不要改 package.json 迁就** |
| ② | 内核已先行发布到 npm | 根 `package.json`.version == `npm view @zooique/memora version`（= npm latest） | 宿主 bundle 内联内核 dist，内核未发 ⇒ 市场上出现「依赖不存在的内核版本」；这是宿主专属前置护栏 |
| ③ | 格式 / 类型 / lint / 测试 / 打包 | `format:check`（根 prettier）→ 构建内核 dist → 构建 memora-mcp dist（跨宿主契约测试前置，`--no-frozen-lockfile` + `npm run build`）→ 宿主依赖安装 `pnpm install --frozen-lockfile`（含内核 dist 重链）→ `typecheck` → `lint` → 串行 `test` → `package` vsix | 任一红即终止 |

> ⚠️ **gate ③ 不含 `verify:changelog` / `verify:publish-docs`**（那是内核 `release.yml` 的闸）。CHANGELOG 宿主区日期窗 + 文档发布态须由人在 tag 前人工确认（见技能 Step 1/Step 2）。

### 内核先行机制（gate ② 为什么必须在 CI 拦）
宿主 bundle 由 esbuild **内联**内核 dist ⇒ 产物里带的是本地构建的内核代次。宿主测试跑的是本地 dist（天然同代），不会暴露「npm 上不存在该内核版本」的问题；只能靠此闸拦。判据 = 根 `package.json` version 必须已是 npm latest。

### 宿主依赖安装（内核 dist 重链）——为什么 CI 必须 `--frozen-lockfile`、禁 `--offline`

内核 dist 变更后，宿主 vitest 会加载旧的硬链接副本（不刷新会测到上一代内核）——重链靠任何一次 `pnpm install` 完成，这是这一步存在的目的。

**但安装方式两环境不同（0.2.0 首跑实证，run 39889566947）**：
- 根与宿主是**两个独立 pnpm 工程**（无 `pnpm-workspace.yaml`，各自 `pnpm-lock.yaml`）；CI 上游只把根 lockfile 的包灌进 store。
- 宿主 lockfile 239 包中 **~187 个根没有**（vsce / @vscode / cheerio 系——打包链路依赖）⇒ CI 冷 store 上 `--offline` 解析**必炸**（1 秒即红，后续步骤全 skip）。
- 故 CI 定 `--frozen-lockfile`（在线、锁文件确定性、照样重链）；本地 store 已暖，本地跑 `--offline` 仍可。**勿改回 `--offline`**（workflow 步骤注释已留痕）。

### 跨宿主契约测试的前置：memora-mcp dist（0.2.0 二跑实证，run 39890131524）

`crossHostLayout.test.ts` 加载 `hosts/memora-mcp/dist/readOnlyFileStore.js` **构建产物**（非源码，防跨包 import 的 TS6059）且有 mtime 守卫（dist 不旧于 src）。CI 从未构建过 mcp ⇒ 首跑「mcp 产物缺失」红。workflow 已在 build 内核 dist 后加构建步（mcp 依赖 `@zooique/memora: file:../..`，故排在内核 dist 之后）；mcp 尚未独立发版无 lockfile ⇒ 只能 `--no-frozen-lockfile`（SDK 版本浮动），**mcp 出包补 lockfile 后应收紧为 `--frozen-lockfile`**。本地新 clone 同样先 `cd hosts/memora-mcp && npm run build`。

### 平台相关断言：`runIf(平台)` 互斥孪生（0.2.0 二跑实证）

`path.relative` / findFiles `fsPath` 等语义随 OS 变：反斜杠形态只在 Windows 运行时出现，ubuntu 上喂 `'C:\\proj'` 得 `'../C:/...'`。平台相关断言写两条互斥用例——`runIf(process.platform === 'win32')` 原形态 + `runIf(!win32)` POSIX 孪生，各跑真实形态、断言同一结果——**不产生隐藏 skip**，任一平台都有在跑的用例。范式见 `projectSearchProvider.test.ts`。

### tag 触发的 CI 用 tag commit 的 workflow 版本 ⇒ 修 workflow 后必须删 tag 重打

tag push 事件以 **tag 指向 commit 中的 workflow 文件**起跑；push 修复到 main 后重跑旧 run 仍用旧 workflow。正确顺序：删远端+本地 tag → 在含修复的新 HEAD 重打 → 再推。0.2.0 因此重打 tag 两次。

## 分发出口（按 2026-10-23 调研结论定案）

| 出口 | 现状 | 备注 |
|---|---|---|
| ① GitHub Release asset | ✅ 本 workflow 已带（零外部账号门槛） | 幂等：`gh release upload --clobber`；asset 名 `memora-vscode-<VER>.vsix`；**body 结构化**（`--notes-file` 正文 + `--generate-notes` 追加）：随包内核代次 / sha256 / 字节数 / Marketplace 手动上传提示（0.2.0 实证缺口回补：纯 `--generate-notes` 只剩 auto changelog 链接，内核代次对账信息在发布面丢失） |
| ② Open VSX | 🔒 须先拿 namespace ownership + 手动首发第一版，之后 `npx ovsx publish --trusted-publishing` | Trusted Publishing 按 **workflow 文件名** `host-release.yml` 匹配 ⇒ **不得改名**（改名须删注册重来） |
| ③ VS Code Marketplace | 🔒 **定案保持手动上传，CI 路线放弃** | 全局 PAT 2026-12-01 退役；Entra ID 需 Azure 订阅（国外银行卡拦路石）；`vsce publish --oidc` 未进稳定版且无 Marketplace 策略注册 UI；手动每版传一次 `.vsix` 成本可忽略 |

## 改名红线

Open VSX 的 Trusted Publishers 按 **workflow 文件名**匹配（按名字，非数字 ID）⇒ 本文件 `host-release.yml` 一旦在 Open VSX 注册，**不得改名**。改名必须删掉 Open VSX 注册重来——出口②开通后此约束生效。
