import { Module } from '@nestjs/common';
import { AppLogger } from './app-logger.js';

// AppLogger 依赖 LogsRepository（DatabaseModule 全局导出）；main.ts 用 app.get(AppLogger) 取实例接管日志
@Module({
  providers: [AppLogger],
  exports: [AppLogger],
})
export class LoggingModule {}
