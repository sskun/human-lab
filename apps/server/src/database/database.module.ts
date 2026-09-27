import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { TasksRepository } from './tasks.repository.js';
import { ChatRepository } from './chat.repository.js';

@Global()
@Module({
  providers: [DatabaseService, TasksRepository, ChatRepository],
  exports: [DatabaseService, TasksRepository, ChatRepository],
})
export class DatabaseModule {}
