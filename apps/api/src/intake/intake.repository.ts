import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { ParsedDelivery } from './payload';

const UUID = 'pg/uuid@1';
const TEXT = 'pg/text@1';

export type StoreOutcome =
  'retry' | 'match' | 'duplicate-job' | 'test' | 'unparsed';

export type StoreInput = {
  userId: string;
  deliveryId: string;
  event: string;
  sentAt: Date;
  rawBody: string;
  parsed: ParsedDelivery;
};

/** Reads intake links and stores deliveries and matches. Never logs. */
@Injectable()
export class IntakeRepository {
  constructor(private readonly database: DatabaseService) {}

  /** The link whose token hashes to `tokenHash`, or null. */
  async findLink(
    tokenHash: string,
  ): Promise<{ userId: string; secret: string } | null> {
    const { db } = this.database;
    const [row] = await db.query(
      db.raw.sql`SELECT "userId", secret FROM intake_links
        WHERE "tokenHash" = ${tokenHash}::text`
        .returnsRow({ userId: UUID, secret: TEXT })
        .build(),
    );
    return row
      ? { userId: row.userId as string, secret: row.secret as string }
      : null;
  }

  /**
   * In one transaction: the delivery row, then for a match the match row.
   * A delivery id already stored for the user is a 10xjobs retry and writes
   * nothing. A match that hits either unique key (the 10xjobs job id or the
   * LinkedIn job id) leaves the delivery marked `duplicate-job`.
   */
  async store(input: StoreInput): Promise<StoreOutcome> {
    const { userId, deliveryId, event, sentAt, rawBody, parsed } = input;
    return this.database.db.transaction(async (tx) => {
      const outcome = parsed.kind;
      const [delivery] = await tx.query(
        tx.raw.sql`INSERT INTO webhook_deliveries
            ("userId", "deliveryId", event, "sentAt", "rawBody", outcome)
          VALUES (${userId}::uuid, ${deliveryId}::text, ${event}::text,
            ${sentAt.toISOString()}::timestamptz, ${rawBody}::text, ${outcome}::text)
          ON CONFLICT ("userId", "deliveryId") DO NOTHING
          RETURNING id`
          .returnsRow({ id: UUID })
          .build(),
      );
      if (!delivery) return 'retry';
      if (parsed.kind !== 'match') return parsed.kind;

      const m = parsed.match;
      // Raw SQL takes no null parameter: a nullable value travels with a flag.
      // No conflict target: either unique key makes it a duplicate.
      const [match] = await tx.query(
        tx.raw.sql`INSERT INTO matches
            ("userId", "deliveryId", "xjobsJobId", "jobKey", "linkedinJobId", title,
             "companyName", "postingUrl", "applyUrl", "profileLabel", unverified, "matchedAt")
          VALUES (${userId}::uuid, ${deliveryId}::text, ${m.xjobsJobId}::text,
            CASE WHEN ${m.jobKey !== null} THEN ${m.jobKey ?? ''}::text END,
            CASE WHEN ${m.linkedinJobId !== null} THEN ${m.linkedinJobId ?? ''}::text END,
            ${m.title}::text, ${m.companyName}::text, ${m.postingUrl}::text,
            CASE WHEN ${m.applyUrl !== null} THEN ${m.applyUrl ?? ''}::text END,
            ${m.profileLabel}::text, ${m.unverified}::boolean,
            ${m.matchedAt.toISOString()}::timestamptz)
          ON CONFLICT DO NOTHING
          RETURNING id`
          .returnsRow({ id: UUID })
          .build(),
      );
      if (match) return 'match';
      await tx.execute(
        tx.raw.sql`UPDATE webhook_deliveries
          SET outcome = 'duplicate-job', "updatedAt" = now()
          WHERE id = ${delivery.id as string}::uuid`
          .affectedCount()
          .build(),
      );
      return 'duplicate-job';
    });
  }
}
