import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFactBank } from '@xapply/fact-bank';
import {
  bankNameSecrets,
  bankSecrets,
  leakCheck,
  scrubSnapshot,
} from './scrub.js';

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
      [],
    );
    for (const t of ['Your city', 'Visa', 'Leeds area', 'Next step', '>Yes<'])
      expect(html).toContain(t);
  });

  it('keeps a question <p> right inside a form field wrapper, and no other <p>', () => {
    const { html } = scrubSnapshot(
      '<div componentkey="easyApplyFieldFocus_ea.q::1::UNKNOWN::value.validation">' +
        '<p>Location (city)*</p><div><p>Typed note</p><input></div></div>' +
        '<div componentkey="other"><p>Other text</p></div><p>Loose words</p>',
      ['Leeds'],
      [],
    );
    expect(html).toContain('<p>Location (city)*</p>');
    expect(html).not.toContain('Typed note');
    expect(html).not.toContain('Other text');
    expect(html).not.toContain('Loose words');
  });

  it('still replaces a secret in a kept question <p>', () => {
    const { html } = scrubSnapshot(
      '<div componentkey="easyApplyFieldFocus_x"><p>Do you live in Leeds?</p></div>',
      ['Leeds'],
      [],
    );
    expect(html).toContain('<p>Do you live in [secret]?</p>');
  });

  describe('public option lists', () => {
    // A list every applicant sees: a [secret] in it shows the bank's pick by
    // its position, so bank values are left whole there.
    it('leaves a select with the bank value among other options intact', () => {
      const { html } = scrubSnapshot(
        '<label for="c">Phone country code</label><select id="c">' +
          '<option value="LY">Libya (+218)</option>' +
          '<option value="MA">Morocco (+212)</option>' +
          '<option value="MC">Monaco (+377)</option></select>',
        ['Morocco', '+212'],
        [],
      );
      expect(html).toContain('>Morocco (+212)</option>');
      expect(html).not.toContain('[secret]');
      // value= attributes are blanked as before.
      expect(html).toContain('value="xx"');
    });

    it('still scrubs a one-option select (the author’s own email list)', () => {
      const { html } = scrubSnapshot(
        '<select id="e"><option>sam-mail-handle</option></select>',
        ['sam-mail-handle'],
        [],
      );
      expect(html).not.toContain('sam-mail-handle');
      expect(html).toContain('[secret]');
    });

    it('a placeholder is not an option: one real option is still scrubbed', () => {
      const { html } = scrubSnapshot(
        '<select id="e"><option value="" disabled hidden></option>' +
          '<option value="sam-mail-handle">sam-mail-handle</option></select>',
        ['sam-mail-handle'],
        [],
      );
      expect(html).not.toContain('sam-mail-handle');
    });

    it('still replaces any email address inside a multi-option select', () => {
      const { html } = scrubSnapshot(
        '<select><option>a@x.io</option><option>b@x.io</option></select>',
        [],
        [],
      );
      expect(html).not.toContain('@x.io');
    });

    it('leaves a radio or checkbox group option equal to a bank answer intact', () => {
      const { html } = scrubSnapshot(
        '<fieldset><legend>Background</legend>' +
          '<div><div><input id="a" type="checkbox"><label for="a"></label></div><p>East Asian</p></div>' +
          '<div><div><input id="b" type="checkbox"><label for="b"></label></div><p>North African</p></div></fieldset>' +
          '<fieldset role="radiogroup"><input id="y" type="radio" name="g"><label for="y">North African</label>' +
          '<input id="n" type="radio" name="g"><label for="n">No</label></fieldset>',
        ['North African'],
        [],
      );
      expect(html).toContain('<p>North African</p>');
      expect(html).toContain('<label for="y">North African</label>');
      expect(html).not.toContain('[secret]');
    });

    it("still scrubs the author's own list: radios each labelled by its own name (resumes)", () => {
      const { html } = scrubSnapshot(
        '<fieldset role="radiogroup">' +
          '<div><div><input id="r1" type="radio" name="g" aria-label="SamExampleCV.pdf"><label for="r1"></label></div><div><p>SamExampleCV.pdf</p></div></div>' +
          '<div><div><input id="r2" type="radio" name="g" aria-label="other.docx"><label for="r2"></label></div><div><p>other.docx</p></div></div></fieldset>',
        ['SamExample'],
        ['SamExample'],
      );
      expect(html).not.toContain('SamExample');
    });

    it('still scrubs a bank value in free text, a question or a lone box', () => {
      const { html } = scrubSnapshot(
        '<div componentkey="easyApplyFieldFocus_q"><p>Do you live in Leeds?</p>' +
          '<fieldset><div><input id="c" type="checkbox"><label for="c"></label><p>Leeds</p></div></fieldset></div>' +
          '<h3>Leeds</h3><span>Leeds</span>',
        ['Leeds'],
        [],
      );
      expect(html).not.toContain('Leeds');
      expect(html.match(/\[secret\]/g)).toHaveLength(3);
    });
  });

  describe('review-page Edit buttons', () => {
    // LinkedIn's review page: a section header is an <h4> or a <p> beside
    // its Edit button; a profile entry's button is named after the entry.
    const REVIEW =
      '<div><div><h4>Contact info</h4><button aria-label="Edit Contact info"><span>Edit</span></button></div></div>' +
      '<div><div><p>Education</p><button aria-label="Edit Education"><span>Edit</span></button></div>' +
      '<div><div><div><p>School</p><p>Uni of Somewhere</p></div></div>' +
      '<button aria-label="Edit Uni of Somewhere, Some Town"><span></span></button></div></div>' +
      '<div><button aria-label="Edit, Work Experience"></button></div>';

    it('keeps a section name taken from a heading or the <p> beside the button', () => {
      const { html } = scrubSnapshot(REVIEW, [], []);
      expect(html).toContain('aria-label="Edit Contact info"');
      expect(html).toContain('aria-label="Edit Education"');
      expect(html).toContain('aria-label="Edit, Work Experience"');
    });

    it('blanks the entry part of any other Edit label, whatever the bank holds', () => {
      const { html, counts } = scrubSnapshot(REVIEW, [], []);
      expect(html).not.toContain('Somewhere');
      expect(html).not.toContain('Some Town');
      expect(html).toContain('aria-label="Edit xxx xx xxxxxxxxxx xxxx xxxx"');
      expect(counts.blankedTexts).toBeGreaterThan(0);
    });

    it('a heading elsewhere on the page also names a section', () => {
      const { html } = scrubSnapshot(
        '<h3>Resume</h3><div><div></div><button aria-label="Edit Resume"></button></div>',
        [],
        [],
      );
      expect(html).toContain('aria-label="Edit Resume"');
    });

    it('a <div> beside the button is an entry, not a section header', () => {
      const { html } = scrubSnapshot(
        '<div><div>Acme Ltd</div><button aria-label="Edit Acme Ltd"></button></div>',
        [],
        [],
      );
      expect(html).toContain('aria-label="Edit xxxx xxx"');
    });
  });

  it('keeps help text named by aria-describedby', () => {
    const { html } = scrubSnapshot(
      '<input aria-describedby="h1 h2"><div id="h1">Use digits only</div>' +
        '<div id="h2"><span>Max ten</span></div><div id="h3">Other text</div>',
      [],
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
      [],
    );
    expect(html).toContain('<option>[secret]</option>');
    expect(counts.secretsReplaced).toBe(1);
  });

  it('replaces a secret inside a kept aria-label, ignoring case', () => {
    const { html } = scrubSnapshot(
      '<button aria-label="Send to Me@Example.com (a+b)">Go</button>' +
        '<div aria-label="Sam Example">x</div>',
      ['me@example.com', '(a+b)'],
      [],
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
      [],
    );
    expect(html).not.toContain('Sam Example');
    expect(html).not.toContain('Secret words');
  });

  it('reaches into shadow roots', () => {
    const { html } = scrubSnapshot(
      '<div><template shadowrootmode="open"><span>Private</span><label>Ask</label></template></div>',
      [],
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
    const { html, counts } = scrubSnapshot(input, secrets, []);
    for (const s of secrets)
      expect(html.toLowerCase()).not.toContain(s.toLowerCase());
    expect(JSON.stringify(counts).toLowerCase()).not.toContain('sam');
    expect(counts.removedElements).toBe(1);
    expect(counts.blankedTexts).toBe(3);
    expect(counts.droppedAttributes).toBe(2);
    expect(counts.secretsReplaced).toBe(1);
  });
});

