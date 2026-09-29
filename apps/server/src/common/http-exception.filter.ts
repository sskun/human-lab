// 全局异常过滤器：把所有错误统一成 { error: string }（重构前 Express 版的响应形状）。
// 各路由抛出的 HttpException（含 ChatError）按其状态码返回；未匹配路由的 Nest 默认文案
// "Cannot GET /x" 还原为 "not found: GET /x"；其余未知异常一律 500。
// 5xx 与未知异常额外记一条 error 日志（带请求方法与路径，进入管理后台「运行日志」）；4xx 属于调用方问题，不记。
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  /** @param logger 可注入替身（单测用），缺省为 Nest Logger（经 AppLogger 落库） */
  constructor(private readonly logger: Pick<Logger, 'error'> = new Logger('Http')) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string' ? body : ((body as { message?: string }).message ?? exception.message);
      if (status >= 500) this.logError(ctx.getRequest<Request>(), status, message, exception.stack);
      res.status(status).json({ error: message.replace(/^Cannot /, 'not found: ') });
      return;
    }
    const message = exception instanceof Error ? exception.message : String(exception);
    this.logError(
      ctx.getRequest<Request>(),
      HttpStatus.INTERNAL_SERVER_ERROR,
      message,
      exception instanceof Error ? exception.stack : undefined,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: message });
  }

  private logError(req: Request | undefined, status: number, message: string, stack?: string): void {
    const where = req ? `${req.method} ${req.originalUrl ?? req.url}` : 'unknown request';
    this.logger.error(`${where} → ${status}: ${message}`, stack);
  }
}
