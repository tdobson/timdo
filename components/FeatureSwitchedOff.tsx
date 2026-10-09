'use client';

import React from 'react';
import { IconInfoCircle } from '@tabler/icons-react';
import { Alert, Container } from '@mantine/core';

/** Shown in place of a page whose feature this instance has switched off. */
export function FeatureSwitchedOff({ what }: { what: string }) {
  return (
    <Container size="sm" py="xl">
      <Alert
        icon={<IconInfoCircle size="1rem" />}
        title={`${what} are switched off on this instance`}
        color="gray"
        variant="light"
      >
        Whoever runs this TimDo has turned this part off. Everything else works as usual.
      </Alert>
    </Container>
  );
}
