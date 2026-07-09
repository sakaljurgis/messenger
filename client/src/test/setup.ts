import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Default 1s async-query timeout can lose races when all suite files run on
// saturated workers; 5s keeps queries deterministic under CPU contention.
configure({ asyncUtilTimeout: 5000 });

// jsdom implements neither of these; the chat view calls them for auto-scroll.
Element.prototype.scrollIntoView = function scrollIntoView() {};
Element.prototype.scrollTo = function scrollTo() {} as typeof Element.prototype.scrollTo;

// jsdom has no object-URL support; the composer creates/revokes them for image
// previews. Deterministic stubs keep those flows working in tests.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:mock';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}

afterEach(() => {
  cleanup();
});
