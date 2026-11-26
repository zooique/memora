/**
 * 追加式审计（只 append，不就地改写）—— 远程桥的可回溯留痕
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §16.2 G5：追加式审计，落 `globalStorage`，**不写 `.memora`**（避免污染用户数据）
 *   - §5.6：业务授权层（L3）负责审计留痕；审计不碰密钥材料
 *
 * 为什么要有本文件：配对 / 拒绝 / 限流这些安全事实必须能事后回查（谁在何时从哪来试过什么）。
 * 一条事件一行 JSON 是唯一能「只追加 + 可机读」的最小形态。
 *
 * 边界：
 *   - **审计失败不得拖垮桥**：sink 抛错只记日志，`record()` 永不 reject；
 *   - 不做轮转 / 压缩 / 读取（那是运维面，不在本切片）；
 *   - 不 import vscode 与 fs：落盘目标经 `RemoteAuditSink` 注入。
 */

/** 一条审计事件（`at` 由审计日志统一盖戳，调用方不传） */
export interface RemoteAuditEvent {
  /** 事件时刻（epoch ms） */
  at: number;
  /** 事件名（如 `device_paired` / `pairing_rejected` / `hello_fp_mismatch`） */
  event: string;
  /** 相关设备指纹（若涉及设备） */
  deviceFp?: string;
  /** 来源 IP（若可取得） */
  ip?: string;
  /** 补充说明（如拒绝原因、错误摘要） */
  detail?: string;
}

/** 追加口（宿主用 `fs.promises.appendFile` 实现；收到的行**不含换行**，由 sink 补） */
export interface RemoteAuditSink {
  append(line: string): Promise<void>;
}

/**
 * 审计日志（无状态，除注入的 sink / 时钟 / 日志口）
 */
export class RemoteAuditLog {
  constructor(
    private readonly sink: RemoteAuditSink,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /**
   * 记录一条事件（一条一行 JSON）
   *
   * 永不抛出：审计是旁路证据，不能让「写日志失败」把桥的连接或握手判死。
   *
   * @param evt 事件内容（`at` 自动补齐）
   */
  async record(evt: Omit<RemoteAuditEvent, 'at'>): Promise<void> {
    const line = JSON.stringify({ at: this.now(), ...evt });
    try {
      await this.sink.append(line);
    } catch (err) {
      this.log(`[REMOTE-AUDIT] 追加审计行失败：${String(err)}`);
    }
  }
}
