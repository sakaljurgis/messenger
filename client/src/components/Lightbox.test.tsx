import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AttachmentDTO } from '@messenger/shared';
import Lightbox from './Lightbox';

function photo(id: number, name: string): AttachmentDTO {
  return {
    id,
    kind: 'image',
    originalName: name,
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    width: 800,
    height: 600,
    hasThumb: true,
  };
}

describe('Lightbox slide track', () => {
  it('lays prev/current/next out in non-overlapping full-width slots', () => {
    const images = [1, 2, 3, 4, 5].map((n) => photo(n, `p${n}.jpg`));
    render(
      <Lightbox
        attachment={images[2]!}
        images={images}
        onNavigate={() => {}}
        onClose={() => {}}
      />,
    );

    // The track holds exactly the 3-slot window, not the whole gallery.
    expect(screen.getAllByRole('img')).toHaveLength(3);

    const slotOf = (alt: string) => screen.getByAltText(alt).parentElement!;
    expect(slotOf('p2.jpg').style.left).toBe('-100%');
    expect(slotOf('p3.jpg').style.left).toBe('0%');
    expect(slotOf('p4.jpg').style.left).toBe('100%');

    // jsdom does no layout, so guard the geometry structurally: a slot must set
    // an explicit width and must not pin right:0 (inset-0). With `left`
    // overridden per slot, a pinned right edge makes the prev slot 200% wide —
    // its centered photo bleeding over the current one — and the next slot 0.
    for (const n of [2, 3, 4]) {
      const slot = slotOf(`p${n}.jpg`);
      expect(slot.className).toContain('w-full');
      expect(slot.className).not.toMatch(/(?:^|\s)inset-0(?:\s|$)/);
    }
  });
});
