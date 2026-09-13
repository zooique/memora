# role-packs 角色包库

> **声明**：本目录是 memora 的角色包**唯一内容源**——既随 @zooique/memora npm 包发布供示例 / 参考，亦作 memora-vscode 宿主的**生产角色包源（构建期同步）**。内容在此维护、一处改处处生效，消除复制分叉漂移（2026-08-24 机制化单一真理源）。

## 身份

本目录归属 memora 内核仓库，随内核版本演进，**是角色包内容的单一真理源**：

| 项 | 说明 |
|----|------|
| 身份 | 唯一内容源（示例 / 参考 + memora-vscode 生产源） |
| 归属 | memora 内核仓库 |
| 分发 | 随 @zooique/memora npm 包发布（见 `package.json` files）；memora-vscode 构建期经 esbuild `copyRolePacks()` 复制到 `dist/extension/role-packs/` 进 VSIX |
| 生命周期 | 随内核能力演进；已接入宿主不再自持副本，构建期全量同步 |

## 接入者指引

- 宿主（如 VS Code 插件）应将本目录作为**角色包唯一源**：构建期从 `role-packs/` 复制到自己的 `dist/<configDir>/role-packs/`，不要复制后再手工维护副本（否则重新引入分叉漂移）。参阅中立规范 [role-pack-spec.md](../docs/architecture/role-pack-spec.md) §9.1。
- 新增 / 修改角色包：直接改本目录 → npm 包更新 + 宿主构建期自动同步，一处改处处生效。
- 宿主如需 VS Code 专属角色包（非通用，需注入宿主专属工具），应明确约定归属；一旦进入共享范畴即移回本目录统一维护。

## 角色包清单

| 角色包 | 说明 | 覆盖能力面 |
|--------|------|-----------|
| **memora助手** | **兜底契约包**（非示例，名字由内核常量 `BUILTIN_FALLBACK_PACK` 锁定，改名须走 ADR；**宿主 UI 禁删 + 构建期 existsSync 硬校验**）：领域无关的最小兜底角色，负责通用对话与任务执行 | 领域无关最小集：无 skills / 无 capabilities（省略 = 全部暴露）/ 无 strategy（走内核默认） |
| 共鸣小说家 | 示例：方法论型角色包——三层结构小说创作（**需求层**：社会热点→痛点→精神需求缺口；**内核层**：经典人性内核，跨时代稳定；**形式层**：题材文笔是内核与读者的纽带），先需求再内核后形式，写出让读者共鸣的故事 | 真实 skills/ 文件（need-finder / core-extractor / three-layer-check + 结构/人物/对白/伏笔技法）+ capabilities（web:search 特权）+ strategy（高温度 / askOn 主动提问）+ handoffPrompt |
| 白话方案设计师 | 示例：方法论型角色包——融合方案设计（单一真理源·最小单元·网络为土壤）与文档编排，先用白话把设计讲清楚，再落实为可开发的专业文档 | 真实 skills/ 文件（种子收敛/土壤吸收/SSOT 自检 + 文档骨架/风格规范/API 写法）+ capabilities（web:search 特权 / llm:summarize）+ strategy（白话优先 / askOn 含 confirm / 受众先定）+ handoffPrompt |

> 兜底契约包与示例包**同目录但性质不同**：示例可删，契约包不可删（宿主 UI 禁删 + 构建期校验）；二者均随 `copyRolePacks()` 同步进宿主 `dist/extension/role-packs/`。

> 两个示例包**全面覆盖当前角色包设计**：**内容文件零声明**（persona.md / rules.md 约定名 + skills/ 目录扫描，manifest 不含任何内容路径注册）、顶层 capabilities（能力面）、strategy 策略、handoffPrompt 衔接提示词。开放键使用与消费方说明见 [role-pack-开放键指南](../docs/role-pack-开放键指南.md)；完整中立规范见 [role-pack-spec.md](../docs/architecture/role-pack-spec.md)（仓库内文档）。