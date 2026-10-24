/**
 * 配置写入通道（host 侧 `getConfiguration().update()` 的**唯一封装**）
 *
 * 为什么必须有这一层（2026-10-24 G9 实测的伤害类，不是风格问题）：
 *   在**只读用户设置 / 受管设置**上，`update()` 会先改内存并触发
 *   `onDidChangeConfiguration`（热更据此拉起进程），随后落盘失败——而 promise
 *   **不 settle**。调用方 `await` 之后的成功提示、状态回推、操作回执全部永不执行
 *   ⇒ 表单关不掉、toast 不出、用户输入被静默吞掉。没有超时上限，这类挂死
 *   **无法靠测试发现**（用例也会挂住而不是变红），只能靠单点兜底。
 *
 * 单一真理源：
 *   - 超时上限只在这里定义一次，所有写入方共用（散落到各 module 私有常量时，
 *     新增调用点天然漏配且无报警）；
 *   - 失败文案只由 {@link writeErrorText} 生成，toast / 回执 / 结果 message 共用同一句，
 *     不二次加工；
 *   - 读取仍走各域的读口（本模块只管「写」，不引入第二份配置形态）。
 *
 * 调用方分工（选哪种反应由调用方决定，写入路径仍只有一条）：
 *   - 用户动作（表单保存、开关切换）：看 {@link WriteResult}，失败即提示 + 回推状态；
 *   - 必须 throw 才能被上层 catch 的动作（如激活态回滚）：自行 `if (!ok) throw`；
 *   - 背景迁移（activate 期一次性清理）：失败即中止后续步骤，不静默删数据。
 */
import * as vscode from 'vscode';
import { toNoticeText } from './host/noticeText.js';

/**
 * 单次配置写入的超时上限（ms）
 *
 * 5s 足够覆盖正常落盘（本地 settings.json 写入是毫秒级）；超过即按失败上报，
 * 宁可多一条错误回执，也不让调用方永久挂起。
 */
export const WRITE_TIMEOUT_MS = 5000;

/**
 * 写结果（失败区分「不 settle 超时」与「真 reject」——文案不同，但都按失败上报）
 */
export type WriteResult = { ok: true } | { ok: false; timedOut: boolean; reason: string };

/**
 * 写一个配置键（整键覆盖）
 *
 * `update` 是整键覆盖语义：`value` 必须是完整值，不是差量。
 *
 * @param key 相对 section 的短键（如 `providers` / `mcpServers`）
 * @param value 完整值；`undefined` = 删除该层级的键（VS Code 语义）
 * @param target 配置层级（缺省 Global：用户级偏好，跨项目共享）
 * @returns 写入结果（超时 / reject 都 ok=false；本函数**永不 reject**）
 */
export async function writeSetting(
  key: string,
  value: unknown,
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
): Promise<WriteResult> {
  /** 超时是否已触发（catch 里据此区分「不 settle」与「真拒绝」） */
  let timedOut = false;
  /** 超时兜底计时器（finally 必须清掉，否则 5s 后仍在事件循环里） */
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      vscode.workspace.getConfiguration('memora').update(key, value, target),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('配置写入未在期限内完成'));
        }, WRITE_TIMEOUT_MS);
      }),
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, timedOut, reason: toNoticeText(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 失败文案（toast / 回执 / 结果 message 共用同一句，不二次加工）
 *
 * @param label 写入对象名（如 `MCP 配置` / `搜索引擎设置`）
 * @param failure 写结果里的失败分支
 */
export function writeErrorText(
  label: string,
  failure: { timedOut: boolean; reason: string },
): string {
  return failure.timedOut
    ? `${label}写入超时：文件可能只读或被占用（设置可能已临时生效，但未落盘）`
    : `${label}写入失败：${failure.reason}`;
}
