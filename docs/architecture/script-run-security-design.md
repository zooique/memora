# 脚本运行能力三形态与安全边界 · 探索草稿

> **定位**：脚本运行能力按「来源 × 生命周期 × 权限」划分为三种形态，统一收敛到一个执行单元 + 三层防线。属探索期草稿，非 ADR、不占编号（设计已落地；自设固化触发已满足，固化评估登记台账，见「七」）。
> **状态**：**已实施**（2026-09-08 三形态/暴露模型/确认闸落地，落地清单见「五」；行为微调——env 继承反转 + FORCE_COLOR 源头禁色 + error 语义——见 [待完成任务.md](../../tasks/待完成任务.md) 2026-09-08 台账批）。
> **触发背景**：宿主对话中 LLM 如实回答「没有运行脚本的能力」——排查确认根因是角色包能力白名单过滤了技能工具（见「二、背景与根因」），而非内核无能力。
> **关联**：[role-pack-skills-progressive-disclosure.md](./role-pack-skills-progressive-disclosure.md)（三级披露 L3 脚本）、[memory-role-pack-boundary.md](./memory-role-pack-boundary.md)（能力面/内容面分离）、`单一真理源思维模型`、`security_rules.md`。

---

## 一、问题回顾：LLM 为什么说没有脚本能力

宿主（vscode 插件）最新一轮对话中，LLM 明确回答工具仅 5 个（read_file / write_file / search_project / search_memories / web_search），无脚本能力。对照内核机制（[agent.ts 白名单应用](../../src/agent/agent.ts)、[capabilityMap.ts](../../src/role-pack/capabilityMap.ts)）验证：

- 这 5 个工具与该宿主「方案设计师」角色包声明的能力映射**严格一一对应**（file:read / file:write / project:search / memory:recall / web:search）——LLM 回答是白名单精确过滤的结果，不是编造；
- 技能系统 4 工具（read_skill / read_resource / run_skill_script / list_skills）**在能力映射表中无对应键** → 角色包一旦声明任何 capabilities，技能工具即被误杀；
- run_code（通用代码执行）需 `code:execute` 能力 + 宿主注入 `ICodeExecutionProvider` 双重门槛。

**结论**：内核能力存在（skillScriptRunner 子进程执行器已实现 L3），问题是**暴露面设计不对称**——技能工具「默认全暴露，但声明能力即误伤」。

## 二、主流养分（2026 年已验证范式，来源可追溯）

| 范式 | 主流依据 | 对 memora 的启示 |
| --- | --- | --- |
| 弹窗是最弱防线 | Anthropic 实测审批接受率 93%，因此转向沙箱+分类器而非更多弹窗 | 确认通道不默认弹窗，仅 guest/confirm 配置触发 |
| 沙箱 × 审批是两个正交旋钮 | Codex 废弃 `--full-auto`（沙箱/审批/信任三合一），拆为三个独立控制；默认 workspace-write、网络默认关 | 暴露面（逻辑层）与执行隔离（系统层）分离，各有各的开关 |
| 边界锚定项目工作区 | Codex workspace、Gemini trusted folders、Claude working directory，越界才审批 | 脚本路径白名单以「技能目录 / 项目根」为边界，越界即拒绝不协商 |
| 三层防线各管一层 | Claude Code：权限（逻辑层）→ 沙箱（系统层）→ 错误恢复 | 暴露层 / 边界层 / 执行层分层实现 |
| 权限与执行必须一致 | CSA Black Hat 2026：三主流均被攻破，Gemini CVE-2026-12537 根因「allowlist 注册但执行未强制」 | 路径校验在执行分支内二次强制，不信 LLM 自觉 |
| 凭据最小化 | Claude Mask credentials/env；Gemini 自动排除 .env | 子进程**继承宿主用户环境**（2026-09-08 反转，原 PATH/HOME 白名单过度裁剪——项目脚本读用户环境是合理需求；对齐宿主 codeExecutor 同语义）。密钥默认经 SecretStorage→config 对象注入不经 env（宿主默认路径）；env 回退配置模式（`MEMORA_API_KEY`，security_rules 支持）下 key 在进程 env 对脚本可见——owner 信任模型（默认自动批准）+ 脚本来源审阅（判据 B）为边界，视同用户本地 shell |
| LLM 会自主越权（overeager） | OverEager-Bench：7500 次运行 Claude Code 越权率 27.7% | 边界由机制强制，不靠模型自觉 |

## 三、设计收敛：三种形态与权限模型

按「脚本来源 × 生命周期 × 谁能用」切三刀：

| 形态 | 工具 | 脚本来源 | 生命周期 | 权限模型 | 执行器 |
| --- | --- | --- | --- | --- | --- |
| 第一类 · 技能内嵌 | `run_skill_script` | 技能目录 `scripts/`（L3，须文件夹形态 SKILL.md） | 随技能常态存在 | **默认开放**，豁免角色包能力白名单 | 内核子进程（已有） |
| 第二类 · LLM 临时 | `run_code` | LLM 现写 → 用完即删 | 一次性 | **角色包控制**，声明 `code:execute` 才在能力白名单内 | 宿主注入沙箱（已有） |
| 第三类 · 项目现成 | `run_project_script`（**新增**） | 项目仓库已存在脚本 | 常态存在 | **默认开放**，豁免角色包能力白名单 | 内核子进程（复用，加 cwd） |

