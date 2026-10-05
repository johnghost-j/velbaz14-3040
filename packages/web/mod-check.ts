import { needsAiModeration } from './src/api/agents/orchestrator';

const msgs = [
  "j'ai reçu un avis d'imposition avec un redressement fiscal sur mes revenus locatifs, quels sont mes recours juridiques et les délais légaux ?",
  "quels sont les avantages d'un abonnement mensuel pour une salle de sport ?",
  "comment optimiser le référencement d'un site e-commerce ?",
];
for (const m of msgs) console.log(needsAiModeration(m), JSON.stringify(m.slice(0, 60)));
