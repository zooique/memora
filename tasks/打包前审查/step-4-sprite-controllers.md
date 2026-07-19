# Step 4 · Sprite 宿主控制器层 · 打包前审查报告

> **审查模式**：问诊·炼化归元（规则对齐 → 剪枝 → 提交前审查）
> **审查范围**：sprite 宿主控制器层 17 文件 ~4600 行
>   - `src/sprite/controllers/`（12 文件，4066 行，contextAwareness/rapportController/affectController/proactiveEngine/reviewManager/personaController/memoryHealth 等）
>   - `src/sprite/audit/`（2 文件，240 行）
>   - `src/sprite/cli/`（2 文件，146 行）
>   - `src/sprite/usage/`（1 文件，159 行）
> **审查日期**：2026-07-19
> **执行模式**：问诊·炼化归元
> **测试基线**：9 测试文件 / 289 测试通过 / 0 失败（controllers 227 + audit 27 + cli 15 + usage 20）
> **后续衔接**：Step 5（sprite Web 服务层）

---

## 1. 规则对齐

### 1.1 已对齐项（合规无问题）

| # | 规则 | 验证方式 | 结果 |
|---|------|----------|------|
| AL-1 | project-rules §7.1 零容忍 `@ts-ignore` / `as any` | Grep 全量扫描控制器层 17 文件 | ✅ 0 处违规 |
| AL-2 | project-rules §7.1 零容忍生产 `console.*` | Grep 全量扫描 | ✅ 0 处违规 |
| AL-3 | coding-convention §2 不吞异常（无空 catch 块） | Grep + 子代理扫描 | ✅ 0 处违规（jsonlAppender 原 `clearPromise.catch(() => {})` 已补注释，见 §3.1 QC-2） |
| AL-4 | 无 TODO/FIXME/XXX/HACK 遗留 | Grep 全量扫描 | ✅ 0 处违规 |
| AL-5 | backend_layers §控制器职责边界 | 子代理扫描 controllers/ 12 文件 | ✅ 单一职责清晰（rapport/affect/proactive/review/persona/memoryHealth 等） |
| AL-6 | ADR-002 控制器不直接访问 SQLite | Grep `better-sqlite3` 全量扫描 | ✅ 0 处违规（控制器通过 storage 层抽象） |
| AL-7 | project-rules §7.4 内核调用通过 Agent 门面 | Grep `from 'memora'` + manager 直调检查 | ✅ 控制器通过 Agent 公共 API 调用 |
| AL-8 | directory-structure §controllers/ 分层 | controllers/index.ts barrel 检查 | ✅ barrel 仅透传本目录内容 |
| AL-9 | project-rules §7.1 零容忍裸 throw | Grep `throw new Error` | ✅ 0 处违规（控制器使用 SpriteError 体系） |
| AL-10 | ADR-017 枝叶层 2 次提取 | 5 类重复模式扫描 | ⚠️ 2 类已提取（round2/describeLevel），3 类未触发（见 §3.2） |
| AL-11 | coding-convention §3 函数/类/文件级注释 | 17 文件抽样 | ✅ 注释齐全（含文件级职责、函数级 JSDoc） |
| AL-12 | project-rules §7.5 LLM 工具调用 tools 参数 | affectController/rapportController prompt builder | ✅ 不涉及 LLM 调用 |
| AL-13 | shared/ 跨进程纯函数无 Node 依赖 | 新增 numberUtils.ts/levelUtils.ts 检查 | ✅ 零 import node:* |

### 1.2 规则对齐发现的违规

| ID | 规则 | 文件:行号 | 性质 |
|----|------|----------|------|
| AL-V1 | ADR-017 枝叶层 2 次提取 | affectController/rapportController/memoryController 三文件 | `Math.round(x * 100) / 100` 重复 7+ 处 → 已提取 round2（见 §3.1 QC-1） |
| AL-V2 | ADR-017 枝叶层 2 次提取 | affectController.describeLevel + rapportController.describeLevel 两处完全相同 | → 已提取 describeLevel（见 §3.1 QC-1） |
| AL-V3 | backend_layers §控制器职责边界 | memoryController.ts ↔ memoryHealth.ts/reviewManager.ts | type-only 循环依赖（不阻塞运行，归档待办） |
| AL-V4 | backend_layers §VALUE-IMPORT 反向依赖 | perceptionCoordinator.ts → affectController（静态方法） | 控制器间 VALUE-IMPORT 静态方法（归档待办） |

