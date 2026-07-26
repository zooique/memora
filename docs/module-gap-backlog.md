# 模块缺口 Backlog

> 扫描日期：2026-07-26
> 范围：三路并行扫描未审模块（精灵感知系统 / 核心库 / 存储·共享·Web）
> 裁决标准：操作流中断 > 新功能，数据安全 > 体验增强

---

## 实装状态标记

- **[DONE]** 已实装
- **[TODO]** 待实装
- **[SKIP]** 经评估暂不实装（附理由）

---

## 一、精灵感知系统（sprite/ 15 文件）

### High

| ID | 文件:行 | 缺口 | 状态 |
|---|---|---|---|
| H1 | fileWatcherTrigger.ts:80-100 | 文件监听路径被拒仅 warn，用户无感 | [DONE] |
| H2 | fileWatcherTrigger.ts:92-98 | 监听器创建失败仅 warn | [DONE] |
| H3 | fileWatcherTrigger.ts:129-131 | watcher error 事件仅 logger.error | [DONE] |
| H4 | sprite.ts:530-557 | personas 目录热重载启动失败用户无感 | [DONE] |
| H5 | spriteLifecycleManager.ts:222-246 | 回收站自动清理失败静默吞掉 | [DONE] |
| H6 | sprite.ts:958-998 | 设定文件内核联动失败用户不知 | [DONE] |
| H7 | sprite.ts:718-741 | 专注模式项目切换失败用户无感 | [DONE] |
| H8 | triggers.ts:19-24 | 触发原因不暴露给用户 | [DONE] |
| H9 | proactiveEngine.ts:428-481 | 主动提示被多条件静默抑制，用户不知道错过了什么 | [DONE] |
| H10 | proactiveEngine.ts:718-783 | 里程碑事件可能永远无法展示 | [DONE] |
| H11 | spriteConfig.ts:320-374 | 配置文件损坏静默回退，用户丢失全部设置 | [DONE] |

### Medium

| ID | 文件:行 | 缺口 | 状态 |
|---|---|---|---|
| M1 | rapportController.ts:177-182 | 默契度等级变化无通知 | [SKIP] 需为 RapportController 增加回调机制，低需求 |
| M2 | affectController.ts:122-164 | 情感基调四维值用户不可见 | [SKIP] 情感值展示属于 UI pull 功能，非主动 push 缺口 |
| M3 | contextAwareness.ts:161-169 | 对话节奏分析影响提示抑制但用户无感 | [SKIP] 抑制逻辑对用户透明是设计意图 |
| M4 | memoryHealth.ts:273-278 | 记忆健康度降至 poor/critical 无主动通知 | [DONE] generateSmartSuggestions 增加 overall<50 检测 |
| M5 | patternDetector.ts:216-262 | 知识缺口检测结果仅走 ProactiveEngine 通道 | [SKIP] ProactiveEngine 是唯一信息出口，走同一通道是设计收敛 |
| M6 | patternDetector.ts:276-326 | 兴趣漂移检测结果用户不可直接查看 | [SKIP] 兴趣漂移属 UI pull 展示，非主动通知缺口 |
| M7 | perceptionCoordinator.ts:411-455 | 跨会话上下文选取的记忆用户不可见 | [SKIP] 上下文选取是内部推理过程，暴露给用户导致信息过载 |
| M8 | spriteConfigManager.ts:221-236 | 每日消息计数持久化失败静默吞掉 | [DONE] |
| M9 | sprite.ts:650-702 | 欢迎回来记忆召回失败用户无感 | [DONE] |
| M10 | proactiveEngine.ts:134 | promptedPatterns 无限增长且不可重置 | [DONE] |
| M11 | contextAwareness.ts:202-210 | 对话深度判定基于内容长度过于粗糙 | [SKIP] 深度判定算法改进是持续优化事项 |
| M12 | spriteLifecycleManager.ts:441-476 | 工作品投影更新失败静默吞掉 | [DONE] |
| M13 | reviewManager.ts:190-201 | 记忆增长趋势变化方向无主动通知 | [DONE] lastTrendDirection 状态对比 + 方向变更通知 |

### Low

