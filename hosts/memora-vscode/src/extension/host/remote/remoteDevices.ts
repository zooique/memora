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
 *   - 不 import vscode：`globalState` 经 `RemoteDeviceMemento` 窄接口注入。
 */

/** 权限档位（§5.9；`approve` 才能答执行类审批 / ask 提问） */
export type RemoteDeviceTier = 'observe' | 'send' | 'approve';

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

/** 指纹归一（大小写不敏感；设备表与握手比较共用同一形态） */
function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim().toUpperCase();
}

/** 是否为合法档位 */
function isDeviceTier(value: unknown): value is RemoteDeviceTier {
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
  if (!isDeviceTier(raw.tier)) return undefined;
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
   * 整数组覆盖写（设备表体量小，整写比增量合并简单且无并发写窗口）
   */
  private async write(records: readonly RemoteDeviceRecord[]): Promise<void> {
    await this.memento.update(REMOTE_DEVICES_KEY, records);
  }
}
