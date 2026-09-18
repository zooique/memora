# Memora MVP 边界（写作助手初版）

> **⚠️ 历史文档**：本文是 MVP 阶段的规划定稿，描述的是未落地时立项的边界假设。**后续落地已偏离本文**——特别是工具命名（`writeFile`/`readFile` → 现为 `write_file`/`read_file`）与工具暴露模型（MVP 设想工具挂角色包 skill，现已演进为「顶层 `capabilities` → `src/role-pack/capabilityMap.ts` 映射工具白名单（C2）+ 技能目录动态扫描（C3）」）。本文仅作历史脉络参考，**不作为现行实现依据**；工具命名/角色包结构以 [role-pack-spec.md](./role-pack-spec.md) 与源码为准。
>
> **定位**：MVP = 验证「先聊后干」主链路的第一个可用产品——陪用户聊出思路，拍板后自动生成文章并写入本地文件。
> **原则**：MVP 是**全量设计的子集**。MVP 内不引入全量设计之外的新机制；砍掉的能力一律后置，不预埋接口、不半实现。

## 历史说明
本文为 MVP 阶段（写作助手初版）的立项边界规划，落地已偏离，不作现行依据。现状真理源：[role-pack-spec.md](./role-pack-spec.md)（角色包标准本体）· [architecture_philosophy_rules.md §11](../../.trae/rules/architecture_philosophy_rules.md)（插卡机设计哲学）。正文已随 2026-09-18 docs 清理瘦身为头部索引，完整历史见 git 历史。