// 根模块：配置（全局）→ 数据库（全局）→ 能力 → 编排（tasks / chat）
import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { CapabilitiesModule } from './capabilities/capabilities.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { ChatModule } from './chat/chat.module.js';

@Module({
  imports: [ConfigModule, DatabaseModule, CapabilitiesModule, TasksModule, ChatModule],
})
export class AppModule {}
