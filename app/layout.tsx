import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';

import { Notifications } from '@mantine/notifications';

import './print.css'; // Import global print styles

import React from 'react';
import { ColorSchemeScript, mantineHtmlProps, MantineProvider } from '@mantine/core';
import { AppLayout } from '../components/AppLayout/AppLayout';
import { Providers } from '../components/Providers';
import { theme } from '../theme';
import { INSTANCE } from './lib/instance';

export const metadata = {
  title: INSTANCE.siteTitle,
  description: INSTANCE.siteDescription,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript />
        <link rel="shortcut icon" href="/favicon.svg" />
        <meta
          name="viewport"
          content="minimum-scale=1, initial-scale=1, width=device-width, user-scalable=no"
        />
      </head>
      <body>
        <MantineProvider theme={theme}>
          <Notifications />
          <Providers>
            <AppLayout>{children}</AppLayout>
          </Providers>
        </MantineProvider>
      </body>
    </html>
  );
}
