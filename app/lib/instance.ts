/**
 * What this instance calls itself and who runs it. Everything here comes from NEXT_PUBLIC_*
 * variables set at build time, with the original timdo.tdobson.net values as the defaults,
 * so a deployment that sets nothing looks exactly as before.
 *
 *   NEXT_PUBLIC_APP_NAME           short product name shown in the header and titles
 *   NEXT_PUBLIC_SITE_TITLE         the browser tab title
 *   NEXT_PUBLIC_SITE_DESCRIPTION   the meta description
 *   NEXT_PUBLIC_CONTACT_EMAIL      the Contact link in the footer
 *   NEXT_PUBLIC_REPO_URL           where the CLI setup page tells people to clone from
 *   NEXT_PUBLIC_CREATOR_NAME       the "Made by" card on the landing page; set it to "" to hide the card
 *   NEXT_PUBLIC_CREATOR_BIO        the paragraph under the name
 *   NEXT_PUBLIC_CREATOR_TAGLINE    the small line under the paragraph
 *   NEXT_PUBLIC_CREATOR_LINKS      "Label|https://..." pairs separated by commas
 *   NEXT_PUBLIC_COPYRIGHT          the footer line, e.g. "© 2025 Tim Dobson"
 */

export interface CreatorLink {
  label: string;
  href: string;
}

export interface Creator {
  name: string;
  bio: string;
  tagline: string;
  links: CreatorLink[];
}

export interface InstanceConfig {
  appName: string;
  siteTitle: string;
  siteDescription: string;
  contactEmail: string;
  repoUrl: string;
  copyright: string;
  /** null when the instance chose not to show a creator card */
  creator: Creator | null;
}

const DEFAULT_CREATOR: Creator = {
  name: 'Tim Dobson',
  bio: 'Full-stack developer and technology leader who got tired of complicated tools getting in the way of getting things done. Built TimDo to solve his own problem: a simple, visual way to manage life without the bloat.',
  tagline: 'Technology Leader & Community Builder',
  links: [
    { label: 'LinkedIn', href: 'https://linkedin.com/in/tdobson' },
    { label: 'GitHub', href: 'https://github.com/tdobson' },
    { label: 'Website', href: 'https://tdobson.net' },
  ],
};

function parseLinks(value: string | undefined, fallback: CreatorLink[]): CreatorLink[] {
  if (value === undefined) {
    return fallback;
  }
  return value
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [label, ...rest] = pair.split('|');
      return { label: label.trim(), href: rest.join('|').trim() };
    })
    .filter((link) => link.label && link.href);
}

/** Build the config from an environment, so tests can pass their own. */
export function readInstanceConfig(env: Record<string, string | undefined>): InstanceConfig {
  const creatorName = env.NEXT_PUBLIC_CREATOR_NAME;
  const creator: Creator | null =
    creatorName === ''
      ? null
      : {
          name: creatorName ?? DEFAULT_CREATOR.name,
          bio: env.NEXT_PUBLIC_CREATOR_BIO ?? DEFAULT_CREATOR.bio,
          tagline: env.NEXT_PUBLIC_CREATOR_TAGLINE ?? DEFAULT_CREATOR.tagline,
          links: parseLinks(env.NEXT_PUBLIC_CREATOR_LINKS, DEFAULT_CREATOR.links),
        };

  return {
    appName: env.NEXT_PUBLIC_APP_NAME || 'TimDo',
    siteTitle: env.NEXT_PUBLIC_SITE_TITLE || "TimDo - Tim's Projects",
    siteDescription:
      env.NEXT_PUBLIC_SITE_DESCRIPTION ||
      "A dynamic display of Tim's projects, inspired by the SVG project poster.",
    contactEmail: env.NEXT_PUBLIC_CONTACT_EMAIL || 'tim@example.com',
    repoUrl: env.NEXT_PUBLIC_REPO_URL || 'https://github.com/tdobson/timdo',
    copyright: env.NEXT_PUBLIC_COPYRIGHT || '© 2025 Tim Dobson',
    creator,
  };
}

// Next.js inlines NEXT_PUBLIC_* only when each is read as a literal property, so list them.
export const INSTANCE: InstanceConfig = readInstanceConfig({
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_SITE_TITLE: process.env.NEXT_PUBLIC_SITE_TITLE,
  NEXT_PUBLIC_SITE_DESCRIPTION: process.env.NEXT_PUBLIC_SITE_DESCRIPTION,
  NEXT_PUBLIC_CONTACT_EMAIL: process.env.NEXT_PUBLIC_CONTACT_EMAIL,
  NEXT_PUBLIC_REPO_URL: process.env.NEXT_PUBLIC_REPO_URL,
  NEXT_PUBLIC_CREATOR_NAME: process.env.NEXT_PUBLIC_CREATOR_NAME,
  NEXT_PUBLIC_CREATOR_BIO: process.env.NEXT_PUBLIC_CREATOR_BIO,
  NEXT_PUBLIC_CREATOR_TAGLINE: process.env.NEXT_PUBLIC_CREATOR_TAGLINE,
  NEXT_PUBLIC_CREATOR_LINKS: process.env.NEXT_PUBLIC_CREATOR_LINKS,
  NEXT_PUBLIC_COPYRIGHT: process.env.NEXT_PUBLIC_COPYRIGHT,
});
