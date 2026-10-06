import { randomUUID } from 'node:crypto';

const accessLevels = new Set(['read', 'write', 'rollback-write', 'command', 'external', 'destructive']);
const terminalStates = new Set(['completed', 'failed', 'cancelled']);

function frozenJson(value, ancestors = new Set(), depth = 0) {
  if (depth > 32) throw new Error('Parameters exceed nesting limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Parameters must be finite JSON');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Parameters must use plain objects');
  }
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? value.map(item => frozenJson(item, ancestors, depth + 1))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenJson(item, ancestors, depth + 1)]));
  ancestors.delete(value);
  return Object.freeze(copy);
}

/** Host-only controller. This library does not provide a filesystem or process sandbox. */
export class Task {
  #id;
  #state;
  #permission;
  #capabilities = new Map();
  #pending = null;
  #events = [];
  #abort = null;

  constructor({ id = randomUUID(), execution = 'direct', permission = 'ask', capabilities = {} } = {}) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Task ID is required');
    if (!['direct', 'plan'].includes(execution)) throw new Error('Unknown execution mode');
    if (!['ask', 'workspace-auto'].includes(permission)) throw new Error('Unknown permission mode');
    for (const [name, capability] of Object.entries(capabilities)) {
      if (!accessLevels.has(capability.access) || typeof capability.validate !== 'function' ||
          typeof capability.execute !== 'function') throw new Error(`Invalid capability: ${name}`);
      this.#capabilities.set(name, Object.freeze({
        access: capability.access, validate: capability.validate, execute: capability.execute,
      }));
    }
    this.#id = id;
    this.#state = execution === 'plan' ? 'planning' : 'ready';
    this.#permission = permission;
    this.#record('created');
  }

  #record(type, ticket) {
    this.#events.push(Object.freeze({ sequence: this.#events.length + 1, type, ...(ticket ? { ticket } : {}) }));
  }

  #available() {
    if (!['ready', 'planning'].includes(this.#state)) throw new Error(`Task unavailable: ${this.#state}`);
  }

  #validate(capability, parameters) {
    // A synchronous explicit true is required; missing checks and accidental promises fail closed.
    if (capability.validate(parameters) !== true) throw new Error('Capability validation denied');
  }

  snapshot() {
    return {
      id: this.#id, state: this.#state, permission: this.#permission,
      pending: this.#pending ? { ticket: this.#pending.ticket, tool: this.#pending.tool } : null,
      events: this.#events.map(event => ({ ...event })),
    };
  }

  confirmPlan() {
    if (this.#state !== 'planning') throw new Error('No plan awaiting confirmation');
    this.#state = 'ready';
    this.#record('plan-confirmed');
  }

  async request(tool, parameters = {}) {
    this.#available();
    const capability = this.#capabilities.get(tool);
    const ticket = randomUUID();
    let frozen;
    try {
      if (!capability) throw new Error('Unknown capability');
      if (this.#state === 'planning' && capability.access !== 'read') throw new Error('Plan phase is read only');
      frozen = frozenJson(parameters);
      this.#validate(capability, frozen);
    } catch (error) {
      this.#record('blocked', ticket);
      throw error;
    }
    const request = Object.freeze({ ticket, tool, parameters: frozen, capability });
    const automatic = capability.access === 'read' ||
      (this.#permission === 'workspace-auto' && capability.access === 'rollback-write');
    if (automatic) {
      this.#record('automatic', ticket);
      return this.#execute(request);
    }
    this.#pending = request;
    this.#state = 'waiting';
    this.#record('approval-requested', ticket);
    return { kind: 'approval', ticket, tool };
  }

  async approve(ticket) {
    if (this.#state !== 'waiting' || this.#pending?.ticket !== ticket) throw new Error('Invalid approval ticket');
    const request = this.#pending;
    this.#pending = null;
    this.#record('approved', ticket);
    return this.#execute(request);
  }

  reject(ticket) {
    if (this.#state !== 'waiting' || this.#pending?.ticket !== ticket) throw new Error('Invalid approval ticket');
    this.#pending = null;
    this.#state = 'ready';
    this.#record('rejected', ticket);
  }

  async #execute(request) {
    const previous = this.#state === 'planning' ? 'planning' : 'ready';
    this.#state = 'executing';
    const controller = new AbortController();
    this.#abort = controller;
    try {
      this.#validate(request.capability, request.parameters);
      this.#record('started', request.ticket);
      const value = await request.capability.execute(request.parameters, { signal: controller.signal });
      if (controller.signal.aborted) return { kind: 'cancelled' };
      this.#state = previous;
      this.#record('succeeded', request.ticket);
      return { kind: 'result', value };
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'cancelled' };
      this.#state = 'failed';
      this.#record('failed', request.ticket);
      throw error;
    } finally {
      this.#abort = null;
    }
  }

  cancel() {
    if (terminalStates.has(this.#state)) return false;
    this.#state = 'cancelled';
    this.#pending = null;
    this.#record('cancelled');
    this.#abort?.abort();
    return true;
  }

  complete() {
    if (this.#state !== 'ready') throw new Error(`Cannot complete: ${this.#state}`);
    this.#state = 'completed';
    this.#record('completed');
  }
}
