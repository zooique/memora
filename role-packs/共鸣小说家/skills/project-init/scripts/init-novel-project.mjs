#!/usr/bin/env node
/**
 * 小说工程目录初始化（共鸣小说家 · project-init 技能 · L3 scripts）
 *
 * 目录规范：编号目录 = 角色包七阶段流水线（00-需求 … 07-归档）。
 * 设定权威源 = 03-组织/设定圣经/（承接 story-bible 四卷；正文与圣经冲突时，正文是错的）。
 *
 * 用法：
 *   node init-novel-project.mjs <书名> [--dir <父目录>] [--minimal] [--force]
 *
 * 参数：
 *   <书名>      必填。项目目录名（同时写入 README）。
 *   --dir       父目录，默认当前工作目录。
 *   --minimal   精简子集（短篇/中篇）：只建 README + 设定圣经四卷 + 人物卡 + 大纲 + 正文。
 *   --force     目标目录已存在且非空时仍继续（默认中止，防覆盖已有工程）。
 *
 * 约定：
 *   - 中文路径一律无空格 —— Windows + git 处理含空格中文路径会乱码（血训）。
 *   - 纯 Node 内置模块，零第三方依赖（与内核同哲学）。
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────
// 模板（SSOT：与 story-bible / craft-review / hotspot-mapping 等技能字段对齐）
// 约定：模板内不使用反引号，避免与 JS 模板字面量冲突。
// ─────────────────────────────────────────────────────────────

const T_README = (name) => `# 《${name}》

> 由「共鸣小说家」角色包的 project-init 技能初始化。

## 一句话 logline

（待填：谁 + 想要什么 + 障碍 + 代价）

## 三层定位

- **需求层**：回应什么痛点 / 读者的什么精神缺口 →
- **内核层**：经典人性内核（不随时代变）→
- **形式层**：题材 / 设定 / 文风 →

## 当前进度

- [ ] 阶段1 需求洞察与事件转换（need-finder + hotspot-mapping）
- [ ] 阶段2 内核锁定（core-extractor）
- [ ] 阶段3 一致性闸门（three-layer-check）
- [ ] 阶段4 概念包装（logline-craft + idea-lever）
- [ ] 阶段5 组织搭建（story-structure / relationship-web / character-sheet / world-builder / story-bible）
- [ ] 阶段6 大纲与成文（outline-expand → scene-craft）
- [ ] 阶段7 打磨与体检（polish-method / longform-guard / craft-review）

## 目录约定

编号目录 = 角色包七阶段流水线。设定权威源 = 03-组织/设定圣经/ —— 正文与圣经冲突时，正文是错的。
`;

const T_HOTSPOT = `# 热点与情绪内核

> 来源技能：need-finder + hotspot-mapping。AI 不想象共鸣——只搬运事件里已经存在的情绪。

## 热点现象

- 事件：
- 时间范围（须最近一周到一个月，过时热点不用）：
- 来源平台（微博 / 知乎 / 小红书 / B 站…）：

## 情绪内核（一句话感受，不是事件描述）

- 事件是壳，壳下面的情绪才带走 →
- 判据：是读者也在感受的（是「老实人总吃亏」，不是「某案判错了」）→

## 映射到小说世界（换事件、留内核）

- 原事件外壳 → 换成的虚构设定：
- 保留的人的属性（贪婪 / 恐惧 / 被看见的渴望 / 守护 / 不甘…）：

## 验证三问

- [ ] 读者感到「这种情绪我熟悉」？
- [ ] 读者认不出原新闻（外壳换干净）？
- [ ] 删掉映射故事仍完整（非喧宾夺主）？
`;

const T_READER = `# 读者画像

- 痛点属于谁（Z世代 / 中老年 / 女性 / 男性 / 下沉市场…）：
- 精神需求缺口（解压 / 治愈 / 共鸣 / 代偿 / 爽感）：
- 读者在什么场景读（通勤 / 睡前 / 碎片）：
- 验证依据（榜单 / 评论 / 标签热度）：
- 时效性：当下红利 / 长期底色
`;

const T_CORE = `# 人性内核卡

> 来源技能：core-extractor。内核不随时代变——从经典提炼骨架，不抄故事。

- 内核（一句话人性命题）：
- 经典出处与提炼方式（换时代 / 换人物 / 换冲突具象）：
- 与需求层痛点的匹配理由：
- 情绪价值承诺（读者读完得到什么）：
`;

const T_GATE = `# 三层一致性检查（闸门）

> 来源技能：three-layer-check。**硬关卡**——不过闸不进入大纲成文。

| 检查 | 判定 |
| --- | --- |
| 内核 ↔ 需求（内核回应的就是这个痛点？） |  |
| 题材 ↔ 内核（形式由内核决定，不反过来） |  |
| 形式 ↔ 读者（这个形式这个读者群吃得下？） |  |
| 情绪价值 ↔ 需求缺口（交付的就是承诺的？） |  |

- 结论：通过 / 不通过（不通过则回需求层或内核层重来，不许硬写）
`;

const T_LOGLINE = `# logline

- 一句话卖点（谁 + 想要什么 + 障碍 + 代价）：
- 开篇方向：
- 候选版本（A / B / C，用 idea-lever 展开后挑）：
`;

const T_LEVER = `# 创意杠杆候选

> 来源技能：idea-lever。方向性岔路口先穷举，作者挑选或融合——穷举不替代判断。

## 岔路口

（写明是哪一处：内核 / 开头 / 转折）

## 候选（≥3 个异质候选，各带优缺点与代价）

1. 方向：
   - 优点：
   - 代价：
2. 方向：
   - 优点：
   - 代价：
3. 方向：
   - 优点：
   - 代价：
`;

const T_STRUCTURE = `# 三幕骨架

> 来源技能：story-structure。

- **激励事件**（第一幕末，打破平衡）：
- **中点**（第二幕中，真假胜负 / 认知反转）：
- **高潮**（第三幕，代价最大的抉择）：
- 纪律：每一章自问「这章冲突是升级、反转还是收束」，答不出即重写。
`;

const T_RELATION = `# 人物关系网

> 来源技能：relationship-web。

- 主角 ↔ 对手：价值观镜像（对手是主角的另一种可能）：
- 关系张力清单（谁对谁有未清的账）：
- 阵营与利益流向：
`;

const T_WORLD = `# 世界观

> 来源技能：world-builder。设计期工作稿——定稿后并入 03-组织/设定圣经/卷2-世界观设定.md；正文一致性以设定圣经为准。

- 时代 / 期限 / 地点 / 冲突层面（四维）：
- 规则清单（每条规则 + 它产生的冲突）：
- 修订记录（何时改了什么）：
`;

const T_CHAR_TEMPLATE = `# 人物卡模板

> 来源技能：character-sheet。复制本文件为每个角色新建一份。设计期工作稿——定稿后并入 03-组织/设定圣经/卷1-人物档案.md；正文一致性以设定圣经为准。

## 人物：<名字>

- **目标（想要什么）**：
- **需求（真正需要什么，与目标冲突）**：
- **障碍（什么挡着）**：
- **代价（得到要付出什么）**：
- **缺陷（具体化，不是形容词）**：
- **压力下的反应方式**（幽默 / 照顾 / 外化 / 内化 / 沉默）：
- **语言指纹**（遮住名字能认出是谁）：
- **弧光事件**（哪几件事让他变了）：
`;

const T_BIBLE_1 = `# 卷 1 · 人物档案

> 来源技能：story-bible。**一致性权威源**——正文与圣经冲突时，正文是错的。（设计期人物卡在 ../人物卡/，定稿后并入本卷）

## <人物名>

- 目标（当前）：
- 动机（深层）：
- 压力下的反应方式：
- 关系：<谁>（连接 / 张力 / 弧线）
- 状态变化：<章节> 发生了什么 → 状态如何变
`;

const T_BIBLE_2 = `# 卷 2 · 世界观设定

> 来源技能：story-bible。**一致性权威源**。（设计期世界观稿在 ../../世界观.md，定稿后并入本卷）

- 时代 / 期限 / 地点 / 冲突层面（四维）：
- 规则清单：每条规则 + 它产生的冲突
- 修订记录：何时改了什么（防设定漂移后读者对不上）
`;

const T_BIBLE_3 = `# 卷 3 · 时间线

| 章节 | 关键事件 | 人物状态 | 伏笔 |
| --- | --- | --- | --- |
`;

const T_BIBLE_4 = `# 卷 4 · 伏笔台账

> 来源技能：foreshadow。埋得轻、收得重、埋收必对。

| 伏笔 | 埋设章节 | 计划回收章节 | 当前状态（待回收 / 已回收 / 悬置） |
| --- | --- | --- | --- |
`;

const T_OUTLINE = `# 大纲索引

> 来源技能：outline-expand（五级展开：一句话 → 一段 → 一幕 → 一场 → 成文）。

| 卷 | 章 | 定位（升级 / 反转 / 收束） | 状态 |
| --- | --- | --- | --- |
`;

const T_CHAPTERS = `# 正文

- 命名：第001章-标题.md（三位数补零、标题无空格）。
- 动笔前先读 ../03-组织/设定圣经/ 四卷 —— 不靠对话记忆，承接前文以圣经为准。
- 新增设定先入册再写；矛盾以圣经为准，改正文。
- 长篇每 5 章复盘一次：时间线 / 伏笔台账对一遍，防漂移。
`;

const T_REVIEW = `# 体检报告

> 来源技能：craft-review / polish-method / longform-guard。

## 四道自检

- [ ] 价值转变（每场景有好→坏 / 坏→好 / 信息揭晓）
- [ ] 情绪价值达成（对照需求层承诺）
- [ ] 留存思维（开头 3 章留人、章末有钩）
- [ ] 三层一致性在正文中维持

## 反 AI 叙事特征（结构层）

- [ ] 无说教点题句
- [ ] 有留白与支线（非闭环单线）
- [ ] 句长有参差（非节拍器）
- [ ] 主角非全能（配角 / 环境 / 巧合偶尔主导）

## 微层去AI味（字句级）

- [ ] 无「然而 / 因此 / 与此同时 / 值得注意的是」等过渡词套路
- [ ] 无「首先…其次…最后」规整句式
- [ ] 无 ≥3 个形容词堆砌
- [ ] 对话标签不规整（无「他微微一笑，开口说道」）
- [ ] 叙述者留有犹豫（结论没给满、承认不确定、克制收尾）

## 问题清单（按严重度）

1.
`;

const T_ARCHIVE = `# 归档

废稿与旧版本放这里，不删 —— 写作的退路。
`;

// ─────────────────────────────────────────────────────────────
// 目录规范（唯一可执行真源；SKILL.md 为其说明文档）
// min=true 表示 --minimal 精简子集也包含
// ─────────────────────────────────────────────────────────────

const STRUCTURE = [
  { p: '00-需求', dir: true },
  { p: '00-需求/热点与情绪内核.md', c: T_HOTSPOT },
  { p: '00-需求/读者画像.md', c: T_READER },
  { p: '01-内核', dir: true },
  { p: '01-内核/人性内核卡.md', c: T_CORE },
  { p: '01-内核/三层一致性检查.md', c: T_GATE },
  { p: '02-概念', dir: true },
  { p: '02-概念/logline.md', c: T_LOGLINE },
  { p: '02-概念/创意杠杆候选.md', c: T_LEVER },
  { p: '03-组织', dir: true, min: true },
  { p: '03-组织/三幕骨架.md', c: T_STRUCTURE },
  { p: '03-组织/人物关系网.md', c: T_RELATION },
  { p: '03-组织/世界观.md', c: T_WORLD },
  { p: '03-组织/人物卡', dir: true, min: true },
  { p: '03-组织/人物卡/人物卡模板.md', c: T_CHAR_TEMPLATE, min: true },
  { p: '03-组织/设定圣经', dir: true, min: true },
  { p: '03-组织/设定圣经/卷1-人物档案.md', c: T_BIBLE_1, min: true },
  { p: '03-组织/设定圣经/卷2-世界观设定.md', c: T_BIBLE_2, min: true },
  { p: '03-组织/设定圣经/卷3-时间线.md', c: T_BIBLE_3, min: true },
  { p: '03-组织/设定圣经/卷4-伏笔台账.md', c: T_BIBLE_4, min: true },
  { p: '04-大纲', dir: true, min: true },
  { p: '04-大纲/大纲索引.md', c: T_OUTLINE, min: true },
  { p: '05-正文', dir: true, min: true },
  { p: '05-正文/README.md', c: T_CHAPTERS, min: true },
  { p: '06-体检', dir: true },
  { p: '06-体检/体检报告模板.md', c: T_REVIEW },
  { p: '07-归档', dir: true },
  { p: '07-归档/README.md', c: T_ARCHIVE },
];

// ─────────────────────────────────────────────────────────────
// 参数解析
// ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  printUsage();
  process.exit(argv.length === 0 ? 1 : 0);
}

const flags = new Set();
const options = {};
const positional = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--minimal' || arg === '--force') {
    flags.add(arg);
  } else if (arg === '--dir') {
    options.dir = argv[++i];
  } else {
    positional.push(arg);
  }
}

const bookName = positional[0];
if (!bookName) {
  console.error('✗ 缺少书名。用法见 --help');
  process.exit(1);
}

// 安全校验：书名不含空格 / 路径分隔符（Windows + git 中文空格路径会乱码）
if (/\s/.test(bookName)) {
  console.error(`✗ 书名不能含空格（Windows + git 处理含空格中文路径会乱码）→ 建议改用：${bookName.replace(/\s+/g, '-')}`);
  process.exit(1);
}
if (bookName.includes('/') || bookName.includes('\\') || bookName === '.' || bookName === '..') {
  console.error('✗ 书名不能含路径分隔符或为 . / ..');
  process.exit(1);
}

const parentDir = options.dir ? resolve(options.dir) : process.cwd();
const targetDir = join(parentDir, bookName);

// 目标目录非空保护
if (existsSync(targetDir)) {
  const existing = await readdir(targetDir);
  if (existing.length > 0 && !flags.has('--force')) {
    console.error(`✗ 目标目录已存在且非空：${targetDir}\n  加 --force 可继续（已存在文件会跳过，不覆盖）。`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// 生成
// ─────────────────────────────────────────────────────────────

const minimal = flags.has('--minimal');
const plan = minimal ? STRUCTURE.filter((e) => e.min) : STRUCTURE;

const created = [];
const skipped = [];

// 项目根目录
await mkdir(targetDir, { recursive: true });

// README（门面，两种模式都要）
const readmePath = join(targetDir, 'README.md');
if (existsSync(readmePath) && !flags.has('--force')) {
  skipped.push('README.md');
} else {
  await writeFile(readmePath, T_README(bookName), 'utf-8');
  created.push('README.md');
}

for (const entry of plan) {
  const full = join(targetDir, entry.p);
  if (entry.dir) {
    await mkdir(full, { recursive: true });
    created.push(entry.p + '/');
    continue;
  }
  await mkdir(dirname(full), { recursive: true });
  if (existsSync(full) && !flags.has('--force')) {
    skipped.push(entry.p);
    continue;
  }
  await writeFile(full, entry.c, 'utf-8');
  created.push(entry.p);
}

// ─────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────

console.log(`\n✓ 小说工程已初始化：${targetDir}`);
console.log(`  模式：${minimal ? '精简（--minimal）' : '完整（七阶段）'}`);
console.log(`\n  已创建 ${created.length} 项：`);
for (const c of created) console.log(`    + ${c}`);
if (skipped.length > 0) {
  console.log(`\n  跳过 ${skipped.length} 项（已存在，未覆盖）：`);
  for (const s of skipped) console.log(`    - ${s}`);
}
const nextStep = minimal
  ? '先填 03-组织/设定圣经/ 四卷（人物档案 / 世界观 / 时间线 / 伏笔台账），再进 04-大纲 与 05-正文。'
  : '先填 00-需求/热点与情绪内核.md（搜热点 → 提情绪内核 → 映射进小说世界）。';
console.log(`\n  下一步：${nextStep}\n`);

function printUsage() {
  console.log(`小说工程目录初始化（共鸣小说家 · project-init）

用法：
  node init-novel-project.mjs <书名> [--dir <父目录>] [--minimal] [--force]

参数：
  <书名>      必填。项目目录名，不得含空格（Windows + git 中文空格路径会乱码）。
  --dir       父目录，默认当前工作目录。
  --minimal   精简子集（短篇/中篇）：README + 人物卡 + 设定圣经四卷 + 大纲 + 正文。
  --force     目标目录非空时仍继续（已存在文件跳过，不覆盖）。

示例：
  node init-novel-project.mjs 长夜将尽 --dir ./novels
  node init-novel-project.mjs 春雨 --minimal
`);
}