---

## 2. 剪枝

### 2.1 已剪枝项（本次完成）

#### 2.1.1 枝叶层 2 次提取（ADR-017）

| ID | 文件 | 描述 | 处置 |
|----|------|------|------|
| PR-1 | `src/shared/numberUtils.ts` 新增 + affectController/rapportController/memoryController 三文件 | 7+ 处 `Math.round(x * 100) / 100` 重复 → 提取 `round2(value: number): number` 到 shared/numberUtils.ts | ✅ 已提取 |
| PR-2 | `src/shared/levelUtils.ts` 新增 + affectController/rapportController 两文件 | 两处完全相同的 `describeLevel(value)` 实现（低/中/高三档判定） → 提取到 shared/levelUtils.ts，删除两处静态方法 | ✅ 已提取 |

#### 2.1.2 修改痕迹注释清理（grower skill DON'T）

| ID | 范围 | 数量 | 描述 |
|----|------|------|------|
| PR-3 | affectController.ts | 1 处 | "── 新增：语气关键词..." → "── 语气关键词：..." |
| PR-4 | memoryController.ts | 2 处 | "SEC-GAP6-02：用 getDeletedById 替代 listDeleted().some()" → "使用 getDeletedById 精确查询"；"修复 T1：原实现仅调用 addRelation（UPSERT）..." 新旧对比 → 当前状态描述 |
| PR-5 | perceptionCoordinator.ts | 2 处 | "header 注释订正：原声称'无副作用'..." 新旧对比 + "[SYNC-SPRITE-WELCOMEBACK]..." 防御性说明 → 当前状态描述 |
| PR-6 | proactiveEngine.ts | 2 处 | "silent 字段恒为 false...移除死字段" → 简洁说明；"补充按置信度降序排序，确保取 top-3" → 简洁版本 |
| PR-7 | personaController.ts | 1 处 | "注意：角色切换...不再由本控制器委托..." → "角色切换...本控制器不参与切换流程..." |
| PR-8 | presenceController.ts | 2 处 | "新增 removeListener 方法..." 两处 → "removeListener 方法支持 stop() 时取消注册..."；"测试可注入仅含 checkPending 的 mock 而无需 as any 断言" → "测试可注入仅含 checkPending 的 mock" |
| PR-9 | reviewManager.ts | 5 处 | 4 处"修复 UTC 跨日 bug"/"已同步改本地"痕迹 + 1 处"获取 ISO 日期部分"误导注释 → 简洁的本地时区说明 |
| PR-10 | auditManager.ts | 3 处 | 删除"重构（R1）：- 提取 JSONL 写入..."整个变更历史块 → 改为描述当前设计；"替代 setTimeout 等不可靠的竞态等待方式"痕迹清理 |
| PR-11 | jsonlAppender.ts | 2 处 | "提取自两个模块的同构逻辑（DRY），优化截断策略为计数器间隔式"痕迹清理 + 空 catch 块加注释（见 §3.1 QC-2） |
| PR-12 | cli/formatter.ts | 2 处 | "PersonaEntry 改为导入 PersonaInfo（sprite 层真理源），消除重复定义"痕迹 + 文件 header 从变更历史式改为当前状态式 |
| PR-13 | usage/usageStatsCollector.ts | 2 处 | "修复 UTC 跨日 bug" + "修复凌晨 UTC 跨日导致 chatTurns 写入错误日期 key" 痕迹清理 |

**剪枝合计**：12 文件 25 处 AI 修改痕迹全部清理。

#### 2.1.3 误导常量与注释修正

| ID | 文件:行号 | 描述 | 处置 |
|----|----------|------|------|
| PR-14 | memoryHealth.ts | `DUPLICATE_NAME_THRESHOLD = 1` 但实际生效需 `> 1`，原条件 `indices.length >= 1 && indices.length > 1` 冗余误导 | 阈值改为 2，简化条件为 `indices.length >= DUPLICATE_NAME_THRESHOLD` |
| PR-15 | reviewManager.ts | "获取 ISO 日期部分" 注释误导（实际是本地时区） | 修正为"获取本地日期部分" |

