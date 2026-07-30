# Changelog

本文件记录 memora-sprite 的版本变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.5.0] - 2026-07-30

> 本版本打包内核 `@zooique/memora` **2.0.2**（万物皆记忆 v2：Persona/Skill 从 SQLite 索引解耦、技能当轮实时生效；详见内核 CHANGELOG）。发版仅升宿主版本，内核独立维护、无需同步升号。

### Added

#### 对话与补全
- 主对话补全弹窗折叠开关：候选列表顶部新增「收起候选」，点击后弹窗折叠为胶囊条（显示候选计数），
  让出被遮挡的对话内容供回看/复制；点击胶囊展开恢复。折叠态不拦截 ↓↑ 按键、继续输入不自动展开，
  发送/选中/清空后下次出现恢复展开（quick-input 浮窗由窗口增高避让，不受影响）

## [1.1.0] - 2026-07-11

从 1.0.0 到 1.1.0 的功能增强与质量收敛版本。核心目标：对话操作深化、感知面板独立化、PanelManager 拆分收敛、体验评审全链路、防御式编程消除。

### Added

#### 对话与消息
- 消息右键菜单（复制/重新生成/忘记/分叉会话）
- 深化对话操作：重新生成支持任意位置 + 忘记删除消息对
- 会话管理闭环：回到今天按钮 + 跨会话内容搜索
- 冲突检测 banner 新增查看跳转到冲突记忆详情

#### 记忆与图谱
- 记忆详情新增直接邻居视图（Phase 5.2 渲染层补全，1 跳全景 both 方向）
- 仪表盘运行指标补全召回/工具绝对值明细 + 衰减最近运行时间

#### 快速输入与补全
- 快速输入补全浮窗（Phase 1 骨架 + Phase 2 补全能力 + 记忆沉淀闭环）
- 输入补全集成到主对话输入框——功能可发现性闭环
- 方向 A 遗忘召回

#### 感知与仪表盘
- 感知面板独立化（从 DashboardPanelManager 分离为 PerceptionPanelManager）
- 仪表盘指标明细补全

#### 设置与应急
- 设置面板新增强制释放对话锁入口（应急恢复）
- 快捷键帮助补全——9 项扩展到 18 项并分组
- 空状态补充快捷键帮助引导

#### 工程化
- memora 依赖改为 file: 协议 + sync-memora 同步脚本
- ADR-SP-005 记录 file: 协议决策修订

### Fixed

- Phase 1 P0+P1 阻塞项全量收敛
- Phase 2 P2 质量收敛
- 感知面板情感基调视觉不可见 + 仪表盘 Canvas 空白
- WCAG AA 颜色对比度 + z-index 层级冲突
- 2 处 outline:none 覆盖全局 focus-visible 兜底
- 对话模块审查修复——跨 group 遍历 + IME 守卫 + XSS + 截断保留
- 感知层降级保护 + applyProjectMode 降级策略对齐
- collectMatches 无限循环导致测试 OOM
- 会话搜索模块闭环修复
- P0 功能可达性修复——3 个已实现但完全不可达的功能恢复
- quickInputCompletion ArrowUp 循环导航 bug
- NSIS 配置移到顶层（electron-builder 26 schema 要求）

### Changed

#### PanelManager 拆分收敛（F-LINE-1/2）
- chatPanelManager.ts 1711 → 1262 行（-448 行）：提取 startupSummaryBanner + messageOperations + chatPanelEvents 三个 helper
- memoryPanelManager.ts 1968 → 1334 行（-634 行）：提取 memoryGraphPanel + memoryDetailPanel 两个 helper
- Context 依赖注入 + 纯函数 helper 模式成为 PanelManager 拆分的标准范式

#### 体验评审全链路
- CSS 令牌统一治理（A-2/A-3/A-4）：消除硬编码颜色/字号/间距，统一 tokens.css 真理源
- 按钮体系统一（B-1）：primary/secondary/danger 三态 + active 绿色高亮
- 弹窗结构统一（B-2）：modal-header + modal-body + modal-footer 标准布局
- 文案同步（S-0）：术语统一（忘记→隐藏此对话、分叉会话→新建会话、在对话中讨论→去对话中提问）

#### 代码质量
- 防御式编程消除——契约式编程转型（直面 bug 修复 bug，不掩盖问题）
- 渲染进程日志统一收敛（console 改用 reportError 统一函数）
- F-P0 技术债偿还——4 处写操作从直调 IPC 改为回调注入
- 基于 coding-convention-rules 9 大约束规则对齐全量重构
- 全局组件/输入区/仪表盘/记忆/设置/感知模块 UX 审查修复
- 扩散剪枝——消除项目全局硬编码魔法数字，统一复用 constants.ts
- 渲染层长线迭代——表单校验统一 + errorState 提取 + 可访问性深度审计
- 剪枝去痕——清理 themeManager 调试日志与变更说明注释

### Removed

- 感知面板选项卡方案文档（已实施，方案文档归档）
- 渲染层剪枝 C-1 修改痕迹 + C-2 CSS 硬编码收尾

## [1.0.0] - 2026-07-08

首个正式版本。对齐 memora 1.0.1 内核，完整实现 Phase 1-4 全部交付物。
