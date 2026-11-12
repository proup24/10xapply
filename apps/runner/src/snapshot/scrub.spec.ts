import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFactBank } from '@xapply/fact-bank';
import { bankSecrets, scrubSnapshot } from './scrub.js';

const EXAMPLE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'libs',
  'fact-bank',
  'fact-bank.example.yaml',
);

describe('scrubSnapshot', () => {
  it('blanks review-page answers', () => {
    const { html } = scrubSnapshot(
      '<div><h3>Notice period</h3><span>Two weeks</span></div>',
      [],
    );
    expect(html).toContain('<h3>Notice period</h3>');
    expect(html).toContain('<span>xxx xxxxx</span>');
  });

  it('keeps form wording', () => {
    const { html } = scrubSnapshot(
      '<form><label for="a">Your city</label><legend>Visa</legend>' +
        '<select id="a"><option>Leeds area</option></select>' +
        '<button>Next step</button><div role="radio">Yes</div></form>',
      [],
    );
    for (const t of ['Your city', 'Visa', 'Leeds area', 'Next step', '>Yes<'])
      expect(html).toContain(t);
  });

  it('keeps help text named by aria-describedby', () => {
    const { html } = scrubSnapshot(
      '<input aria-describedby="h1 h2"><div id="h1">Use digits only</div>' +
        '<div id="h2"><span>Max ten</span></div><div id="h3">Other text</div>',
      [],
    );
    expect(html).toContain('Use digits only');
    expect(html).toContain('Max ten');
    expect(html).toContain('xxxxx xxxx');
    expect(html).not.toContain('Other text');
  });

  it('replaces a bank value inside an option', () => {
    const { html, counts } = scrubSnapshot(
      '<select><option>me@example.com</option></select>',
      ['me@example.com'],
    );
    expect(html).toContain('<option>[secret]</option>');
    expect(counts.secretsReplaced).toBe(1);
  });

  it('replaces a secret inside a kept aria-label, ignoring case', () => {
    const { html } = scrubSnapshot(
      '<button aria-label="Send to Me@Example.com (a+b)">Go</button>' +
        '<div aria-label="Sam Example">x</div>',
      ['me@example.com', '(a+b)'],
    );
    expect(html).toContain('aria-label="Send to [secret] [secret]"');
    // not on the allowlist: dropped
    expect(html).not.toContain('Sam Example');
  });

  it('drops input values, URLs and scripts', () => {
    const { html } = scrubSnapshot(
      '<head><meta charset="x"><link href="https://a.example/s.css"><style>p{}</style></head>' +
        '<body onload="evil()"><script>var secret=1</script><noscript>nojs</noscript>' +
        '<a href="https://l.example/in/me" style="color:red" data-x="1" data-test-id="t">me</a>' +
        '<img src="https://l.example/p.png"><svg><text>logo</text></svg><iframe src="u"></iframe>' +
        '<input type="hidden" name="csrf" value="tok"><input type="text" value="Sam Example">' +
        '<textarea value="v">typed</textarea>' +
        '<code>{"data":{"name":"Sam"}}</code><code>plain</code>' +
        '<script type="application/ld+json">{"a":1}</script></body>',
      [],
    );
    for (const t of [
      'https://',
      'evil',
      'var secret',
      'nojs',
      'color:red',
      'data-x',
      'csrf',
      'tok',
      'Sam',
      'logo',
      'ld+json',
      '<meta',
      '<link',
      '<style',
      '<script',
      '<img',
      '<svg',
      '<iframe',
      'value=',
      'typed',
    ])
      expect(html).not.toContain(t);
    expect(html).toContain('data-test-id="t"');
    expect(html).toContain('<code>xxxxx</code>');
  });

  it('removes comments and blanks ordinary template content', () => {
    const { html } = scrubSnapshot(
      '<div><!-- Sam Example --><template><p>Secret words</p></template></div>',
      [],
    );
    expect(html).not.toContain('Sam Example');
    expect(html).not.toContain('Secret words');
  });

  it('reaches into shadow roots', () => {
    const { html } = scrubSnapshot(
      '<div><template shadowrootmode="open"><span>Private</span><label>Ask</label></template></div>',
      [],
    );
    expect(html).toContain('xxxxxxx');
    expect(html).toContain('<label>Ask</label>');
  });

  it('counts what it did and returns no secret', () => {
    const secrets = ['sam@example.com', 'Sam Example', 'Leeds'];
    const input =
      '<div><h3>Contact</h3><span>Sam Example, Leeds</span>' +
      '<option>SAM@example.com</option><input value="Leeds" title="Leeds">' +
      '<script>1</script><a href="x">y</a></div>';
    const { html, counts } = scrubSnapshot(input, secrets);
    for (const s of secrets)
      expect(html.toLowerCase()).not.toContain(s.toLowerCase());
    expect(JSON.stringify(counts).toLowerCase()).not.toContain('sam');
    expect(counts.removedElements).toBe(1);
    expect(counts.blankedTexts).toBe(2);
    expect(counts.droppedAttributes).toBe(2);
    expect(counts.secretsReplaced).toBe(2);
  });
});

describe('bankSecrets', () => {
  const bank = loadFactBank(EXAMPLE);
  const secrets = bankSecrets(bank);

  it('includes the email, the phone without spaces, facts and the resume name', () => {
    expect(secrets).toContain(bank.fields.email);
    expect(secrets).toContain(
      `${bank.fields.phone.countryCode}${bank.fields.phone.number.replace(/ /g, '')}`,
    );
    for (const f of bank.facts) expect(secrets).toContain(f.text);
    expect(secrets).toContain('resume.pdf');
    for (const a of bank.answers)
      if (a.answer) expect(secrets).toContain(a.answer);
    for (const s of bank.stories) expect(secrets).toContain(s.title);
  });

  it('drops short strings and sorts longest first', () => {
    expect(secrets).not.toContain('+1');
    expect(secrets.every((s) => s.length >= 3)).toBe(true);
    const lengths = secrets.map((s) => s.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });
});