### 2.2 重复代码（P1 · ADR-017 枝叶层 2 次提取候选，未触发或暂缓）

| ID | 文件 | 重复次数 | 描述 | 处置 |
|----|------|---------|------|------|
| PR-16 | memoryController.ts + memoryHealth.ts + reviewManager.ts | source 标签映射 2 次 | source → 中文标签（profile→画像/insight→洞察/...）重复 | 归档待办（STEP4-7） |
| PR-17 | proactiveEngine.ts + reviewManager.ts | `new Date(m.createdAt).getTime()` 模式 | 时间戳转换重复 | 归档观察 |
| PR-18 | proactiveEngine.ts | `tokenize` + `STOP_WORDS` jaccard 相似度计算 | jaccardSimilarity 内联 tokenize，未提取为模块级私有函数 | 归档待办（STEP4-6） |

### 2.3 死字段（P3 · 归档观察）

| ID | 文件:行号 | 描述 | 处置 |
|----|----------|------|------|
| PR-19 | proactiveEngine.ts | `silent: false` 字段恒为 false（tryEmit 已在 silentMode 时 return） | 归档待办（STEP4-4） |
| PR-20 | memoryController.ts | `getDuplicateRemovalIds` / `getStaleRemovalIds` 未在主流程使用 | 归档待办（STEP4-5） |

### 2.4 硬编码不一致（P3 · 归档观察）

| ID | 文件 | 描述 | 处置 |
|----|------|------|------|
| PR-21 | memoryController.ts + memoryHealth.ts + reviewManager.ts | list limit 硬编码不一致：`DEFAULT_LIST_LIMIT` / `1000` / `50` | 归档待办（STEP4-8） |

---

## 3. 提交前审查

### 3.1 已审查修复（本次完成）

| ID | 类型 | 文件:行号 | 问题 | 修复 | 验证 |
|----|------|----------|------|------|------|
| QC-1 | 枝叶层 2 次提取 | affectController.ts + rapportController.ts + memoryController.ts + `shared/numberUtils.ts` 新增 + `shared/levelUtils.ts` 新增 | `Math.round(x*100)/100` 重复 7+ 处 + `describeLevel` 两处完全相同 | 提取 `round2(value)` 到 shared/numberUtils.ts，提取 `describeLevel(value)` 到 shared/levelUtils.ts；删除两处静态方法；6+11+9=26 处测试调用同步替换 | ✅ tsc --noEmit 通过 + 289 测试全通过 |
| QC-2 | 空 catch 块（coding-convention §2） | jsonlAppender.ts | `clearPromise.catch(() => {})` 空块无注释 | 补注释 `/* 错误已通过 clearPromise 抛出 */` | ✅ audit 27 测试通过 |
| QC-3 | 误导常量 | memoryHealth.ts | `DUPLICATE_NAME_THRESHOLD = 1` 但实际生效需 > 1 | 阈值改为 2，简化条件为 `indices.length >= DUPLICATE_NAME_THRESHOLD` | ✅ memoryHealth 测试通过 |
| QC-4 | 误导注释 | reviewManager.ts | "获取 ISO 日期部分" 实际是本地时区 | 修正为"获取本地日期部分" | ✅ reviewManager 测试通过 |
| QC-5 | 修改痕迹注释（PR-3~13） | 12 文件 25 处 | "新增/修复/重构(R1)/替代/移除死字段/已同步改" 等变更说明、新旧对比、防御性说明 | 全部清理为当前状态描述 | ✅ tsc --noEmit 通过 |

**已审查修复合计**：5 项（2 项枝叶层提取 + 1 项空 catch + 1 项误导常量 + 1 项误导注释 + 25 处修改痕迹批量清理）。

### 3.2 归档待办（P2/P3 · 移交待完成任务.md）

