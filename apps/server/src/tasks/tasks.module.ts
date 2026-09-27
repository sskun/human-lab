import { Module } from '@nestjs/common';
import { CapabilitiesModule } from '../capabilities/capabilities.module.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

@Module({
  imports: [CapabilitiesModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
