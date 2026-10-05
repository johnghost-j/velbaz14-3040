import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PREVIEW_BACKDROP, previewHeight } from './image-preview';

describe('aperçu image au survol', () => {
  it('suit la proportion réelle de l’image', () => {
    expect(previewHeight(240, 517, 451, 160)).toBe(209); // logo réel 517×451
    expect(previewHeight(240, 1200, 800, 160)).toBe(160);
  });
  it('borne la hauteur et retombe sur la valeur par défaut sans dimensions', () => {
    expect(previewHeight(240, 2000, 200, 160)).toBe(100);
    expect(previewHeight(240, 200, 2000, 160)).toBe(300);
    expect(previewHeight(240, 0, 0, 160)).toBe(160);
  });
  it('affiche l’image en entier sur un fond opaque', () => {
    expect(PREVIEW_BACKDROP).toBe('#FFFFFF');
    const src = readFileSync(new URL('../components/ImagePreview.tsx', import.meta.url), 'utf8');
    expect(src).toContain("objectFit: 'contain'");
    expect(src).toContain('background: PREVIEW_BACKDROP');
    expect(src).not.toContain("objectFit: 'cover'");
  });
});
