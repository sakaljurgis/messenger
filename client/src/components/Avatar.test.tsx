import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import Avatar from './Avatar';

describe('Avatar presence dot', () => {
  it('renders a green online dot when online', () => {
    const { getByTestId } = render(<Avatar name="Bob" id={2} online />);
    const dot = getByTestId('presence-dot');
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain('bg-green-500');
    expect(dot.className).toContain('rounded-full');
  });

  it('renders no dot when offline (default)', () => {
    const { queryByTestId } = render(<Avatar name="Bob" id={2} />);
    expect(queryByTestId('presence-dot')).toBeNull();
  });

  it('scales the dot with the avatar size', () => {
    const { getByTestId, rerender } = render(<Avatar name="Bob" id={2} size="xs" online />);
    expect(getByTestId('presence-dot').className).toContain('h-1.5');
    rerender(<Avatar name="Bob" id={2} size="lg" online />);
    expect(getByTestId('presence-dot').className).toContain('h-3.5');
  });
});
