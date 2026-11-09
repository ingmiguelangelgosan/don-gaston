# Flujo Git — proyectos independientes

- `sir-jarvis` y `don-gaston` **son repositorios distintos**, no ramas permanentes del mismo repositorio.
- Dentro de Don Gastón: `main` estable, ramas breves `feature/fin-00-bootstrap`, `feature/fin-01-ledger`, `docs/...`, `fix/...`.
- Pull request pequeño por incremento, con criterios de aceptación, pruebas reales, revisión de cambios sensibles, sin commits de datos personales.
- Separar herramientas o worktrees si varios agentes escriben código en paralelo; nunca dos agentes sobre el mismo archivo.
- Interfaz con Jarvis cambia solo mediante propuesta versionada y PR revisado en **ambos** repositorios, no a través de un `git push` del agente financiero sobre Jarvis.
- Configurar protección de ramas y controles CI al habilitar repositorio remoto. No afirmar que están activados hasta verificarlos.
