# 启动提示词：run_team_meeting 落地推进（小组会议简化 · 方案 A）

> 复制下方 **「提示词正文」** 全部内容，粘贴到一个**新的对话框**（在 Memora 项目上下文下打开），即可让 AI 加载探索方案并落地实现 `run_team_meeting` 内置工具。
> 粘贴前先确认/调整 **<落地范围>** 段落（见正文第三章）。

---

## 提示词正文（从此处开始复制）

请加载并落地 `docs/run_team_meeting-探索方案.md` 描述的 **run_team_meeting** 内置工具（方案 A：工具内调 LLM，注入多角色 persona，单次调用各视角评估）。这是把角色包「小组会议」从「task_table + 装配视角切换」三层叠加简化为单一工具的实现任务。技术可行性已真机实证（见方案 §5.2），本任务直接落地正式实现。

### 一、目标与终点态（不可缩小）

**新增内置工具 `run_team_meeting`**：调用时读取组内 组长+组员 各角色的 persona 全文，拼成一个多角色 system prompt，**一次** `provider.chat()` 让 LLM 以各角色视角评估同一议题，最后组长视角汇总。返回多角色评估文本。

关键验收标准：
- 一次 LLM 调用完成（非多次切换）；
- 真实注入 ≥2 个角色 persona 语义（各视角观点体现角色设定差异，复用现有 `RolePackManager.buildSystemPrompt(name)`）；
- 单次调用工具失败数 = 0；
- 组长（组主）视角含汇总；组员视角各一段。

**第一步不拆旧机制**：新通道与现有 task_table 会议骨架**并行共存**，互不干扰。是否淘汰旧骨架是独立后续任务，不在本任务内。

### 二、实现步骤（参考顺序）

1. **先读方案与现状**（建立事实）：
   - `docs/run_team_meeting-探索方案.md`（含可行性/改动面/边界 §1-§4、实证 §5）
   - 现有会议实现：`src/role-pack/rolePackManager.ts`（buildSystemPrompt L948、activeTeamMembers、resolveRoundAssemblyRole、RolePackTeam）
   - 内置工具注册模式：`src/agent/builtinTools.ts` + `src/agent/builtinToolHandlers.ts`（参考 read_file 的 toolDef + handler 签名、type ToolDefinition）
   - 验证脚本参考：`scripts/test-team-meeting-real.ts`（已跑通的最小可行性探针）
2. **在 `builtinTools.ts` 注册 `run_team_meeting` toolDef**（name/description/parameters：group、topic）。
3. **在 `builtinToolHandlers.ts` 实现 handler**：
   - 参数校验（group 名存在、topic 非空）；
   - 经 `RolePackManager` 解析组名 → 组长 + 组员名单 → 各角色 `buildSystemPrompt(name)` 取 persona 全文；
   - 拼多角色 system prompt（组长唯一：最后汇总视角）；
   - 单次 `provider.chat()`；返回评估文本。
4. **注入 provider**：确认 handler 如何拿到 provider（装配链路），或走现有背景/前台通道。
5. **补测试**：`src/agent/__tests__/` 下新增 run_team_meeting 单测（用 mock rolePackManager + mock provider，验证：参数校验 / persona 拼接 / 单次调用 / 组长汇总视角）。
6. **真机**：跑 `scripts/test-team-meeting-real.ts`（真实 LLM 验证各视角差异）；全量 `npx vitest run` + `npx tsc --noEmit` 0 错。

### 三、落地范围（粘贴前按实际情况填入/调整）
<落地范围>：默认仅实现「新增 run_team_meeting 工具」这一项（含 toolDef、handler、单测、真机验证）。**不**触碰现有 task_table 会议骨架/装配视角切换/T1 链路。若你判断需要额外小改动（如 provider 注入缺口），先在本消息说明再动，避免范围膨胀。

### 四、必须遵守的纪律

- **探索期实现**：不预写 ADR、不改 `tasks/已完成任务.md` 标题生造编号（符合 `.trae/rules/generic/exploration-decision-sedimentation-rules.md` S1/S2）；如有 TODO 记录进 `tasks/待完成任务.md`。
- **自然生长**：优先复用 `buildSystemPrompt` / `rolePackTeams` 等现有原语，**不新造**编辑/调用模型；不足 3 次重复不提取抽象。
- **SSOT / 不带伤**：不改现有三个机制的契约；实现只做串联，不引入"工具内嵌 LLM"之外的架构震动点（若触及请标注观察点）。
- **两个已知边界须落实**（方案 §5.3）：
  1. run_team_meeting 定位为**评估/评审型会议**（各视角独立观点 + 组长汇总），不在本实现覆盖讨论交互型；
  2. persona 全文 token 成本高 → 设角色数上限（默认沿用 `MAX_TEAM_MEMBERS`）并在 toolDef description 说明。
- **注释纪律**：函数/类/文件/变量级注释齐全，中文；**剪枝去痕**——注释不得暴露"这是某次修复/重构/探索"等元叙述。
- **命名**：文件蛇形/组件大驼峰等沿用项目规范；不新增独立模块，改动限 `builtinTools.ts` / `builtinToolHandlers.ts` / 测试。

### 五、验证与收尾

1. 类型检查 + 测试：内核 `npx tsc -p tsconfig.json --noEmit` + `npx vitest run`（全量绿）。
2. 宿主（如涉及）：`hosts/memora-vscode` 独立编译。
3. 真机：`scripts/test-team-meeting-real.ts` 三视角差异可辨（或等价验证）。
4. 提交：遵循 commitlint（`feat(kernel): run_team_meeting 内置工具 …`），必经 pre-commit（lint + typecheck + commitlint）；若只加脚本/文档按当下实际 type。
5. 输出汇总：实现项 / 测试数 / 真机结果 / 未竟事项（含"是否淘汰旧会议骨架"作为独立建议项）。

---

## 使用说明（不复制此段）
1. 把上方「提示词正文」整体复制到新对话框首条消息，在 Memora 项目根 `F:\zooique\memora` 上下文打开。
2. 粘贴前确认第三章 <落地范围>：默认=仅新增 run_team_meeting 工具，不动旧机制。
3. 新对话框 AI 会先读方案文档与现状，确认事实后再动代码；浮现的 provider 注入等缺失能力会先说明再动。
4. 本提示词内嵌了边界与纪律，AI 无需再翻其他 prompt 文件即可开工。