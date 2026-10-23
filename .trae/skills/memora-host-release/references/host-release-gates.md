# 宿主发布闸门（host-release.yml 蒸馏）

> 配套 `memora-host-release` 技能 Step 4。本文件是 `host-release.yml` 的**人类可读闸门表**，真源永远是仓库里的 workflow 文件。

## 触发

- 推送形如 `vscode@X.Y.Z` 的 tag（如 `vscode@0.2.0`）→ 触发 `host-release.yml`。
- 与内核 `release.yml`（`v[0-9]*`，发 npm）**互不干扰**：ADR-033 双版本线，两轴门禁不同、产物不同、节奏有先后。

## 门禁链（按 workflow 顺序）

| # | 闸 | 校验内容 | 失败语义 |
|---|---|---|---|
| ① | tag ↔ 宿主 package.json 一致 | `TAG="${GITHUB_REF_NAME#vscode@}"` == `hosts/memora-vscode/package.json`.version | 打错 tag：市场与 Release 均不可同版本覆盖；请删 tag 重打，**不要改 package.json 迁就** |
| ② | 内核已先行发布到 npm | 根 `package.json`.version == `npm view @zooique/memora version`（= npm latest） | 宿主 bundle 内联内核 dist，内核未发 ⇒ 市场上出现「依赖不存在的内核版本」；这是宿主专属前置护栏 |
| ③ | 格式 / 类型 / lint / 测试 / 打包 | `format:check`（根 prettier）→ 构建内核 dist → `pnpm install --offline`（刷宿主镜像）→ `typecheck` → `lint` → 串行 `test` → `package` vsix | 任一红即终止 |

> ⚠️ **gate ③ 不含 `verify:changelog` / `verify:publish-docs`**（那是内核 `release.yml` 的闸）。CHANGELOG 宿主区日期窗 + 文档发布态须由人在 tag 前人工确认（见技能 Step 1/Step 2）。

### 内核先行机制（gate ② 为什么必须在 CI 拦）
宿主 bundle 由 esbuild **内联**内核 dist ⇒ 产物里带的是本地构建的内核代次。宿主测试跑的是本地 dist（天然同代），不会暴露「npm 上不存在该内核版本」的问题；只能靠此闸拦。判据 = 根 `package.json` version 必须已是 npm latest。

### 镜像刷新为什么必须 `pnpm install --offline`
内核 dist 变更后，宿主 vitest 会加载旧的硬链接副本（不刷新会测到上一代内核）。`host-release.yml` 在 build 内核 dist 后跑此步；本地发版亦须照做。

## 分发出口（按 2026-10-23 调研结论定案）

| 出口 | 现状 | 备注 |
|---|---|---|
| ① GitHub Release asset | ✅ 本 workflow 已带（零外部账号门槛） | 幂等：`gh release upload --clobber`；asset 名 `memora-vscode-<VER>.vsix` |
| ② Open VSX | 🔒 须先拿 namespace ownership + 手动首发第一版，之后 `npx ovsx publish --trusted-publishing` | Trusted Publishing 按 **workflow 文件名** `host-release.yml` 匹配 ⇒ **不得改名**（改名须删注册重来） |
| ③ VS Code Marketplace | 🔒 **定案保持手动上传，CI 路线放弃** | 全局 PAT 2026-12-01 退役；Entra ID 需 Azure 订阅（国外银行卡拦路石）；`vsce publish --oidc` 未进稳定版且无 Marketplace 策略注册 UI；手动每版传一次 `.vsix` 成本可忽略 |

## 改名红线

Open VSX 的 Trusted Publishers 按 **workflow 文件名**匹配（按名字，非数字 ID）⇒ 本文件 `host-release.yml` 一旦在 Open VSX 注册，**不得改名**。改名必须删掉 Open VSX 注册重来——出口②开通后此约束生效。
