import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { resolveBlueprint, resolveBlueprintDynamic, __resetCatalogCacheForTests, DEFAULT_BLUEPRINTS } from './printify-auto';
import * as printify from './printify';

// Ces tests verrouillent le point exact du bug signalé : un produit non
// imprimable ne doit PLUS être silencieusement remplacé par un t-shirt.
describe('resolveBlueprint', () => {
  it('résout les vrais produits Printify', () => {
    expect(resolveBlueprint('Classic Tee')).toBe(DEFAULT_BLUEPRINTS.tshirt);
    expect(resolveBlueprint('Heavy Hoodie')).toBe(DEFAULT_BLUEPRINTS.hoodie);
    expect(resolveBlueprint('Mug céramique')).toBe(DEFAULT_BLUEPRINTS.mug);
    expect(resolveBlueprint('Affiche A2')).toBe(DEFAULT_BLUEPRINTS.poster);
    expect(resolveBlueprint('Tote bag écru')).toBe(DEFAULT_BLUEPRINTS.totebag);
    expect(resolveBlueprint('Stickers pack')).toBe(DEFAULT_BLUEPRINTS.sticker);
    expect(resolveBlueprint('Coque iPhone')).toBe(DEFAULT_BLUEPRINTS.phonecase);
  });

  it('renvoie null pour un produit qui n’existe pas chez Printify', () => {
    for (const text of [
      'Berline électrique GT',
      'SUV hybride 2027',
      'Canapé 3 places',
      'Smartphone 5G',
      'Montre automatique',
      'Parfum boisé 50ml',
      '',
    ]) {
      expect(resolveBlueprint(text)).toBeNull();
    }
  });

  it('ne retombe jamais sur le t-shirt (bug « marque de voiture → pull »)', () => {
    expect(resolveBlueprint('voiture de sport')).not.toBe(DEFAULT_BLUEPRINTS.tshirt);
    expect(resolveBlueprint('voiture de sport')).toBeNull();
  });
});