| ID | 文件:行 | 缺口 | 状态 |
|---|---|---|---|
| L1 | sprite.ts:807-819 | 角色模式持久化失败仅 warn | [DONE] |
| L2 | triggers.ts:113-126 | 触发器回调异常仅记录不通知 | [DONE] |
| L3 | sprite.ts:569-586 | personas 热重载失败仍发射 configFilesChanged 事件 | [DONE] |
| L4 | proactiveEngine.ts:266-269 | acceptanceRate 无数据时返回 0.5 默认值 | [SKIP] 0.5 是合理中间值，返回特殊值需要改 getter 类型签名，收益低 |
| L5 | affectController.ts:24-47 | 情感关键词修正范围有限（硬编码中文） | [SKIP] 关键词扩展是持续改进事项，非结构性缺口 |
| L6 | presenceController.ts:83 | 窗口失焦离开 debounce 2 分钟内不可见 | [SKIP] 2min debounce 是防抖设计，缩短会导致误触发 |
| L7 | patternDetector.ts:186 | 重复主题检测 50% 占比阈值过高 | [SKIP] 阈值是经验参数，可通过配置暴露，非缺口 |
| L8 | patternDetector.ts:225-227 | 知识缺口检测仅依赖 "?" 字符 | [SKIP] 检测算法改进是持续优化事项 |
| L9 | spriteConfig.ts:298-313 | 配置版本迁移失败无通知 | [SKIP] spriteConfig 是纯函数模块无回调机制，迁移是启动时一次性操作 |
| L10 | spriteConfigManager.ts:207-215 | 每日消息计数 7 天后静默丢弃 | [SKIP] 7 天窗口是有意设计，旧数据对趋势分析无价值 |
| L11 | sprite.ts:124-125 | 衰减完成事件 24h 节流但用户不知 | [SKIP] 节流是防骚扰设计，通知用户每次衰减完成会过度打扰 |
| L12 | spriteLifecycleManager.ts:394-411 | smartSuggestions 受 ProactiveEngine 抑制 | [DONE] |

### 系统性缺口

| ID | 范围 | 缺口 | 状态 |
|---|---|---|---|
| S1 | 多控制器 | 感知推导四维结果缺乏统一展示入口 | [TODO] 需设计统一感知面板 API |
| S2 | proactiveEngine + patternDetector + memoryHealth + reviewManager | ProactiveEngine 是唯一信息出口瓶颈 | [DONE] |
| S3 | spriteConfigManager + spriteConfig | 配置变更无用户确认反馈 | [DONE] onConfigChanged ���调 + 4 种关键变更通知 |

---

## 二、核心库 Agent + Memory（src/agent/ + src/memory/）

### High

| ID | 文件:行 | 缺口 | 状态 |
|---|---|---|---|
| H1 | dedupManager.ts:147-225 | 语义去重完全静默 | [DONE] onCompleted 回调 + dedupCompleted 事件 |
| H2 | memoryDecayScheduler.ts:299-396 | L2 时效性评估静默降级 | [SKIP] onDecayCompleted/decayCompleted 已覆盖衰减免周期 |
| H3 | memoryDecayScheduler.ts:172-178 | 记忆衰减调度器后台运行无感知 | [TODO] 需为 decayScheduler 增加生命周期事件 |
| H4 | contextManager.ts:187-279 | 上下文窗口截断静默丢弃用户消息 | [DONE] 4 层注入链完成：agent→assembler→AgentLoop→ContextManager |
| H5 | autoConfigRefiner.ts:61-104 | AutoConfigRefiner 后台提取配置建议无通知 | [TODO] 需增加 configSuggested 事件 |
| H6 | workProjection.ts:91-161 | 作品投影生成无感知（无 memoryAdded 也无事件） | [DONE] WorkProjectionManager.onGenerated 回调 + 4 层接线 |
| H7 | sessionArchiver.ts:103-140 | 会话内容归档无独立进度事件 | [TODO] 需增加 sessionArchived 事件 |

### Medium

