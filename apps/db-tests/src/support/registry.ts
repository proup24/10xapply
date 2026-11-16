export type OwnedTable = {
  table: string;
  ownerColumn: 'userId' | 'id';
  /** Service role creates a row owned by userId and returns its id. */
  seed(userId: string): Promise<string>;
  /** A valid insert payload for userId, or null if users can't insert. */
  insertPayload: ((userId: string) => Promise<Record<string, unknown>>) | null;
  /** A harmless update the owner is allowed to make, or null if the owner can't write. */
  patch: Record<string, unknown> | null;
  /** The owner may delete their own row. The cross-user delete case runs for every table regardless. */
  canDelete: boolean;
};

/** Every table with an owner. Adding one here puts it under the isolation suite. */
export const ownedTables: OwnedTable[] = [
  {
    table: 'users',
    ownerColumn: 'id',
    // The sign-up trigger already created the row.
    seed: async (userId) => userId,
    insertPayload: null,
    patch: { updatedAt: new Date().toISOString() },
    canDelete: false,
  },
];
