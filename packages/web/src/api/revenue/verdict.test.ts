import { describe, expect, it } from 'bun:test';
import { portfolioVerdict, type PortfolioPnl } from './verdict';

const DAY = 24 * 60 * 60 * 1000;
const KILL = 14 * DAY;

function pnl(p: Partial<PortfolioPnl>): PortfolioPnl {
  return { revenue: 0, supplierCost: 0, aiCostUsd: 0, adsSpent: 0, profit: 0, margin: 0, ...p };
}

describe('portfolioVerdict', () => {
  it('laisse tourner une société jeune sans revenu', () => {
    const v = portfolioVerdict({ mrr: 0, totalRevenue: 0, ageMs: 2 * DAY, killMs: KILL, pnl: null });
    expect(v).toEqual({ action: 'wait', reason: 'too_early' });
  });

  it('passe en improve à mi-parcours sans revenu', () => {
    const v = portfolioVerdict({ mrr: 0, totalRevenue: 0, ageMs: 8 * DAY, killMs: KILL, pnl: null });
    expect(v).toEqual({ action: 'improve', reason: 'no_revenue_midway' });
  });

  it('kill après le seuil sans revenu', () => {
    const v = portfolioVerdict({ mrr: 0, totalRevenue: 0, ageMs: 20 * DAY, killMs: KILL, pnl: null });
    expect(v).toEqual({ action: 'kill', reason: 'no_revenue_timeout' });
  });

  it('ne kill jamais une société qui a du revenu, même très vieille', () => {
    const v = portfolioVerdict({
      mrr: 0, totalRevenue: 250, ageMs: 400 * DAY, killMs: KILL,
      pnl: pnl({ revenue: 0 }),
    });
    expect(v.action).toBe('keep');
  });

  it('garde une société rentable', () => {
    const v = portfolioVerdict({
      mrr: 120, totalRevenue: 480, ageMs: 40 * DAY, killMs: KILL,
      pnl: pnl({ revenue: 120, supplierCost: 30, aiCostUsd: 5, profit: 85, margin: 0.708 }),
    });
    expect(v).toEqual({ action: 'keep', reason: 'profitable' });
  });

  it('demande un improve quand il y a des ventes mais une perte nette', () => {
    const v = portfolioVerdict({
      mrr: 100, totalRevenue: 100, ageMs: 40 * DAY, killMs: KILL,
      pnl: pnl({ revenue: 100, supplierCost: 60, aiCostUsd: 40, adsSpent: 80, profit: -80, margin: -0.8 }),
    });
    expect(v).toEqual({ action: 'improve', reason: 'unprofitable' });
  });

  it('ignore un profit négatif quand la fenêtre est sans revenu (coûts non imputables)', () => {
    const v = portfolioVerdict({
      mrr: 0, totalRevenue: 500, ageMs: 200 * DAY, killMs: KILL,
      pnl: pnl({ revenue: 0, aiCostUsd: 12, profit: -12 }),
    });
    expect(v).toEqual({ action: 'keep', reason: 'profitable' });
  });

  it('reste en keep si le P&L est indisponible mais qu’il y a du revenu', () => {
    const v = portfolioVerdict({ mrr: 49.9, totalRevenue: 49.9, ageMs: 5 * DAY, killMs: KILL, pnl: null });
    expect(v).toEqual({ action: 'keep', reason: 'profitable' });
  });

  it('profit exactement nul n’est pas une perte', () => {
    const v = portfolioVerdict({
      mrr: 50, totalRevenue: 50, ageMs: 10 * DAY, killMs: KILL,
      pnl: pnl({ revenue: 50, supplierCost: 50, profit: 0, margin: 0 }),
    });
    expect(v.action).toBe('keep');
  });
});
