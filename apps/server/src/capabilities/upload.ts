// 百炼临时文件上传能力：本地文件 → oss:// 临时 URL（48h 有效），供需要公网 URL 的云能力
// （wan3.0 口播、未来的 ASR/多模态输入）免自建 OSS 使用。
//
// 协议（对照官方"上传本地文件获取临时URL"文档与 async-dashscope oss_util.rs 实现）：
//   ① GET  {base}/uploads?action=getPolicy   Bearer 鉴权 + X-DashScope-OssResourceResolve: enable
//      → { data: { policy, signature, upload_dir, upload_host, oss_access_key_id,
//                  x_oss_object_acl, x_oss_forbid_overwrite, expire_in_seconds, ... } }
//        （老文档字段名为 oss_host，两者都兼容）
//   ② POST upload_host  multipart/form-data：
//        key=<upload_dir>/<文件名>, OSSAccessKeyId, Signature, policy,
//        x-oss-object-acl, x-oss-forbid-overwrite, success_action_status=200, file=<二进制>
//   ③ 返回 oss://<key>，可直接作为 wan3.0 media.url 使用
//
// 能力层纪律：不碰 DB、不碰 HTTP 路由；fetch 可注入（单元测试用 mock，见 tests/upload.test.ts）。

/** 上传凭证（getPolicy 的 data 部分，驼峰化） */
export interface UploadPolicy {
  policy: string;
  signature: string;
  ossAccessKeyId: string;
  /** 形如 oss://dashscope-instant/<前缀>/ */
  uploadDir: string;
  /** OSS 表单上传入口（https） */
  uploadHost: string;
  xOssObjectAcl?: string;
  xOssForbidOverwrite?: string;
  expireInSeconds?: number;
}

/** 可注入的 HTTP 依赖（测试用 mock fetch 替换） */
export interface HttpDeps {
  fetchImpl?: typeof fetch;
}

function pickFetch(deps?: HttpDeps): typeof fetch {
  return deps?.fetchImpl ?? fetch;
}

/** data 里的字段名在两代文档间有差异（upload_host/oss_host），统一读取 */
function parsePolicyData(data: Record<string, unknown>): UploadPolicy {
  const uploadHost = (data.upload_host ?? data.oss_host) as string | undefined;
  const required: Array<[string, unknown]> = [
    ['policy', data.policy],
    ['signature', data.signature],
    ['upload_dir', data.upload_dir],
    ['upload_host', uploadHost],
    ['oss_access_key_id', data.oss_access_key_id],
  ];
  if (required.some(([, v]) => !v)) {
    throw new Error(`上传凭证不完整：缺少 ${required.filter(([, v]) => !v).map(([k]) => k).join('/')}`);
  }
  return {
    policy: String(data.policy),
    signature: String(data.signature),
    ossAccessKeyId: String(data.oss_access_key_id),
    uploadDir: String(data.upload_dir),
    uploadHost: String(uploadHost),
    xOssObjectAcl: data.x_oss_object_acl ? String(data.x_oss_object_acl) : undefined,
    xOssForbidOverwrite: data.x_oss_forbid_overwrite ? String(data.x_oss_forbid_overwrite) : undefined,
    expireInSeconds: data.expire_in_seconds ? Number(data.expire_in_seconds) : undefined,
  };
}

/**
 * 获取上传凭证。实测（2026-09-28，probe P2）：model 参数必填，且只能走公网端点
 * dashscope.aliyuncs.com（专属实例 host 返回 400 InvalidParameter）。
 * @param opts.model 目标模型名（如 wan3.0-video-prime），必填
 * @param opts.apiKey 缺省读环境变量 DASHSCOPE_API_KEY
 * @param opts.baseUrl 上传端点根，缺省公网 https://dashscope.aliyuncs.com/api/v1
 */
export async function getUploadPolicy(
  opts: { model: string; apiKey?: string; baseUrl?: string } & HttpDeps,
): Promise<UploadPolicy> {
  const apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('apiKey 不能为空：请通过环境变量 DASHSCOPE_API_KEY 或参数传入');
  const base = opts.baseUrl ?? 'https://dashscope.aliyuncs.com/api/v1';
  const url = `${base}/uploads?action=getPolicy&model=${encodeURIComponent(opts.model)}`;
  const res = await pickFetch(opts)(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-DashScope-OssResourceResolve': 'enable',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`获取上传凭证失败（HTTP ${res.status}）：${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: Record<string, unknown> };
  if (!json.data) throw new Error(`上传凭证响应缺少 data 字段：${JSON.stringify(json).slice(0, 300)}`);
  return parsePolicyData(json.data);
}

/**
 * 规范化拼接对象键：upload_dir（可能带/不带 oss:// 前缀与尾斜杠）+ 文件名。
 * 返回【裸键】（不带 oss://）——OSS 表单的 key 字段必须是不含 scheme 的对象路径，
 * 传入模型侧的 URL 才加 oss:// 前缀（见 uploadToTempStore 返回值）。
 */
function joinKey(uploadDir: string, filename: string): string {
  return `${uploadDir.replace(/^oss:\/\//, '').replace(/\/+$/, '')}/${filename}`;
}

/**
 * 上传文件到百炼临时存储，返回可直接填入模型 input 的 oss:// 临时 URL。
 * @param policy 由 getUploadPolicy 取得的凭证
 */
export async function uploadToTempStore(
  file: Buffer | Uint8Array,
  filename: string,
  opts: { policy: UploadPolicy } & HttpDeps,
): Promise<string> {
  const form = new FormData();
  const key = joinKey(opts.policy.uploadDir, filename);
  form.set('key', key);  form.set('OSSAccessKeyId', opts.policy.ossAccessKeyId);
  form.set('Signature', opts.policy.signature);
  form.set('policy', opts.policy.policy);
  if (opts.policy.xOssObjectAcl) form.set('x-oss-object-acl', opts.policy.xOssObjectAcl);
  if (opts.policy.xOssForbidOverwrite) form.set('x-oss-forbid-overwrite', opts.policy.xOssForbidOverwrite);
  form.set('success_action_status', '200');
  form.set('file', new Blob([new Uint8Array(file)]), filename);

  const res = await pickFetch(opts)(opts.policy.uploadHost, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`文件上传失败（HTTP ${res.status}）：${body.slice(0, 300)}`);
  }
  // 模型侧（wan3.0 等）接受 oss:// 临时 URL；oss 前缀只加在返回值上，表单 key 是裸键
  return `oss://${key}`;
}
