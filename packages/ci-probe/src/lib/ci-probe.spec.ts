import { ciProbe } from './ci-probe.js';

describe('ciProbe', () => {
  it('should work', () => {
    expect(ciProbe()).toEqual('ci-probe');
  });
});
