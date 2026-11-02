/**
 * 命令：新建用户技能（命令面板与设置页「新建技能」按钮的唯一实现）。
 *
 * 两个入口（`memora.createSkill` 命令、设置页 `skills_create_request` 消息）都只做
 * 「触发」，输入采集 / 校验 / 写盘 / 重扫全部收在本模块——webview 侧零写盘逻辑。
 *
 * 写入形态：单文件 `<userSkillsDir>/<name>.md`（目录 + SKILL.md 形态暂不做）。
 * 写盘前必过四道判据（顺序即执行序）：
 *   1. 名字净化（正则 + 路径逃逸断言，见 `userAssetPath.ts`）；
 *   2. 同名用户文件已存在 ⇒ 拒绝（不静默覆盖）；
 *   3. 同名内置 ⇒ 明确提示「将覆盖内置技能」并确认后继续（既有 userOverrides 语义）；
 *   4. description 必填 + 正文非空（缺 description 的技能会被 LLM 可见集过滤，等于白建）。
 */

import * as vscode from 'vscode';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Agent } from '@zooique/memora';
import { toNoticeText } from '../host/noticeText.js';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import type { MemoraSettingsPanel } from '../../webview/panels/settingsPanel.js';
import {
  pathExists,
  resolveInsideDir,
  sanitizeAssetName,
  type SanitizeResult,
} from './userAssetPath.js';

/** 新建技能的草稿（name / description 即用户输入的两项） */
export interface SkillDraft {
  name: string;
  description: string;
}

/** 写盘结果：成功回显**实际写入路径**；失败给出可读原因（不落盘） */
export type WriteSkillResult = { ok: true; filePath: string } | { ok: false; reason: string };

/** 新建技能命令的依赖（由 extension 装配期注入，路径只在这一处给一次） */
export interface CreateUserSkillDeps {
  /** 用户技能目录（globalStorageUri/skills，与装配期 loadExtraDir 同一路径） */
  userSkillsDir: string;
  /** 取当前工作区 Agent（失败返 null，不抛错） */
  tryGetAgent: () => Promise<Agent | null>;
  /** 对话区技能清单刷新通道 */
  chatProvider: MemoraChatViewProvider;
  /** 设置页技能清单刷新通道 */
  settingsProvider: MemoraSettingsPanel;
}

/**
 * 技能正文模板（保证非空）
 *
 * 只写结构骨架，具体内容留给用户补：新建技能的价值在「能被模型看见」，而不是代写正文。
 * H1 标题 = 界面显示名（宿主 UI 取正文首个 H1），故与技能名一致。
 */
export function buildSkillBody(name: string): string {
  return [
    `# ${name}`,
    '',
    '## 何时使用',
    '',
    '（补充：在什么场景下使用该技能）',
    '',
    '## 执行步骤',
    '',
    '1. （补充具体步骤）',
    '',
  ].join('\n');
}

/**
 * 生成完整技能 markdown（frontmatter + 正文）
 *
 * frontmatter 值不裹引号：内核 `parseFrontmatter` 按首个冒号朴素切分且不剥引号，
 * 裹引号会让 `description` 原样带上引号进入 LLM 清单。
 */
