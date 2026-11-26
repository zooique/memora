/**
 * 配对一次性口令（首次信任的第二道闸）—— 8 位数字，TTL / 次数 / 一次即废
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §5.3：Mode T / D 的 `pid` 是**一次性口令**（PC 内存校验，5 分钟过期、一次即废；
 *     失败回 `err{ code:'bad_passcode', ch:'ctl' }`）
 *   - §5.8：口令 + 双向指纹核对 + PC 人工批准，三者缺一不能完成配对
 *
 * 为什么要有本文件：口令的过期、尝试次数、清除时机是三件互相牵连的状态机，
 * 散在握手分支里必然出现「过期了还能用 / 用完了不清」的静默漏洞。
 *
 * 边界：只回答「这个码现在算不算对」；**不做限流、不弹窗、不落库**——
 * 限流归 `remoteRateLimiter`，人工批准归宿主，配对成功后的设备表归 `remoteDevices`。
 */

import { randomInt, timingSafeEqual } from 'node:crypto';

/**
 * 校验结论
 *   - `ok`：口令正确（已清除，不能二次使用）
 *   - `expired`：口令已过期（已清除）
 *   - `mismatch`：口令不对（尚未耗尽，可重试）
 *   - `exhausted`：尝试次数已耗尽（已清除）
 *   - `none`：当前**没有**口令（手机应索取新口令 / 等待 PC 重新生成）
 */
export type PairingVerdict = 'ok' | 'expired' | 'mismatch' | 'exhausted' | 'none';

/** 当前有效的配对挑战（展示给用户输入的一次性口令） */
export interface PairingChallenge {
  /** 8 位数字口令（含前导零） */
  code: string;
  /** 过期时刻（epoch ms） */
  expiresAt: number;
}

/** 构造参数（时钟与随机源可注入，便于单测） */
export interface RemotePairingOptions {
  /** 时钟（缺省 `Date.now`） */
  now?: () => number;
  /** 口令有效期（缺省 5 分钟） */
  ttlMs?: number;
  /** 最大尝试次数（缺省 5） */
  maxAttempts?: number;
  /** 随机整数源（缺省 `crypto.randomInt`；注入后返回 [0, max) 的整数） */
  randomInt?: (max: number) => number;
}

/** 口令有效期默认值（§5.3：5 分钟） */
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

/** 最大尝试次数默认值（§5.3：失败回 bad_passcode，不无限重试） */
const DEFAULT_PAIRING_MAX_ATTEMPTS = 5;

/** 口令位数（§5.3：8 位数字） */
const PAIRING_CODE_LENGTH = 8;

/** 8 位数字口令的取值空间（`0` ~ `99999999`） */
const PAIRING_CODE_SPACE = 10 ** PAIRING_CODE_LENGTH;

/**
 * 一次性口令状态机
 *
 * 语义（调用方必须按此读）：
 *   - `start()` 覆盖旧口令并重置尝试计数——PC 每次提示用户时都应重新生成；
 *   - `verify()` 返回 `expired` / `exhausted` 时**口令已被清除**，后续 `verify()` 得到 `none`；
 *   - `verify()` 返回 `none` 表示当前没有口令，不是「码错了」，手机应索取新口令。
 */
export class RemotePairing {
  /** 当前挑战（undefined = 没有有效口令） */
  private challenge?: PairingChallenge;
  /** 已尝试次数（随 `start()` 归零） */
  private attempts = 0;
  /** 时钟 */
  private readonly now: () => number;
  /** 有效期 */
  private readonly ttlMs: number;
  /** 最大尝试次数 */
  private readonly maxAttempts: number;
  /** 随机整数源 */
  private readonly randomInt: (max: number) => number;

  constructor(opts: RemotePairingOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_PAIRING_MAX_ATTEMPTS;
    this.randomInt = opts.randomInt ?? ((max) => randomInt(max));
  }

  /** 生成新口令（覆盖旧口令，重置尝试计数） */
  start(): PairingChallenge {
    const code = String(this.randomInt(PAIRING_CODE_SPACE)).padStart(PAIRING_CODE_LENGTH, '0');
    this.challenge = { code, expiresAt: this.now() + this.ttlMs };
    this.attempts = 0;
    return this.challenge;
  }

  /** 清除当前口令（配对成功 / 用户取消 / 关闭桥时调用） */
  clear(): void {
    this.challenge = undefined;
    this.attempts = 0;
  }

  /** 当前口令（不做过期判定；过期判定发生在 `verify()`，以便区分 `expired` 与 `none`） */
  current(): PairingChallenge | undefined {
    return this.challenge;
  }

  /**
   * 校验一个用户输入的口令
   *
   * 比较用 `timingSafeEqual`（长度不同直接 mismatch，避免长度差提前返回的时序差）；
   * 正确即清除（一次即废）。
   *
   * @param code 用户输入（原样比较，不做 trim）
   */
  verify(code: string): PairingVerdict {
    const challenge = this.challenge;
    if (!challenge) return 'none';
    if (this.now() >= challenge.expiresAt) {
      this.clear();
      return 'expired';
    }
    this.attempts += 1;
    if (this.equals(code, challenge.code)) {
      this.clear();
      return 'ok';
    }
    if (this.attempts >= this.maxAttempts) {
      this.clear();
      return 'exhausted';
    }
    return 'mismatch';
  }

  /** 定长安全比较（字节层面；长度不同视为不匹配） */
  private equals(given: string, expected: string): boolean {
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
