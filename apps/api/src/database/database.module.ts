import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DATABASE_URL, DatabaseService } from './database.service';

@Global()
@Module({})
export class DatabaseModule {
  static register(url: string): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [{ provide: DATABASE_URL, useValue: url }, DatabaseService],
      exports: [DatabaseService],
    };
  }
}
