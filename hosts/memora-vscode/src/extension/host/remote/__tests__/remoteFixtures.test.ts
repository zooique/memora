/**
 * 远程契约 golden fixture —— 宿主侧断言（宿主 → fixture 方向）
 *
 * 判据链（三方锁死，任一方漂移都会红）：
 *   ① 本文件：宿主 `buildSnapshotFrame` 的输出 == 已提交 fixture（主仓 docs/contract-fixtures/remote）；
 *   ② 手机仓 `tool/fixture_smoke.dart`：同一份 fixture 能被手机 DTO 按字段解析；
 *   ③ 生成器 `scripts/gen-remote-fixtures.ts` 是 fixture 的唯一写入口（禁止手改）。
 *
 * 为什么 fixture 放 `docs/`：宿主包 `.vscodeignore` 与根包 `files` 白名单都不含它，
 * 产物不会混进 vsix / npm 包；而两仓都能从仓库根稳定寻址。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildAppendTextDeltaFrame,
  buildProcessEventDeltaFrame,
  buildSnapshotFrame,
  serializeBridgeFrame,
  type SnapshotPayload,
} from '../remoteBridgeProtocol.js';
import type { ProcessEvent } from '@zooique/memora';
import { TRIMMED_RECENT_EVENTS, TRIMMED_RECENT_LOG } from '../remoteSnapshotTrim.js';

/** fixture 目录（`__tests__` 上溯 7 层 = 仓库根） */
const FIXTURE_DIR = new URL('../../../../../../../docs/contract-fixtures/remote/', import.meta.url);

/** 读一个 fixture JSON */
function readJson(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, FIXTURE_DIR)), 'utf8'));
}

/** fixture 覆盖的用例名 */
const CASES = [
  'snapshot.simple',
  'snapshot.trimmed',
  'delta.append_text',
  'delta.process_event',
] as const;

/** 富增量样本输入（逐字段独立声明，禁止从实现反推期望） */
interface AppendTextInput {
  sid: string;
  seq: number;
  roundId: string;
  text: string;
}
interface ProcessEventInput {
  sid: string;
  seq: number;
  roundId: string;
  event: ProcessEvent;
}

/** 帧的最小可检查形状（只声明断言用到的键，避免测试里造第二份完整协议类型） */
interface FrameShape {
  p: {
    state: unknown;
    rounds: Array<Record<string, unknown>>;
    pendingQueue: unknown;
  };
}
interface DeltaFrameShape {
  sid: string;
  seq: number;
  p: Record<string, unknown>;
}

describe('远程契约 golden fixture', () => {
  for (const name of CASES) {
    it(`${name}：桥构造结果 == 已提交 fixture`, () => {
      const input = readJson(`${name}.input.json`);
      const expected = readJson(`${name}.frame.json`);
      // 用与桥完全相同的构造 + 序列化函数重算，禁止在测试里手拼帧
      let actual: unknown;
      if (name === 'snapshot.simple' || name === 'snapshot.trimmed') {
        const snapshotInput = input as { sid: string; snapshot: SnapshotPayload };
        actual = JSON.parse(
          serializeBridgeFrame(buildSnapshotFrame(snapshotInput.sid, snapshotInput.snapshot)),
        );
      } else if (name === 'delta.append_text') {
        const richInput = input as AppendTextInput;
        actual = JSON.parse(
          serializeBridgeFrame(
            buildAppendTextDeltaFrame(
              richInput.sid,
              richInput.seq,
              richInput.roundId,
              richInput.text,
            ),
          ),
        );
      } else {
        const richInput = input as ProcessEventInput;
        actual = JSON.parse(
          serializeBridgeFrame(
            buildProcessEventDeltaFrame(
              richInput.sid,
              richInput.seq,
              richInput.roundId,
              richInput.event,
            ),
          ),
        );
      }
      expect(actual).toEqual(expected);
    });
  }

  it('fixture 覆盖三条硬约束（state 对象 / 无 attachmentUris / 裁剪计数）', () => {
    const simple = readJson('snapshot.simple.frame.json') as FrameShape;
    expect(typeof simple.p.state).toBe('object');
    expect(simple.p.rounds[0]).not.toHaveProperty('attachmentUris');

    const trimmed = readJson('snapshot.trimmed.frame.json') as FrameShape;
    expect(trimmed.p.rounds[0].processEvents).toHaveLength(TRIMMED_RECENT_EVENTS);
    expect(trimmed.p.rounds[0].assistantLog).toHaveLength(TRIMMED_RECENT_LOG);
    expect(trimmed.p.rounds[0].truncated).toEqual({
      processEvents: 3,
      assistantLog: 2,
    });
  });

  it('fixture 覆盖两类富 delta 载荷（后缀正文 / ProcessEvent 逐字透传）', () => {
    const append = readJson('delta.append_text.frame.json') as DeltaFrameShape;
    expect(append.sid).toBe('fixture-rich');
    expect(append.seq).toBe(11);
    expect(append.p).toEqual({
      kind: 'append_text',
      roundId: 'r-rich',
      text: '新增正文后缀',
    });

    const process = readJson('delta.process_event.frame.json') as DeltaFrameShape;
    expect(process.sid).toBe('fixture-rich');
    expect(process.seq).toBe(12);
    expect(process.p).toEqual({
      kind: 'process_event',
      roundId: 'r-rich',
      event: {
        type: 'tool_start',
        seq: 4,
        ts: '2026-11-27T00:00:00.000Z',
        payload: { toolCallId: 'call-rich', name: 'read_file', args: '{"path":"a.txt"}' },
      },
    });
  });
});