| ID | 文件:行 | 缺口 | 状态 |
|---|---|---|---|
| M1 | memoryAdvisor.ts:195-256 | 记忆健康诊断算出来却不主动告诉任何人 | [TODO] |
| M2 | memoryAdvisor.ts:383-454 | L3 语义冲突检测手动触发，无定期巡检 | [TODO] |
| M3 | relationBuilder.ts:179-224 | 关系构建（supports/follows/refines/caused）完全静默 | [TODO] |
| M4 | insightExtractor.ts:276-290 | Insight 提取的预检去重 + 质量分级对用户不透明 | [TODO] |
| M5 | userProfile.ts:207-209 | 用户画像待确认条目无主动通知 | [TODO] |
| M6 | userProfile.ts:359-400 | 用户画像冲突解决无通知——旧事实被静默删除 | [TODO] |
| M7 | guardrail.ts 全文 | Guardrail block/warn 无结构化事件 | [TODO] |
| M8 | contextManager.ts:449 | Context summary 摘要内容不回传宿主 | [TODO] |
| M9 | loop.ts:409-424 | 工具调用的 Reflection（自修正）对用户不透明 | [TODO] |
| M10 | agent.ts:448-460 | 配置热重载暂存+补执行无可见反馈 | [DONE] configReloaded 事件已接线 |
| M11 | loader.ts:63-100 | 记忆加载器启动扫描错误静默吞没 | [TODO] |

### Low

| ID | 文件:行 | 缺口 | 状态 |
|---|---|---|---|
| L1 | agent.ts:534-536 | boost score 持久化失败无事件 | [DONE] boostPersistFailed 事件已接线 |
| L2 | recall.ts:122-124 | 关键词搜索/语义搜索降级无事件 | [SKIP] 内部技术降级已有 logger.debug，用户不需知道 |
| L3 | agent.ts:976-980 | persona 切换防抖锁定状态变化无事件 | [SKIP] personaManager 管理锁状态，需跨层接线 |
| L4 | agent.ts:899-907 | archiveMode 切换无事件 | [DONE] archiveModeChanged 事件已接线 |
| L5 | agent.ts:846-860 | 会话切换/恢复/删除无独立事件 | [TODO] |
| L6 | workProjection.ts:133 | hash 变更检测覆盖旧投影无事件 | [TODO] |
| L7 | projectManager.ts:155-157 | InMemoryStorage 兜底降级无事件 | [TODO] |
| L8 | guardrail.ts:78+88-91 | Guardrail 规则正则编译失败放行但无主动报错 | [TODO] |
| L9 | loop.ts:448-454 | 空响应兜底无事件 | [TODO] |
| L10 | relationBuilder.ts:109+145 | RelationBuilder 未注入时静默降级无反馈 | [TODO] |

### 缺失事件类型（16 项建议）

| 建议事件 | 触发点 | 现状 |
|---|---|---|
| dedupCompleted | DedupManager 完成去重 | 无事件，报告只 return |
| timelinessEvaluated | L2 评估完成 | 无事件，fire-and-forget |
| contextTruncated | ContextManager 截断 | 无事件，用户不知道消息被丢弃 |
| contextSummarized | 摘要生成完成/失败 | 无事件，摘要内容不回传 |
| configSuggested | AutoConfigRefiner 提取建议 | 无事件，建议去了 ConfigManager |
| workProjectionGenerated | WorkProjection 生成/更新 | 无事件，无 memoryAdded |
| profilePending | 待确认画像条目产生 | 无事件，需主动轮询 |
| profileConflictResolved | 画像旧条目被替换 | 无事件，静默删除 |
| relationBuilt | 非 contradicts 关系写入 | 无事件，只有 contradicts 有 |
| guardrailTriggered | 护栏命中 block/warn | 只有 chunk 无结构化事件 |
| guardrailError | 护栏正则编译失败 | 无事件，静默放行 |
| configReloaded | 热重载完成（含补执行） | 无事件，只 logger.info |
| loadErrors | 启动扫描有文件失败 | 在 LoadResult 里但不检查 |
| healthCritical | sourceHealth 降为 critical | 无主动通知，需轮询 |
| conflictDetected (L3) | 主动冲突检测发现 | 与 insight 提取时的不对称 |
| toolReflection | Reflection 触发/耗尽 | 无 chunk/事件，用户不知自我修正 |

---

## 三、存储/共享/Web（storage/ + shared/ + web/）

### High

