import { Controller, Get, Header, HttpCode, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly database: DatabaseService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async get(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'ok' | 'database-unreachable' }> {
    try {
      await this.database.ping();
      return { status: 'ok' };
    } catch {
      // A fixed line: the driver's message could carry the database URL.
      this.logger.error('health: database unreachable');
      res.status(503);
      return { status: 'database-unreachable' };
    }
  }
}
