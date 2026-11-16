import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// `db:migrate` (and the cloud deploy) runs `prisma db migrate --to db`, so it
// stops at the contract hash in refs/db.json. The ref is moved by hand after
// each plan (docs/database.md); a stale one gives a green run that migrates
// nothing. This fails until the ref names the newest contract.
const src = join(import.meta.dirname, '..');
const app = join(src, 'migrations', 'app');

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

/** The newest migration folder: their names start with a sortable timestamp. */
function newestMigration(): string {
  const folders = readdirSync(app, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(app, entry.name, 'migration.json')),
    )
    .map((entry) => entry.name)
    .sort();
  const newest = folders.at(-1);
  if (newest === undefined) throw new Error(`no migration under ${app}`);
  return newest;
}

describe('the db migration ref', () => {
  const ref = readJson(join(app, 'refs', 'db.json'))['hash'];

  it('is a contract hash', () => expect(ref).toMatch(/^[0-9a-f]{64}$/));

  it("points at the emitted contract's storage hash", () => {
    const contract = readJson(join(src, 'contract', 'contract.json'));
    const storage = contract['storage'] as Record<string, unknown>;
    expect(ref).toBe(storage['storageHash']);
  });

  it("points at the newest migration's target", () => {
    const newest = newestMigration();
    expect(ref, `refs/db.json is behind ${newest}`).toBe(
      readJson(join(app, newest, 'migration.json'))['to'],
    );
  });

  it('has the snapshot of that contract', () =>
    expect(
      existsSync(
        join(src, 'migrations', 'snapshots', String(ref), 'contract.json'),
      ),
    ).toBe(true));
});
