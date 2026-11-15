# 托管形态（助手 / 自助）落地计划

## Context

侧栏目前只有一种形态：会话列表 + 对话。用户要的是**两个并列形态**，用一个原生开关切过去：

- **自助**（默认）：现有全部行为，逐字不变。
- **助手**：输入区一眼可辨「你在跟助手说话」，工作台有明确入口。

用户已拍板的两处：

1. **切进助手要自动换会话**：进程内已有助手会话就切过去；没有就进托管草稿（等第一句再落会话）。切回自助回到原来正在看的那条会话，位置不丢。
2. **形态不记住**：每次启动回自助。

外加一条硬约束：助手形态的输入区**只有输入框 + 发送键**，不出现第二个控件（发送键自身的「生成中→停止」三态保留）。工作台仍留编辑器区独立面板（搬进 chatPanel 会伤自助），入口放在输入区上方小字旁边。

## 落地方式（四条输入框差异 + 第五条）

| 需求 | 落点 | 实现 |
|---|---|---|
| ① 占位文字 | `chatView.ts` 新增 `applyForm()` | init 时存下 `input.placeholder` 原值（HTML 里那份，唯一文案源）；切助手时换 `Tell the assistant what you want done`，切回**逐字还原原值** |
| ② 底色/边框 | `chatStyles.ts` | `body[data-form='assistant'] #inputWrap { border-color: var(--accent); background: var(--accent-soft); }` |
| ③ 左侧助手图标 | `chatPanelHtml.ts` 新增 `#inputBox` 包裹层 + `#assistantModeIcon` | 图标 = 会话列表里「助手会话」同款 `data-icon="assistant"`（`icons.ts` 既有机器人头）；`#inputBox` 默认 `display:contents`（自助零影响），助手形态改 `display:flex` 让图标落到输入框左缘 |
| ④ 上方小字 | `chatPanelHtml.ts` `#assistantModeBar`（`#inputWrap` 首个子节点） | 文案「助手模式 · 它会替你安排会话」+ 右侧「工作台」按钮（post `assistant_open_workbench` → 宿主执行既有 `memora.openWorkbench`）；默认 `hidden` |
| ⑤ 去掉运行控制排 | `chatStyles.ts` | `body[data-form='assistant']` 作用域内 `display:none!important` 掉 `.composer-left`（技能/模型/润色/图片）、`#pauseBtn`、`.composer-row--status`（角色徽章+占用环）；`#send` 保留三态；空出的左侧改 `justify-content:flex-end` 让发送键回右 |

**为什么漏不到自助形态**：形态只落在 `<body data-form="…">` 一个属性上，所有助手规则一律 `body[data-form='assistant']` 前缀；`#inputBox` 在自助下 `display:contents`、`#assistantModeBar`/`#assistantModeIcon` 默认 `hidden`；placeholder 由脚本存原值还原。自助面没有任何一条选择器被改写。

## 文件与改动

### 提交 ①：形态状态 + 切换命令 + 自动换会话
- `src/shared/protocol.ts`：导出 `type UiForm = 'self' | 'assistant'`；W→E 增 `{ type:'ui_form'; form }`；E→W 增 `{ type:'assistant_open_workbench' }`。
- `src/shared/__tests__/protocolGuard.test.ts`：阈值 141 → 143，沿革补一条（两条通道：一条下行形态、一条上行开工作台意图；语义不可合并）。
- `src/extension/commands/assistantForm.ts`（新）：`UI_FORM_CONTEXT_KEY='memora.form'`；`registerAssistantFormCommands(context, chatProvider)` 注册 `memora.form.self` / `memora.form.assistant`，并按当前形态播种 context key。
- `src/webview/panels/chatPanel.ts`：
  - `_uiForm`（默认 `'self'`，不落盘）+ `_selfFormReturn`（自助面位置：会话 id，空串 = 草稿）；
  - `getUiForm()` / `setUiForm(form)`（唯一写点：写 state → `setContext` → post `ui_form` → 再换会话）；
  - 进助手：当前会话已是托管则不动；否则 `listManagedSessionIds()` 取最后登记的一条 `switchToSession`；一条都没有 → `newSessionFromCommand('managed')`；
  - 回自助：按记录位置 `switchToSession` / `newSessionFromCommand('self')`；无记录则原地不动；
  - `new_session` 分支按当前形态带 mode（助手形态的「＋」建的是助手会话）；
  - `handleWebviewReady()` 开头补推 `ui_form`（覆盖草稿早退路径）。
