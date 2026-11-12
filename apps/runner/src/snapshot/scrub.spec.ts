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
    expect(counts.blankedTexts).toBe(3);
    expect(counts.droppedAttributes).toBe(2);
    expect(counts.secretsReplaced).toBe(1);
  });
});

describe('scrubSnapshot, fix round 1', () => {
  const scrub = (h: string, s: string[] = []) => scrubSnapshot(h, s);

  it('blanks textarea, contenteditable and textbox text inside kept text', () => {
    const { html } = scrub(
      '<label>Cover letter<textarea>I am Sam</textarea></label>' +
        '<button>Go<div contenteditable="true">Draft one</div>' +
        '<div contenteditable>Draft two</div><span contenteditable="false">Fixed</span>' +
        '<span role="textbox">Typed here</span></button>',
    );
    expect(html).toContain('Cover letter');
    expect(html).not.toContain('I am Sam');
    expect(html).not.toContain('Draft');
    expect(html).not.toContain('Typed here');
    expect(html).toContain('Fixed');
  });

  it('does not inherit kept text into block descendants', () => {
    const { html } = scrub(
      '<label>Resume <div><h3>CV.pdf</h3><p>Last used on 10/1/2026</p></div></label>',
    );
    expect(html).toContain('Resume');
    expect(html).toContain('<h3>CV.pdf</h3>');
    expect(html).not.toContain('Last used');
    expect(html).toContain('<p>xxxx xxxx xx xxxxxxxxx</p>');
  });

  it('inline descendants of kept text still inherit', () => {
    const { html } = scrub(
      '<button><span>Next</span></button><label><b>Bold</b> <em>em</em></label>',
    );
    expect(html).toContain('<span>Next</span>');
    expect(html).toContain('<b>Bold</b>');
  });

  it('keeps text for role option and checkbox', () => {
    const { html } = scrub(
      '<div role="option">Option text</div><div role="checkbox">Check text</div>' +
        '<div role="listitem">Other</div>',
    );
    expect(html).toContain('Option text');
    expect(html).toContain('Check text');
    expect(html).not.toContain('Other');
  });

  it('drops selection and state attributes and counts them', () => {
    const { html, counts } = scrub(
      '<select><option selected>A</option></select><input type="checkbox" checked>' +
        '<div role="checkbox" aria-checked="true" aria-selected="true" aria-pressed="true">z</div>',
    );
    for (const a of [
      'selected',
      'checked',
      'aria-checked',
      'aria-selected',
      'aria-pressed',
    ])
      expect(html).not.toContain(a);
    expect(counts.droppedAttributes).toBe(5);
  });

  it('blanks free-text attributes', () => {
    const { html, counts } = scrub(
      '<input title="Sam at home" placeholder="Enter 07700" aria-valuetext="Ten of 12">' +
        '<img alt="photo">' +
        '<div aria-description="Last used 5 days ago" alt="Jo">q</div>',
    );
    expect(html).toContain('title="xxx xx xxxx"');
    expect(html).toContain('placeholder="xxxxx xxxxx"');
    expect(html).toContain('aria-valuetext="xxx xx xx"');
    expect(html).toContain('aria-description="xxxx xxxx x xxxx xxx"');
    expect(html).toContain('alt="xx"');
    expect(counts.blankedTexts).toBeGreaterThanOrEqual(5);
  });

  it('blanks value attributes unless they equal the element text', () => {
    const { html } = scrub(
      '<select><option value="Sam-123">Yes</option><option value=" yes ">Yes</option></select>' +
        '<button value="Secret">Go</button><ul><li value="5">Item</li></ul><data value="42">n</data>',
    );
    expect(html).toContain('value="xxxxxxx"');
    expect(html).toContain('value=" yes "');
    expect(html).toContain('value="xxxxxx"');
    expect(html).toContain('<li value="x">');
    expect(html).toContain('<data value="xx">');
    expect(html).not.toContain('Sam-123');
    expect(html).not.toContain('"Secret"');
  });

  it('drops any attribute whose value is a URL', () => {
    const { html, counts } = scrub(
      '<div data="https://a.example/x" foo=" HTTP://b" bar="//c.example" baz="data:text/plain,hi" qux="javascript:1" ok="https-like">t</div>',
    );
    for (const a of ['data=', 'foo=', 'bar=', 'baz=', 'qux=', 'example'])
      expect(html).not.toContain(a);
    expect(html).toContain('ok="https-like"');
    expect(counts.droppedAttributes).toBe(5);
  });

  it('replaces a secret in a kept attribute on an input', () => {
    const { html } = scrub('<input aria-label="Email sam@example.com">', [
      'sam@example.com',
    ]);
    expect(html).toContain('aria-label="Email [secret]"');
  });

  it('matches secrets on word boundaries only', () => {
    const { html } = scrub('<label>Yes Yesterday Yes. xYes</label>', ['Yes']);
    expect(html).toBe('<label>[secret] Yesterday [secret]. xYes</label>');
  });

  it('matches a secret across whitespace, nbsp and separators', () => {
    const { html } = scrub(
      '<label>Sam\n  Example | Sam Example | sam_example | SAM.EXAMPLE | sam-example | SamExample</label>',
      ['Sam Example'],
    );
    expect(html).not.toMatch(/sam/i);
    expect(html).toContain('[secret]');
  });

  it('matches a phone number written in any layout', () => {
    const { html, counts } = scrub(
      '<label>+44 7700 900123, (+44) 7700-900-123, 447700900123, +447700900123</label>',
      ['+447700900123'],
    );
    expect(html).toBe(
      '<label>+[secret], (+[secret], [secret], +[secret]</label>',
    );
    expect(counts.secretsReplaced).toBe(4);
    const near = scrub('<label>9447700900123</label>', ['+447700900123']);
    expect(near.html).toContain('9447700900123');
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
    expect(secrets).toContain('5000 USD per month');
    for (const s of bank.stories) expect(secrets).toContain(s.title);
  });

  it('drops option-like single words and adds the profile slug', () => {
    const bank = loadFactBank(EXAMPLE);
    const answers = bank.answers.flatMap((a) => [
      ...(a.answer ? [a.answer] : []),
      ...(a.variants ?? []).map((v) => v.answer),
    ]);
    for (const a of answers) {
      const optionLike = /^\S+$/.test(a) && !/\d/.test(a) && !a.includes('@');
      expect(secrets.includes(a.trim())).toBe(
        !optionLike && a.trim().length >= 3,
      );
    }
    expect(secrets).toContain('sam-example');
  });

  it('drops short strings and sorts longest first', () => {
    expect(secrets).not.toContain('+1');
    expect(secrets.every((s) => s.length >= 3)).toBe(true);
    const lengths = secrets.map((s) => s.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });
});
