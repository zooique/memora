# src/extension/commands/

命令处理器（每个命令一个文件）。extension.ts 只做**注册**与**装配接线**，命令逻辑委托到本目录。

当前命令（通用化设计，功能定位由内置角色包承载）：

- openChat：打开对话面板（装配 Agent + 注入文档上下文 + 聚焦侧边栏视图）
- demo：运行能力演示（隔离目录装配独立 Agent，产物不污染当前工作区）
- reloadSkills：重载技能与角色包（空闲重载 / 忙碌提交待执行，语义见实现注释）
- memory：记忆治理三命令（统计 / 清理过期 / 孤儿回收）
- registerWork：登记作品投影（右键文件，LLM 生成一句话描述）
- addToChat：添加到对话（右键文件/目录，仅挂路径与形态，不注入内容）
- userDataReset：「恢复初始状态」处理器（命令与设置面板按钮共用同一 handler）

thin 命令（只切选项卡再聚焦，无独立逻辑）仍内联在 extension.ts：configureModel /
openRoles；copyDiagnostics（取数 + 格式化两行，由 hostDiagnostics 单点负责排版）。

分工判据：**有分支、有 IO、有降级兜底的命令，实现进本目录**；纯导航命令留在注册行旁边，避免为三行代码开文件。
