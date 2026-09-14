# skills 技能目录

> 本目录承载角色的**领域方法库**（渐进披露：skill 文件 frontmatter 的 name/description 常驻 L1，正文经 read_skill 按需读 L2）。
>
> 新增技能：在本目录创建 `*.md`，**frontmatter 必须声明 `name` 与 `description`**（缺 description 的技能不可用，不会激活）。
> `skills/` 目录动态扫描注册——无需在 manifest.json 注册路径（内容文件零声明）。
>
> **description 编写规范（描述四问）**：description 是 LLM 决定是否调 `read_skill` 的唯一说明书，务必写清——
> ① 做什么（一句话动作）② 何时用（触发场景）③ 输入（接受什么）④ 返回（结果形式，含失败形态）。
> 反例：`处理数据`（含糊，LLM 无法判断相关性）→ 正例：`将 Markdown 表格转 CSV：输入表格路径，返回 CSV 文本；整理文档数据时用`。
> 作品投影等索引描述同理：一句话说清「文件是什么 + 何时会用到」。
>
> **引用格式**：在 persona.md / rules.md 里引用本目录技能时，**必须用反引号包裹技能名**（如 `foreshadow`）——这是唯一合法形式，且受双向守卫保护（每个技能至少被引用一次 / 每条引用都指向真实技能）。
>
> 若本角色暂无领域方法库，此文件可删除。