import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom implements neither of these; the chat view calls them for auto-scroll.
Element.prototype.scrollIntoView = function scrollIntoView() {};
Element.prototype.scrollTo = function scrollTo() {} as typeof Element.prototype.scrollTo;

afterEach(() => {
  cleanup();
});