| ID | 文件:行 | 缺口 | 状态 |
|---|---|---|---|
| H1 | sqliteStorage.ts:89-111 | Schema 迁移静默丢数据（重建表仅保留 id+content） | [TODO] |
| H2 | spriteConfigStore.ts:120-132 | 配置损坏导致静默覆盖（loadOrDefault 返回默认后续 save 覆盖） | [DONE] |
| H3 | safeWriteJson.ts:30-35 | 非原子写入，崩溃导致文件损坏 | [DONE] 临时文件+rename 原子写入 |
| H4 | sensitivePatterns.ts:83-90 | 敏感内容被静默吞掉，不提示用户 | [SKIP] 后端已发射 sensitive-ignored 事件，UI 层订阅缺失属前端缺口 |
| H5 | server.ts:324-329 | Agent 初始化失败后用户无诊断信息 | [TODO] |
| H6 | webContext.ts:77-80 | Preload 脚本转译失败后所有 API 不可用 | [TODO] |
| H7 | systemRoutes.ts:158-189 | Web 模式保存配置后新 Agent 未注入 ctx | [TODO] |
| H8 | spriteEventBridge.ts:143-323 | Web 模式完全没有精灵事件推送（16 事件全丢） | [TODO] |

### Medium

| ID | 文件:行 | 缺口 | 状态 |
|---|---|---|---|
| M1 | errorMessages.ts:178-179 | fallback 文案过于泛化 | [DONE] 追加恢复建议 |
| M2 | llmErrorClassifier.ts:138 | 未匹配时泄露原始技术错误 | [DONE] 改为通用提示 |
| M3 | llmErrorClassifier.ts:45 | 正则可能误匹配（无 \b 边界） | [DONE] 401/403 加 \b |
| M4 | inputValidation.ts:52-57 | 验证失败不提供拒绝原因 | [SKIP] 需改返回值类型（API 重设计） |
| M5 | chatStreamRoutes.ts:146-486 | Web 模式缺少感知刷新和消息计数 | [SKIP] Web SSE 通道属架构级 |
| M6 | chatStreamRoutes.ts:242-262 | Web 模式超时不强制释放对话锁 | [SKIP] Web 超时策略属架构级 |
| M7 | chatHandlers.ts:34-36 | 输入校验失败静默吞消息 | [DONE] 增加 logger.warn |
| M8 | chatStreamHandler.ts vs chatStreamRoutes.ts | 错误映射策略不一致 | [SKIP] 策略统一属架构级重构 |
| M9 | systemRoutes.ts:186+217+233+279 | 多个路由 catch 块泄露原始错误 | [DONE] sanitizeError 统一处理 |
| M10 | systemRoutes.ts:106-114 | 配置读取失败不区分损坏和首次使用 | [DONE] 增加 corrupted 标记 |
| M11 | server.ts:363-365 | 500 错误返回英文 | [DONE] 改为中文 |
| M12 | sessionStore.ts:48-53 | 消息写入失败无用户反馈 | [SKIP] 存储层，通知责任在调用方 |
| M13 | sqliteRelationStore.ts:134-138 | 关系操作无存在性反馈 | [SKIP] 存储层，通知责任在调用方 |
| M14 | spriteEventBridge.ts:277-280 | archiveFailed 事件可能永久丢失 | [SKIP] 属架构级 |

### Low

| ID | 文件:行 | 缺口 | 状态 |
|---|---|---|---|
| L1 | nodeSqliteDatabase.ts:101-103 | close() 无幂等保护 | [DONE] _closed 标记 |
| L2 | sessionStore.ts:196-219 | copySession 覆盖目标不通知 | [SKIP] 数据操作层不应通知 UI，调用方负责 |
| L3 | systemRoutes.ts:420-432 | 仪表盘降级数据无用户提示 | [DONE] 增加 degraded 标记 |
| L4 | errorMessages.ts:119-123 | 归档失败文案无恢复建议 | [DONE] 追加恢复/重试建议 |
| L5 | chatStreamHandler.ts:185 | 窗口销毁时不发 STREAM_END | [SKIP] 已销毁窗口无法接收 IPC，正确行为 |
| L6 | chatHandlers.ts:68-78 | CHAT_FORCE_RELEASE_LOCK 无用户反馈 | [SKIP] 返回值已含 released 状态，UI 层消费 |
