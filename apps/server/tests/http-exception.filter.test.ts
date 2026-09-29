// 全局异常过滤器：响应形状保持 { error }；5xx 与未知异常额外记一条 error 日志（带请求方法与路径），4xx 不记。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';

function fakeHost(req = { method: 'POST', originalUrl: '/api/x' }) {
  const res = {
    code: 0,
    body: undefined as unknown,
    status(c: number) {
      this.code = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { res, host };
}

function fakeLogger() {
  const calls: unknown[][] = [];
  return { calls, error: (...args: unknown[]) => void calls.push(args) };
}

describe('HttpExceptionFilter', () => {
  it('4xx：响应 { error }，不记日志', () => {
    const logger = fakeLogger();
    const { res, host } = fakeHost();
    new HttpExceptionFilter(logger).catch(new BadRequestException('text 不能为空'), host);
    assert.equal(res.code, 400);
    assert.deepEqual(res.body, { error: 'text 不能为空' });
    assert.equal(logger.calls.length, 0);
  });

  it('5xx HttpException：响应不变，记 error 日志（含方法与路径）', () => {
    const logger = fakeLogger();
    const { res, host } = fakeHost();
    new HttpExceptionFilter(logger).catch(new HttpException('识别失败：上游超时', HttpStatus.BAD_GATEWAY), host);
    assert.equal(res.code, 502);
    assert.deepEqual(res.body, { error: '识别失败：上游超时' });
    assert.equal(logger.calls.length, 1);
    assert.match(String(logger.calls[0][0]), /POST \/api\/x → 502: 识别失败：上游超时/);
  });

  it('未知异常：500 + 记 error 日志并带堆栈', () => {
    const logger = fakeLogger();
    const { res, host } = fakeHost({ method: 'GET', originalUrl: '/api/y' });
    new HttpExceptionFilter(logger).catch(new Error('kaboom'), host);
    assert.equal(res.code, 500);
    assert.deepEqual(res.body, { error: 'kaboom' });
    assert.match(String(logger.calls[0][0]), /GET \/api\/y → 500: kaboom/);
    assert.match(String(logger.calls[0][1]), /Error: kaboom/);
  });
});