export function buildSkillMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${buildSkillBody(name)}`;
}

/**
 * 写前校验（唯一判据，写函数与命令入口共用）
 *
 * @returns null = 通过；字符串 = 拒绝原因
 */
export function validateSkillDraft(draft: SkillDraft): string | null {
  const sanitized = sanitizeAssetName(draft.name);
  if (!sanitized.ok) return sanitized.reason;
  if (!draft.description.trim()) {
    return '描述（description）必填：缺失的技能不会进入模型可见清单，等于白建';
  }
  // 换行会提前闭合 frontmatter 块，把正文误读成元数据
  if (/[\r\n]/.test(draft.description)) {
    return '描述不得包含换行（会破坏技能 frontmatter 结构）';
  }
  if (!buildSkillBody(sanitized.name).trim()) {
    return '技能正文不能为空';
  }
  return null;
}

/**
 * 解析用户技能文件路径（名字净化 + 逃逸断言后的唯一路径来源）
 *
 * @param userSkillsDir 用户技能根目录
 * @param name 用户输入名字
 */
export function userSkillFilePath(
  userSkillsDir: string,
  name: string,
): { ok: true; filePath: string } | { ok: false; reason: string } {
  const sanitized = sanitizeAssetName(name);
  if (!sanitized.ok) return sanitized;
  const resolved = resolveInsideDir(userSkillsDir, `${sanitized.name}.md`);
  if (!resolved.ok) return resolved;
  return { ok: true, filePath: resolved.path };
}

/**
 * 新建技能的唯一写盘实现
 *
 * 命令面板与设置页两个入口最终都落到这里（写一人份）。同名用户文件存在时拒绝，
 * 杜绝「UI 说新建、实际把用户已有技能静默覆盖」。
 *
 * @param userSkillsDir 用户技能根目录
 * @param draft 用户输入（name / description）
 */
export async function writeUserSkillFile(
  userSkillsDir: string,
  draft: SkillDraft,
): Promise<WriteSkillResult> {
  const invalid = validateSkillDraft(draft);
  if (invalid) return { ok: false, reason: invalid };
  const target = userSkillFilePath(userSkillsDir, draft.name);
  if (!target.ok) return target;
  // 同名用户文件已存在 ⇒ 拒绝（不静默覆盖）
  if (await pathExists(target.filePath)) {
    return { ok: false, reason: `同名用户技能文件已存在：${target.filePath}` };
  }
  const sanitized = sanitizeAssetName(draft.name);
  if (!sanitized.ok) return sanitized;
  await mkdir(userSkillsDir, { recursive: true });
  await writeFile(
    target.filePath,
    buildSkillMarkdown(sanitized.name, draft.description.trim()),
    'utf-8',
  );
  return { ok: true, filePath: target.filePath };
}

/** 单行输入框（名字 / 描述共用：只在标题与提示上分叉，校验入口同一份） */
async function promptLine(
  title: string,
  prompt: string,
  validate: (value: string) => SanitizeResult | string | undefined,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const result = validate(value);
      if (result === undefined) return undefined;
      if (typeof result === 'string') return result;
      // 净化结果三态：合格（ok）返回 undefined 放行；不合格取 reason 作为输入框提示
      return result.ok ? undefined : result.reason;
    },
  });
}

/**
 * 新建技能命令入口（命令面板 / 设置页消息 → 同一函数）
 *
 * 执行序：名字 → 净化 → 同名用户文件拒绝 → 同名内置确认 → 描述（必填）→ 写盘
 * → 内核重扫 → 双通道刷新列表 → 回显实际路径。
 *
 * @param deps 装配期注入的依赖
 */
export async function createUserSkillCommand(deps: CreateUserSkillDeps): Promise<void> {
  const rawName = await promptLine(
    '新建技能 · 名称',
    '技能名（中文 / 字母 / 数字 / 下划线 / 连字符）；将写入 <用户技能目录>/<名称>.md',
    (value) => sanitizeAssetName(value),
  );
  if (rawName === undefined) return; // 用户取消

  const sanitized = sanitizeAssetName(rawName);
  if (!sanitized.ok) {
    void vscode.window.showWarningMessage(`技能名不合法：${sanitized.reason}`);
    return;
  }
  const target = userSkillFilePath(deps.userSkillsDir, sanitized.name);
  if (!target.ok) {
    void vscode.window.showWarningMessage(`技能名不合法：${target.reason}`);
    return;
  }
  if (await pathExists(target.filePath)) {
    void vscode.window.showWarningMessage(
      `同名用户技能已存在：${target.filePath}（不会覆盖，请换一个名字或直接编辑该文件）`,
    );
    return;
  }

  const agent = await deps.tryGetAgent();
  if (!agent?.skills) {
    void vscode.window.showWarningMessage('Memora Agent 未就绪，无法新建技能');
    return;
  }
  // 同名内置：用户文件已由上方排除 ⇒ 同名项必为内置（或运行时注入项），走覆盖确认。
  // 语义与 kernel userOverrides 一致：同名用户版覆盖内置，内置文件本身不动。
  if (agent.skills.list.some((s) => s.name === sanitized.name)) {
    const choice = await vscode.window.showWarningMessage(
      `已存在同名内置技能「${sanitized.name}」。继续将创建一个同名用户技能覆盖它（内置文件不改动），确认继续？`,
      { modal: true },
      '继续覆盖',
    );
    if (choice !== '继续覆盖') return; // 用户放弃
  }

  const rawDescription = await promptLine(
    '新建技能 · 描述',
    '必填：一句话说明「做什么 / 何时用」（缺描述的技能不会进入模型可见清单）',
    (value) => (value.trim() ? undefined : '描述必填'),
  );
  if (rawDescription === undefined) return; // 用户取消

  let written: WriteSkillResult;
  try {
    written = await writeUserSkillFile(deps.userSkillsDir, {
      name: sanitized.name,
      description: rawDescription,
    });
  } catch (err) {
    void vscode.window.showWarningMessage(`创建技能失败：${toNoticeText(err)}`);
    return;
  }
  if (!written.ok) {
    void vscode.window.showWarningMessage(`创建技能失败：${written.reason}`);
    return;
  }

  // 写后重扫：内核从磁盘重建用户池（不需要 Reload Window）+ 双通道刷新列表
  try {
    await agent.skills.resyncUserSkills();
    await deps.settingsProvider.refreshSkillList();
    deps.chatProvider.refreshSkillList();
  } catch (err) {
    void vscode.window.showWarningMessage(
      `技能已写入 ${written.filePath}，但刷新列表失败：${toNoticeText(err)}`,
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `已创建技能「${sanitized.name}」：${written.filePath}`,
    '打开所在目录',
  );
  if (choice === '打开所在目录') {
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(written.filePath));
  }
}
