import React from 'react';
import { screen } from '@testing-library/react';
import { render } from '../../test-utils/render';
import { VoiceCommandGuide } from './VoiceCommandGuide';

describe('VoiceCommandGuide', () => {
  it('shows fictional examples while recording', () => {
    render(
      <VoiceCommandGuide opened onClose={jest.fn()} isRecording onStopRecording={jest.fn()} />
    );

    expect(
      screen.getByText(
        'Try “Add a Northstar Workshop task for Casey Example to check the inverter datasheet” or “Assign the Acme Solar onboarding task to me”.'
      )
    ).toBeInTheDocument();
  });
});
