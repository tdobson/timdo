import React from 'react';
import { screen } from '@testing-library/react';
import { render } from '../../test-utils/render';
import { VoiceCommandIntro } from './VoiceCommandIntro';

describe('VoiceCommandIntro', () => {
  beforeEach(() => {
    localStorage.removeItem('voice-command-intro-shown-v2');
  });

  it('shows fictional examples for shared-workspace commands', async () => {
    render(<VoiceCommandIntro />);

    expect(
      await screen.findByText(
        /Add a Northstar Workshop task for Casey Example to check the inverter datasheet/
      )
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '“Move Fix inverter alarm to done”',
      '“Set the priority of Renew passport to 8”',
      '“Snooze the Acme Solar report until next Monday”',
      '“Add a Northstar Workshop task for Casey Example to check the inverter datasheet”',
      '“Assign the Acme Solar onboarding task to me”',
      "“What's Casey Example working on?”",
    ]);
  });
});
