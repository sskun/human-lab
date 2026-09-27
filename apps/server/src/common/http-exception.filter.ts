// 全局异常过滤器：把所有错误统一成 { error: string }（重构前 Express 版的响应形状）。
// 各路由抛出的 HttpException（含 ChatError）按其状态码返回；未匹配路由的 Nest 默认文案
// "Cannot GET /x" 还原为 "not found: GET /x"；其余未知异常一律 500。
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string' ? body : ((body as { message?: string }).message ?? exception.message);
      res.status(status).json({ error: message.replace(/^Cannot /, 'not found: ') });
      return;
    }
    const message = exception instanceof Error ? exception.message : String(exception);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: message });
  }
}
