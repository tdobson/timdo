import { execFileSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('CLI recorded events', () => {
  it('passes focused finite, follow and checkpoint scenarios', () => {
    const scriptPath = path.resolve(__dirname, '../../../tests/cliEvents.test.sh');
    const result = execFileSync('bash', [scriptPath], {
      encoding: 'utf-8',
      env: { ...process.env, TIMDO_CONFIG: '/dev/null' },
    });
    expect(result).toContain('ALL CLI EVENTS TESTS PASSED!');
  }, 120_000);
});
