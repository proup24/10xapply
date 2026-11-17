import { Controller, Get, Header, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
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
      res.status(503);
      return { status: 'database-unreachable' };
    }
  }
}
