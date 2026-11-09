# Codex multiagente — coordinación y reglas de propiedad

## Equipo

- **Coordinador (sesión principal):** inspecciona repo, valida fase, divide tareas, implementa el bootstrap cuando esté autorizado, integra y ejecuta pruebas.
- **`finance_domain`:** interpreta reglas de dinero y detecta dobles conteos; entrega informe/trazabilidad y ejemplos de dominio; no edita archivos del coordinador.
- **`security_reviewer`:** inspección solo lectura de identidad, idempotencia, aislamiento, secretos, recibos, permisos y costos; no ejecuta despliegues ni explora datos privados.
- **`test_engineer`:** diseña matriz de pruebas deterministas, fixtures y casos negativos; puede crear únicamente archivos de tests asignados después de autorización.

Máximo 3 subagentes concurrentes **más** el coordinador. Codex utiliza agentes solo si las herramientas disponibles en esa sesión lo permiten; config no garantiza delegación automática. Si no funciona, ejecutar roles por turnos y documentar la limitación.

## Primera ola en paralelo (Fase 0)

| Rol | Archivos exclusivos | Entrega |
|---|---|---|
| Coordinador | `package.json`, `tsconfig*`, `src/app/**`, `.github/**`, `.env.example`, `README.md` | Bootstrap mínimo y comandos probados |
| Dominio | `docs/reviews/FINANCE_DOMAIN_REVIEW.md` | Invariantes, conflictos, casos y decisiones pendientes |
| Seguridad | `docs/reviews/SECURITY_REVIEW.md` | Modelo de amenazas y riesgos bloqueantes/no bloqueantes |
| Pruebas | `docs/reviews/TEST_MATRIX.md` | Casos para el primer flujo y datos sintéticos |

Estos archivos de revisión **no existen todavía** y deberán crearlos los agentes al comenzar, si el coordinador lo aprueba. No permitir que subagentes reescriban `AGENTS.md`, `PRODUCT_RULES.md`, `ARCHITECTURE.md` o el contrato al mismo tiempo.

## Contrato de delegación

1. Cada subagente recibe objetivo, rutas exclusivamente asignadas, evidencia requerida, prohibiciones y criterios de salida.
2. Trabajo paralelo solo cuando no existan dependencias de escritura. No anidar nuevos subagentes por iniciativa propia.
3. Revisores no modifican archivos funcionales. El coordinador decide qué recomendaciones implementar.
4. Si hay conflicto de reglas, detener trabajo conflictivo y solicitar resolución humana.
5. Una revisión de seguridad debe distinguir *amenaza potencial* de *vulnerabilidad reproducible*. No bloquear todo el proyecto por hipótesis menores sin criterios de decisión.

## Puertas de calidad

- Sin claims de pruebas ejecutadas si no hay comandos y resultado.
- Contratos API y escrituras financieras con pruebas de permisos e idempotencia antes de integrar.
- Cambios a datos reales, credenciales o infraestructura siempre requieren aprobación explícita.
- Resumen obligatorio de cada ola: responsables, archivos, cambios, pruebas, pendientes, decisiones y riesgos residuales.

## Uso

1. Abre el repositorio **Don Gastón** como workspace único.
2. Valida configuración de Codex para repositorios confiables; revisa soporte de roles `.codex` y límite de concurrencia.
3. Pega `prompts/00_CODEX_START.md` en **la sesión coordinadora**; NO pegues los prompts de especialistas en la misma sesión simultáneamente.
4. Si Codex no dispone de delegación, usar prompts de `prompts/01...03` en sesiones separadas en modo lectura o ramas/worktrees aislados, con propiedad de archivos.
5. Comenzar con Fase 0, sin ejecutar Fase 1 automáticamente.
