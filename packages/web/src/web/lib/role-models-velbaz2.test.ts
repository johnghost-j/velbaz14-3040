import { describe, it, expect } from 'bun:test';
import {
  roleModel, marketingModel, MARKETING_MODEL,
  VELBAZ2_MODE, VELBAZ2_TEXT_LABEL, VELBAZ2_IMAGE_LABEL,
} from './role-models';
import { VELBAZ2_TEXT_MODEL, VELBAZ2_IMAGE_MODEL } from '../../api/agent/model-mode';

// [2026-10-03] En Velbaz 2.0 le front annonçait claude-sonnet-4.6 sous chaque
// étape engineering alors que le serveur écrivait le code avec GPT 6 Luna.
describe('étiquettes du mode Velbaz 2.0', () => {
  it('recopie exactement les modèles du serveur', () => {
    expect(VELBAZ2_TEXT_MODEL.endsWith(VELBAZ2_TEXT_LABEL)).toBe(true);
    expect(VELBAZ2_IMAGE_MODEL.endsWith(VELBAZ2_IMAGE_LABEL)).toBe(true);
  });

  it("n'annonce plus jamais sonnet-4.6 pour une étape du mode", () => {
    for (const r of ['engineering', 'engineer', 'marketing', 'support', 'supply_chain']) {
      expect(roleModel(r, VELBAZ2_MODE)).toBe('gpt-6-luna');
    }
    expect(roleModel('design', VELBAZ2_MODE)).toBe('gemini-3.1-flash-image');
    expect(marketingModel(VELBAZ2_MODE)).toBe(VELBAZ2_TEXT_MODEL);
  });

  it('garde les étiquettes normales hors mode (lignes anciennes incluses)', () => {
    for (const mode of [undefined, null, 'normal']) {
      expect(roleModel('engineering', mode)).toBe('claude-sonnet-4.6');
      expect(roleModel('support', mode)).toBe('gpt-5.4-mini');
      expect(marketingModel(mode)).toBe(MARKETING_MODEL);
    }
  });
});
