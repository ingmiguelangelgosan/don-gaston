// Synthetic orchestration only. Never imported by application startup/build.
import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  parseRequest,
  validateResult,
  jsonSnapshot,
} from '../../src/interfaces/jarvis-demo-contract.ts';

const states = [
  'awaiting_confirmation',
  'cancelled',
  'executing',
  'completed',
  'uncertain',
  'failed',
];
function reject(code) {
  throw Object.assign(new Error(code), { code });
}
function exact(value, fields) {
  const result = jsonSnapshot(value);
  if (
    !result ||
    Array.isArray(result) ||
    typeof result !== 'object' ||
    Object.keys(result).sort().join('|') !== [...fields].sort().join('|')
  )
    reject('INVALID_COMMAND');
  return result;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}
function frozen(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
const digest = (request) =>
  createHash('sha256').update(canonical(request)).digest('hex');

export class ConfirmationFlow {
  #db;
  #execute;
  #actor;
  constructor({ path, create = false, execute, actor }) {
    this.#actor = exact(actor, ['instance_id', 'subject_ref']);
    if (
      typeof this.#actor.instance_id !== 'string' ||
      typeof this.#actor.subject_ref !== 'string' ||
      typeof execute !== 'function' ||
      !isAbsolute(path)
    )
      reject('INVALID_CONFIGURATION');
    this.#execute = execute;
    if (create) {
      const fd = openSync(path, 'wx', 0o600);
      closeSync(fd);
    } else if (!existsSync(path)) reject('MISSING_FLOW_STORE');
    try {
      this.#db = new DatabaseSync(path, { allowExtension: false });
      this.#db.exec(
        'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=500; PRAGMA trusted_schema=OFF;',
      );
      if (create) {
        this.#db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE binding (identity TEXT NOT NULL);
          CREATE TABLE flows (id TEXT PRIMARY KEY, request TEXT NOT NULL, token TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('awaiting_confirmation','cancelled','executing','completed','uncertain','failed')), outcome TEXT, evidence TEXT, revision INTEGER NOT NULL DEFAULT 0) STRICT;
          PRAGMA user_version=1; PRAGMA application_id=1145520972; COMMIT;`);
        this.#db
          .prepare('INSERT INTO binding VALUES (?)')
          .run(canonical(this.#actor));
      }
      if (
        this.#db.prepare('PRAGMA user_version').get().user_version !== 1 ||
        this.#db.prepare('PRAGMA application_id').get().application_id !==
          1145520972 ||
        this.#db.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
      )
        reject('CORRUPT_FLOW_STORE');
      const bindings = this.#db.prepare('SELECT identity FROM binding').all();
      if (
        bindings.length !== 1 ||
        bindings[0].identity !== canonical(this.#actor)
      )
        reject('FORBIDDEN');
    } catch (error) {
      this.#db?.close();
      throw error;
    }
  }
  #authorize(actor) {
    if (
      canonical(exact(actor, ['instance_id', 'subject_ref'])) !==
      canonical(this.#actor)
    )
      reject('FORBIDDEN');
  }
  #row(id) {
    if (typeof id !== 'string') reject('INVALID_COMMAND');
    const row = this.#db.prepare('SELECT * FROM flows WHERE id=?').get(id);
    if (!row) reject('UNKNOWN_CONFIRMATION');
    const request = parseRequest(JSON.parse(row.request));
    if (
      !states.includes(row.state) ||
      digest(request) !== row.token ||
      request.instance_id !== this.#actor.instance_id ||
      request.subject_ref !== this.#actor.subject_ref ||
      request.capability.name !== 'finance.expense.record' ||
      request.idempotency_key !== id
    )
      reject('CORRUPT_FLOW_STORE');
    return row;
  }
  #snapshot(row) {
    const request = JSON.parse(row.request);
    const evidence = row.evidence === null ? null : JSON.parse(row.evidence);
    const messages = {
      awaiting_confirmation: `Confirma el gasto de ${request.input.amount} ${request.input.currency}, categoría ${request.input.categoryId}, fecha ${request.input.occurredOn}.`,
      cancelled:
        'Solicitud cancelada antes de ejecutar. No se registró el gasto.',
      executing:
        'Confirmación aceptada. La operación está en ejecución; no la repitas.',
      completed: 'Gasto confirmado y recuperable por su intención original.',
      uncertain: evidence
        ? 'Gasto encontrado. El flujo sigue incierto y pendiente de conciliación con Jarvis; no se repetirá la escritura.'
        : 'No hay resultado confirmado. La operación sigue incierta; no se repetirá la escritura.',
      failed: 'La operación fue rechazada de forma definitiva.',
    };
    return frozen({
      id: row.id,
      state: row.state,
      request,
      confirmationToken: row.token,
      gatewayOutcome: row.outcome,
      evidence,
      message: messages[row.state],
    });
  }
  #change(row, state, outcome = row.outcome, evidence = row.evidence) {
    this.#db
      .prepare(
        'UPDATE flows SET state=?,outcome=?,evidence=?,revision=revision+1 WHERE id=? AND revision=?',
      )
      .run(state, outcome, evidence, row.id, row.revision);
    return this.#row(row.id);
  }
  prepare(actor, value) {
    this.#authorize(actor);
    const request = parseRequest(value);
    if (
      request.instance_id !== this.#actor.instance_id ||
      request.subject_ref !== this.#actor.subject_ref
    )
      reject('FORBIDDEN');
    if (request.capability.name !== 'finance.expense.record')
      reject('INVALID_COMMAND');
    const token = digest(request);
    this.#db
      .prepare(
        "INSERT INTO flows(id,request,token,state) VALUES(?,?,?,'awaiting_confirmation') ON CONFLICT(id) DO NOTHING",
      )
      .run(request.idempotency_key, canonical(request), token);
    const row = this.#row(request.idempotency_key);
    if (row.token !== token) reject('IDEMPOTENCY_CONFLICT');
    return this.#snapshot(row);
  }
  inspect(actor, id) {
    this.#authorize(actor);
    return this.#snapshot(this.#row(id));
  }
  #command(actor, value) {
    this.#authorize(actor);
    const command = exact(value, ['id', 'confirmationToken']);
    const row = this.#row(command.id);
    if (command.confirmationToken !== row.token)
      reject('CONFIRMATION_MISMATCH');
    return row;
  }
  cancel(actor, command) {
    const row = this.#command(actor, command);
    if (row.state === 'cancelled') return this.#snapshot(row);
    if (row.state !== 'awaiting_confirmation') reject('CANNOT_CANCEL_EXECUTED');
    return this.#snapshot(this.#change(row, 'cancelled'));
  }
  async confirm(actor, command) {
    let row = this.#command(actor, command);
    if (row.state !== 'awaiting_confirmation') return this.#snapshot(row);
    // Durable compare-and-set before invoking any asynchronous external effect.
    const changed = this.#db
      .prepare(
        "UPDATE flows SET state='executing', revision=revision+1 WHERE id=? AND state='awaiting_confirmation' AND revision=?",
      )
      .run(row.id, row.revision);
    if (changed.changes !== 1) return this.#snapshot(this.#row(row.id));
    row = this.#row(row.id);
    const request = parseRequest(JSON.parse(row.request));
    try {
      const result = validateResult(
        await this.#execute(request, this.#actor),
        request,
      );
      if (result.status === 'completed')
        row = this.#change(
          row,
          'completed',
          'completed',
          JSON.stringify(result.output.expense),
        );
      else row = this.#change(row, 'failed', 'failed');
    } catch (error) {
      const definitive =
        error?.outcome === 'not-started' || error?.outcome === 'failed';
      row = this.#change(
        row,
        definitive ? 'failed' : 'uncertain',
        error?.outcome === 'completed'
          ? 'completed'
          : definitive
            ? error.outcome
            : 'uncertain',
      );
    }
    return this.#snapshot(row);
  }
  async recover(actor, value) {
    this.#authorize(actor);
    const { id } = exact(value, ['id']);
    let row = this.#row(id);
    if (!['executing', 'uncertain'].includes(row.state))
      return this.#snapshot(row);
    if (row.state === 'executing')
      row = this.#change(row, 'uncertain', 'uncertain');
    const request = JSON.parse(row.request);
    const readId = `recovery-${randomUUID()}`;
    const lookup = parseRequest({
      ...request,
      request_id: readId,
      correlation_id: readId,
      idempotency_key: readId,
      capability: { name: 'finance.expense.lookup', version: '1.0' },
      deadline_at: new Date(Date.now() + 20000).toISOString(),
      input: { write_intent_id: request.idempotency_key },
    });
    try {
      const result = validateResult(
        await this.#execute(lookup, this.#actor),
        lookup,
      );
      if (result.status === 'completed' && result.output.found)
        row = this.#change(
          row,
          row.outcome === 'completed' ? 'completed' : 'uncertain',
          row.outcome,
          JSON.stringify(result.output.expense),
        );
    } catch {
      /* Lookup failure cannot prove failure of the original write. */
    }
    return this.#snapshot(this.#row(id));
  }
  close() {
    this.#db.close();
  }
}
