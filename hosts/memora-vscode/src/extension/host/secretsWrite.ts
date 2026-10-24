/**
 * SecretStorage 写入通道（apiKey 存储面的**唯一封装**，与 settingsWrite.ts 对称）
 *
 * 为什么必须有这一层（2026-10-24 审计推导的伤害类，与 G9 同类）：
 *   `vscode.SecretStorage.store/delete` 在系统钥匙串不可用时 reject
 *   （Windows Credential Manager 故障 / 被企业策略禁用；本项目有 credential-manager
 *   故障前例）。三个写入点此前的形态是裸调：
 *   - `ProviderStore.save`：配置先落盘成功 → store reject ⇒ **半完成态**——
 *     服务商出现在列表里但密钥没存上，用户按回执无法判断真实状态；
 *   - `ProviderStore.remove`：配置先删成功 → delete reject ⇒ 孤儿密钥留在钥匙串，
 *     同名服务商重新添加后「编辑留空」会**静默沿用旧密钥**（用错 key 的安全面）；
 *   - `userDataReset`：delete reject 抛裸错，缺「哪一步、哪个 key」的语义标签。
 *   三者的共性 = 写入面的失败没有结构化回执，用户与上层都无法据回执判断磁盘事实——
 *   与 settingsWrite 防的「静默吞回执」是同一伤害类，故按同一方法论收口。
 *
 * 单一真理源：
 *   - 超时上限复用 {@link WRITE_TIMEOUT_MS}（settingsWrite 定义）——两存储面共用
 *     一个上限值，不建第二份常量；
 *   - 失败文案只由 {@link secretErrorText} 生成（与 settings 面的 writeErrorText
 *     各自域内单点：两面的超时归因不同——settings 说「文件只读/占用」，
 *     secrets 说「钥匙串无响应」——故不共用同一模板，但都是单点派生）；
 *   - 返回 {@link WriteResult}（settingsWrite 的类型），调用方判 ok 转回执，不静默。
 *
 * 关于超时兜底的诚实说明：secrets.store **没有**「只读设置上永不 settle」的实测前例
 * （那是 G9 在 configuration.update 上抓到的）。此处仍加 5s 上限是防御性对齐——
 * 钥匙串锁定 / COM 调用挂起在 Windows 有前例，失败路径多等 5s 可接受，
 * 宁可多一条回执，不让用户面对无上限等待。
 *
 * 调用方分工（同 settingsWrite）：用户动作（保存/删除服务商）看结果转回执；
 * 必须抛出的流程（初始化清理）自行 `if (!ok) throw`——契约在调用方，写入路径只有一条。
 */
import type * as vscode from 'vscode';
import { WRITE_TIMEOUT_MS, type WriteResult } from '../settingsWrite.js';
import { toNoticeText } from './noticeText.js';

/** 单次 SecretStorage 写入的超时上限（ms）——复用 settingsWrite 的值，不建第二常量 */
export { WRITE_TIMEOUT_MS };

/**
 * 写一个 secret（apiKey 落系统钥匙串）
 *
 * @param secrets VS Code SecretStorage（由 extension context.secrets 提供）
 * @param key secret 键（构造式由调用方域的单点给出，如 providerSecretKey）
 * @param value 待存值（调用方保证已 trim）
 * @returns 写入结果（超时 / reject 都 ok=false；本函数**永不 reject**）
 */
export async function writeSecret(
  secrets: vscode.SecretStorage,
  key: string,
  value: string,
): Promise<WriteResult> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      secrets.store(key, value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('密钥写入未在期限内完成'));
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
 * 删一个 secret（apiKey 从系统钥匙串移除）
 *
 * 删除失败的伤害面见模块头注释（孤儿密钥 ⇒ 同名重添沿用旧 key），
 * 故与写入同通道、同回执契约。
 *
 * @param secrets VS Code SecretStorage
 * @param key secret 键
 * @returns 删除结果（永不 reject）
 */
export async function deleteSecret(
  secrets: vscode.SecretStorage,
  key: string,
): Promise<WriteResult> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      secrets.delete(key),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('密钥删除未在期限内完成'));
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
 * SecretStorage 失败文案（回执 / toast / throw 消息共用同一句，不二次加工）
 *
 * 与 settings 面的 {@link writeErrorText} 分开的原因：超时归因不同——设置写入
 * 超时要指向「文件只读/被占用」（G9 真机验收原句，有测试逐字钉死），密钥超时
 * 的合理排查方向是「系统钥匙串无响应」。两面各自域内单点，不互相串用。
 *
 * 模板里 label 后留一个半角空格：本面的 label 常以英文词结尾（`API Key`），
 * 无空格会得到「API Key失败」这种中英粘连形态；settings 面 label 全中文，
 * 其模板保持无空格（原句有测试钉死，不因本面改动而漂移）。
 *
 * @param label 操作对象名（如 `API Key` / `API Key「deepseek」清理`）
 * @param failure 写结果里的失败分支
 */
export function secretErrorText(
  label: string,
  failure: { timedOut: boolean; reason: string },
): string {
  return failure.timedOut
    ? `${label} 超时：系统钥匙串未在期限内响应，密钥可能未保存`
    : `${label} 失败：${failure.reason}`;
}
