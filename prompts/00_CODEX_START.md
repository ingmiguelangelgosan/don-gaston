# Prompt inicial para la sesión COORDINADORA de Codex — Don Gastón

> Abre el repositorio independiente `don-gaston` en VS Code y pega el texto siguiente en una sesión nueva de Codex. No pegar el prompt en el repositorio de Jarvis.

---

Actúa como **coordinador técnico** del nuevo proyecto **Don Gastón**, agente financiero independiente que más adelante se integrará con Sir Jarvis. El workspace actual es únicamente Don Gastón. No toques el código ni la infraestructura de Sir Jarvis.

**Primero lee** `AGENTS.md`, `README.md` y solo los apartados relevantes de `docs/ARCHITECTURE.md`, `docs/PRODUCT_RULES.md`, `docs/ROADMAP.md`, `docs/CODEX_WORKFLOW.md` y `docs/SECURITY.md`. Confirma el estado REAL del repositorio y trata este kit como documentación, no como software ya construido.

**Objetivo autorizado: ejecutar SOLO Fase 0 local.** Antes de editar, entrega un plan corto que contenga estructura mínima, archivos, dependencias actuales a verificar, dueño por archivo, pruebas, riesgos y criterios de cierre. No asumas que ya existe una base de datos, API o enlace con Jarvis. Pide revisión/aprobación del plan antes de pasar a implementar si detectas decisiones no resueltas.

Coordina, **en paralelo cuando esté disponible**, máximo **3 subagentes** especializados y evita colisiones de escritura:

1. `finance_domain`: revisar invariantes y decisiones contra reglas; ruta exclusiva `docs/reviews/FINANCE_DOMAIN_REVIEW.md`.
2. `security_reviewer`: inspección solo lectura de amenazas, idempotencia, privacidad y autorización; devolver informe para que TÚ lo documentes en `docs/reviews/SECURITY_REVIEW.md`.
3. `test_engineer`: matriz de pruebas sintéticas; ruta exclusiva `docs/reviews/TEST_MATRIX.md`.

Tú, coordinador, eres propietario EXCLUSIVO de `package.json`, lockfile, `tsconfig*`, bootstrap `src/app/**`, configuración, `.github/**` y actualización final del README. No permitas que varios agentes editen el mismo archivo. Si el entorno Codex no permite subagentes, haz estas revisiones secuencialmente y dilo explícitamente.

**Implementa únicamente el bootstrap mínimo** de Node.js LTS + TypeScript estricto, validación de configuración, lint/formato, typecheck, runner de tests con ejemplos de dominio SIN datos reales, `.env.example` y `.gitignore` seguros. Comprueba versiones reales antes de fijar dependencias; no instales servicios/recursos externos ni expandas a todo el dominio financiero. No crear endpoints públicos, integración con Jarvis, Telegram, DB remota, LLM ni Docker deployment. No alterar el archivo histórico de requisitos.

El proyecto debe quedar modular y fácil de ejecutar localmente. Puedes dejar la decisión de DB como ADR pendiente si falta aprobación; no inventes almacenamiento. Usa siempre montos exactos y separa caja de consumo.

**Prohibido:** SSH, acceso Lightsail/AWS, npm scripts no revisados, secretos reales, bancos, WhatsApp, tokens de Telegram, registrar gastos personales reales, despliegues o compras de API. Ningún subagente puede saltarse estas prohibiciones.

**Salida esperada de Fase 0:** estructura funcionando localmente, comandos realmente ejecutados con resultados, un test reproducible, tres informes paralelos/secuenciales, ADRs pendientes y un resumen de archivos/alcance/próxima fase. No marques Fase 1 como completada ni digas que la integración con Jarvis funciona.
