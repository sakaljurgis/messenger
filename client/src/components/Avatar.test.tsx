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

describe('Avatar color', () => {
  it('derives a color from the id when no color prop is given', () => {
    const { container: c1 } = render(<Avatar name="Bob" id={2} />);
    const { container: c2 } = render(<Avatar name="Bob" id={99} />);
    const bg1 = (c1.firstChild as HTMLElement).style.backgroundColor;
    const bg2 = (c2.firstChild as HTMLElement).style.backgroundColor;
    expect(bg1).not.toBe('');
    // Different ids derive different colors — proves it's id-based, not fixed.
    expect(bg1).not.toBe(bg2);
  });

  it('falls back to the id-derived color when color is null (no visual change)', () => {
    const { container: withNull } = render(<Avatar name="Bob" id={2} color={null} />);
    const { container: withoutProp } = render(<Avatar name="Bob" id={2} />);
    expect((withNull.firstChild as HTMLElement).style.backgroundColor).toBe(
      (withoutProp.firstChild as HTMLElement).style.backgroundColor,
    );
  });

  it('uses the provided color when set, overriding the derived color', () => {
    const { container } = render(<Avatar name="Bob" id={2} color="#ff8800" />);
    const circle = container.firstChild as HTMLElement;
    expect(circle.style.backgroundColor).toBe('rgb(255, 136, 0)');
  });

  it('renders 2+ colors as an equal-slice conic-gradient pie', () => {
    const { container } = render(<Avatar name="Team" id={9} colors={['#ff0000', '#00ff00', '#0000ff']} />);
    const circle = container.firstChild as HTMLElement;
    // jsdom serializes the hex stops back as rgb().
    expect(circle.style.backgroundImage).toBe(
      'conic-gradient(rgb(255, 0, 0) 0deg 120deg, rgb(0, 255, 0) 120deg 240deg, rgb(0, 0, 255) 240deg 360deg)',
    );
    expect(circle.style.backgroundColor).toBe('');
  });

  it('ignores a colors array with fewer than 2 entries (falls back to color/derived)', () => {
    const single = render(<Avatar name="Team" id={9} colors={['#ff0000']} />);
    const derived = render(<Avatar name="Team" id={9} />);
    const singleEl = single.container.firstChild as HTMLElement;
    expect(singleEl.style.backgroundImage).toBe('');
    expect(singleEl.style.backgroundColor).toBe(
      (derived.container.firstChild as HTMLElement).style.backgroundColor,
    );
  });
});
