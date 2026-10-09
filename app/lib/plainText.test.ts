import { markdownToPlainText } from './plainText';

describe('markdownToPlainText', () => {
  it('turns a GitHub issue body into one readable line', () => {
    const body =
      '## Background\n\nWe recently discovered a bug where the `@capacitor/screen-orientation` plugin was installed but **not bundled** into the app.\n\n- it was not listed in `includePlugins`\n- see [the docs](https://example.org/docs)';
    expect(markdownToPlainText(body)).toBe(
      'Background We recently discovered a bug where the @capacitor/screen-orientation plugin was installed but not bundled into the app. it was not listed in includePlugins see the docs'
    );
  });

  it('keeps code from a fence, drops images, and copes with nothing', () => {
    expect(markdownToPlainText('Run:\n```bash\nnpm test\n```\n![shot](a.png) > quoted _it_')).toBe(
      'Run: npm test quoted it'
    );
    expect(markdownToPlainText('')).toBe('');
    expect(markdownToPlainText(null)).toBe('');
  });

  it('leaves plain text alone', () => {
    expect(markdownToPlainText('Leaking in rain, 3 * 2 = 6')).toBe('Leaking in rain, 3 * 2 = 6');
  });
});
