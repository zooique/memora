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
  buildSnapshotFrame,
  serializeBridgeFrame,
  type SnapshotPayload,
} from '../src/extension/host/remote/remoteBridgeProtocol.js';
import {
  TRIMMED_RECENT_EVENTS,
  TRIMMED_RECENT_LOG,
} from '../src/extension/host/remote/remoteSnapshotTrim.js';

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
 */
function collectTargets(options: GenerateOptions): { targets: FixtureTarget[]; mobileDir: string } {
  const root = path.resolve(options.hostDir, '../..');
  const fixtureDir = path.join(root, 'docs', 'contract-fixtures', 'remote');
  const mobileDir = options.mobileDir ?? path.resolve(root, '../memora-mobile');
  const mirrorDir = path.join(mobileDir, 'test', 'fixtures', 'remote');
  const mobileExists = existsSync(mobileDir);

  const targets: FixtureTarget[] = [];
  const cases = [
    { name: 'snapshot.simple', input: SIMPLE_INPUT },
    { name: 'snapshot.trimmed', input: buildTrimmedInput() },
  ];
  for (const item of cases) {
    const frame = buildSnapshotFrame(item.input.sid, asSnapshotPayload(item.input.snapshot));
    const frameJson: unknown = JSON.parse(serializeBridgeFrame(frame));
    // 主仓：输入 + 期望帧都留，主仓单测据此重算（输入是可复查的样本，不是派生结果）
    targets.push(
      { filePath: path.join(fixtureDir, `${item.name}.input.json`), value: item.input },
      { filePath: path.join(fixtureDir, `${item.name}.frame.json`), value: frameJson },
    );
    // 手机仓：镜像输入 + 期望帧（输入让客户端能自证裁剪不变量，不必复刻 50/20 常量）
    if (mobileExists) {
      targets.push(
        { filePath: path.join(mirrorDir, `${item.name}.input.json`), value: item.input },
        { filePath: path.join(mirrorDir, `${item.name}.frame.json`), value: frameJson },
      );
    }
  }
  return { targets, mobileDir };
}

/**
 * 生成 fixture；返回实际写出的文件列表（供调用方打印）。
 */
export function generate(options: GenerateOptions): string[] {
  const { targets, mobileDir } = collectTargets(options);
  // 目录按目标逐个创建（不假设「主仓在前、镜像在后」的下标顺序）
  for (const target of targets) {
    mkdirSync(path.dirname(target.filePath), { recursive: true });
    writeJson(target.filePath, target.value);
  }
  if (!existsSync(mobileDir)) {
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
  const { targets } = collectTargets(options);
  const mismatched: string[] = [];
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
