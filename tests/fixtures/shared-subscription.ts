// Ejemplo sintético, no es un ledger ni implementación del dominio.
// COP en unidades menores (centavos). División exacta: no requiere redondeo.
export const subscription = Object.freeze({
  factId: 'synthetic-subscription-001',
  currency: 'COP' as const,
  paidMinor: 90_000_000_000_000_003n,
  participants: 3n,
});
