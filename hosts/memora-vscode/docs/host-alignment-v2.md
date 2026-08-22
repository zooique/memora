# 宿主插件对齐方案（基于 memora-vscode 现状）

> **定位**：基于 `hosts/memora-vscode` 现有代码，对齐 memora 内核最新形态（角色包、技能系统、记忆系统、Agent Loop）。**不是从零设计，而是在已有基础上自然生长**。
>
> **设计哲学**：
> - **已有优先**：先看宿主已实现了什么，再决定对齐什么
> - **渐进生长**：按内核能力 → 插件功能 → UI 展示逐层对齐
> - **薄壳装配**：宿主只做"注入 + 转发 + 渲染"，不重复实现内核逻辑
>
> **版本**：v2.0 · 2026-08-18（基于插件现状 + 内核最新演进）

---

## 一、现状盘点

### 1.1 宿主已实现能力

| 维度 | 模块 | 状态 | 说明 |
|------|------|------|------|
| **装配** | [assemble.ts](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/host/assemble.ts) | ✅ | 薄壳装配，注入 Agent 所需全部依赖 |
| **记忆存储** | [WorkspaceStorage](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/host/workspaceStorage.ts) | ✅ | JSON 文件持久化，实现 IMemoryStorage 接口 |
| **会话存储** | [WorkspaceSessionStore](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/host/sessionStore.ts) | ✅ | JSON 文件持久化 + 宿主扩展（deleteSession/truncateFrom） |
| **LLM 配置** | [llmConfig.ts](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/host/llmConfig.ts) | ✅ | ProviderStore + 环境变量双通道 |
| **可观测性** | [VscodeTracer](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/host/tracer.ts) | ✅ | ITracer 实现，环形缓冲采集 span |
| **协议** | [protocol.ts](file:///f:/zooique/memora/hosts/memora-vscode/src/shared/protocol.ts) | ✅ | 50+ 消息类型，覆盖全量 AgentChunk |
| **角色包** | 5 个内置角色包 | ✅ | doc-review / 写作助手 / 技术文档工程师 / 方案设计师 / 翻译助手 |
| **UI 面板** | 对话 + 设置（角色/模型/记忆） | ✅ | 3 选项卡合并视图 |

### 1.2 内核最新能力 vs 宿主对齐情况

#### A. 角色包系统

| 内核能力 | 宿主状态 | 差距 |
|---------|---------|------|
| 多角色包 + `activate()` 切换 | ✅ 已实现 | — |
| `personaSwitched` 事件 | ✅ 已绑定 | — |
| 粘性匹配 + 互斥切换 | ✅ 内核自动处理 | — |
| `skills/` 目录动态扫描（C3） | ✅ 已对齐 | 5 个角色包均有 `skills/` 目录 + markdown 技能文件 |
| `capabilities` 独立顶层声明 | ✅ manifest 已有 | — |
| 两级技能（全局 + 角色包） | ✅ 已对齐 | `src/extension/skills/` 有 3 个全局技能（web-search / code-review / summarize） |
| manifest 不声明 persona/rules 路径（R7） | ✅ 已对齐 | 全部角色包无路径声明，走约定名 |

#### B. 技能系统

| 内核能力 | 宿主状态 | 差距 |
|---------|---------|------|
| `SkillManager` 两级技能 | ✅ 已接入 | 全局技能池 + 角色包技能 |
| `readSkillContent` 按需加载 | ✅ 已对齐 | 角色包 `skills/` 目录动态扫描 |
| `skillMatched` 事件 | ✅ 已绑定 | chatPanel 监听 + chatView UI 指示器 |
| 技能 UI 指示器 | ✅ 已实现 | 本轮持续展示 skill chip，结束后清除 |

#### C. 记忆系统

| 内核能力 | 宿主状态 | 差距 |
|---------|---------|------|
| round-summary 摘要记忆 | ✅ 内核自动生成 | — |
| `MemoryInspector` 查询 | ✅ 已接入 | 记忆管理面板可用 |
| `searchHybrid` 混合搜索 | ✅ 已接入 | 记忆搜索框可用 |
| `governance.suggest()` Follow-up 建议 | ✅ 已接入 | `suggestions` 协议消息 |
| `sourceCountCache` 增量维护 | ✅ WorkspaceStorage 实现 | — |
| `decayScores` 自然遗忘 | ✅ 内核自动执行 | — |
| `validateSource` 校验 | ✅ WorkspaceStorage 实现 | — |
| 向量索引 `IVectorStore` | ❌ 未实现 | WorkspaceStorage 仅关键词搜索 |
| `memory/sessionStore.ts` ISessionStore v2 | ✅ 已对齐 | 全部必需+可选方法已实现 |

#### D. Agent Loop

| 内核能力 | 宿主状态 | 差距 |
|---------|---------|------|
| 流式 AgentChunk | ✅ 全量转发 | — |
| `thinking{phase}` 阶段 | ✅ 已对齐 | UI 显示"召回/处理/归档" |
| `handoff` 衔接决策 | ✅ 已转发 | `loop` 决策自动续跑（限 3 轮） |
| `retry` LLM 重试 | ✅ 已转发 | 低扰提示条 |
| `paused` 暂停 | ✅ 已实现 | 暂停/恢复按钮对接 agent.pause()/resume() |
| `selfReview` 自审查 | ✅ 已转发 | 过程性提示 |
| `questionPending` 主动提问 | ✅ 已实现 | need_clarify → clarify_answer |
| Loop 自动续跑（`handoff: loop`） | ✅ 已实现 | 自动续跑限 3 轮，超限提示用户手动介入 |
| `toolWhitelist` 按 capabilities 过滤 | ✅ 已实现 | 工具权限徽章 + allow/block 模式 |
| `preExecutionCheck` 统一检查点 | ✅ 已注入 | 放行，收敛版不审计 |

#### E. 存储层

| 内核能力 | 宿主状态 | 差距 |
|---------|---------|------|
| `IFileSystem` 文件操作抽象 | ❌ 未实现 | WorkspaceStorage 直接用 `fs.writeFileSync` |
| `atomicWriteFile` 原子写入 | ✅ 已使用 | WorkspaceStorage + WorkspaceSessionStore 均用 `atomicWriteFileSync` |
| SQLite 生产级存储 | ❌ 未实现 | JSON 文件存储，性能/可靠性受限（择机升级） |
| `StoragePathResolver` 路径解析 | ❌ 未使用 | 宿主直接拼接路径 |

---

## 二、对齐方案（按优先级分层）

### Tier A：存储层加固（P0，稳定性）

#### A1. WorkspaceStorage.save() 原子写入

**问题**：[workspaceStorage.ts:43-50](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/host/workspaceStorage.ts#L43-L50) 中 `save()` 方法：
- 写了两次 `writeFileSync`（第 48、49 行），第一次是 tmp 但命名不对，第二次是正式文件——但两次都是同步写，且没有 rename 操作
- 如果进程在两次写入之间崩溃，可能导致数据损坏

**方案**：使用内核 `atomicWriteFile` 工具（`src/utils/atomicWrite.ts`）

```typescript
// WorkspaceStorage.save() 修正
private save(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const list = [...this.store.values()];
    // 使用内核原子写入：先写 .tmp 再 rename
    atomicWriteFileSync(this.filePath, JSON.stringify(list, null, 2));
}
```

#### A2. WorkspaceSessionStore.save() 原子写入

**问题**：[sessionStore.ts:57-66](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/host/sessionStore.ts#L57-L66) 同样非原子。

**方案**：同上，使用 `atomicWriteFileSync`。

#### A3. WorkspaceStorage.validateSource 对齐

**问题**：WorkspaceStorage.upsert() 直接写入，未调用内核 `validateSource()` 校验。

**方案**：在 `upsert` 入口增加 source 校验：

```typescript
upsert(memory: Memory): void {
    // 对齐内核 validateSource，拦截无效 source
    const result = validateSource(memory.source);
    if (result.severity === 'block') {
        throw new MemoraError('source 校验失败', result.warning);
    }
    this.store.set(memory.id, memory);
    this.save();
}
```

### Tier B：角色包系统对齐（P1，核心能力）

#### B1. 角色包 skills 目录扫描（对齐 C3 规则）

**问题**：当前角色包用 `manifest.skills` 数组声明技能，但内核 C3 规则已改为**目录动态扫描**（`role-packs/<名>/skills/*.md` 自动注册）。

**方案**：
1. 将角色包 manifest 中的 `skills` 数组移除（或保留为可选白名单过滤）
2. 在 `skills/` 目录下创建技能文件（带 frontmatter）
3. 内核 `RolePackManager` 自动扫描加载

**迁移动作**：

```
角色包结构（现状）：                角色包结构（对齐后）：
方案设计师/                        方案设计师/
├── manifest.json                  ├── manifest.json
├── persona.md                     ├── persona.md
├── rules.md                       ├── rules.md
└── (skills 在 manifest 声明)      └── skills/
                                       ├── design-methodology.md
                                       └── review-checklist.md
```

#### B2. 全局技能池接入

**问题**：内核支持两级技能（全局 `configDir/skills/*.md` + 角色包 `role-packs/<名>/skills/*.md`），宿主仅用了角色包级。

**方案**：
1. 在 `configDir`（即 `dist/extension/`）下创建 `skills/` 目录
2. 放入全局技能文件（跨角色通用）：
   - `web-search.md` — 网络搜索技能
   - `code-review.md` — 代码审查技能
   - `file-operations.md` — 文件操作技能
3. 内核 `SkillManager` 自动扫描 `configDir/skills/` 并全局激活

#### B3. manifest 清理路径声明（对齐 R7 规则）

**问题**：部分角色包 manifest 仍声明 `"persona": "persona.md"` 和 `"rules": "rules.md"`，违反 R7（路径约定俗成，manifest 不声明）。

**方案**：移除 manifest 中的 `persona` 和 `rules` 字段。内核 `RolePackManager` 默认读取 `persona.md` 和 `rules.md`。

**需要清理的角色包**：
- 技术文档工程师 manifest
- 方案设计师 manifest
- 写作助手 manifest
- 翻译助手 manifest
- doc-review manifest

#### B4. 工具白名单按 capabilities 过滤

**问题**：内核 `ToolExecutor` 支持按角色包 `capabilities` 过滤工具暴露，但宿主未利用——所有角色看到相同的工具集。

**方案**：
1. 角色包 manifest 的 `skills[].capability` 声明保留（作为工具可见性声明）
2. 宿主在装配 Agent 时，将角色包 capabilities 传给内核
3. 内核自动过滤工具列表，角色切换时工具集随之变化

**示例**：
```
"方案设计师" 角色 → capabilities: [file:read, file:write, web:search, memory:recall]
  → Agent 只暴露 read_file / write_file / web_search / search_memories

"技术文档工程师" 角色 → capabilities: [llm:summarize]
  → Agent 只暴露 summarize 相关工具（block 模式下）
```

### Tier C：技能系统接入（P1，差异化能力）

#### C1. 创建全局技能池

**动作**：在 `src/extension/skills/` 下创建技能文件

```
src/extension/skills/
├── web-search.md          ← 网络搜索技能
├── code-review.md         ← 代码审查技能
├── summarize.md           ← 内容摘要技能
└── file-operations.md     ← 文件操作技能
```

每个技能文件带 frontmatter：
```markdown
---
name: 代码审查
description: 对代码进行安全与质量审查
keywords: ['审查', 'code review', '安全', 'bug']
---

## 技能说明
...
```

#### C2. 绑定 skillMatched 事件

**问题**：宿主未监听 `skillMatched` 事件，无法在 UI 中提示用户当前触发了什么技能。

**方案**：在 chatPanel 的事件绑定中增加：

```typescript
agent.on('skillMatched', (match) => {
    // 转发为 notice 协议消息："检测到技能：{match.skill.name}"
    postMessage({
        type: 'notice',
        level: 'info',
        message: `已激活技能：${match.skill.name}`,
    });
});
```

#### C3. 技能 UI 指示器

**动作**：在对话面板底部或侧边栏增加"已激活技能"提示区，显示当前角色包激活的技能列表。

### Tier D：记忆系统增强（P2，长期价值）

#### D1. WorkspaceStorage 增加缺失接口方法

**问题**：对比内核 `IMemoryStorage` 接口，WorkspaceStorage 缺少以下方法：

| 方法 | 状态 | 说明 |
|------|------|------|
| `getDeletedById(id)` | ✅ 已有 | |
| `purgeExpired(before)` | ✅ 已有 | |
| `count()` | ✅ 已有 | |
| `countBySource(source)` | ✅ 已有 | |
| `incrementScore(id, delta, now)` | ✅ 已有 | |
| `setScore(id, newScore, now)` | ✅ 已有 | |
| `getAllSources()` | ✅ 已有 | |
| `close()` | ✅ 已有 | |

**结论**：WorkspaceStorage 接口完整，无需补充。

#### D2. WorkspaceStorage.search() 对齐内核

**问题**：WorkspaceStorage.search() 已实现分词匹配，但缺少空查询按 score 降序返回的路径。

**方案**：确认空查询路径已正确实现（当前代码第 127-129 行已有 `!q` 处理）。

#### D3. SQLite 存储升级（远期）

**问题**：JSON 文件存储在记忆量 > 1000 条时性能下降。

**方案**：引入 `better-sqlite3`，创建 `SqliteMemoryStorage` 实现。

**时机**：当记忆量增长到 JSON 文件 > 500KB 时触发迁移。当前阶段不需要。

### Tier E：Agent Loop 增强（P2，体验优化）

#### E1. Loop 自动续跑

**问题**：内核产出 `handoff{decision: 'loop'}` 时，宿主仅渲染提示"Agent 将自动续跑"，但未实际触发续跑。

**方案**：在 chatPanel 的 handoff 处理中增加：

```typescript
case 'loop':
    postMessage({ type: 'handoff', decision: 'loop' });
    // 自动触发下一轮（用户无感知）
    setTimeout(async () => {
        try {
            for await (const chunk of agent.chat('继续')) {
                // 正常转发
            }
        } catch (err) { /* ... */ }
    }, 300);
    break;
```

**注意**：此功能需谨慎——应仅在**批量任务场景**（如"修复所有 lint 错误"）下启用。默认 `handoff: wait` 语义不变。

#### E2. 工具权限 UI 徽章

**问题**：角色包切换后，工具暴露面变化对用户不可见。

**方案**：在对话面板底部状态栏增加工具模式徽章：

```
[当前角色：方案设计师] [工具：只读/可写/全部] [联网：开/关]
```

#### E3. 停止按钮增强

**问题**：当前仅支持中断，不支持暂停/恢复。

**方案**：增加"暂停"按钮，调 `agent.pause()` / `agent.resume()`。

### Tier F：角色包迁移清理（P1，对齐规则）

#### F1. 清理 manifest 路径声明

**动作**：从所有角色包 manifest 中移除 `persona` 和 `rules` 字段。

**涉及文件**：
- [doc-review/manifest.json](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/role-packs/doc-review/manifest.json)
- [写作助手/manifest.json](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/role-packs/写作助手/manifest.json)
- [技术文档工程师/manifest.json](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/role-packs/技术文档工程师/manifest.json)
- [方案设计师/manifest.json](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/role-packs/方案设计师/manifest.json)
- [翻译助手/manifest.json](file:///f:/zooique/memora/hosts/memora-vscode/src/extension/role-packs/翻译助手/manifest.json)

#### F2. 为角色包创建 skills 目录

**动作**：将 manifest `skills` 数组中的能力声明迁移到 `skills/` 目录下的 markdown 文件。

**示例**（方案设计师）：
```
方案设计师/
├── manifest.json          ← 移除 persona/rules/skills 路径声明
├── persona.md
├── rules.md
└── skills/
    ├── design-methodology.md  ← 设计方法论（含 SSOT/最小单元/网络为土壤）
    └── review-checklist.md    ← 方案审查清单
```

#### F3. 角色包能力声明迁移

**问题**：当前 `skills` 数组混合了"能力声明"和"技能描述"。按 R8 规则，能力声明应在 manifest 顶层 `capabilities`。

**方案**：将 `skills[].capability` 迁移到 `capabilities` 顶层字段，`skills[].description` 迁移到技能 markdown 文件的 description。

```json
{
    "capabilities": [
        { "capability": "file:read", "description": "读取既有文档与代码" },
        { "capability": "file:write", "description": "将设计方案写入文档" },
        { "capability": "web:search", "description": "搜索最新行业资料" },
        { "capability": "memory:recall", "description": "召回相关决策与历史设计" }
    ]
}
```

---

## 三、实施路线图

### Phase 1：存储层加固（半天）

| 任务 | 文件 | 改动量 |
|------|------|--------|
| A1: atomicWriteFileSync | workspaceStorage.ts | 5 行 |
| A2: atomicWriteFileSync | sessionStore.ts | 5 行 |
| A3: validateSource | workspaceStorage.ts | 8 行 |

**验收**：插件重启后记忆/会话不丢，异常退出不损坏文件。

### Phase 2：角色包迁移（1 天）

| 任务 | 文件 | 改动量 |
|------|------|--------|
| F1: 清理 manifest 路径声明 | 5 个 manifest.json | 每个删 2 行 |
| F2: 创建 skills 目录 + 技能文件 | 5 个角色包 × 1-3 个技能 | ~15 个新文件 |
| F3: 迁移 capabilities 到顶层 | 5 个 manifest.json | 每个改 5-10 行 |
| B2: 创建全局技能池 | src/extension/skills/ | 4 个新文件 |

**验收**：插件启动后扫描到角色包 + 全局技能池，技能匹配正常。

### Phase 3：技能系统接入（1 天）

| 任务 | 文件 | 改动量 |
|------|------|--------|
| C2: 绑定 skillMatched 事件 | chatPanel.ts | 10 行 |
| C3: 技能 UI 指示器 | chatView.ts + chatStyles.ts | ~30 行 |
| B4: 工具白名单过滤 | assemble.ts + chatPanel.ts | ~20 行 |

**验收**：切换角色包后工具暴露面变化，技能触发时 UI 有提示。

### Phase 4：Loop 增强（半天）

| 任务 | 文件 | 改动量 |
|------|------|--------|
| E1: Loop 自动续跑 | chatPanel.ts | 15 行 |
| E2: 工具权限徽章 | chatView.ts | 10 行 |
| E3: 暂停/恢复按钮 | chatPanel.ts + protocol.ts | ~30 行 |

**验收**：批量任务自动续跑不超过 3 轮，暂停按钮可用。

### Phase 5：远期存储升级（择机）

| 任务 | 说明 | 时机 |
|------|------|------|
| D3: SQLite 存储 | 引入 better-sqlite3 | 记忆量 > 500KB 时 |

---

## 四、约束与纪律

### 4.1 对齐纪律

| 规则 | 说明 |
|------|------|
| **不重复实现内核** | 宿主只做注入/转发/渲染，不重写内核逻辑 |
| **不修改内核源码** | 所有对齐在宿主侧完成，内核通过接口暴露能力 |
| **渐进不跳跃** | 按 Phase 1→4 顺序实施，每步独立可验证 |
| **保持向后兼容** | manifest 迁移同时兼容旧格式（内核 RolePackManager 有兜底） |

### 4.2 已对齐的设计真理源

| 真理源 | 宿主体现 |
|--------|---------|
| 角色包 = 设定卡 | 5 个角色包，可切换，粘性匹配 |
| 记忆 = 摘要记忆 | round-summary 自动生成，WorkingMemoryInspector 消费 |
| Loop = 闭环自然生长 | 最小执行闭环，handoff 控制循环 |
| 单一真理源 | protocol.ts 统一消息协议 |
| 薄壳装配 | assemble.ts 注入所有依赖 |

### 4.3 禁止操作

| 禁止 | 原因 |
|------|------|
| 在宿主实现记忆衰减/搜索逻辑 | 内核已实现，宿主只需存储接口 |
| 绕过 IMemoryStorage 直接操作记忆文件 | 破坏接口抽象 |
| 在 manifest 声明非约定名内容文件路径 | 违反 R7 规则 |
| 在内核 AgentOptions 之外传入自定义字段 | 破坏契约 |
| 修改内核源码以适配宿主 | 宿主通过接口注入，不修改内核 |

---

## 五、验收标准

### Phase 1 验收

```
✅ WorkspaceStorage.save() 使用 atomicWriteFileSync
✅ WorkspaceSessionStore.save() 使用 atomicWriteFileSync
✅ WorkspaceStorage.upsert() 调用 validateSource
✅ typecheck 无错误
✅ 全量测试通过
```

### Phase 2 验收

```
✅ 5 个角色包 manifest 移除 persona/rules 路径声明
✅ 每个角色包有 skills/ 目录（至少 1 个技能文件）
✅ manifest 有顶层 capabilities 声明
✅ configDir/skills/ 有全局技能文件
✅ 插件启动后角色包扫描正常（5 个角色包 + 全局技能池）
```

### Phase 3 验收

```
✅ 切换角色包后工具暴露面变化（如"技术文档工程师" block 模式下工具受限）
✅ skillMatched 事件触发时 UI 有提示
✅ 技能指示器显示当前角色包的技能列表
```

### Phase 4 验收

```
✅ Loop 自动续跑不超过 3 轮（可配置）
✅ 暂停/恢复按钮可用
✅ 工具权限徽章实时更新
✅ 用户中断后状态正确恢复
```

---

## 附录 A：角色包 manifest 对齐示例

### 对齐前（方案设计师）

```json
{
    "name": "方案设计师",
    "persona": "persona.md",
    "rules": "rules.md",
    "skills": [
        { "capability": "file:read", "description": "读取既有文档与代码" },
        { "capability": "file:write", "description": "写入设计方案文档" },
        { "capability": "web:search", "description": "搜索最新行业资料" }
    ]
}
```

### 对齐后

```json
{
    "name": "方案设计师",
    "formatVersion": "1.0.0",
    "keywords": ["方案设计", "SSOT", "最小单元"],
    "trigger": ["/(方案设计|proposal|design)/i"],
    "strategy": {
        "prepare": { "memoryRecall": "full", "recentRounds": 5 },
        "act": { "toolMode": "allow", "temperature": 0.5 },
        "reflect": { "handoff": "loop" }
    },
    "capabilities": [
        { "capability": "file:read", "description": "读取既有文档与代码" },
        { "capability": "file:write", "description": "写入设计方案文档" },
        { "capability": "web:search", "description": "搜索最新行业资料" },
        { "capability": "memory:recall", "description": "召回相关决策与历史设计" }
    ]
}
```

**变化**：
1. 移除 `persona` 和 `rules` 路径声明（R7 对齐）
2. 移除 `skills` 数组（改为 `skills/` 目录动态扫描，C3 对齐）
3. `capabilities` 提升为顶层（R8 对齐）
4. 保留 `strategy` / `keywords` / `trigger` 等字段
5. `formatVersion` 声明版本

## 附录 B：全局技能池设计

### `web-search.md`

```markdown
---
name: 网络搜索
description: 搜索互联网获取最新信息
keywords: ['搜索', 'search', 'web', '联网']
layer: agent
---

## 能力说明
当用户需要最新信息（如最新 API、框架版本、行业动态）时，
自动触发网络搜索技能，获取外部最新信息作为回答的养分。
```

### `code-review.md`

```markdown
---
name: 代码审查
description: 对代码进行安全与质量审查
keywords: ['审查', 'code review', '安全', 'bug', 'lint']
layer: agent
---

## 审查维度
1. 安全性（SQL 注入、XSS、密钥泄露）
2. 代码质量（命名、复杂度、重复代码）
3. 最佳实践（错误处理、类型安全）
```
