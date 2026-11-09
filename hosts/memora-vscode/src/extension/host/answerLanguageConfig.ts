/**
 * 回答语言设置 — `memora.answerLanguage` 的唯一读取点与装配参数构造
 *
 * 为什么单独一个文件而不是塞进 `extension.ts`：那份文件已顶到行数闸门（1000/1000），
 * 且「设置项键名 + 默认值 + 装配传参」是一组同源事实，散落两处必漂移。
 *
 * 为什么这个设置不是「第二套语言真源」（ADR-042 决策 1）：真源仍唯一 = VS Code 显示语言；
 * 本项是**用户对回答语言的一层显式覆盖**（空 = 不覆盖）。它不改任何界面文案、不参与 UI
 * 本地化（那套走 `package.nls*` / l10n bundle），只在宿主产出注入 system prompt 的那一行
 * 指令时被读一次。判定与措辞全在 `responseLanguage.ts`，本文件只负责「读」。
 */
import * as vscode from 'vscode';
import type { AnswerLanguageInput } from './responseLanguage.js';

/** 设置项键（不含 `memora.` 前缀） */
const SETTING_KEY = 'answerLanguage';

/**
 * 读取用户自定义回答语言。
 *
 * @returns 用户填写的原文（空串 = 跟随显示语言）；**不做清洗**——空白折叠 / `auto` 哨兵
 *          属指令产出的判定，归 `buildResponseLanguageDirective`，此处保持「读什么给什么」
 */
export function readAnswerLanguageOverride(): string {
  return vscode.workspace.getConfiguration('memora').get<string>(SETTING_KEY, '');
}

/**
 * 构造回答语言装配参数（宿主装配层唯一入口）
 *
 * 传**读取器**而非结果：内核每轮重建 system prompt 前缀时都会同步拉一次环境快照，
 * 覆盖值随那次读取现取 ⇒ 用户改完设置，下一次回答即生效（不必重启 / 重装配）。
 */
export function answerLanguageAssembly(): AnswerLanguageInput {
  return { display: vscode.env.language, readOverride: readAnswerLanguageOverride };
}
