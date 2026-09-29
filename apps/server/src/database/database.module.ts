import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { TasksRepository } from './tasks.repository.js';
import { ChatRepository } from './chat.repository.js';
import { LogsRepository } from './logs.repository.js';

@Global()
@Module({
  providers: [DatabaseService, TasksRepository, ChatRepository, LogsRepository],
  exports: [DatabaseService, TasksRepository, ChatRepository, LogsRepository],
})
export class DatabaseModule {}
