/**
 * 远程契约 golden fixture 生成器（**唯一写入口**）
 *
 * 为什么需要它：手机仓的帧 DTO 是对宿主下发行的"消费者复刻"，若没有真源样本，
 * 字段漂移只能等真机联调才发现（2026-11-27 已踩过一次：`state` 被写成字符串）。
 * 本生成器用**桥自身的构造/序列化函数**产出样本，主机单测再逐字节比对，
 * 手机仓测试再按字段断言 —— 三方锁死，任何一方改了形状都会红。
 *
 * 用法（宿主包目录）：npm run fixtures:gen
 *   - 主仓产物：docs/contract-fixtures/remote/*.json（规则见同目录 README.md）
 *   - 手机仓镜像：../memora-mobile/test/fixtures/remote/*.json（仓不存在则跳过）
 *
 * 禁止手改产物：改了主仓 fixture 而宿主单测还绿，说明样本没覆盖到桥的真路径。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildAppendTextDeltaFrame,
  buildProcessEventDeltaFrame,
  buildSnapshotFrame,
  serializeBridgeFrame,
  type SnapshotPayload,
} from '../src/extension/host/remote/remoteBridgeProtocol.js';
import type { ProcessEvent } from '@zooique/memora';
import {
  TRIMMED_RECENT_EVENTS,
  TRIMMED_RECENT_LOG,
} from '../src/extension/host/remote/remoteSnapshotTrim.js';
import { buildPairingLink } from '../src/extension/host/remote/remotePairingLink.js';

/** 生成参数 */
export interface GenerateOptions {
  /** 宿主包目录（`hosts/memora-vscode`） */
  hostDir: string;
  /** 手机仓目录；缺省为 `<root>/../memora-mobile` */
  mobileDir?: string;
}

/**
 * 简单用例输入
 *
 * 覆盖三件事：`attachmentUris` 必须被剥、`state` 是对象、`pendingQueue` 是字符串数组。
 */
const SIMPLE_INPUT = {
  sid: 'fixture-simple',
  snapshot: {
    state: { phase: 'running', roundId: 'r1' },
    rounds: [
      {
        id: 'r1',
        status: 'running',
        attachmentUris: { 'sha256-demo': 'vscode-webview://demo.png' },
        processEvents: [{ kind: 'text', text: 'hello' }],
        assistantLog: [{ role: 'assistant', content: 'earlier' }],
      },
    ],
    pendingQueue: ['q-item-1'],
  },
};

/** 裁剪用例：过程事件 / 前序回答各超出上限若干条，用来锁定 `truncated` 计数 */
function buildTrimmedInput() {
  const eventCount = TRIMMED_RECENT_EVENTS + 3;
  const logCount = TRIMMED_RECENT_LOG + 2;
  return {
    sid: 'fixture-trimmed',
    snapshot: {
      state: { phase: 'waiting', roundId: 'r2' },
      rounds: [
        {
          id: 'r2',
          status: 'completed',
          processEvents: Array.from({ length: eventCount }, (_, i) => ({
            kind: 'text',
            text: `e${i}`,
          })),
          assistantLog: Array.from({ length: logCount }, (_, i) => ({
            role: 'assistant',
            content: `log-${i}`,
          })),
        },
      ],
      pendingQueue: [],
    },
  };
}

/**
 * 配对连接串样本（v2）
 *
 * `certDerBase64` 刻意取含 `+` `/` 的字节，锁死 base64url 转换（手机据此还原标准 base64
 * 喂给 `PinnedTlsClient`）；客户端 key/cert 取含换行的 PEM 文本，锁死「PEM → base64url →
 * 原样还原」这条路（手机会把它们写成文件再交给 `SecurityContext`）。都不是真实证书。
 */
const PAIRING_LINK_INPUT = {
  address: '192.168.1.9',
  port: 41234,
  certDerBase64: Buffer.from([0xfb, 0xff, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]).toString('base64'),
  code: '123456',
  shortFp: 'ABCD-1234',
  // 2100-01-01：样本永不过期，避免测试断言随系统时钟改变
  expiresAt: 4102444800000,
  clientKeyPem: '-----BEGIN PRIVATE KEY-----\nAAECAwQ=\n-----END PRIVATE KEY-----\n',
  clientCertPem: '-----BEGIN CERTIFICATE-----\nBQYHCAk=\n-----END CERTIFICATE-----\n',
  clientFingerprint: 'A'.repeat(64),
};