| ID | 优先级 | 类型 | 文件:行号 | 任务 |
|----|--------|------|----------|------|
| STEP4-1 | 🟡 P2 | 架构层循环依赖 | memoryController.ts ↔ memoryHealth.ts/reviewManager.ts | type-only 循环依赖（不阻塞运行），评估通过接口抽象或回调注入消除 |
| STEP4-2 | 🟡 P2 | 控制器间 VALUE-IMPORT | perceptionCoordinator.ts → affectController（静态方法） | perceptionCoordinator VALUE-IMPORT affectController 静态方法，评估改为回调注入或 shared/ 工具函数 |
| STEP4-3 | 🟡 P2 | 规则文档同步 | `hosts/memora-sprite/.trae/rules/directory-structure.md` | directory-structure.md 未列 shared/numberUtils.ts + shared/levelUtils.ts（本次新增 2 文件） |
| STEP4-4 | 🟢 P3 | 死字段清理 | proactiveEngine.ts | `silent: false` 字段恒为 false（tryEmit 已在 silentMode 时 return），评估移除字段或保留作为 API 契约 |
| STEP4-5 | 🟢 P3 | 未使用 API 确认 | memoryController.ts | `getDuplicateRemovalIds` / `getStaleRemovalIds` 未在主流程使用，评估是否保留作为公共 API |
| STEP4-6 | 🟢 P3 | 重复代码提取 | proactiveEngine.ts | jaccardSimilarity 内联 tokenize，评估提取为模块级私有函数 |
| STEP4-7 | 🟢 P3 | 重复代码提取 | memoryController.ts + memoryHealth.ts + reviewManager.ts | source 标签映射 2 次出现，评估提取到 shared/sourceLabels.ts |
| STEP4-8 | 🟢 P3 | 硬编码不一致 | memoryController.ts + memoryHealth.ts + reviewManager.ts | list limit 硬编码不一致（`DEFAULT_LIST_LIMIT` / `1000` / `50`），评估统一为常量 |
| STEP4-9 | 🟢 P3 | 重复代码提取（接近阈值） | proactiveEngine.ts + reviewManager.ts | STOP_WORDS 中文停用词列表评估提取到 shared/chineseStopWords.ts |

### 3.3 文件长度监控

| 文件 | 当前行数 | 阈值 | 状态 |
|------|---------|------|------|
| src/sprite/controllers/perceptionCoordinator.ts | ~590 | 800 | ✅ 在控 |
| src/sprite/controllers/proactiveEngine.ts | ~560 | 800 | ✅ 在控 |
| src/sprite/controllers/memoryController.ts | ~480 | 800 | ✅ 在控 |
| src/sprite/controllers/reviewManager.ts | ~400 | 800 | ✅ 在控 |
| src/sprite/controllers/contextAwareness.ts | ~380 | 800 | ✅ 在控 |
| src/sprite/controllers/affectController.ts | ~330 | 800 | ✅ 在控（剪枝后 -10 行） |
| src/sprite/controllers/rapportController.ts | ~310 | 800 | ✅ 在控（剪枝后 -15 行） |
| src/sprite/controllers/memoryHealth.ts | ~290 | 800 | ✅ 在控 |
| src/sprite/controllers/personaController.ts | ~270 | 800 | ✅ 在控 |
| src/sprite/controllers/presenceController.ts | ~240 | 800 | ✅ 在控 |
| src/sprite/controllers/index.ts | ~80 | 800 | ✅ barrel 透传 |
| src/sprite/audit/auditManager.ts | ~140 | 800 | ✅ 在控 |
| src/sprite/audit/jsonlAppender.ts | ~100 | 800 | ✅ 在控 |
| src/sprite/cli/formatter.ts | ~104 | 800 | ✅ 在控 |
| src/sprite/cli/interaction.ts | ~42 | 800 | ✅ 在控 |
| src/sprite/usage/usageStatsCollector.ts | ~159 | 800 | ✅ 在控 |

全部 17 文件均在 800 行阈值内，无超阈值文件。

---

## 4. 已归档项重新评估

无。本次审查范围内无已归档项需重新评估。

---

## 5. 汇总

### 5.1 量化指标

