/**
 * 已配对设备表（L3 授权层的本地真源）—— 设备指纹 → 权限档的持久化索引
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §5.9：权限三档（`observe` 默认 / `send` / `approve` 默认关闭）
 *   - §5.7：设备表放 `globalState`（可跨窗口共享；**不含密钥材料**）
 *   - §16.2 G2：配对白名单（设备证书指纹 + 权限档），首次信任必须 PC 侧人工批准
 *
 * 为什么要有本文件：桥只问「这个指纹是什么档」，不自己维护设备清单；
 * 设备表必须单点读写，否则「配对写一份、握手读另一份」会各自漂移。
 *
 * 边界：
 *   - 只存**非密钥**事实（指纹 / 展示名 / 档位 / 时间）；
 *   - 读时逐条校验，坏条目丢弃并留痕（一条坏数据不能拖死整张表）；
 *   - **登记上限**：{@link REMOTE_MAX_PAIRED_DEVICES} 台，准入判定收在 {@link pairingAdmission}
 *     （批准弹窗与写入面共用同一份判据，禁止各写一套）；
 *   - 不 import vscode：`globalState` 经 `RemoteDeviceMemento` 窄接口注入。
 */

import { normalizeFingerprint } from './remoteFingerprint.js';
// 档位类型的**唯一定义**在 `shared/protocol.ts`（wire 与设备表共用一份，§5.9；
// `approve` 才能答执行类审批 / ask 提问）。此处只再导出，让既有
// `import { RemoteDeviceTier } from './remoteDevices.js'` 的调用面不必改。
import type { RemoteDeviceTier } from '../../../shared/protocol.js';
export type { RemoteDeviceTier };

/** 一条已配对设备（设备表的一行） */
export interface RemoteDeviceRecord {
  /** 设备证书 DER 的 SHA-256（全大写 hex）——设备身份的唯一判据 */
  fingerprint: string;
  /** 指纹短码（展示用，不参与判据） */
  shortFp: string;
  /** 设备展示名（手机在 hello 里声明的 deviceId） */
  name: string;
  /** 权限档（配对默认 `observe`） */
  tier: RemoteDeviceTier;
  /** 首次配对时间（epoch ms） */
  pairedAt: number;
}

/** `globalState` 窄接口（Memento；本模块不 import vscode） */
export interface RemoteDeviceMemento {
  /** 读整表（未写过 = undefined） */
  get<T>(key: string): T | undefined;
  /** 覆盖写整表 */
  update(key: string, value: unknown): Thenable<void>;
}

/** `globalState` 里的键名（v1：结构变更须换键，避免旧结构被误读） */
export const REMOTE_DEVICES_KEY = 'memora.remote.devices.v1';

/** 合法档位集合（读时校验的唯一来源，避免散落 if 判断） */
const DEVICE_TIERS: readonly RemoteDeviceTier[] = ['observe', 'send', 'approve'];

/**
 * 是否为合法档位
 *
 * 导出供跨边界校验复用（设置页动作来自 webview 消息，属不可信输入）：
 * 档位集合只此一份，别处不得再写第二套字面量判定。
 */
export function isRemoteDeviceTier(value: unknown): value is RemoteDeviceTier {
  return typeof value === 'string' && (DEVICE_TIERS as readonly string[]).includes(value);
}

/**
 * 逐条校验一条设备记录
 *
 * 任何字段不成立即丢弃（宁可让用户重配，也不让半条坏数据参与授权判定）。
 *
 * @param value 表里的原始条目
 * @returns 规范化后的记录，或 undefined（坏条目）
 */
function parseRecord(value: unknown): RemoteDeviceRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.fingerprint !== 'string' || raw.fingerprint.trim().length === 0) return undefined;
  if (typeof raw.name !== 'string') return undefined;
  if (!isRemoteDeviceTier(raw.tier)) return undefined;
  if (typeof raw.pairedAt !== 'number' || !Number.isFinite(raw.pairedAt)) return undefined;
  const fingerprint = normalizeFingerprint(raw.fingerprint);
  const record: RemoteDeviceRecord = {
    fingerprint,
    // 短码只承担展示：缺失时留空串；授权判据永远用全长指纹（不依赖此字段）
    shortFp: typeof raw.shortFp === 'string' ? raw.shortFp : '',
    name: raw.name,
    tier: raw.tier,
    pairedAt: raw.pairedAt,
  };
  return record;
}

/**
 * 已配对设备表（一个宿主进程一份；所有读写都走这里）
 */
