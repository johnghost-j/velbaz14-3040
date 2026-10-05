import { describe, expect, it } from 'bun:test';
import { analyticsBrief, biggestLeak, type SiteAnalytics } from './brief';

function a(p: Partial<SiteAnalytics>): SiteAnalytics {
  return {
    windowDays: 30,
    pageviews: 0,
    visitors: 0,
    funnel: { pageview: 0, lead: 0, checkout_start: 0, purchase: 0 },
    conversionRate: 0,
    leadRate: 0,
    revenue: 0,
    channels: [],
    topPaths: [],
    daily: [],
    devices: [],
    ...p,
  };
}

describe('analyticsBrief', () => {
  it('dit clairement qu’il n’y a aucune visite', () => {
    const s = analyticsBrief(a({}));
    expect(s).toContain('AUCUNE visite');
    expect(s).toContain('acquisition');
  });

  it('résume trafic, tunnel et canaux quand il y a des données', () => {
    const s = analyticsBrief(a({
      pageviews: 340, visitors: 210,
      funnel: { pageview: 340, lead: 12, checkout_start: 4, purchase: 2 },
      leadRate: 12 / 210, conversionRate: 2 / 210, revenue: 99.8,
      channels: [{ channel: 'organic', visits: 200, sessions: 130, purchases: 2, revenue: 99.8 }],
      topPaths: [{ path: '/', views: 200 }, { path: '/pricing', views: 80 }],
      devices: [{ device: 'mobile', sessions: 150 }],
    }));
    expect(s).toContain('340 pages vues');
    expect(s).toContain('210 visiteurs uniques');
    expect(s).toContain('organic');
    expect(s).toContain('/pricing');
    expect(s).toContain('99.80');
  });
});

describe('biggestLeak', () => {
  it('pointe l’acquisition quand il n’y a personne', () => {
    expect(biggestLeak(a({}))?.step).toBe('acquisition');
  });

  it('pointe l’activation : du trafic, zéro lead, zéro achat', () => {
    expect(biggestLeak(a({ pageviews: 500, visitors: 300 }))?.step).toBe('activation');
  });

  it('pointe le paiement : des checkouts ouverts mais aucun payé', () => {
    const r = biggestLeak(a({
      pageviews: 500, visitors: 300,
      funnel: { pageview: 500, lead: 20, checkout_start: 9, purchase: 0 },
    }));
    expect(r?.step).toBe('paiement');
  });

  it('pointe la conversion quand le taux est sous le plancher', () => {
    const r = biggestLeak(a({
      pageviews: 2000, visitors: 1000,
      funnel: { pageview: 2000, lead: 40, checkout_start: 10, purchase: 1 },
      conversionRate: 0.001,
    }));
    expect(r?.step).toBe('conversion');
  });

  it('ne signale rien quand le tunnel est sain', () => {
    const r = biggestLeak(a({
      pageviews: 1000, visitors: 500,
      funnel: { pageview: 1000, lead: 60, checkout_start: 30, purchase: 18 },
      conversionRate: 18 / 500,
    }));
    expect(r).toBeNull();
  });

  it('n’accuse pas la conversion sur un échantillon trop petit', () => {
    const r = biggestLeak(a({
      pageviews: 20, visitors: 10,
      funnel: { pageview: 20, lead: 1, checkout_start: 0, purchase: 0 },
      conversionRate: 0,
    }));
    expect(r?.step).not.toBe('conversion');
  });
});
