/**
 * 列工作区文件时的排除 glob —— 单一真源（HOST-CTX-14）
 *
 * 派生自内核 `IGNORED_DIR_NAMES`：`list_dir` / `search_project` / mention 文件列表
 * 共用同一套忽略规则，禁并列维护第二份基线（内核新增忽略目录时三处须同时生效，
 * 各写一份必漂移）。
 *
 * 🔴 为什么必须**显式**传给 `vscode.workspace.findFiles`，不能传 `undefined` 指望默认排除：
 * legacy `findFiles` 只应用 `files.exclude`、**不应用** `search.exclude`、
 * `.gitignore` **默认不尊重**（VS Code 源码 extHostWorkspace.ts 一手实读：
 * `useExcludeSettings=FilesExclude`；`useIgnoreFiles.local=false` 自 VS Code 1.87 起
 * 硬编码，PR #204845 合入 2024-02；opt-in 开关 = `search.experimental.useIgnoreFilesInFindFiles`）。
 * 传 `undefined` 时 `node_modules`（memora 仓实测 32,040 文件）/ `dist` / `coverage`
 * 全进列表、撞 `MENTION_FILE_LIMIT` 上限**静默截断** ⇒ 用户想引的源码文件随机缺席
 * （HOST-CTX-11 报「搜不到还以为没有」、CTX-14 实锤根因）。
 *
 * 形态 = 每个忽略目录名生成一条「双星斜杠 目录名 斜杠双星」的 glob（VS Code glob
 * 语义：任意深度下该名目录的内容全排；字面量形态见下方代码行）。
 */
import { IGNORED_DIR_NAMES } from '@zooique/memora';

/** 逐目录 glob 数组（供断言/拼接场景；测试断言请写字面量黄金串，勿镜像本常量——镜像断言两边同错照样绿） */
export const IGNORED_DIR_GLOBS: readonly string[] = IGNORED_DIR_NAMES.map((d) => `**/${d}/**`);

/** 逗号拼接形态（`findFiles` exclude 实参直接消费） */
export const IGNORED_DIR_GLOB: string = IGNORED_DIR_GLOBS.join(',');
