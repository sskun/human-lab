// 配置模块：config.ts 解析出的目录/各能力配置以 DI 方式注入。
// config.ts 本身保持纯函数（lego CLI 与冒烟测试直接引用），本模块是它的 Nest 封装。
import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service.js';

@Global()
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