describe('scrubSnapshot, final review', () => {
  it('catches a phone number in its national form with a leading 0', () => {
    const { html, counts } = scrubSnapshot(
      '<label>Call 07700 900123 or 07700-900-123 or +44 7700 900123</label>',
      ['+44 7700 900123'],
      [],
    );
    expect(html).not.toMatch(/7700|900/);
    expect(counts.secretsReplaced).toBe(3);
  });

  it('replaces any email address in kept text and attributes', () => {
    const { html, counts } = scrubSnapshot(
      '<label>Write to other.person@corp.io today</label>' +
        '<input aria-label="Email a.b+c@mail.d-e.co.uk"><button title="x">Go</button>',
      [],
      [],
    );
    expect(html).not.toContain('@');
    expect(html).toContain('Write to [secret] today');
    expect(html).toContain('aria-label="Email [secret]"');
    expect(counts.secretsReplaced).toBe(2);
  });

  it('needs the name secrets', () => {
    // @ts-expect-error the name secrets are required
    expect(() => scrubSnapshot('<p></p>', [])).not.toThrow();
  });
});

describe('scrubSnapshot, fix round 1', () => {
  const scrub = (h: string, s: string[] = []) => scrubSnapshot(h, s, []);

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

  it('kept text flows into every descendant, such as a resume card', () => {
    const { html } = scrub(
      '<label>Resume <div><h3>CV.pdf</h3><p>Last used on 10/1/2026</p></div></label>',
    );
    expect(html).toContain('Resume');
    expect(html).toContain('<h3>CV.pdf</h3>');
    expect(html).toContain('<p>Last used on 10/1/2026</p>');
  });

  it("keeps LinkedIn's label > div wrapper text", () => {
    const { html } = scrub(
      '<label for="_r_1d_"><div>First name</div></label><input id="_r_1d_">',
    );
    expect(html).toContain('<div>First name</div>');
  });

  it("keeps LinkedIn's helper text named by aria-describedby", () => {
    const { html } = scrub(
      '<input aria-describedby="_r_1d_-info">' +
        '<div data-testid="text-input-helper-text" id="_r_1d_-info"><div>' +
        '<p aria-live="polite"><span aria-hidden="true">First</span>' +
        '<span>0 of 100 characters</span></p></div></div>',
    );
    expect(html).toContain('<span aria-hidden="true">First</span>');
    expect(html).toContain('<span>0 of 100 characters</span>');
  });

  it('still blanks a textarea nested in a kept wrapper', () => {
    const { html } = scrub(
      '<label for="t"><div>Cover letter<textarea id="t">I am Sam</textarea></div></label>',
    );
    expect(html).toContain('Cover letter');
    expect(html).not.toContain('I am Sam');
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
    expect(html).toBe('<label>[secret], [secret], [secret], [secret]</label>');
    expect(counts.secretsReplaced).toBe(4);
    const near = scrub('<label>9447700900123</label>', ['+447700900123']);
    expect(near.html).toContain('9447700900123');
  });
});