/** 富增量样本：用协议层唯一构造点生成，禁止在生成器里手写第二份帧形状 */
const RICH_APPEND_TEXT_INPUT = {
  sid: 'fixture-rich',
  seq: 11,
  roundId: 'r-rich',
  text: '新增正文后缀',
};
const RICH_PROCESS_EVENT_INPUT = {
  sid: 'fixture-rich',
  seq: 12,
  roundId: 'r-rich',
  event: {
    type: 'tool_start',
    seq: 4,
    ts: '2026-11-27T00:00:00.000Z',
    payload: { toolCallId: 'call-rich', name: 'read_file', args: '{"path":"a.txt"}' },
  } satisfies ProcessEvent,
};

/**
 * 输入刻意是最小投影：`RoundView` 其余字段不参与裁剪（与桥单测同一手法）。
 * 这里只补类型，不让 TS 对未参与裁剪的字段提出必填要求。
 */
function asSnapshotPayload(snapshot: unknown): SnapshotPayload {
  return snapshot as unknown as SnapshotPayload;
}

/** 写一份 JSON（末尾带换行，便于 git diff） */
function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 一份应落盘文件：绝对路径 + 期望内容 */
interface FixtureTarget {
  filePath: string;
  value: unknown;
}

/**
 * 计算全部应落盘文件（**唯一目标清单**）
 *
 * `generate` 与 `check` 都从这里取目标：若各写一份，检查就会漏掉新增用例——
 * 「检查通过」变成「只检查了旧用例」。
 *
 * `mobileExists` 一并回传：`generate` 时手机仓缺失可跳过镜像（新建仓前的正常态），
 * 但 `check` 是**跨仓契约**判据——手机仓不在场却报 OK 等于声称「两端一致」而实际只验了一端，
 * 属静默降级（2026-11-27 审查补）。存在性真源只此一处，调用方不得另行硬编码路径。
 */
function collectTargets(options: GenerateOptions): {
  targets: FixtureTarget[];
  mobileDir: string;
  mobileExists: boolean;
} {
  const root = path.resolve(options.hostDir, '../..');
  const fixtureDir = path.join(root, 'docs', 'contract-fixtures', 'remote');
  const mobileDir = options.mobileDir ?? path.resolve(root, '../memora-mobile');
  const mirrorDir = path.join(mobileDir, 'test', 'fixtures', 'remote');
  const mobileExists = existsSync(mobileDir);

  const targets: FixtureTarget[] = [];
  const snapshotCases = [
    { name: 'snapshot.simple', input: SIMPLE_INPUT },
    { name: 'snapshot.trimmed', input: buildTrimmedInput() },
  ];
  for (const item of snapshotCases) {
    const frame = buildSnapshotFrame(item.input.sid, asSnapshotPayload(item.input.snapshot));
    const frameJson: unknown = JSON.parse(serializeBridgeFrame(frame));
    writeCaseTargets(
      targets,
      fixtureDir,
      mirrorDir,
      mobileExists,
      item.name,
      item.input,
      frameJson,
    );
  }

  const richCases = [
    {
      name: 'delta.append_text',
      input: RICH_APPEND_TEXT_INPUT,
      frame: buildAppendTextDeltaFrame(
        RICH_APPEND_TEXT_INPUT.sid,
        RICH_APPEND_TEXT_INPUT.seq,
        RICH_APPEND_TEXT_INPUT.roundId,
        RICH_APPEND_TEXT_INPUT.text,
      ),
    },
    {
      name: 'delta.process_event',
      input: RICH_PROCESS_EVENT_INPUT,
      frame: buildProcessEventDeltaFrame(
        RICH_PROCESS_EVENT_INPUT.sid,
        RICH_PROCESS_EVENT_INPUT.seq,
        RICH_PROCESS_EVENT_INPUT.roundId,
        RICH_PROCESS_EVENT_INPUT.event,
      ),
    },
  ];
  for (const item of richCases) {
    const frameJson: unknown = JSON.parse(serializeBridgeFrame(item.frame));
    writeCaseTargets(
      targets,
      fixtureDir,
      mirrorDir,
      mobileExists,
      item.name,
      item.input,
      frameJson,
    );
  }

  // 配对连接串（v2）：非帧样本，但同属跨仓契约——手机解析器按它断言字段与 base64url 还原。
  // 走同一目标清单 ⇒ `fixtures:check` 也覆盖它，手改即红。
  const pairingValue = {
    input: PAIRING_LINK_INPUT,
    link: buildPairingLink(PAIRING_LINK_INPUT),
  };
  targets.push({ filePath: path.join(fixtureDir, 'pairing.link.json'), value: pairingValue });
  if (mobileExists) {
    targets.push({ filePath: path.join(mirrorDir, 'pairing.link.json'), value: pairingValue });
  }
  return { targets, mobileDir, mobileExists };
}

