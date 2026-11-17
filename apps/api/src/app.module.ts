import { Module, type DynamicModule } from '@nestjs/common';
import type { Environment } from './config/environment';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { IntakeModule } from './intake/intake.module';

@Module({})
export class AppModule {
  static register(env: Environment): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule.register(env.DATABASE_URL), IntakeModule],
      controllers: [HealthController],
    };
  }
}