export class RemoteDeviceStore {
  constructor(
    private readonly memento: RemoteDeviceMemento,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /** 读整表（读时逐条校验；坏条目丢弃并留痕） */
  list(): RemoteDeviceRecord[] {
    const raw = this.memento.get<unknown>(REMOTE_DEVICES_KEY);
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      this.log('[REMOTE-DEVICES] 设备表不是数组，按空表处理');
      return [];
    }
    const records: RemoteDeviceRecord[] = [];
    for (const entry of raw) {
      const record = parseRecord(entry);
      if (record) records.push(record);
      else this.log('[REMOTE-DEVICES] 丢弃一条损坏的设备记录');
    }
    return records;
  }

  /** 按指纹查一台设备（不存在 = undefined） */
  get(fingerprint: string): RemoteDeviceRecord | undefined {
    const target = normalizeFingerprint(fingerprint);
    return this.list().find((record) => record.fingerprint === target);
  }

  /**
   * 新增或覆盖一台设备（按指纹去重，其他设备原样保留）
   *
   * @param record 设备记录（指纹会被归一为大写）
   */
  async upsert(record: RemoteDeviceRecord): Promise<void> {
    const normalized: RemoteDeviceRecord = {
      ...record,
      fingerprint: normalizeFingerprint(record.fingerprint),
    };
    const next = this.list().filter((item) => item.fingerprint !== normalized.fingerprint);
    next.push(normalized);
    await this.write(next);
  }

  /**
   * 改一台设备的权限档（其他设备原样保留）
   *
   * 只改档位、不动配对时间与展示名；设备不存在时**不写表**并返回 false，
   * 让调用方能把「设备已被撤销」如实告知用户，而不是静默成功。
   *
   * @param fingerprint 设备指纹（大小写不敏感）
   * @param tier        目标档位
   * @returns true = 已写入；false = 设备不存在
   */
  async setTier(fingerprint: string, tier: RemoteDeviceTier): Promise<boolean> {
    const target = normalizeFingerprint(fingerprint);
    const records = this.list();
    const index = records.findIndex((record) => record.fingerprint === target);
    if (index < 0) return false;
    records[index] = { ...records[index], tier };
    await this.write(records);
    return true;
  }

  /**
   * 撤销一台设备（从设备表删除该行）
   *
   * 撤销后该指纹不再命中 `tierOf`，桥的下一次握手 / 命令即按未配对拒绝；
   * 手机侧证书不删，但会被永久拒绝（§5.9「撤销」语义）。
   *
   * @param fingerprint 设备指纹（大小写不敏感）
   * @returns true = 已删除；false = 设备不存在
   */
  async remove(fingerprint: string): Promise<boolean> {
    const target = normalizeFingerprint(fingerprint);
    const records = this.list();
    const next = records.filter((record) => record.fingerprint !== target);
    if (next.length === records.length) return false;
    await this.write(next);
    return true;
  }

  /**
   * 整数组覆盖写（设备表体量小，整写比增量合并简单且无并发写窗口）
   */
  private async write(records: readonly RemoteDeviceRecord[]): Promise<void> {
    await this.memento.update(REMOTE_DEVICES_KEY, records);
  }
}

/** 可登记的设备上限（2026-11-28 用户拍板：最多 3 台） */
export const REMOTE_MAX_PAIRED_DEVICES = 3;

/** 配对准入判定（批准弹窗与写入面共用的唯一判据） */
export type PairingAdmission =
  /** 新设备且未满额：可批准 */
  | 'new'
  /** 该指纹已在表里：视为重新配对，不占新名额 */
  | 'repair'
  /** 已满额且是新设备：必须先撤销一台 */
  | 'full';

/**
 * 判断一台待配对设备能否写入设备表
 *
 * 为什么收成纯函数：批准弹窗（给用户看后果）与 `registerDevice`（真正写表）必须同一份判据，
 * 否则会出现「弹窗说可以、写入却拒绝」或反之的双头语义，且没有任何测试会红。
 *
 * @param existing    当前设备表快照
 * @param fingerprint 待配对设备指纹（大小写不敏感）
 * @returns 准入结论（见 {@link PairingAdmission}）
 */
export function pairingAdmission(
  existing: readonly RemoteDeviceRecord[],
  fingerprint: string,
): PairingAdmission {
  const target = normalizeFingerprint(fingerprint);
  if (existing.some((record) => record.fingerprint === target)) return 'repair';
  return existing.length >= REMOTE_MAX_PAIRED_DEVICES ? 'full' : 'new';
}