// Ces tests verrouillent le point exact de la demande de Johne : au lieu de
// dépendre d'une table figée (qu'il faut étendre à la main pour chaque
// nouveau type de produit — t-shirt → hoodie → chaussure...), la résolution
// doit chercher EN DIRECT dans le catalogue Printify (catalog/blueprints.json)
// si le produit demandé existe réellement, même s'il n'a jamais été mappé.
describe('resolveBlueprintDynamic', () => {
  const cfg = { apiToken: 'fake-token', shopId: '1' };

  beforeEach(() => __resetCatalogCacheForTests());
  afterEach(() => __resetCatalogCacheForTests());

  it('trouve un produit qui n’est PAS dans la table figée, via le catalogue live', async () => {
    // « casquette de baseball » n'est mappé nulle part dans BLUEPRINT_BY_POD_TYPE
    // sous ce libellé précis — seul le catalogue live doit permettre de le trouver.
    spyOn(printify, 'listBlueprints').mockResolvedValue({
      ok: true, status: 200, message: undefined, error: undefined,
      data: [
        { id: 999, title: 'Baseball Cap' },
        { id: 6, title: 'Unisex Jersey Short Sleeve Tee' },
      ] as any,
    } as any);
    spyOn(printify, 'getBlueprintProviders').mockResolvedValue({
      ok: true, status: 200, message: undefined, error: undefined,
      data: [{ id: 1 }] as any,
    } as any);
    spyOn(printify, 'getBlueprintVariants').mockResolvedValue({
      ok: true, status: 200, message: undefined, error: undefined,
      data: { variants: [{ id: 1 }] } as any,
    } as any);

    const id = await resolveBlueprintDynamic(cfg, 'casquette de baseball brodée');
    expect(id).toBe(999);
  });

  it('n’utilise jamais un blueprint dont le catalogue live ne confirme pas la disponibilité', async () => {
    spyOn(printify, 'listBlueprints').mockResolvedValue({
      ok: true, status: 200, message: undefined, error: undefined,
      data: [{ id: 42, title: 'Discontinued Widget' }] as any,
    } as any);
    // Aucun provider disponible → blueprint non fabricable, doit être rejeté.
    spyOn(printify, 'getBlueprintProviders').mockResolvedValue({
      ok: true, status: 200, message: undefined, error: undefined, data: [] as any,
    } as any);

    const id = await resolveBlueprintDynamic(cfg, 'widget discontinued');
    expect(id).toBeNull();
  });

  it('se replie sur la table statique si le catalogue live est inaccessible', async () => {
    spyOn(printify, 'listBlueprints').mockResolvedValue({
      ok: false, status: 500, message: 'panne', error: undefined, data: null,
    } as any);
    spyOn(printify, 'getBlueprintProviders').mockResolvedValue({
      ok: true, status: 200, message: undefined, error: undefined, data: [{ id: 1 }] as any,
    } as any);
    spyOn(printify, 'getBlueprintVariants').mockResolvedValue({
      ok: true, status: 200, message: undefined, error: undefined,
      data: { variants: [{ id: 1 }] } as any,
    } as any);

    const id = await resolveBlueprintDynamic(cfg, 'Classic Tee');
    expect(id).toBe(DEFAULT_BLUEPRINTS.tshirt);
  });

  // [2026-09-25] Bug signalé : la fiche « Urban Pulse Low » (une basket)
  // s'affichait en CHAUSSONS/mules blanches. Toutes les chaussures partageaient
  // un seul sac de synonymes, donc « Women's Slippers » et « Men's Sneakers »
  // marquaient le même score et le tirage au sort des ex-aequo sortait un
  // chausson une fois sur deux. Ces tests verrouillent la séparation par style.
  describe('style de chaussure', () => {
    const FOOTWEAR_CATALOG = [
      { id: 101, title: "Men's Sneakers" },
      { id: 102, title: "Women's Sneakers" },
      { id: 103, title: 'Unisex Low Top Canvas Shoes' },
      { id: 104, title: 'Unisex High Top Canvas Shoes' },
      { id: 201, title: "Women's Slippers" },
      { id: 202, title: 'Cozy Slippers' },
      { id: 301, title: 'Slide Sandals' },
      { id: 302, title: 'Flip Flops' },
      { id: 401, title: "Women's Boots" },
      { id: 6, title: 'Unisex Jersey Short Sleeve Tee' },
    ];
    const SNEAKER_IDS = [101, 102, 103, 104];

    const mockCatalog = () => {
      spyOn(printify, 'listBlueprints').mockResolvedValue({
        ok: true, status: 200, message: undefined, error: undefined,
        data: FOOTWEAR_CATALOG as any,
      } as any);
      spyOn(printify, 'getBlueprintProviders').mockResolvedValue({
        ok: true, status: 200, message: undefined, error: undefined, data: [{ id: 1 }] as any,
      } as any);
      spyOn(printify, 'getBlueprintVariants').mockResolvedValue({
        ok: true, status: 200, message: undefined, error: undefined,
        data: { variants: [{ id: 1 }] } as any,
      } as any);
    };

    it('ne sort JAMAIS de chaussons pour une basket, même sur 40 tirages', async () => {
      mockCatalog();
      for (let i = 0; i < 40; i++) {
        __resetCatalogCacheForTests();
        const id = await resolveBlueprintDynamic(cfg, 'Urban Pulse Low shoe');
        expect(SNEAKER_IDS).toContain(id!);
      }
    });

    it('garde de la variété entre modèles de baskets', async () => {
      mockCatalog();
      const seen = new Set<number>();
      for (let i = 0; i < 60; i++) {
        __resetCatalogCacheForTests();
        seen.add((await resolveBlueprintDynamic(cfg, 'Metro Flex shoe'))!);
      }
      for (const id of seen) expect(SNEAKER_IDS).toContain(id);
      expect(seen.size).toBeGreaterThan(1);
    });

    it('privilégie la coupe nommée dans le produit (low top / high top)', async () => {
      mockCatalog();
      __resetCatalogCacheForTests();
      expect(await resolveBlueprintDynamic(cfg, 'Urban Pulse Low Top shoe', 'shoe')).toBe(103);
      __resetCatalogCacheForTests();
      expect(await resolveBlueprintDynamic(cfg, 'Summit High Top shoe', 'shoe')).toBe(104);
    });

    // [2026-09-25] Le nom du produit est inventé par l'IA : « High Top »
    // matchait le synonyme t-shirt « top », « Canvas » le synonyme poster
    // « canvas ». Le type décidé en amont (pod-guard) doit gagner.
    it('ne laisse pas le nom du produit voler le type de produit', async () => {
      mockCatalog();
      for (const name of ['Summit High Top', 'Canvas Kicks', 'Court Print', 'Atlas Tank Top']) {
        __resetCatalogCacheForTests();
        const id = await resolveBlueprintDynamic(cfg, `${name} shoe`, 'shoe');
        expect(SNEAKER_IDS).toContain(id!);
      }
    });

    it('respecte les autres styles quand ils sont explicitement demandés', async () => {
      mockCatalog();
      for (const [text, expected] of [
        ['Cocoon chaussons shoe', [201, 202]],
        ['Sunset tongs shoe', [301, 302]],
        ['Sunset sandales shoe', [301, 302]],
        ['Ranger bottes shoe', [401]],
      ] as Array<[string, number[]]>) {
        __resetCatalogCacheForTests();
        const id = await resolveBlueprintDynamic(cfg, text);
        expect(expected).toContain(id!);
      }
    });

    it('n’habille pas la chaussure en t-shirt', async () => {
      mockCatalog();
      __resetCatalogCacheForTests();
      expect(await resolveBlueprintDynamic(cfg, 'Urban Pulse Low shoe')).not.toBe(6);
    });
  });

  it('n’invente jamais de produit de substitution quand rien ne correspond', async () => {
    spyOn(printify, 'listBlueprints').mockResolvedValue({
      ok: true, status: 200, message: undefined, error: undefined,
      data: [{ id: 6, title: 'Unisex Jersey Short Sleeve Tee' }] as any,
    } as any);

    const id = await resolveBlueprintDynamic(cfg, 'berline électrique GT');
    expect(id).toBeNull();
  });
});

