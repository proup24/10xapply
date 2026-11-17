import {
  Controller,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IntakeRepository } from './intake.repository';
import { parseDelivery } from './payload';
import { verifySignature } from './signature';
import { hashToken } from './token';

/**
 * The body as stored text. Postgres text cannot hold U+0000, so a NUL becomes
 * U+FFFD, as `toString('utf8')` already does for invalid bytes: in those two
 * cases the stored copy is not byte-identical to what was signed. Header
 * values need no such step: Node's HTTP parser refuses a NUL in a header.
 */
function storedText(rawBody: Buffer): string {
  return rawBody.toString('utf8').replaceAll('\u0000', '\uFFFD');
}

type Reply = { ok: true } | { error: 'unauthorized' | 'internal' };

/**
 * The single value of a header, or undefined when it is missing or repeated.
 * `headersDistinct` keeps each occurrence apart (Node joins `headers` with
 * ", "), so a repeated header is seen as such.
 */
function single(req: Request, name: string): string | undefined {
  const values = req.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

/**
 * Receives 10xjobs's match webhook. Order: the token's link, then the
 * signature, then the delivery headers; nothing is written before all pass.
 * Logs one line per request and never the token, its hash, the secret, the
 * signature or the body. Errors are caught here so Nest's exception handler
 * never logs a database message.
 */
@Controller('intake')
export class IntakeController {
  private readonly logger = new Logger(IntakeController.name);

  constructor(private readonly repository: IntakeRepository) {}

  @Post(':token')
  @HttpCode(200)
  async receive(
    @Param('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Reply> {
    let deliveryId: string | undefined;
    try {
      const link = await this.repository.findLink(hashToken(token));
      if (!link) return this.unauthorized(res);

      // No body leaves req.body undefined; it then fails the signature or parses as unparsed.
      const rawBody: Buffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.alloc(0);
      const signature = verifySignature({
        rawBody,
        timestamp: single(req, 'x-10xjobs-timestamp'),
        signature: single(req, 'x-10xjobs-signature'),
        secret: link.secret,
        nowSeconds: Date.now() / 1000,
      });
      if (!signature.ok) return this.unauthorized(res);

      const delivery = single(req, 'x-10xjobs-delivery');
      const event = single(req, 'x-10xjobs-event');
      if (!delivery || !event) return this.unauthorized(res);
      deliveryId = delivery;

      const outcome = await this.repository.store({
        userId: link.userId,
        deliveryId,
        event,
        sentAt: signature.sentAt,
        rawBody: storedText(rawBody),
        parsed: parseDelivery(rawBody, event, deliveryId),
      });
      this.logger.log(`intake: ${deliveryId} ${outcome} 200`);
      return { ok: true };
    } catch {
      // A fixed line: a database error's message could carry values.
      this.logger.error(
        deliveryId === undefined
          ? 'intake: error 500'
          : `intake: ${deliveryId} error 500`,
      );
      res.status(500);
      return { error: 'internal' };
    }
  }

  private unauthorized(res: Response): Reply {
    this.logger.log('intake: unauthorized');
    res.status(401);
    return { error: 'unauthorized' };
  }
}
