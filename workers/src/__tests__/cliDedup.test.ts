import { execFileSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';

// tests/cliDedup.test.sh runs bin/timdo against a stateful Python mock of the v2 API and checks
// the requests it sends and what it prints: --on-duplicate error|return|report on add, the
// similar-task question on a terminal (forced with TIMDO_FORCE_TTY=1), the stderr hints for
// scripts, and `timdo similar`.
describe('CLI no duplicates on create', () => {
  it('passes all CLI dedup scenarios', () => {
    const scriptPath = path.resolve(__dirname, '../../../tests/cliDedup.test.sh');
    const env: NodeJS.ProcessEnv = { ...process.env, TIMDO_CONFIG: '/dev/null' };
    delete env.TIMDO_FORCE_TTY;
    const result = execFileSync('bash', [scriptPath], { encoding: 'utf-8', env });
    expect(result).toContain('ALL CLI DEDUP TESTS PASSED!');
  }, 180_000);
});
