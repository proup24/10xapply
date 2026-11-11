import { redact } from './redact.js';

describe('redact', () => {
  it('hides a token query value', () => {
    const m = 'connect failed: ws://127.0.0.1:9333/cdp?token=abc123&x=1';
    expect(redact(m)).toBe(
      'connect failed: ws://127.0.0.1:9333/cdp?token=<redacted>&x=1',
    );
  });
  it('hides a known token anywhere', () => {
    expect(redact('bad secret-xyz here', 'secret-xyz')).toBe(
      'bad <redacted> here',
    );
  });
  it('leaves other messages alone', () => {
    expect(redact('plain')).toBe('plain');
  });
});