- `src/extension/extension.ts`：一行接线 `registerAssistantFormCommands`。
- `package.json`：两条命令（`robot` / `comment-discussion` 图标）+ `view/title` 两条互斥 menu 项（`memora.form != 'assistant'` / `== 'assistant'`）；`package.nls.json` + `package.nls.zh-cn.json` 补标题。

### 提交 ②：输入区骨架
- `src/webview/panels/chatPanelHtml.ts`：`buildHtml(scriptUri, cspSource, form: UiForm = 'self')` → `<body data-form="…">`；`#inputWrap` 首插 `#assistantModeBar`；textarea 外包 `#inputBox` + `#assistantModeIcon`。
- `src/webview/panels/chatPanel.ts`：`render()` 传 `this._uiForm`。

### 提交 ③：样式与形态应用
- `src/webview/styles/chatStyles.ts`：上表 ②⑤ 全部规则，统一 `body[data-form='assistant']` 前缀（注释禁用反引号）。
- `src/webview/scripts/chatView.ts`：元素引用 + `applyForm(form)`；消息链加 `ui_form` 分支；工作台按钮 post `assistant_open_workbench`。

### 提交 ④：测试 + 文案
- `src/webview/__tests__/helpers/chatViewTestEnv.ts`：夹具补 `#assistantModeBar` / `#assistantModeIcon` / `#inputBox` / `#assistantWorkbenchBtn`（三方 id 一致性守卫要求）。
- 新增 `src/webview/__tests__/assistantFormView.test.ts`：
  1. 默认（不发 `ui_form`）= 自助：`body[data-form='self']`、placeholder 逐字不变、小字条与图标 hidden；
  2. 切助手：placeholder 换成助手文案、小字条与图标显形、`data-form=assistant`；
  3. 切回自助：placeholder **逐字**还原（与初值严格相等）、小字条/图标重新 hidden；
  4. 源码级守卫：`chatStyles.ts` 里 `#inputBox` / `.assistant-mode` / `#assistantMode*` 相关规则必须以 `body[data-form='assistant']` 开头（防后人写出漏作用域规则）。
- `l10n/bundle.l10n.json` + `bundle.l10n.zh-cn.json`：助手占位文字、小字条文案、工作台按钮文案（已有键则复用）。

## 验证

1. 每笔提交：`git add <具体文件>` → commit（pre-commit 跑 gate-fast），提交信息说明改了什么、为什么。
2. 提交前手动 `tsc --noEmit -p ./` + `eslint . --max-warnings 0` + `vitest run`（相关测试文件）。
3. 形态可跑的最小验证：本地 F5 打开侧栏 → 标题栏点「助手」→ 输入区变色/换占位/出小字与图标/只剩发送键；点「工作台」打开面板；点「自助」回原会话且原对话位置未丢。
4. 不推送；不碰 `.trae/rules/**`、`lefthook.yml`、`.github/workflows/**`、`deliverables/`。

## 已知取舍（如实登记）

- 多条助手会话时「切到哪一条」取**最后登记**的一条（不是 QuickPick）：用户点「助手」要的是「跟助手说话」，弹框选择会把一次点击变成两次；工作台入口已提供「看哪条会话」的选择能力。
- 形态命令做成标题栏按钮而非输入区加开关控件：输入区除发送键外不许有第二个控件（用户硬约束）。
- 运行控制按钮用 **CSS 隐藏**而非删 DOM：能力保留（内部停止/暂停照旧可达），自助形态一行未动。
