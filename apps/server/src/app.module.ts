// 根模块：配置（全局）→ 数据库（全局）→ 日志 → 能力 → 编排（tasks / chat）→ 后台与系统信息
import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { CapabilitiesModule } from './capabilities/capabilities.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { ChatModule } from './chat/chat.module.js';
import { AdminModule } from './admin/admin.module.js';
import { SystemModule } from './system/system.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    LoggingModule,
    CapabilitiesModule,
    TasksModule,
    ChatModule,
    AdminModule,
    SystemModule,
  ],
})
export class AppModule {}
