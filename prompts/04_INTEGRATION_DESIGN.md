# Prompt posterior (no ejecutar en Fase 0): contrato Don Gastón ↔ Jarvis

**Uso:** cuando la Fase 0 esté aprobada y se autorice expresamente el trabajo de contrato. No habilita despliegue, conexión ni escrituras reales.

Actúa como arquitecto de integración de Don Gastón. Lee `docs/AGENT_PROTOCOL_DRAFT.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md` y `docs/PRODUCT_RULES.md`. Solicita o revisa una **copia autorizada y actual** del contrato de agentes de Jarvis: no infieras endpoints, versionado ni esquemas a partir del borrador.

Con 3 subagentes, paraleliza solo (a) trazabilidad del dominio, (b) seguridad e identidad entre repos y (c) pruebas de contrato con fixtures. Entrega un reporte comparativo: campos compatibles, diferencias, autenticación, sujeto, capacidades, idempotencia, timeout, errores, consentimiento, límites de payload y revocación.

Propón OpenAPI/JSON Schema versionado para aprobación humana; no abras puertos ni realices cambios en Jarvis, Lightsail, APIs externas, DB real o firewall. Presenta puerta explícita de go/no-go para integración.
