// 数字人后端入口（NestJS）：装配 AppModule 并启动 HTTP 服务
//
// 接口（与设计文档 §4.2 / docs/asr-design.md §4.4 一致）：
//   POST /api/speak        { text, voice? } → 202 { taskId }      受理合成任务（异步，轮询取结果）
//   POST /api/listen       { audioBase64, format? } → 200 { taskId, text, duration }
//                                                                 语音识别（同步，亚秒级返回）
//   GET  /api/tasks/:id    → TaskView { id, status, audioUrl?, text?, error? }
//   GET  /api/tasks        → TaskView[]（最近 20 条）
//
// 实时聊天（会话制）：
//   POST /api/chat/sessions            → 201 { session }            点击「开始聊天」
//   POST /api/chat/sessions/:id/turns  { text? | audioBase64?, format? }
//                                      → 200 { turn }               说一轮（ASR→LLM→TTS，同步）
//   POST /api/chat/sessions/:id/end    → 200 { session }            点击「结束聊天」
//   GET  /api/chat/sessions            → ChatSessionView[]          历史会话列表
//   GET  /api/chat/sessions/:id/turns  → ChatTurnView[]             会话的输入/输出明细
//
//   GET  /media/<file>     → 静态文件（output/ 目录下的 mp3/wav/mp4）
//
// 系统信息与管理后台（只读，当前无鉴权，仅适合本机/内网）：
//   GET  /api/meta                 → AppMeta（形象/音色/模型/字数上限）
//   GET  /api/avatar/image         → 当前形象图
//   GET  /api/admin/overview       → 概览统计
//   GET  /api/admin/logs           → 运行日志（?level=&scope=&q=&before=&limit=）
//   GET  /api/admin/logs/scopes    → 日志模块名
//   GET  /api/admin/tasks          → 任务记录（?type=&status=&limit=）
//
// 启动：npm run dev:server（nest start --watch，端口 3101）
// web 端通过 vite 代理把 /api、/media 转发到这里，因此无需处理 CORS。
import 'reflect-metadata';
import express from 'express';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { AppLogger } from './logging/app-logger.js';
import { OUTPUT_DIR, loadDotEnv } from './config.js';

async function bootstrap(): Promise<void> {
  // .env 是唯一的密钥/配置来源：解析任何配置前先加载（不覆盖已有环境变量）
  loadDotEnv();
  // 必须在 loadDotEnv 之后读取，.env 里的 PORT 才会生效（优先级：环境变量 > .env > 默认 3101）
  const PORT = Number(process.env.PORT || 3101);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // 关闭内置 body 解析：JSON 上限需放宽到 16MB（默认 100kb 装不下 base64 音频，约放大 4/3），
    // 音频本身的大小再由 /api/listen 内按解码后字节数精确限制（超限 413）。
    bodyParser: false,
    // 启动期日志先缓冲：数据库要到 init 才建表，等 AppLogger 接管后一并回放落库
    bufferLogs: true,
  });
  // 中间件必须在 init 之前注册（init 时挂路由，晚于路由的 body 解析不会生效）
  app.use(express.json({ limit: '16mb' }));
  // 把 output/ 目录挂载为静态资源：前端拿到的 audioUrl 是 /media/tts-xxx.mp3
  app.use('/media', express.static(OUTPUT_DIR));
  // 所有错误统一为 { error: string } 响应体（与响应格式约定一致）
  app.useGlobalFilters(new HttpExceptionFilter());

  // 时序：init（模块初始化、app_logs 建表）→ 切换到持久化日志器（回放缓冲日志）→ 监听端口
  await app.init();
  app.useLogger(app.get(AppLogger));

  await app.listen(PORT);
  const logger = new Logger('Bootstrap');
  logger.log(`listening on http://localhost:${PORT}`);
  logger.log(`media dir: ${OUTPUT_DIR}`);
}

void bootstrap();
