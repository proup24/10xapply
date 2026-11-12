import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePage } from './dom.js';
import { readFormCompany, readJobPage } from './job-page.js';
import { EASY_APPLY } from './selectors.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../apply/fixtures');
// Rows of the README table: | file | kind | source | scrubbed |
const rows = readFileSync(join(dir, 'README.md'), 'utf8')
  .split('\n')
  .filter((l) => /^\|\s*\S+\.html\s*\|/.test(l))
  .map((l) => l.split('|').map((c) => c.trim()))
  .map(([, file, kind]) => ({ file: file ?? '', kind: kind ?? '' }));
const load = (file: string) =>
  readJobPage(parsePage(readFileSync(join(dir, file), 'utf8')));

describe('readJobPage on the fixtures', () => {
  it('has job rows', () => {
    expect(rows.filter((r) => r.kind === 'job').length).toBeGreaterThan(0);
  });

  it.each(rows.filter((r) => r.kind === 'job'))(
    '$file is an Easy Apply job with a description',
    ({ file }) => {
      const r = load(file);
      expect(r.easyApply).toBe(EASY_APPLY);
      expect(r.applied).toBe(false);
      expect(r.description?.length ?? 0).toBeGreaterThan(200);
      expect(r.description).not.toMatch(/^About the job/);
      expect(r.description).not.toMatch(/… ?more\s*$/);
      // Both job captures carry the alert switch and the Follow button.
      expect(r.title).not.toBeNull();
      expect(r.company).not.toBeNull();
    },
  );

  it.each(rows.filter((r) => r.kind === 'job-applied'))(
    '$file reads as applied',
    ({ file }) => {
      const r = load(file);
      expect(r.applied).toBe(true);
      expect(r.easyApply).toBeNull();
      expect(r.description?.length ?? 0).toBeGreaterThan(200);
    },
  );
});

describe('readJobPage', () => {
  it('reads title and company from the alert switch and Follow button', () => {
    const r = readJobPage(
      parsePage(
        '<body><input type="checkbox" aria-label="Set alert for similar jobs as Back End Developer"><button aria-label="Following, click to unfollow Acme Corp">Following</button></body>',
      ),
    );
    expect(r).toEqual({
      title: 'Back End Developer',
      company: 'Acme Corp',
      location: null,
      description: null,
      easyApply: null,
      applied: false,
    });
  });

  it('takes the company from a Follow button, not the form checkbox', () => {
    const r = readJobPage(
      parsePage(
        '<body><input type="checkbox" aria-label="Follow Other to stay up to date with their page"><button aria-label="Follow Acme">Follow</button></body>',
      ),
    );
    expect(r.company).toBe('Acme');
  });

  it('has no company when Follow buttons name different companies', () => {
    const r = readJobPage(
      parsePage(
        '<body><button aria-label="Follow Acme">Follow</button><button aria-label="Follow Globex">Follow</button></body>',
      ),
    );
    expect(r.company).toBeNull();
  });

  it('keeps the company when every Follow button names it', () => {
    const r = readJobPage(
      parsePage(
        '<body><button aria-label="Follow Acme">Follow</button><button aria-label="Following, click to unfollow Acme">Following</button></body>',
      ),
    );
    expect(r.company).toBe('Acme');
  });

  it('prefers the open form\'s "Apply to <company>" heading', () => {
    const r = readJobPage(
      parsePage(
        '<body><button aria-label="Follow Globex">Follow</button><dialog aria-labelledby="dialog-header" open><header id="dialog-header"><h2>Apply to Acme Corp</h2></header></dialog></body>',
      ),
    );
    expect(r.company).toBe('Acme Corp');
  });

  it('is not applied while the Easy Apply button is there', () => {
    const r = readJobPage(
      parsePage(
        `<body><h2>Application status</h2><button aria-label="Easy Apply to this job">Easy Apply</button></body>`,
      ),
    );
    expect(r.applied).toBe(false);
    expect(r.easyApply).toBe(EASY_APPLY);
  });

  it('reads "Your application was sent" as applied', () => {
    const r = readJobPage(
      parsePage('<body><p>Your application was sent to Acme</p></body>'),
    );
    expect(r.applied).toBe(true);
  });

  it('reads the About the job text without the heading or the more button', () => {
    const r = readJobPage(
      parsePage(
        '<body><div><div><h2>About the job</h2></div><div><p>We build things.</p><p>You test them.</p><button data-testid="expandable-text-button">… more</button></div></div><div><h2>About the company</h2><p>Other</p></div></body>',
      ),
    );
    expect(r.description).toBe('We build things.\nYou test them.');
  });
});

describe('readFormCompany', () => {
  it('reads the company from the form heading', () => {
    expect(
      readFormCompany(
        parsePage(
          '<dialog><header id="dialog-header"><h2>Apply to Acme Corp</h2></header></dialog>',
        ),
      ),
    ).toBe('Acme Corp');
  });

  it('is null without the form or with another heading', () => {
    expect(
      readFormCompany(parsePage('<body><h2>Apply to X</h2></body>')),
    ).toBeNull();
    expect(
      readFormCompany(
        parsePage(
          '<dialog><header id="dialog-header"><h2>Save this application?</h2></header></dialog>',
        ),
      ),
    ).toBeNull();
  });

  it.each(rows.filter((r) => r.kind.startsWith('step')))(
    '$file names a company in its form heading',
    ({ file }) => {
      const doc = parsePage(readFileSync(join(dir, file), 'utf8'));
      expect(readFormCompany(doc)).not.toBeNull();
    },
  );
});
