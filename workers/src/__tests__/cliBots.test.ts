import { execFileSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('CLI bot management', () => {
  it('passes isolated CLI bot-management scenarios against a fictional API', () => {
    const scriptPath = path.resolve(__dirname, '../../../tests/cliBots.test.sh');
    const result = execFileSync('bash', [scriptPath], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent' },
      timeout: 120_000,
    });
    expect(result).toContain('ALL CLI BOT TESTS PASSED!');
  }, 120_000);
});
