/**
 * 用户技能资产的**格式校验**（只校验、不落盘）。
 *
 * 为什么单独成模块：校验与落盘是两件事。落盘的唯一执行面是 `zipImport.ts`
 * （暂存 + 换名提交）；对话路径写技能走内核 `write_file`。把校验留在已退役的
 * `write.ts` 里，会让下一个人以为宿主还有第二套写盘器。
 *
 * 判据边界：
 *   - 本模块不读盘、不写盘、不弹框，纯函数；
 *   - 名字合法性复用 `./path.ts` 的 `sanitizeAssetName`（唯一判据，不另写正则）。
 */

// 值导入（非 import type）：拒绝原因是用户可见文案，须经 vscode.l10n.t 出本地化版本
import * as vscode from 'vscode';
import { sanitizeAssetName } from './path.js';

/** 技能校验入参：三项都已确定（正文由调用方提供，本模块不生成空壳模板） */
export interface SkillAssetInput {
  /** 技能名（落盘文件名的来源，也是 frontmatter 的 name） */
  name: string;
  /** 一句话描述（必填；缺失的技能不会进入模型可见清单） */
  description: string;
  /** 正文（markdown，不含 frontmatter；空技能对模型无用，故必填） */
  content: string;
}

/**
 * 技能写前校验（技能侧唯一判据）
 *
 * @returns null = 通过；字符串 = 拒绝原因（直接进用户可见提示）
 */
export function validateSkillAsset(input: SkillAssetInput): string | null {
  const sanitized = sanitizeAssetName(input.name);
  if (!sanitized.ok) return sanitized.reason;
  if (!input.description.trim()) {
    return vscode.l10n.t(
      'A description is required: skills without one never enter the model-visible list',
    );
  }
  // 换行会提前闭合 frontmatter 块，把正文误读成元数据
  if (/[\r\n]/.test(input.description)) {
    return vscode.l10n.t(
      'The description must not contain line breaks (they would break the skill frontmatter)',
    );
  }
  if (!input.content.trim()) {
    return vscode.l10n.t('The skill body cannot be empty');
  }
  return null;
}
