import { Module, type DynamicModule } from '@nestjs/common';
import type { Environment } from './config/environment';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';

@Module({})
export class AppModule {
  static register(env: Environment): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule.register(env.DATABASE_URL)],
      controllers: [HealthController],
    };
  }
}
