// Polyfill for TextEncoder/TextDecoder which are not available in JSDOM
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock next-auth/react module globally for Jest
jest.mock('next-auth/react', () => {
  return {
    useSession: jest.fn(() => ({
      data: {
        user: { name: 'Test User', email: 'test@example.com', id: 'test-user-id' },
        accessToken: 'test-token',
        expires: '1',
      },
      status: 'authenticated',
    })),
    signIn: jest.fn(),
    signOut: jest.fn(),
    SessionProvider: ({ children }) => children,
  };
});

// Polyfill for react-dom/server in JSDOM environment.
// This is required because react-dom/server expects a full browser environment,
// which includes MessageChannel. JSDOM does not provide it.
if (typeof global.MessageChannel === 'undefined') {
  const { MessageChannel } = require('node:worker_threads');
  global.MessageChannel = MessageChannel;
}

// Increase default timeout to 30s to prevent timeouts on slower machines/CI
jest.setTimeout(30000);

require('@testing-library/jest-dom');

const { getComputedStyle } = window;
window.getComputedStyle = (elt) => getComputedStyle(elt);
window.HTMLElement.prototype.scrollIntoView = () => {};

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

// The instance settings come from a public API call; tests see everything switched on
jest.mock('./app/hooks/useInstanceConfig', () => {
  const ALL_FEATURES = { goals: true, poster: true, voice: true, gmail: true };
  return {
    ALL_FEATURES,
    useInstanceConfig: jest.fn(() => ({ config: null, features: ALL_FEATURES, isLoading: false })),
  };
});

jest.mock('marked', () => ({
  marked: {
    parse: jest.fn((str) => str),
    setOptions: jest.fn(),
  },
}));
