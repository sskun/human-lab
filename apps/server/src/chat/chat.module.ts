import { Module } from '@nestjs/common';
import { CapabilitiesModule } from '../capabilities/capabilities.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [CapabilitiesModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
