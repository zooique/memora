# DISPATCH-MEMORY-1 真机验收计划（只验不改）

## Context

本轮要验的功能是「重启后还记不记得自己派过活」：工作台靠 `Round.dispatchedBy` 反查被派过活的会话，并分档展示来源（助手新建 / 派发接管）。

验收纪律：**只验不改**——不改代码、不改配置、不提交、不推送；现象原话抄录，推测必须标注「推测」；每步留截图；做不了就说做不了。

## 开工现状（已完成的准备）

- 仓库：HEAD `576a189a`（本地未推送）；工作区另有 3 个**未提交**文件改动（`workbenchDto.ts` / `workbenchModel.ts` / `workbenchView.ts`，内容为 `dispatchTruncated` 反查窗口截断提示）。
- dist：`hosts/memora-vscode/dist/.build-stamp.json` builtAt `2026-11-15T14:10:47Z`（本地 22:10:47），**不含**上述 3 个未提交改动。
- 开发宿主已重启：pid 18536，hwnd 4522354，窗口 1878x1024；扩展禁用提示条已关闭。
- 落盘基线：`%TEMP%\memora-acceptance\baseline-index.json`、`baseline-state.vscdb`。

## 已完成的一步（步骤 1）

让助手走 `send_to_session` 往**已存在、origin=user** 的会话 `2026-11-15-smwhrnpyw`（标题「空白页草稿S-自助」）派一条活。

落盘证据：
- `.memora/rounds/round-59a890bf-dbb4-4391-a82c-99b283b9a559.json`：`dispatchedBy = { from: "2026-11-15-smwhseq70", via: "delegate" }`，status complete，助手回了「收到。」
- `.memora/rounds/index.json` 该轮条目同样带 `dispatchedBy`。
- 顺带观察（待报）：`.memora/sessions/2026-11-15-smwhrnpyw.json` **未更新**（roundIds / messageCount / lastActiveAt 仍是旧值），派发轮只进了 rounds 目录与 index。

## 剩余步骤

### 步骤 2：工作台标签检查
1. 命令面板执行 `Memora: 打开工作台`。
2. 截图，确认 `空白页草稿S-自助` 出现在清单里。
3. 抄录来源副行文案（期望「派发接管」= l10n `Dispatched here`），并记录其在条目内的位置。

### 步骤 3：真重启后的记忆
1. 记录重启前状态；关闭开发宿主（当前 pid 18536）。
2. 用 WMI `Win32_Process.Create` 拉起（`Start-Process` 会被作业对象连带杀掉，已踩过）。
3. 等 ~30s 取 hwnd，截图。
4. 打开工作台，确认该会话仍在、来源仍是「派发接管」。

### 步骤 4：反向（助手新建不许被改成派发接管）
1. 让助手 `create_session` 新建一条会话（记下 sid 与标题）。
2. 重启宿主。
3. 打开工作台，确认新会话仍在且来源为「助手新建」（`Created by assistant`），未被更早的派发改写。

### 步骤 5：提示文案
- 若出现「部分历史读不到 / 部分会话找不到」类提示，抄录原文，判断是否说清原因。
- **注意**：dist 不含未提交的 `dispatchTruncated` 改动，本次看到的提示属改动前行为；如要验截断说明，需先构建 dist——但那会把另一条线的半成品混进来，本轮不做，只如实记录。

## 交付

- 截图目录：`.screenshots/acceptance-20261115-origin/`
- 结论按「现象 / 位置 / 是否通过」三条报，不声称证明了未覆盖的场景。
