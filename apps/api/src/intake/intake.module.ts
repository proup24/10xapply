import { Module } from '@nestjs/common';
import { IntakeController } from './intake.controller';
import { IntakeRepository } from './intake.repository';

/** The webhook intake: `POST /api/intake/:token`. */
@Module({
  controllers: [IntakeController],
  providers: [IntakeRepository],
})
export class IntakeModule {}