describe('fieldset text', () => {
  const radios =
    '<fieldset aria-describedby="error-message-_r_45_" role="radiogroup"><div><div><div><div><input id="_r_47_" aria-label="Do you have a residence permit in Portugal?" type="radio" name="radio-group-_r_45_"><label for="_r_47_"></label></div><div><p>Yes</p></div></div></div><div><div><div><input id="_r_49_" aria-label="Do you have a residence permit in Portugal?" type="radio" name="radio-group-_r_45_"><label for="_r_49_"></label></div><div><p>No</p></div></div></div></div></fieldset>';

  it('keeps option text beside an empty label', () => {
    const { html } = scrubSnapshot(radios, [], []);
    expect(html).toContain('<p>Yes</p>');
    expect(html).toContain('<p>No</p>');
  });

  it('still replaces a name secret inside a fieldset', () => {
    const { html } = scrubSnapshot(
      '<fieldset><p>Sam_Example_CV.pdf</p></fieldset>',
      ['Sam Example'],
      ['Sam Example'],
    );
    expect(html).toBe('<fieldset><p>[secret]_CV.pdf</p></fieldset>');
  });

  it('still blanks a textarea inside a fieldset', () => {
    const { html } = scrubSnapshot(
      '<fieldset><p>Why</p><textarea>my reasons</textarea></fieldset>',
      [],
      [],
    );
    expect(html).toContain('<p>Why</p>');
    expect(html).not.toContain('my reasons');
  });
});