// [2026-10-03] Pantalons & autres vêtements : blueprints vérifiés en direct.
import { isBottomsGarment, legPlacementPositions } from './printify-auto';
describe('vêtements ajoutés au catalogue', () => {
  it('résout pantalon / jogging / robe vers les blueprints vérifiés', () => {
    expect(resolveBlueprint('pantalon')).toBe(5526);
    expect(resolveBlueprint('jogging')).toBe(1398);
    expect(resolveBlueprint('robe')).toBe(431);
    expect(resolveBlueprint('chaussettes')).toBe(365);
  });
  it('reconnaît un bas (pantalon, jogging, short) mais pas legging/chaussettes', () => {
    expect(isBottomsGarment("Men's Trousers")).toBe(true);
    expect(isBottomsGarment('Unisex Sweatpants')).toBe(true);
    expect(isBottomsGarment('Fleece Sweat Shorts')).toBe(true);
    expect(isBottomsGarment("Women's Casual Leggings (AOP)")).toBe(false);
    expect(isBottomsGarment('Crew Socks')).toBe(false);
  });
  it('un bas est imprimé sur UNE seule zone avant de jambe', () => {
    expect(legPlacementPositions(['front_left_leg_dtf', 'front_right_leg_dtf'])).toEqual(['front_left_leg_dtf']);
    expect(legPlacementPositions(['left_leg_back', 'right_leg_back', 'right_leg_front', 'left_leg_front'])).toEqual(['left_leg_front']);
    expect(legPlacementPositions(['front', 'back'])).toEqual(['front', 'back']);
  });
});
