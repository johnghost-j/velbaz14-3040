import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { resolveBlueprintDynamic, __resetCatalogCacheForTests } from './printify-auto';
import * as printify from './printify';

// Bug réel 2026-10-03 : « ajoute un mug avec un loup » → blueprint 891
// « Stein Mug » (chope à bière), tiré au sort parmi les ex-aequo « mug ».
describe('mug ≠ chope à bière', () => {
  const cfg = { apiToken: 'fake-token', shopId: '1' };
  const ok = (data: any) => ({ ok: true, status: 200, message: undefined, error: undefined, data } as any);

  beforeEach(() => {
    __resetCatalogCacheForTests();
    spyOn(printify, 'listBlueprints').mockResolvedValue(ok([
      { id: 891, title: 'Stein Mug' },
      { id: 892, title: 'Beer Mug' },
      { id: 68, title: 'Mug 11oz' },
    ]));
    spyOn(printify, 'getBlueprintProviders').mockResolvedValue(ok([{ id: 1 }]));
    spyOn(printify, 'getBlueprintVariants').mockResolvedValue(ok({ variants: [{ id: 1 }] }));
  });
  afterEach(() => __resetCatalogCacheForTests());

  it('un mug demandé n’est jamais une chope', async () => {
    for (let i = 0; i < 15; i++) {
      __resetCatalogCacheForTests();
      expect(await resolveBlueprintDynamic(cfg, 'Mug PasStride — Loup minimaliste mug', 'mug')).toBe(68);
    }
  });

  it('une chope demandée explicitement reste possible', async () => {
    expect(await resolveBlueprintDynamic(cfg, 'stein mug bavarois', 'mug')).toBe(891);
  });
});
