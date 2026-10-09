import { readInstanceConfig } from './instance';

describe('readInstanceConfig', () => {
  it('keeps the original instance when nothing is set', () => {
    const config = readInstanceConfig({});
    expect(config.appName).toBe('TimDo');
    expect(config.repoUrl).toBe('https://github.com/tdobson/timdo');
    expect(config.creator?.name).toBe('Tim Dobson');
    expect(config.creator?.links.map((l) => l.label)).toEqual(['LinkedIn', 'GitHub', 'Website']);
  });

  it('lets another instance name itself and hide the creator card', () => {
    const config = readInstanceConfig({
      NEXT_PUBLIC_APP_NAME: 'Freegle Tasks',
      NEXT_PUBLIC_SITE_TITLE: 'Freegle Tasks',
      NEXT_PUBLIC_CONTACT_EMAIL: 'geeks@example.org',
      NEXT_PUBLIC_REPO_URL: 'https://github.com/example/timdo',
      NEXT_PUBLIC_COPYRIGHT: '© 2026 Example',
      NEXT_PUBLIC_CREATOR_NAME: '',
    });
    expect(config.appName).toBe('Freegle Tasks');
    expect(config.contactEmail).toBe('geeks@example.org');
    expect(config.creator).toBeNull();
  });

  it('parses creator links as label|url pairs', () => {
    const config = readInstanceConfig({
      NEXT_PUBLIC_CREATOR_NAME: 'Robin Fairweather',
      NEXT_PUBLIC_CREATOR_LINKS:
        'Site|https://robin.example, Code|https://git.example/robin, broken',
    });
    expect(config.creator?.links).toEqual([
      { label: 'Site', href: 'https://robin.example' },
      { label: 'Code', href: 'https://git.example/robin' },
    ]);
  });
});