**统一执行单元**：三类不建三个引擎——第一、三类共用同一内核子进程执行器（skillScriptRunner），仅「根目录」不同（技能目录 vs 项目根）；第二类的执行器由宿主注入（零依赖红线）。

## 四、三层防线（全部长在现有机制上）

```
三层防线（逻辑层 → 边界层 → 执行层）
 ① 暴露层  技能工具（read_skill/read_resource/run_skill_script/list_skills）
           + run_project_script 豁免能力白名单；run_code 仍走 capabilityMap 白名单
 ② 边界层  路径白名单 = 来源根目录（技能目录 / 项目根）+ resolveSafePath 防穿越；
           执行分支内二次强制校验（响应「注册≠强制」教训）
 ③ 执行层  运行时白名单（node/python/shell 固定三档）· 超时（默认 60s/上限 600s，LLM 可传 timeout_ms）·
           env 继承宿主用户环境（2026-09-08 反转；密钥默认不经 env，见上表凭据最小化行）·
           windowsHide（Windows 不弹 conhost 黑框）
 确认层   needConfirm = permission==='guest' || confirmWrites || confirmScripts
           （confirmScripts 为新增可选开关，默认 false，供对脚本独立收紧）
```

## 五、落地清单（已实施 ✅，2026-09-08）

1. ✅ `src/skill/skillScriptRunner.ts`：执行器增加 `cwd` 选项（与 `code-exec/types.ts` 的 `CodeExecutionOptions.cwd` 对齐），供 run_project_script 以项目根为工作目录。
2. ✅ `src/agent/builtinTools.ts`：新增 `run_project_script` 工具定义；幂等映射登记 `non-idempotent`（运行结果不可预期，与 run_skill_script 同为禁止跳过语义）。
3. ✅ `src/agent/toolExecutor.ts`：新增 `run_project_script` 执行分支——路径白名单二次校验（resolveSafePath 确认在项目根内）+ 确认（guest/confirmScripts）+ 内核子进程执行器；技能工具豁免白名单（经 `DEFAULT_EXPOSED_TOOLS` 常驻豁免集，范围见 [tool-exposure-model.md](./tool-exposure-model.md)）。
4. ✅ `src/role-pack/capabilityMap.ts`：技能工具豁免（run_code 的 code:execute 仍受角色包控制；file:* 等失效键已随 tool-exposure-model 一并清理）。
5. ✅ `src/security/pathGuard.ts` / `src/agent/types.ts` / `src/agent/agent.ts`：`confirmScripts` 配置位（默认 false）接入 `confirmScriptRun` 执行闸（与 confirmWrites 并列；run_code/run_project_script 执行前查，owner 自动批准、guest 强制确认）。

**边界红线**：容器/seatbelt/VM 级沙箱不进内核（零依赖）；classifier 式 AI 审核不进内核（订阅侧服务）——两者均为宿主职责，`ICodeExecutionProvider` 即宿主注沙箱预留口。

> 备注：`run_skill_script` 默认保持「来源可信、owner 默认放行」——技能目录脚本经技能作者审阅（判据 B）。**确认面收口（2026-09-11 定案）**：与 run_code/run_project_script 走同一 `confirmScriptRun` 闸——owner + confirmScripts=false 自动批准（无人值守语义不变）；**guest 恒确认**（受限权限下不设"来源可信豁免"自主执行，缝合三脚本工具语义裂缝；无 OS 级沙箱支撑 Codex workspace-write 式"边界内自动"前提）；confirmScripts=true 时 owner 亦确认（开关统一约束全部脚本执行）。

## 六、已弃用选项（土壤筛选结论，记录以免回捞）

| 方案 | 弃用理由 |
| --- | --- |
| 所有脚本运行一律弹窗确认 | 违背第一、三类「默认开放」设计意图；弹窗疲劳（93% 接受率实证）边际收益递减；与现有 owner/guest 分级重复造轮子 |
| 内核内置容器/Docker 沙箱 | 违反零依赖内核红线；沙箱隔离等级应由宿主按部署环境决定 |
| classifier 式 AI 审核（Anthropic auto mode 同款） | 订阅侧服务、内核不引入；留待宿主可插拔 |
| 补 `skill:*` 能力键由角色包声明才能用技能脚本 | 与「技能属能力面而非权限面、默认开放」意图相反，且存量角色包需逐一补声明 |
| run_project_script 复用 run_code 的 script_path 模式 | run_code 承载「临时脚本闭环」语义，混入「项目已有脚本」将污染权限模型与生命周期语义 |

## 七、验证方式（已执行 ✅，2026-09-08）

1. ✅ 定向测试：skillScriptRunner cwd / 路径白名单拒绝逃逸 / 豁免后技能工具在声明 capabilities 时仍暴露——落地/补测两批全绿（内核 exec + O1 核心路径 + 工具集鉴权用例）；
2. ✅ 回归：能力白名单对 run_code 的过滤语义不变（code:execute 仍受控，tool-exposure-model 工具集测试覆盖）；
3. ✅ 内核全量测试 + tsc + eslint + commitlint 全绿——**文档自设固化触发（三条件满足：被 src 引用 4 处 + 规则体系消费 + 真实场景复现）已到，固化（补 ADR）评估登记台账（2026-09-08 新枝破土扫描①，触发 = 用户拍板定案）**。