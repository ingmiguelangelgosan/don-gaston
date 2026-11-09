# ADR-001 — Persistencia
Estado: pendiente de decisión y aprobación. Fase 0 no incluye almacenamiento.

Comparar SQLite aislado y PostgreSQL/Supabase antes de crear adaptadores o migraciones.
Criterios: unicidad transaccional de intención y huella, concurrencia, auditoría,
aislamiento, costo, respaldo y restauración demostrada con fixtures (RPO/RTO).
No reutilizar almacenamiento de Jarvis. Ningún proveedor elegido o instalado.

Las simulaciones no prueban idempotencia durable. La decisión deberá preceder
al trabajo de persistencia; no bloquea el bootstrap local autorizado.
