# role-packs 示例库

> **声明**：本目录下的角色包是 **示例 / 参考实现**，用于展示角色包目录结构、字段用法和内核支持能力。**随 @zooique/memora npm 包发布，仅作示例 / 参考，不作生产使用**（不进入宿主运行时产物）。

## 身份

本示例库归属 memora 内核仓库，随内核版本演进，**随 npm 包发布、不进入宿主运行时产物**：

| 项 | 说明 |
|----|------|
| 身份 | 示例 / 参考 |
| 归属 | memora 内核示例库 |
| 分发 | 随 @zooique/memora npm 包发布（见 `package.json` files）；不进入宿主运行时产物（VSIX 等） |
| 生命周期 | 随内核能力演进，独立于宿主角色包 |

## 接入者指引

- 宿主（如 VS Code 插件）应使用**宿主内置角色包**作为生产配置，参阅中立规范 [role-pack-spec.md](../docs/architecture/role-pack-spec.md) §9.1 示例库 vs 宿主生产库（仓库内文档；随包发布的使用入口见 [role-pack-开放键指南](../docs/role-pack-开放键指南.md)）。
- 本目录仅作**结构参考**和**字段 / 能力用法示例**，修改本目录内容不影响任何宿主运行时行为。
- 新增宿主时，可复制本目录角色包到宿主内置目录，复制后即"分叉"——各自独立演进，不回写本目录。

## 角色包清单

| 角色包 | 说明 | 覆盖能力面 |
|--------|------|-----------|
| 文档设计师 | 示例：工具型角色包——技术文档设计（API 文档 / 教程 / 架构说明） | 真实 skills/ 文件（read_skill L2）+ capabilities + strategy（toolMode:allow / 低温度）+ handoffPrompt |
| 小说助手 | 示例：创作型角色包——小说写作（结构 / 人物 / 对白 / 伏笔） | 真实 skills/ 文件 + capabilities + strategy（高温度 / askOn 主动提问）+ handoffPrompt |
| 方案设计师 | 示例：方法论型角色包——基于 memora 设计哲学（单一真理源·最小单元·网络为土壤）从模糊想法设计自洽方案 | 真实 skills/ 文件（种子收敛/土壤吸收/SSOT 自检）+ capabilities（含 memory:recall / llm:summarize）+ strategy（contextAssembly:hybrid / handoff:loop）+ handoffPrompt |

> 三个示例包**全面覆盖当前角色包设计**：**内容文件零声明**（persona.md / rules.md 约定名 + skills/ 目录扫描，manifest 不含任何内容路径注册）、顶层 capabilities（能力面）、strategy 策略、handoffPrompt 衔接提示词。开放键使用与消费方说明见 [role-pack-开放键指南](../docs/role-pack-开放键指南.md)；完整中立规范见 [role-pack-spec.md](../docs/architecture/role-pack-spec.md)（仓库内文档）。