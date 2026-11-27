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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

/**
 * 生成 fixture；返回实际写出的文件列表（供调用方打印）。
 */
export function generate(options: GenerateOptions): string[] {
  const root = path.resolve(options.hostDir, '../..');
  const fixtureDir = path.join(root, 'docs', 'contract-fixtures', 'remote');
  const mobileDir = options.mobileDir ?? path.resolve(root, '../memora-mobile');
  const mirrorDir = path.join(mobileDir, 'test', 'fixtures', 'remote');
  mkdirSync(fixtureDir, { recursive: true });

  const written: string[] = [];
  const cases = [
    { name: 'snapshot.simple', input: SIMPLE_INPUT },
    { name: 'snapshot.trimmed', input: buildTrimmedInput() },
  ];
  for (const item of cases) {
    const frame = buildSnapshotFrame(item.input.sid, asSnapshotPayload(item.input.snapshot));
    const frameJson: unknown = JSON.parse(serializeBridgeFrame(frame));
    // 主仓：输入 + 期望帧都留，主仓单测据此重算（输入是可复查的样本，不是派生结果）
    const inputPath = path.join(fixtureDir, `${item.name}.input.json`);
    const framePath = path.join(fixtureDir, `${item.name}.frame.json`);
    writeJson(inputPath, item.input);
    writeJson(framePath, frameJson);
    written.push(inputPath, framePath);
    // 手机仓：镜像输入 + 期望帧（输入让客户端能自证裁剪不变量，不必复刻 50/20 常量）
    if (existsSync(mobileDir)) {
      mkdirSync(mirrorDir, { recursive: true });
      const mirrorInputPath = path.join(mirrorDir, `${item.name}.input.json`);
      const mirrorFramePath = path.join(mirrorDir, `${item.name}.frame.json`);
      writeJson(mirrorInputPath, item.input);
      writeJson(mirrorFramePath, frameJson);
      written.push(mirrorInputPath, mirrorFramePath);
    }
  }
  if (!existsSync(mobileDir)) {
    console.log(`SKIP_MIRROR ${mobileDir}`);
  }
  return written;
}
