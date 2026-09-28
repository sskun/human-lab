// capabilities/upload.ts 的单元测试：契约由本文件定义（mock fetch，不碰真实网络）。
// getPolicy 响应结构对照官方文档 + async-dashscope oss_util.rs：data.{policy, signature,
// upload_dir, upload_host, oss_access_key_id, x_oss_object_acl, x_oss_forbid_overwrite}。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getUploadPolicy, uploadToTempStore, type UploadPolicy } from '../src/capabilities/upload.js';

/** 构造 JSON Response 的工具 */
function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** 记录请求的 fetch 桩 */
type CapturedCall = { url: string; init: RequestInit };
function stubFetch(handler: (url: string, init: RequestInit, call: number) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = calls.length;
    calls.push({ url: String(url), init: init ?? {} });
    return await handler(String(url), init ?? {}, call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const POLICY: UploadPolicy = {
  policy: 'POLICY_B64',
  signature: 'SIG==',
  ossAccessKeyId: 'AKID',
  uploadDir: 'oss://dashscope-instant/2026/abc/',
  uploadHost: 'https://oss.example.com',
  xOssObjectAcl: 'private',
  xOssForbidOverwrite: 'true',
};

describe('getUploadPolicy', () => {
  it('GET {base}/uploads?action=getPolicy，带 Bearer 与 OssResourceResolve 头，解析 data 字段', async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      jsonRes({
        request_id: 'r1',
        data: {
          policy: 'POLICY_B64',
          signature: 'SIG==',
          upload_dir: 'oss://dashscope-instant/2026/abc/',
          upload_host: 'https://oss.example.com',
          oss_access_key_id: 'AKID',
          x_oss_object_acl: 'private',
          x_oss_forbid_overwrite: 'true',
          expire_in_seconds: 3600,
        },
      }),
    );
    const policy = await getUploadPolicy({
      fetchImpl,
      apiKey: 'sk-test',
      baseUrl: 'https://maas.example.com/api/v1',
      model: 'wan3.0-video-prime',
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://maas.example.com/api/v1/uploads?action=getPolicy&model=wan3.0-video-prime',
    );
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-test');
    assert.equal(headers['X-DashScope-OssResourceResolve'], 'enable');
    assert.equal(policy.policy, 'POLICY_B64');
    assert.equal(policy.signature, 'SIG==');
    assert.equal(policy.ossAccessKeyId, 'AKID');
    assert.equal(policy.uploadDir, 'oss://dashscope-instant/2026/abc/');
    assert.equal(policy.uploadHost, 'https://oss.example.com');
    assert.equal(policy.xOssObjectAcl, 'private');
  });

  it('兼容 oss_host 字段名（老文档口径）', async () => {
    const { fetchImpl } = stubFetch(() => jsonRes({ data: { policy: 'p', signature: 's', upload_dir: 'oss://b/x/', oss_host: 'https://h', oss_access_key_id: 'a' } }));
    const policy = await getUploadPolicy({ fetchImpl, apiKey: 'sk', model: 'wan3.0-video-prime' });
    assert.equal(policy.uploadHost, 'https://h');
  });

  it('响应缺关键字段 → 报"上传凭证不完整"', async () => {
    const { fetchImpl } = stubFetch(() => jsonRes({ data: { policy: 'p' } }));
    await assert.rejects(() => getUploadPolicy({ fetchImpl, apiKey: 'sk', model: 'm' }), /上传凭证不完整/);
  });

  it('非 2xx → 报错带状态码', async () => {
    const { fetchImpl } = stubFetch(() => jsonRes({ code: 'Throttling', message: 'rate' }, 429));
    await assert.rejects(() => getUploadPolicy({ fetchImpl, apiKey: 'sk', model: 'm' }), /429/);
  });
});

describe('uploadToTempStore', () => {
  it('multipart POST 到 upload_host：表单字段齐全，key=uploadDir+文件名（规范化斜杠），返回 oss:// URL', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response('', { status: 200 }));
    const url = await uploadToTempStore(Buffer.from('fake-audio'), 'audio.mp3', { policy: POLICY, fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://oss.example.com');
    const form = calls[0].init.body as FormData;
    assert.equal(form.get('key'), 'dashscope-instant/2026/abc/audio.mp3', 'OSS 表单 key 是裸键（无 oss:// 前缀）');
    assert.equal(form.get('OSSAccessKeyId'), 'AKID');
    assert.equal(form.get('Signature'), 'SIG==');
    assert.equal(form.get('policy'), 'POLICY_B64');
    assert.equal(form.get('x-oss-object-acl'), 'private');
    assert.equal(form.get('x-oss-forbid-overwrite'), 'true');
    assert.equal(form.get('success_action_status'), '200');
    const file = form.get('file') as File;
    assert.ok(file && file.size === Buffer.byteLength('fake-audio'));
    assert.equal(url, 'oss://dashscope-instant/2026/abc/audio.mp3');
  });

  it('uploadDir 无尾斜杠时也正确拼接', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response('', { status: 200 }));
    await uploadToTempStore(Buffer.from('x'), 'img.png', {
      policy: { ...POLICY, uploadDir: 'oss://dashscope-instant/2026/abc' },
      fetchImpl,
    });
    const form = calls[0].init.body as FormData;
    assert.equal(form.get('key'), 'dashscope-instant/2026/abc/img.png');
  });

  it('非 2xx → 抛错带状态码', async () => {
    const { fetchImpl } = stubFetch(() => new Response('denied', { status: 403 }));
    await assert.rejects(() => uploadToTempStore(Buffer.from('x'), 'a.mp3', { policy: POLICY, fetchImpl }), /403/);
  });
});
