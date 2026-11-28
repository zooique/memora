/**
 * 配对串的「对外地址」覆盖（Mode D / Mode T 共用的唯一判据）
 *
 * 设计源：docs/方案-手机远程控制-20261110.md §4.5（家宽公网 IP + DDNS）、§19.3（tunnel 档后置）
 *
 * 为什么需要覆盖：LAN 启动时 `listLanAddresses()` 取的是本机网卡地址（私网 IPv4），
 * 配对串里的 `h` 因此只能是 `192.168.x.x`。手机走蜂窝 / 别人家 Wi-Fi 时私网地址不可路由，
 * 必须允许用户填「手机真正够得着的地址」——家宽 DDNS 域名或隧道对外域名。
 *
 * 为什么连端口一起覆盖：路由器端口映射的对外端口与桥监听端口**不必相同**
 * （例如外部 5890 → PC 4123）。只改 `h` 不改 `p` 会得到一条必然超时的串。
 * 输入形态统一为 `host` 或 `host:port`；省略端口时沿用桥实际监听端口。
 *
 * 判据纪律：
 *   - 规范化只此一份；宿主读状态、写动作、配对串合成三处都消费它，不各写一套；
 *   - 只接受 URI host 安全字符集，scheme / 路径 / 查询 / 空白 / IPv6 字面量一律拒绝——
 *     配对串是让用户复制导入的 URI，坏 host 会造出手机解析失败的串；
 *   - `0.0.0.0` 是监听绑定值不是可拨地址，与配对串既有可用性判据同口径拒绝；
 *   - 不存第二份真值：`globalState` 只保存规范化后的文本，读时再过一次判据
 *     （旧版本写入的坏值不会被当成有效配置）。
 *
 * 边界：本模块不 import vscode；Memento 以窄接口注入，与设备表同款。
 */

/** 规范化后的对外地址 */
export interface PublicAddress {
  /** 域名或 IPv4 字面量（配对串的 `h`） */
  host: string;
  /** 对外端口（配对串的 `p`）；缺省表示沿用桥监听端口 */
  port?: number;
}

/** `globalState` 窄接口（不 import vscode；`context.globalState` 结构兼容） */
export interface PublicAddressMemento {
  /** 读原值（未写过 = undefined） */
  get<T>(key: string): T | undefined;
  /** 覆盖写（传 undefined 删除） */
  update(key: string, value: unknown): Thenable<void>;
}

/** `globalState` 键名（v1：结构变更须换键，避免旧结构被误读） */
export const REMOTE_PUBLIC_ADDRESS_KEY = 'memora.remote.publicAddress.v1';

/** DNS 标签：字母数字起止，中间允许连字符（标签边界上的连字符不是合法主机名） */
const HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * 规范化用户填入的对外地址
 *
 * @param raw 用户输入（不可信）
 * @returns 合法地址；任一校验失败返回 undefined（调用方据此拒绝写入并如实报错）
 */
export function normalizePublicAddress(raw: unknown): PublicAddress | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  // 253 = DNS 主机名上限；过长值不可能是合法域名
  if (value.length === 0 || value.length > 253) return undefined;
  // scheme / 路径 / 查询 / 片段 / 空白 / 反斜杠 / IPv6 字面量都不进配对串的 h
  if (/[\s/?#@\\\[\]]/.test(value) || value.includes('://')) return undefined;

  let host = value;
  let port: number | undefined;
  // 从右往左找唯一分隔符：域名里不会出现冒号（IPv6 已在上一步拒绝）
  const colon = value.lastIndexOf(':');
  if (colon >= 0) {
    host = value.slice(0, colon);
    const text = value.slice(colon + 1);
    if (!/^\d{1,5}$/.test(text)) return undefined;
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return undefined;
    port = parsed;
  }
  // 逐标签校验：空标签 / 超长标签 / 连字符打头尾都会被 URI 解析或 DNS 拒绝
  const labels = host.split('.');
  if (labels.length > 127) return undefined;
  for (const label of labels) {
    if (label.length > 63 || !HOST_LABEL_PATTERN.test(label)) return undefined;
  }
  // 绑定值不是可拨地址（与 pairingMaterialOfHandle 的既有判据同口径）
  if (host === '0.0.0.0') return undefined;
  return port === undefined ? { host } : { host, port };
}

/**
 * 规范化地址 → 输入框回显文本（读状态与写动作共用同一形态）
 *
 * @param address 已规范化的地址
 */
export function formatPublicAddress(address: PublicAddress): string {
  return address.port === undefined ? address.host : `${address.host}:${address.port}`;
}

/**
 * 从 Memento 读回对外地址（坏值按「未配置」处理，不参与配对）
 *
 * @param memento 用户级存储
 */
export function readPublicAddress(memento: PublicAddressMemento): PublicAddress | undefined {
  return normalizePublicAddress(memento.get<unknown>(REMOTE_PUBLIC_ADDRESS_KEY));
}

/**
 * 校验并写入对外地址
 *
 * @param memento 用户级存储
 * @param raw     用户输入（不可信）
 * @returns 写入后的规范化地址；非法输入不写、返回 undefined
 */
export async function writePublicAddress(
  memento: PublicAddressMemento,
  raw: unknown,
): Promise<PublicAddress | undefined> {
  const address = normalizePublicAddress(raw);
  if (!address) return undefined;
  await memento.update(REMOTE_PUBLIC_ADDRESS_KEY, formatPublicAddress(address));
  return address;
}

/**
 * 清除对外地址（留空保存的落点；回落本机 LAN 地址）
 *
 * 为什么不是 `normalizePublicAddress('')` 返回空对象：判据纪律要求「空串 = 无效地址」
 * 在纯函数里保持拒绝（写坏值不落盘），而清除是**动作语义**——走独立写入口、
 * 明确删除键，不与「非法值」混为一谈。UI 文案承诺「留空回落 LAN」，这里兑现。
 *
 * @param memento 用户级存储
 */
export async function clearPublicAddress(memento: PublicAddressMemento): Promise<void> {
  await memento.update(REMOTE_PUBLIC_ADDRESS_KEY, undefined);
}