describe('name secrets', () => {
  const names = ['Sam Example', 'Sam', 'Example', 'sam-example'];
  const labels = [
    'Sam_Example_Resume (3).pdf',
    'SamExampleCV.pdf',
    'sam-example-cv.pdf',
    'CV Sam Example.pdf',
  ];

  it('matches names inside words, underscores and run-together forms', () => {
    for (const label of labels) {
      const { html } = scrubSnapshot(
        `<input type="radio" aria-label="${label}">`,
        ['sam-example', 'Sam Example', 'Sam', 'Example'],
        names,
      );
      expect(html, label).toContain('[secret]');
      expect(html.toLowerCase(), label).not.toContain('sam');
      expect(html.toLowerCase(), label).not.toContain('example');
    }
  });

  it('leaves an unrelated resume file name alone', () => {
    const { html } = scrubSnapshot(
      '<input type="radio" aria-label="resume-2026.fs.1.pdf">',
      ['Sam Example', 'resume.pdf'],
      names,
    );
    expect(html).toContain('aria-label="resume-2026.fs.1.pdf"');
  });

  it('treats underscore and dot as boundaries for other secrets', () => {
    const { html } = scrubSnapshot(
      '<label>a_Yes_b Yesterday x.Yes.y</label>',
      ['Yes'],
      [],
    );
    expect(html).toBe('<label>a_[secret]_b Yesterday x.[secret].y</label>');
  });

  it('bankSecrets names include first, last, full name and the slug', () => {
    const bank = loadFactBank(EXAMPLE);
    expect(bankNameSecrets(bank)).toEqual(
      expect.arrayContaining(['Sam', 'Example', 'Sam Example', 'sam-example']),
    );
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

describe('leakCheck', () => {
  const bank = loadFactBank(EXAMPLE);
  const kinds = (html: string) =>
    Object.fromEntries(leakCheck(html, bank).map((l) => [l.kind, l.count]));

  describe('public option lists', () => {
    const SALARY =
      '<label for="s">Expected salary</label><select id="s">' +
      '<option value="">Select an option</option>' +
      '<option value="xx">3000 USD per month</option>' +
      '<option value="xx">5000 USD per month</option></select>';

    it("a bank answer that is a whole option of a public list doesn't count", () => {
      expect(kinds(SALARY)).toEqual({});
      expect(
        kinds(
          '<fieldset><legend>Salary</legend>' +
            '<div><div><input id="a" type="radio" name="g"><label for="a"></label></div><p>5000 USD per month</p></div>' +
            '<div><div><input id="b" type="radio" name="g"><label for="b"></label></div><p>Other</p></div></fieldset>',
        ),
      ).toEqual({});
    });

    it('the same text in free text, or a one-option select, still counts', () => {
      expect(kinds(`${SALARY}<p>I want 5000 USD per month</p>`)).toEqual({
        answer: 1,
      });
      expect(
        kinds('<select><option>5000 USD per month</option></select>'),
      ).toEqual({ answer: 1 });
    });

    it("a name counts even inside a list: the resume radios carry the author's name", () => {
      expect(
        kinds(
          '<fieldset role="radiogroup">' +
            '<div><div><input id="r1" type="radio" name="g" aria-label="x.pdf"><label for="r1"></label></div><div><p>SamExampleCV.pdf</p></div></div>' +
            '<div><div><input id="r2" type="radio" name="g" aria-label="y.pdf"><label for="r2"></label></div><div><p>other.pdf</p></div></div></fieldset>' +
            '<select><option>Sam Example</option><option>Someone Else</option></select>',
        ),
      ).toEqual({ name: 2 });
    });
  });

  it("finds the example bank's phone in +447700900123, 07700 900123, (0)7700-900-123", () => {
    for (const form of [
      '+447700900123',
      '07700 900123',
      '(0)7700-900-123',
      '+44 (0)7700 900123',
      '7700900123',
      '447700900123',
    ]) {
      expect(leakCheck(`<p>Call ${form} now</p>`, bank), form).toEqual([
        { kind: 'phone', count: 1 },
      ]);
    }
    expect(kinds('<p>07700 900123 or +44 7700-900-123</p>')).toEqual({
      phone: 2,
    });
  });

  it('does not count the phone digits inside a long id or a longer number', () => {
    for (const html of [
      '<div data-urn="urn:li:fsd:1234567700900123456">x</div>',
      '<p>9447700900123</p>',
      '<p>77009001234</p>',
      '<p>id 4490324628</p>',
    ]) {
      expect(leakCheck(html, bank), html).toEqual([]);
    }
  });

  it('finds the phone beside an unrelated digit group', () => {
    expect(kinds('<p>ref 123 07700 900123</p>')).toEqual({ phone: 1 });
  });

  it('finds the email in mixed case', () => {
    expect(leakCheck('<p>Write to SAM@Example.COM today</p>', bank)).toEqual([
      { kind: 'email', count: 1 },
    ]);
  });

  it('finds names, on word boundaries for first and last name', () => {
    expect(kinds('<p>Sam Example</p>')).toEqual({ name: 1 });
    expect(kinds('<p>SamExampleCV.pdf</p>')).toEqual({ name: 1 });
    expect(kinds('<p>sam_example and sam</p>')).toEqual({ name: 2 });
    expect(kinds('<p>Samples of examples</p>')).toEqual({});
  });

  it('finds personal links without scheme, www or trailing slash', () => {
    expect(
      kinds(
        '<p>HTTPS://WWW.linkedin.com/in/sam-example/ and github.com/sam-example and sam.example/</p>',
      ),
    ).toEqual({ link: 3 });
  });

  it('finds facts and answers across whitespace, ignoring case', () => {
    expect(kinds('<p>I am a British\n   citizen.</p>')).toEqual({ fact: 1 });
    expect(kinds('<span>5000 usd per month</span>')).toEqual({ answer: 1 });
    expect(kinds('<p>The queue bug that only appeared under load</p>')).toEqual(
      { answer: 1 },
    );
  });

  it('skips short and generic values', () => {
    expect(
      leakCheck('<p>Yes</p><p>No</p><p>5</p><p>[secret]</p>', bank),
    ).toEqual([]);
  });

  it('never returns the matched text', () => {
    const out = JSON.stringify(
      leakCheck('<p>sam@example.com 07700 900123 Sam Example</p>', bank),
    );
    expect(out).not.toMatch(/sam|7700|example/i);
  });

  it('decodes entities and nbsp before looking for a phone', () => {
    for (const form of [
      '07700&#160;900123',
      '07700&nbsp;900123',
      '+44&nbsp;7700&nbsp;900123',
      '07700&#xA0;900123',
      '07700\u00a0900123',
    ]) {
      expect(leakCheck(`<p>Call ${form} now</p>`, bank), form).toEqual([
        { kind: 'phone', count: 1 },
      ]);
    }
  });

  it('decodes entities and percent escapes before looking for an email', () => {
    const other = {
      ...bank,
      fields: { ...bank.fields, email: 'jdoe1985@gmail.com' },
    };
    for (const form of [
      'jdoe1985&#64;gmail.com',
      'jdoe1985&#x40;gmail.com',
      'jdoe1985%40gmail.com',
      'mailto:jdoe1985%40gmail.com',
    ]) {
      expect(leakCheck(`<p>${form}</p>`, other), form).toEqual([
        { kind: 'email', count: 1 },
      ]);
    }
  });

  it('finds a fact holding &amp; or nbsp', () => {
    const fact = bank.facts[0];
    if (!fact) throw new Error('example bank has no facts');
    const other = {
      ...bank,
      facts: [{ ...fact, text: 'I worked at Smith & Jones for years.' }],
    };
    expect(
      leakCheck('<p>I worked at Smith &amp; Jones&nbsp;for years.</p>', other),
    ).toEqual([{ kind: 'fact', count: 1 }]);
  });

  it('survives a malformed percent sequence', () => {
    expect(() =>
      leakCheck('<p>100% %E0%A4%A sure %ZZ</p>', bank),
    ).not.toThrow();
    expect(leakCheck('<p>100% %E0%A4%A sure 07700%20900123</p>', bank)).toEqual(
      [{ kind: 'phone', count: 1 }],
    );
  });

  it('returns [] on every committed fixture', () => {
    const dir = join(import.meta.dirname, '..', 'apply', 'fixtures');
    const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(leakCheck(readFileSync(join(dir, f), 'utf8'), bank), f).toEqual(
        [],
      );
    }
  });
});

describe('scrubSnapshot, phone forms', () => {
  const bank = loadFactBank(EXAMPLE);

  it('scrubSnapshot removes +447700900123', () => {
    for (const form of [
      '+447700900123',
      '07700 900123',
      '(0)7700-900-123',
      '+44 (0)7700 900123',
      '(+44) 7700-900-123',
      '0044 7700 900123',
    ]) {
      const { html } = scrubSnapshot(
        `<label>Call ${form} now</label>`,
        bankSecrets(bank),
        bankNameSecrets(bank),
      );
      expect(html, form).toBe('<label>Call [secret] now</label>');
      expect(leakCheck(html, bank), form).toEqual([]);
    }
  });
});