/** 把一份「输入 + 期望帧」写进主仓目标清单，并在手机仓在场时镜像一份 */
function writeCaseTargets(
  targets: FixtureTarget[],
  fixtureDir: string,
  mirrorDir: string,
  mobileExists: boolean,
  name: string,
  input: unknown,
  frameJson: unknown,
): void {
  {
    // 主仓：输入 + 期望帧都留，主仓单测据此重算（输入是可复查的样本，不是派生结果）
    targets.push(
      { filePath: path.join(fixtureDir, `${name}.input.json`), value: input },
      { filePath: path.join(fixtureDir, `${name}.frame.json`), value: frameJson },
    );
    // 手机仓：镜像输入 + 期望帧（输入让客户端能自证裁剪不变量，不必复刻 50/20 常量）
    if (mobileExists) {
      targets.push(
        { filePath: path.join(mirrorDir, `${name}.input.json`), value: input },
        { filePath: path.join(mirrorDir, `${name}.frame.json`), value: frameJson },
      );
    }
  }
}

/**
 * 生成 fixture；返回实际写出的文件列表（供调用方打印）。
 */
export function generate(options: GenerateOptions): string[] {
  const { targets, mobileDir, mobileExists } = collectTargets(options);
  // 目录按目标逐个创建（不假设「主仓在前、镜像在后」的下标顺序）
  for (const target of targets) {
    mkdirSync(path.dirname(target.filePath), { recursive: true });
    writeJson(target.filePath, target.value);
  }
  if (!mobileExists) {
    console.log(`SKIP_MIRROR ${mobileDir}`);
  }
  return targets.map((target) => target.filePath);
}

/**
 * 键序无关的稳定序列化
 *
 * 比较契约**内容**而不是字节：Windows 检出时 Git 可能把 LF 转 CRLF（本仓 core.autocrlf
 * 实测为 true），按字节比较会把换行风格误判成契约漂移——那是假红，会直接诱发绕过门禁。
 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 校验已提交 fixture 是否与当前桥一致（**只读**，不落盘）。
 *
 * 这是「契约新鲜度」的唯一可信判据：真源在宿主，手机仓离开宿主就无法自证样本是否过期。
 *
 * @returns 不一致的文件路径列表；空数组 = 全部最新
 */
export function check(options: GenerateOptions): string[] {
  const { targets, mobileDir, mobileExists } = collectTargets(options);
  const mismatched: string[] = [];
  // 手机仓不在场 = 跨仓契约只验了一端，fail-closed（门禁红）。
  // generate 仍可跳过镜像，但 check 不得把「只验主仓」报成 FIXTURES_OK。
  if (!mobileExists) {
    mismatched.push(`${mobileDir}（手机仓缺失 ⇒ 跨仓契约未闭合）`);
  }
  for (const target of targets) {
    if (!existsSync(target.filePath)) {
      mismatched.push(`${target.filePath}（缺失）`);
      continue;
    }
    let actual: unknown;
    try {
      actual = JSON.parse(readFileSync(target.filePath, 'utf8'));
    } catch {
      mismatched.push(`${target.filePath}（不是合法 JSON）`);
      continue;
    }
    if (stable(actual) !== stable(target.value)) {
      mismatched.push(`${target.filePath}（内容过期）`);
    }
  }
  return mismatched;
}