| 维度 | 数量 |
|------|------|
| 已对齐项（AL-1 ~ AL-13） | 13 项 |
| 规则对齐违规（AL-V1 ~ AL-V4） | 4 项（2 项已修复 + 2 项归档待办） |
| 已剪枝识别（PR-1 ~ PR-21） | 21 项 |
| 已审查修复（QC-1 ~ QC-5） | 5 项（含 25 处修改痕迹批量清理） |
| 归档待办（STEP4-1 ~ STEP4-9） | 9 项（2 项 P2 + 7 项 P3） |

### 5.2 优先级分布

| 优先级 | 数量 | 项目 |
|--------|------|------|
| 🔴 P0 零容忍 | 0 项 | — |
| 🟡 P1 中优先级 | 0 项（本次已全部修复） | — |
| 🟡 P2 归档待办 | 2 项 | STEP4-1（循环依赖）+ STEP4-2（VALUE-IMPORT）+ STEP4-3（文档同步） |
| 🟢 P3 归档待办 | 6 项 | STEP4-4~9（死字段/未使用 API/重复提取/硬编码/STOP_WORDS） |

### 5.3 ADR-017 枝叶层 2 次提取触发清单

| 候选 | 触发次数 | 处置 |
|------|---------|------|
| `Math.round(x*100)/100`（PR-1） | 7+ 处 | ✅ 已提取到 `shared/numberUtils.ts` 的 `round2()` |
| `describeLevel`（PR-2） | 2 处完全相同 | ✅ 已提取到 `shared/levelUtils.ts` |
| source 标签映射（PR-16） | 2 次 | 归档 STEP4-7（评估提取到 shared/sourceLabels.ts） |
| jaccardSimilarity tokenize（PR-18） | 内联 | 归档 STEP4-6（评估提取为模块级私有函数） |
| STOP_WORDS（PR-接近阈值） | 1 处 | 归档 STEP4-9（观察期，等触发） |

### 5.4 与 Step 1/2/3 对比

| 维度 | Step 1（agent+memory） | Step 2（infra 8 模块） | Step 3（sprite 主进程 35 文件） | Step 4（sprite 控制器 17 文件） |
|------|------------------------|------------------------|-------------------------------|-------------------------------|
| 已对齐项 | 10 项 | 32 项 | 18 项 | 13 项 |
| 规则对齐违规 | 3 项 | 1 项 | 7 项 | 4 项（2 已修复 + 2 归档） |
| 重复代码候选 | 5 项 | 2 项 | 11 项 | 5 项（2 已提取 + 3 归档） |
| 死代码/死字段 | 1 项 | 0 项 | 1 项 | 2 项（均归档观察） |
| 修改痕迹注释 | 未单独统计 | 未单独统计 | 28 处 | 25 处（全部本次清理） |
| 已审查修复 | 0 项（全归档） | 0 项（全归档） | 0 项（全归档） | 5 项（含 25 处批量清理） |
| 归档待办 | 4 项 | 2 项 | 35 项 | 9 项 |
| 文件超 800 行 | 0 | 0 | 2（preload.ts + main.ts） | 0 |

Step 4 健康度优于 Step 3：
- **0 项 P0**（Step 3 有 1 项 pin-toggle 死代码）
- **本次已审查修复 5 项**（Step 1-3 均为纯扫描归档，未修复）
- **0 个文件超阈值**（Step 3 有 2 个超阈值）
- **25 处修改痕迹全部本次清理**（Step 3 的 28 处归档待办）

控制器层整体代码质量较高，主要健康问题是 12 文件 25 处 AI 修改痕迹（已清理）+ 5 类枝叶层重复模式中的 2 类已提取。归档待办 9 项均为 P2/P3 观察项，不阻塞打包。

### 5.5 关键修复路径

**本次已完成**（5 项，单次提交）：
1. QC-1 提取 round2 + describeLevel 到 shared/（含 26 处测试调用同步替换）
2. QC-2 jsonlAppender 空 catch 补注释
3. QC-3 memoryHealth DUPLICATE_NAME_THRESHOLD 阈值修正
4. QC-4 reviewManager 误导注释修正
5. QC-5 12 文件 25 处 AI 修改痕迹批量清理

**归档待办**（9 项，不阻塞打包）：
- P2: STEP4-1 循环依赖 + STEP4-2 VALUE-IMPORT + STEP4-3 文档同步
- P3: STEP4-4~9 死字段/未使用 API/重复提取/硬编码/STOP_WORDS

