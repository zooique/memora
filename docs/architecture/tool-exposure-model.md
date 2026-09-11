# 工具暴露模型 · 默认常驻 vs 角色启动 · 探索草稿

> **定位**：为整个工具集的暴露面建立统一分类原则——「默认常驻（豁免角色包能力白名单）」与「角色启动（经能力白名单声明才暴露）」两档，取代当前"声明了才有"的单一路径心智。**属探索期草稿，非 ADR、不占编号**。
> **状态**：**已落地实现，验证中**（2026-09-08 实施：`capabilityMap` 收敛特权映射、`toolExecutor.DEFAULT_EXPOSED_TOOLS` 豁免集、白名单语义翻转为特权声明模型；全量测试绿）。
> **触发背景**：脚本运行能力设计（[script-run-security-design.md](./script-run-security-design.md)）暴露了暴露面不对称——技能工具「默认全暴露，但角色包声明任何 capabilities 即误伤」。根源是缺少"什么工具该常驻、什么工具该特权声明"的统一判据，本草案补上这条上位规则。
> **关联**：[role-pack-spec.md](./role-pack-spec.md)（M2.1 换角色→工具集切换）、[script-run-security-design.md](./script-run-security-design.md)（技能/项目脚本豁免、run_code 归角色包）、`memory-role-pack-boundary.md`（能力面/内容面分离）、`单一真理源思维模型`。

---

## 一、两条分类判据（红线，新增工具自动套用）

**判据 A · 越界判定**：工具副作用是否越出「项目 + 会话 + 内核自有」边界。
不越界（项目内读写删搜、内核自有记忆、人机交互、上下文维护）→ 默认常驻；
越界（外部网络、任意代码执行、领域深度规划）→ 角色启动。

**判据 B · 来源可信度**：执行对象的来源是否已在仓库/技能目录沉淀（有人审过、有轨迹）。
已有轨迹的脚本（技能目录、项目仓库）→ 常驻；
LLM 现写、无轨迹的任意代码 → 特权（角色启动 + 需宿主注沙箱）。

> 任一判据指向"启动"即归角色启动（保守优先）；仅当两者都指向"常驻"才默认开放。

## 二、全工具分类（用户已确认）

### 默认常驻（豁免能力白名单）—— 16 个（DEFAULT_EXPOSED_TOOLS）

| 工具 | 归类依据 |
| --- | --- |
| read_file / list_dir | 判据 A：项目内只读，无副作用 |
| write_file / delete_file | 判据 A：项目内；危险写删已由 confirmWrites/guest 确认层保护，不靠工具存在性当安全阀；读改写是 turn 闭环地基 |
| search_memories / trace_summary / list_sessions / compress_context / ask_user / register_work | 判据 A：内核自有数据 / 人机交互 / 上下文维护等基础设施 |
| read_skill / read_resource / run_skill_script / list_resources / list_skills | 技能属能力面（既定案）；来源可信（判据 B） |
| run_project_script | 判据 A+B：项目内既有脚本，仓库已沉淀 |

> search_project 不在豁免集内：宿主注入即暴露（注入例外，`list` 白名单过滤后追加），与 `file:read` 只读语义同档。

### 角色启动（走能力白名单）—— 3 组

| 工具 | 能力键 | 归类依据 |
| --- | --- | --- |
| web_search / web_fetch | web:search / web:fetch | 判据 A：外部网络副作用 |
| run_code | code:execute | 判据 A+B：LLM 现写任意代码，无轨迹 |
| task_table_write / task_table_update | task:plan | 判据 A：任务规划是领域深度能力，风格差异大（深度规划 vs 快速执行） |

## 三、机制影响

1. **capabilityMap 语义翻转**：从 allow-list（默认全关、声明才开）翻转为 default-on（默认全开、特权才声明）。`file:read` / `file:write` / `file:list` / `memory:recall` / `project:search` 五个能力键**不再控制可见性**，仅保留"声明面广告"或清理（待裁决，倾向清理以免僵尸键）。
2. **M2.1「换角色→工具集切换」验收语义变更**：白名单从"工具全集的黑名单式过滤"变为"特权工具的加法"。角色包声明 capabilities = 声明**超越默认边界的特权**，而非逐项打开本地能力。
3. **文档口径同步**：`docs/role-pack-spec.md` 及角色包 authoring guide 需更新"能力声明=特权声明"表述。
4. **暴露面与工具执行确认解耦**：写删等危险操作收敛到确认层（confirmWrites/guest），关闭"靠工具显隐做安全"的不当耦合。

## 四、实现落点

- `src/agent/toolExecutor.ts` `list` getter：新增常驻豁免集常量（`DEFAULT_EXPOSED_TOOLS`，共 16 个），对豁免集跳过白名单过滤、特权工具（web_* / run_code / task_table_*）仍按现有 `toolWhitelist` 过滤——即 baseTools 拆「豁免 ∪ 特权」两段拼接。
- `src/role-pack/capabilityMap.ts`：裁剪不再控制可见性的能力键（file:read/write/list、memory:recall、project:search），收敛为特权能力映射（web:search / web:fetch / code:execute / task:plan）。
- `src/agent/types.ts` / `agent.ts`：白名单语义微调（null=全部；[]=仅常驻；非空=常驻+名单内特权），现有 `setToolWhitelist` 通道与 onToolsChanged 刷新链路不变。

## 五、验证方式

1. 定向测试：声明任意 capabilities 时 16 个常驻工具仍暴露；未声明时特权工具不暴露；声明 code:execute 后 run_code 出现；
2. 回归：技能工具豁免（脚本草稿第五节点 3/4）与本模型的常驻集不冲突；run_code 仍受能力+宿主注入双重门槛；
3. 全量测试 + tsc + eslint + commitlint 全绿后可评估从 docs 固化。

## 六、已弃用选项

| 方案 | 弃用理由 |
| --- | --- |
| 维持 allow-list（所有工具都要角色包声明才可用） | 即现状——声明几个本地能力就误杀技能系统等常驻工具，暴露面不对称的根源；声明清单冗长、心智负担高 |
| 按"写入型工具一律角色启动"粗分 | write/delete 归常驻已裁决：危险度由确认层管，不由存在性管；粗分会把读改写闭环截断 |