/**
 * SecretStorage 访问通道（apiKey 存储面的**唯一封装**，与 settingsWrite.ts 对称）
 *
 * 为什么必须有这一层（2026-10-24 审计推导的伤害类，与 G9 同类）：
 *   `vscode.SecretStorage.store/delete/get` 在系统钥匙串不可用时 reject
 *   （Windows Credential Manager 故障 / 被企业策略禁用；本项目有 credential-manager
 *   故障前例）。此前的形态是裸调：
 *   - 写入面（2026-10-24 收口）：`ProviderStore.save` 配置先落盘 → store reject
 *     ⇒ **半完成态**；`ProviderStore.remove` 配置先删成功 → delete reject ⇒
 *     孤儿密钥（同名重添「编辑留空」静默沿用旧 key）；`userDataReset` 裸抛缺语义标签；
 *   - 读取面（2026-10-24 收口）：`ProviderStore.list/listMasked` 的 Promise.all
 *     任一 get reject 全 throw ⇒ ① 配置面板 `cfg_loaded` 永不抵达（静默空列表）；
 *     ② `cfg_save` 成功后的 reload 抛错被同一 catch 转成「保存失败」（回执与磁盘
 *     事实相反）；③ `getActive` 被**非活跃** Provider 的坏 key 拖垮（跨 Provider 污染）。
 *   共性 = 密钥面的失败没有结构化回执，用户与上层都无法据回执判断磁盘事实——
 *   与 settingsWrite 防的「静默吞回执」是同一伤害类，故按同一方法论收口。
 *
 * 第三态（2026-10-24 SEC-READ-2 补）：读成功但从未存过（`ok:true + value=undefined`）
 * 对展示面是「正常空态」（面板钉子：空态 ≠ 失败），但对**配置在册的服务商**不是——
 * 保存契约保证在册服务商本应有 key（新增必填 / 编辑保留 / remove 先配置后密钥），
 * 空即异常（半完成态残留 / userDataReset 中间态 / 设置同步不含密钥 / 凭证被清理）。
 * 运行面（getActive / getBackground）见此态抛 {@link secretMissingText}，
 * 不让空 key 打到服务端报无关 401——那又是「用错原因解释失败」。
 *
 * 单一真理源：
 *   - 超时上限复用 {@link WRITE_TIMEOUT_MS}（settingsWrite 定义）——两存储面共用
 *     一个上限值，不建第二份常量；
 *   - 失败文案只由 {@link secretErrorText} 生成（与 settings 面的 writeErrorText
 *     各自域内单点：两面的超时归因不同——settings 说「文件只读/占用」，
 *     secrets 说「钥匙串无响应」——故不共用同一模板，但都是单点派生）；
 *   - 返回 {@link WriteResult} / {@link ReadResult}，调用方判 ok 转回执，不静默。
 *
 * 关于超时兜底的诚实说明：secrets 操作**没有**「只读设置上永不 settle」的实测前例
 * （那是 G9 在 configuration.update 上抓到的）。此处仍加 5s 上限是防御性对齐——
 * 钥匙串锁定 / COM 调用挂起在 Windows 有前例，失败路径多等 5s 可接受，
 * 宁可多一条回执，不让用户面对无上限等待。
 *
 * 调用方分工（同 settingsWrite）：用户动作（保存/删除服务商）看结果转回执；
 * 必须抛出的流程（初始化清理）自行 `if (!ok) throw`——契约在调用方，访问路径只有一条。
 *
 * 故障注入（真机验点专用，默认关）：设环境变量 `MEMORA_FAULT_SECRETS`：
 *   - `read`  ⇒ get 强制失败（验读取面回执：卡片留痕 / 不误报保存失败）；
 *   - `write` ⇒ store/delete 强制失败（验写入面回执：半完成态 / 孤儿密钥文案）；
 *   - `all`   ⇒ 全部强制失败。
 *   未设（或空串）= 正常透传，单测钉死默认态。注入的 reason 自带变量名，
 *   真机回执上可区分「注入」与「真实故障」，不会把验点环境误判成产品缺陷。
 */