---

## 6. Git Commit 建议

本次审查已修复 5 项，建议按以下顺序提交（每条独立可回滚）：

```
# 主提交：枝叶层提取 + 修改痕迹清理 + 误导修正
refactor(sprite-controllers): 提取 round2/describeLevel 到 shared/ + 清理 25 处 AI 修改痕迹

  - 新增 src/shared/numberUtils.ts：提取 round2(value) 工具函数
    消除 affectController/rapportController/memoryController 三文件 7+ 处
    `Math.round(x*100)/100` 重复（ADR-017 枝叶层 2 次提取）

  - 新增 src/shared/levelUtils.ts：提取 describeLevel(value) 工具函数
    消除 affectController.describeLevel + rapportController.describeLevel
    两处完全相同实现（ADR-017 枝叶层 2 次提取）

  - affectController.ts：导入 round2/describeLevel，删除静态方法
    清理"── 新增：语气关键词..."痕迹为"── 语气关键词：..."
    6 处 Math.round(x*100)/100 替换为 round2(x)

  - rapportController.ts：导入 round2/describeLevel
    trust/familiarity 使用 round2 格式化
    buildDescription 使用导入的 describeLevel，删除静态方法

  - memoryController.ts：导入 round2，#formatScore 委托 round2
    清理 SEC-GAP6-02 + T1 修复注释为当前状态描述

  - memoryHealth.ts：DUPLICATE_NAME_THRESHOLD 从 1 改为 2（消除误导）
    简化条件 `indices.length >= 1 && indices.length > 1`
    为 `indices.length >= DUPLICATE_NAME_THRESHOLD`

  - perceptionCoordinator.ts：清理 header 注释订正痕迹
    清理 [SYNC-SPRITE-WELCOMEBACK] 防御性说明痕迹

  - proactiveEngine.ts：清理"移除死字段"痕迹为简洁说明
    清理"补充按置信度降序排序"痕迹

  - personaController.ts：清理"不再由本控制器委托"痕迹

  - presenceController.ts：清理"新增 removeListener"痕迹
    清理"测试可注入仅含 checkPending 的 mock 而无需 as any 断言"痕迹

  - reviewManager.ts：清理 4 处"修复 UTC 跨日 bug"痕迹
    修正"获取 ISO 日期部分"误导注释为"获取本地日期部分"

  - auditManager.ts：删除"重构（R1）"变更历史块
    改为描述当前设计："截断策略为计数器间隔式"

  - jsonlAppender.ts：清理"提取自两个模块的同构逻辑"痕迹
    修复空 catch 块：补注释 `/* 错误已通过 clearPromise 抛出 */`

  - cli/formatter.ts：清理"PersonaEntry 改为导入 PersonaInfo"痕迹
    重构文件 header 注释从变更历史式为当前状态式

  - usage/usageStatsCollector.ts：清理 2 处 UTC 跨日修复痕迹

  - 同步测试文件：
    affectController.test.ts：11 处 AffectController.describeLevel → describeLevel
    rapportController.test.ts：9 处 RapportController.describeLevel → describeLevel

  验证：tsc --noEmit exit 0 + 289 测试全通过
  （controllers 227 + audit 27 + cli 15 + usage 20）

  参考：tasks/打包前审查/step-4-sprite-controllers.md QC-1~5
```

---

## 7. 后序衔接

完成本步审查后，建议进入 **Step 5 · sprite Web 服务层**：

- `hosts/memora-sprite/src/sprite/` 根级（sprite.ts/spriteConfig.ts/spriteLifecycleManager.ts/spriteTracer.ts/triggers.ts/tools.ts/constants.ts/fileWatcherTrigger.ts/interaction.ts/skillInstaller.ts/errors.ts/spriteConfigManager.ts，~2500 行）

预计文件数：约 11 个，行数约 2500 行。

重点关注：
1. sprite.ts 是否含 CLI/REPL 逻辑（应仅含核心类）
2. triggers.ts/fileWatcherTrigger.ts 触发器实现是否纯函数
3. errors.ts ErrorCode 枚举完整性
4. spriteConfigManager.ts 与 kernel config/ 的职责边界
