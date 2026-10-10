import { execFileSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';

// tests/cliRefs.test.sh runs bin/timdo against a Python mock of the v2 refs API and checks the
// requests it sends and what it prints: --ref/--source/--reported-by/--about on add and update,
// --unref, ref list|add|rm, find, list --ref, the Links block in get, and the 409 message.
describe('CLI task refs', () => {
  it('passes all CLI refs scenarios', () => {
    const scriptPath = path.resolve(__dirname, '../../../tests/cliRefs.test.sh');
    const result = execFileSync('bash', [scriptPath], {
      encoding: 'utf-8',
      env: { ...process.env, TIMDO_CONFIG: '/dev/null' },
    });
    expect(result).toContain('ALL CLI REFS TESTS PASSED!');
  }, 120_000);
});
