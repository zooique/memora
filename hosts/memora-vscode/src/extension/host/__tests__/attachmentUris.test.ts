/**
 * 附件预览 URL 派生测试（`attachmentUris.ts`）
 *
 * 只测「表怎么建」与「字段挂不挂」，不测 `asWebviewUri` 本身（那是宿主 API）。
 * 三条判据各自有用例：不编造地址 / 空结果即 undefined / 不可变投影。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ImageRef } from '@zooique/memora';
import type { RoundView } from '../../../shared/protocol.js';
import {
  attachmentPayload,
  attachmentUrisOf,
  stampRoundAttachmentUris,
} from '../attachmentUris.js';

const PROJECT = '/proj';

function ref(sha: string, mime = 'image/png'): ImageRef {
  return { sha256: sha, mime, width: 10, height: 10, bytes: 100, name: `${sha}.png` };
}

/** 假宿主 URL 构造器：把文件名映射成可读地址，便于断言「用的是解析后的路径」 */
function fakeToUri(file: string): string | undefined {
  return `memora-resource://${file.replace(/\\/g, '/')}`;
}

describe('attachmentUrisOf：sha256 → 预览 URL', () => {
  it('正常路径：按 {sha}.{ext} 解析并逐条建表', () => {
    const table = attachmentUrisOf([ref('a1b2c3d4')], PROJECT, fakeToUri);
    expect(table).toEqual({
      a1b2c3d4: 'memora-resource:///proj/.memora/attachments/a1b2c3d4.png',
    });
  });

  it('无附件 / 缺省 ⇒ undefined（不是空对象）', () => {
    expect(attachmentUrisOf(undefined, PROJECT, fakeToUri)).toBeUndefined();
    expect(attachmentUrisOf([], PROJECT, fakeToUri)).toBeUndefined();
  });

  it('mime 不在支持集 ⇒ 跳过该条，不编造地址', () => {
    // image/tiff 不在 MIME→扩展名映射里 = 历史脏数据，没有对应文件可指
    expect(attachmentUrisOf([ref('deadbeef', 'image/tiff')], PROJECT, fakeToUri)).toBeUndefined();
  });

  it('toUri 取不到地址（视图已销毁）⇒ 跳过该条，不塞空串', () => {
    expect(attachmentUrisOf([ref('deadbeef')], PROJECT, () => undefined)).toBeUndefined();
  });

  it('同一 sha 出现两次 ⇒ 一条键、只解析一次', () => {
    const toUri = vi.fn(fakeToUri);
    const table = attachmentUrisOf([ref('same'), ref('same'), ref('other')], PROJECT, toUri);
    expect(Object.keys(table ?? {}).sort()).toEqual(['other', 'same']);
    expect(toUri).toHaveBeenCalledTimes(2);
  });

  it('部分可取 ⇒ 只保留可取的那条（同一批里不因个别失败整批降级）', () => {
    const table = attachmentUrisOf(
      [ref('ok1'), ref('bad', 'image/tiff'), ref('ok2')],
      PROJECT,
      fakeToUri,
    );
    expect(Object.keys(table ?? {}).sort()).toEqual(['ok1', 'ok2']);
  });
});

describe('attachmentPayload：user 回声消息的字段挂载', () => {
  it('有图 ⇒ attachments + attachmentUris 同批给出', () => {
    const payload = attachmentPayload([ref('a1b2c3d4')], PROJECT, fakeToUri);
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachmentUris).toEqual({
      a1b2c3d4: 'memora-resource:///proj/.memora/attachments/a1b2c3d4.png',
    });
  });

  it('无图 ⇒ 空载荷（两个字段都不存在，形状与升级前一致）', () => {
    expect(attachmentPayload(undefined, PROJECT, fakeToUri)).toEqual({});
    expect(Object.keys(attachmentPayload([], PROJECT, fakeToUri))).toHaveLength(0);
  });

  it('有图但取不到地址 ⇒ 仍带 attachments（文字态可渲染），只是没有 URL 表', () => {
    const payload = attachmentPayload([ref('a1b2c3d4')], PROJECT, () => undefined);
    expect(payload.attachments).toHaveLength(1);
    expect('attachmentUris' in payload).toBe(false);
  });
});

describe('stampRoundAttachmentUris：投影盖章', () => {
  function round(id: string, refs?: ImageRef[]): RoundView {
    return {
      id,
      status: 'complete',
      createdAt: 't',
      userMessage: {
        id: `m-${id}`,
        role: 'user',
        content: 'x',
        timestamp: 't',
        ...(refs ? { attachments: refs } : {}),
      },
    };
  }

  it('只给有图的轮盖章，无图的轮原样沿用（零新增字段）', () => {
    const plain = round('r1');
    const withImg = round('r2', [ref('a1b2c3d4')]);
    const out = stampRoundAttachmentUris([plain, withImg], PROJECT, fakeToUri);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(plain); // 未变更的轮沿用原引用，不产生新对象
    expect('attachmentUris' in out[0]!).toBe(false);
    expect(out[1]!.attachmentUris).toEqual({
      a1b2c3d4: 'memora-resource:///proj/.memora/attachments/a1b2c3d4.png',
    });
  });

  it('不可变：入参数组与元素都不被改写', () => {
    const input = round('r2', [ref('a1b2c3d4')]);
    const out = stampRoundAttachmentUris([input], PROJECT, fakeToUri);
    expect('attachmentUris' in input).toBe(false);
    expect(out[0]).not.toBe(input);
    // 其余字段逐字段沿用（只换 attachmentUris，不重造投影）
    expect(out[0]!.userMessage).toBe(input.userMessage);
  });

  it('取不到地址的轮也不盖章（不让 UI 拿到空表）', () => {
    const out = stampRoundAttachmentUris(
      [round('r2', [ref('x', 'image/tiff')])],
      PROJECT,
      fakeToUri,
    );
    expect('attachmentUris' in out[0]!).toBe(false);
  });
});