import type * as vscode from 'vscode';
import { WRITE_TIMEOUT_MS, type WriteResult } from '../settingsWrite.js';
import { toNoticeText } from './noticeText.js';

/** 单次 SecretStorage 访问的超时上限（ms）——复用 settingsWrite 的值，不建第二常量 */
export { WRITE_TIMEOUT_MS };

/**
 * 单次 SecretStorage 读取的结果（与 {@link WriteResult} 对称：永不 reject）
 *
 * `value` 为 undefined = 该 key 从未存过（正常空态，**不是**失败）；
 * ok=false = 钥匙串读取失败（原因见 reason），调用方必须留痕或抛出，禁降级成空值。
 */
export type ReadResult =
  { ok: true; value: string | undefined } | { ok: false; timedOut: boolean; reason: string };

/**
 * 故障注入判定（真机验点用，详见模块头注释）
 *
 * 每次调用现读环境变量（不缓存模块级常量）：测试可自由改 env，真机改 env 后需重启
 * Extension Host 才生效（env 在进程启动时定格）——这正符合验点语义（一次注入一轮验）。
 *
 * @param op 本次访问的侧面（read=get / write=store+delete）
 * @returns 命中注入时返回失败原因（未命中返回 undefined = 正常透传）
 */
function faultReason(op: 'read' | 'write'): string | undefined {
  const mode = (process.env.MEMORA_FAULT_SECRETS ?? '').trim().toLowerCase();
  if (mode !== 'all' && mode !== op) return undefined;
  const what = op === 'read' ? '读取' : '写入';
  return `故障注入：密钥${what}被强制失败（MEMORA_FAULT_SECRETS=${mode}）`;
}

/**
 * 读一个 secret（apiKey 从系统钥匙串取出）
 *
 * @param secrets VS Code SecretStorage（由 extension context.secrets 提供）
 * @param key secret 键（构造式由调用方域的单点给出，如 providerSecretKey）
 * @returns 读取结果（超时 / reject 都 ok=false；本函数**永不 reject**）
 */
export async function readSecret(secrets: vscode.SecretStorage, key: string): Promise<ReadResult> {
  const injected = faultReason('read');
  if (injected) return { ok: false, timedOut: false, reason: injected };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      secrets.get(key),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('密钥读取未在期限内完成'));
        }, WRITE_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, timedOut, reason: toNoticeText(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  const injected = faultReason('write');
  if (injected) return { ok: false, timedOut: false, reason: injected };
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
  const injected = faultReason('write');
  if (injected) return { ok: false, timedOut: false, reason: injected };
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
 * @param label 操作对象名（如 `API Key` / `API Key「deepseek」清理` / `API Key「deepseek」读取`）
 * @param failure 访问结果里的失败分支
 */
export function secretErrorText(
  label: string,
  failure: { timedOut: boolean; reason: string },
): string {
  return failure.timedOut
    ? `${label} 超时：系统钥匙串未在期限内响应，密钥可能未保存`
    : `${label} 失败：${failure.reason}`;
}

/**
 * SecretStorage 第三态文案：读成功但**从未存过**（SEC-READ-2，运行面专用）
 *
 * 与 {@link secretErrorText} 的分界：后者 = 钥匙串**读失败**（状态未知，可能是好 key
 * 读不到）；本函数 = 钥匙串读成功了，里头**没有这个 key**（状态已知 = 没有）。
 * 展示面（listMasked）见此态是「正常空态」不留痕——新用户没配 key 不配报错；
 * 但**配置在册的服务商**走到运行面还空着，只剩异常来路（半完成态残留 /
 * userDataReset 中间态 / 设置同步不含密钥 / 凭证被清理），必须可读地拒绝——
 * 空 key 打到服务端是一个与真实原因无关的 401。
 *
 * @param label 操作对象名（如 `API Key「deepseek」`，中文引号结尾故模板不加空格）
 */
export function secretMissingText(label: string): string {
  return (
    `${label}未存储：可能保存未成功、系统凭证被清理，或设置同步未包含密钥；` +
    `请在配置面板编辑该服务商补填 API Key`
  );
}
