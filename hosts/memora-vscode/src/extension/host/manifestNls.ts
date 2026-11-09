/**
 * manifest nls 值的运行时解析（`%key%` → 当前语言文案）
 *
 * 为什么存在（ADR-042 后果第 2 条）：运行时提示里嵌命令标题时，标题必须与菜单标题
 * **同源**（引用同一 nls 键），禁止在提示句里再抄一遍标题原文——改标题忘改提示，
 * 必然「提示说 A、菜单显示 B」。VS Code 没有运行时取命令标题的 API
 * （`context.extension.packageJSON` 返回**未解析**原始 JSON，`%key%` 字面量原样），
 * 所以按 VS Code 对 manifest `%key%` 的**文件选择规则**自行解析：
 *   `package.nls.<locale>.json` 精确匹配 → 无文件 / 无键 → `package.nls.json`（默认英文）。
 * 与菜单标题恒一致：`zh-tw` 无独立文件时菜单显示英文标题，此处也解析出英文标题。
 *
 * locale 从 `vscode.env.language` 取（调用点传入，本模块不 import vscode，纯 node 可测）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 读取一份 nls JSON；文件缺失 / JSON 坏 / 非对象 → undefined（调用方走默认文件兜底） */
function readNlsFile(path: string): Record<string, string> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 命令标题的 nls 键映射（键命名契约见 ADR-042 决策 3：`command.<id 去 memora. 前缀>.title`） */
const COMMAND_TITLE_NLS_KEYS = {
  addToChat: 'command.addToChat.title',
  registerWork: 'command.registerWork.title',
  toggleResidentRule: 'command.toggleResidentRule.title',
} as const;

/** 命令标题键名（`resolveCommandTitle` 的判别参数） */
export type CommandTitleKey = keyof typeof COMMAND_TITLE_NLS_KEYS;

/**
 * 解析一个 nls 键的当前语言文案
 *
 * @param nlsDir 含 `package.nls*.json` 的目录（宿主 = `context.extensionUri.fsPath`）
 * @param locale VS Code 显示语言（`vscode.env.language`；undefined / 空 = 直接走默认文件）
 * @param key nls 键（如 `command.addToChat.title`）
 * @returns 当前语言文案；两份文件都没有该键时返回**键名本身**
 *   （fail-visible：打包缺陷当场可见，不静默给空串——空串会让提示句缺主语）
 */
export function resolveNlsValue(nlsDir: string, locale: string | undefined, key: string): string {
  if (locale) {
    const localized = readNlsFile(join(nlsDir, `package.nls.${locale}.json`));
    const hit = localized?.[key];
    if (typeof hit === 'string') return hit;
  }
  const fallback = readNlsFile(join(nlsDir, 'package.nls.json'));
  const hit = fallback?.[key];
  return typeof hit === 'string' ? hit : key;
}

/**
 * 解析命令标题（ADR-042 后果第 2 条硬债的单点出口）
 *
 * 运行时提示嵌「Memora: 添加到对话」这类菜单标题时，必须经本函数取值——
 * 与命令面板显示的标题出自**同一个 nls 键**，改标题提示自动跟随。
 *
 * @param nlsDir 含 `package.nls*.json` 的目录（宿主 = `context.extensionUri.fsPath`）
 * @param locale VS Code 显示语言（`vscode.env.language`）
 * @param command 命令短名（`memora.` 前缀去掉后的 id）
 * @returns 当前语言的菜单标题原文
 */
export function resolveCommandTitle(
  nlsDir: string,
  locale: string | undefined,
  command: CommandTitleKey,
): string {
  return resolveNlsValue(nlsDir, locale, COMMAND_TITLE_NLS_KEYS[command]);
}
