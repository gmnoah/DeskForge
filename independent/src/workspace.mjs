import { constants, lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync,
  writeFileSync, fsyncSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { relative, isAbsolute, join, dirname, basename, parse } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

const MAX_BYTES = 1024 * 1024;
const readBounded = (fd, buffer, offset) => readSync(fd, buffer, offset, buffer.length - offset, offset);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../')); };
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sensitive = name => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git|\.ssh|\.aws|\.codex|\.agents|node_modules|\.deskforge-trash|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);
const decoder = new TextDecoder('utf-8', { fatal: true });
function text(bytes) {
  if (bytes.includes(0)) throw new Error('Binary file denied');
  try { return decoder.decode(bytes); } catch { throw new Error('Invalid UTF-8 text'); }
}
function statOrNull(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function glob(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 512 || /[\[\]\\\0]/.test(pattern)) throw new Error('Unsupported glob');
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; expression += '(?:.*/)?'; } else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[.*+?^${}()|]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`);
}

/** Trusted host API. Synchronous I/O narrows races; this is not an OS sandbox. */
export class Workspace {
  #root; #identity; #history; #historyIdentity; #active = true; #previews = new Map();

  constructor({ root, historyDirectory }) {
    if (typeof root !== 'string' || !isAbsolute(root) || lstatSync(root).isSymbolicLink()) throw new Error('Select a real absolute directory');
    this.#root = realpathSync(root);
    this.#identity = lstatSync(this.#root);
    if (!this.#identity.isDirectory() || this.#root === parse(this.#root).root || this.#root === realpathSync(homedir())) throw new Error('Root or home directory denied');
    if (typeof historyDirectory !== 'string' || !isAbsolute(historyDirectory) || lstatSync(historyDirectory).isSymbolicLink()) throw new Error('Private history directory required');
    this.#history = realpathSync(historyDirectory);
    this.#historyIdentity = lstatSync(this.#history);
    if (!this.#historyIdentity.isDirectory() || inside(this.#root, this.#history) || inside(this.#history, this.#root) ||
        (this.#historyIdentity.mode & 0o077) !== 0) throw new Error('History must be private and separate from workspace');
  }

  revoke() { this.#active = false; this.#previews.clear(); }

  #check() {
    if (!this.#active) throw new Error('Workspace authorization revoked');
    for (const [path, identity] of [[this.#root, this.#identity], [this.#history, this.#historyIdentity]]) {
      const current = lstatSync(path);
      if (current.isSymbolicLink() || !sameIdentity(current, identity) || realpathSync(path) !== path) throw new Error('Authorized directory changed');
    }
    if ((lstatSync(this.#history).mode & 0o077) !== 0) throw new Error('History permissions changed');
  }

  #path(name, allowMissing = false) {
    this.#check();
    if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.includes('\0')) throw new Error('Relative path required');
    const parts = name.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || sensitive(part))) throw new Error('Unsafe or sensitive path');
    let current = this.#root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      const info = statOrNull(current);
      if (!info && allowMissing && i === parts.length - 1) return current;
      if (!info) throw new Error('Path does not exist');
      if (info.isSymbolicLink() || !inside(this.#root, realpathSync(current))) throw new Error('Symbolic link denied');
      if (i < parts.length - 1 && !info.isDirectory()) throw new Error('Parent is not a directory');
    }
    return current;
  }

  #snapshot(name, missing = false) {
    const path = this.#path(name, missing);
    const info = statOrNull(path);
    if (!info) return { exists: false, bytes: Buffer.alloc(0), version: 'absent', mode: 0o600 };
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error('Only bounded regular files with one link are allowed');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!sameIdentity(info, before) || !before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) throw new Error('File changed during open');
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      // A bounded read prevents growth after lstat from causing an unbounded allocation.
      let length = 0;
      while (length < bytes.length) {
        const count = readBounded(fd, bytes, length);
        if (!count) break;
        length += count;
      }
      const after = fstatSync(fd);
      if (length > MAX_BYTES || !sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('File changed during read');
      this.#path(name);
      if (!sameIdentity(after, lstatSync(path))) throw new Error('File replaced during read');
      const content = bytes.subarray(0, length);
      text(content);
      return { exists: true, bytes: content, mode: info.mode & 0o777,
        version: `${after.dev}:${after.ino}:${after.mtimeMs}:${after.ctimeMs}:${digest(content)}` };
    } finally { closeSync(fd); }
  }

  read(path) {
    const snapshot = this.#snapshot(path);
    const content = text(snapshot.bytes);
    return { path, text: content, version: snapshot.version, lines: content.split('\n').length };
  }

  prepareWrite(path, content) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES || content.includes('\0')) throw new Error('Bounded text content required');
    const before = this.#snapshot(path, true);
    if (this.#previews.size >= 100) throw new Error('Too many pending previews');
    const bytes = Buffer.from(content);
    const id = randomUUID();
    this.#previews.set(id, { path, before, bytes });
    return { id, path, version: before.version, before: text(before.bytes), after: content,
      changes: previewChanges(before.exists ? text(before.bytes) : '', content),
      beforeLines: before.exists ? text(before.bytes).split('\n').length : 0, afterLines: content.split('\n').length };
  }

  validateWrite(id) {
    const preview = this.#previews.get(id);
    if (!preview) return false;
    return this.#snapshot(preview.path, true).version === preview.before.version;
  }

  discardPreview(id) { return this.#previews.delete(id); }

  #journal(id, record, initial = false) {
    this.#check();
    const destination = join(this.#history, `${id}.json`);
    const temporary = join(this.#history, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      this.#check();
      if (initial && statOrNull(destination)) throw new Error('History ID already exists');
      renameSync(temporary, destination);
    } finally { if (statOrNull(temporary)) unlinkSync(temporary); }
  }

  #replace(path, expected, bytes, mode, signal) {
    signal?.throwIfAborted();
    const destination = this.#path(path, true);
    const temporary = join(dirname(destination), `.deskforge-write-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', mode);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      signal?.throwIfAborted();
      if (this.#snapshot(path, true).version !== expected) throw new Error('Version conflict');
      this.#path(path, true);
      renameSync(temporary, destination);
    } finally {
      // Do not follow a replaced parent to perform cleanup.
      try { this.#path(path, true); if (statOrNull(temporary)) unlinkSync(temporary); } catch { /* leave temporary for host recovery */ }
    }
  }

  commitWrite(id, { signal } = {}) {
    signal?.throwIfAborted();
    const preview = this.#previews.get(id);
    if (!preview || !this.validateWrite(id)) throw new Error('Write preview expired or version conflict');
    this.#previews.delete(id);
    const record = { format: 1, workspace: this.#root, path: preview.path, state: 'prepared',
      beforeExists: preview.before.exists, before: preview.before.bytes.toString('base64'), mode: preview.before.mode,
      beforeHash: digest(preview.before.bytes), afterHash: digest(preview.bytes) };
    this.#journal(id, record, true);
    this.#replace(preview.path, preview.before.version, preview.bytes, preview.before.mode, signal);
    record.afterVersion = this.#snapshot(preview.path).version;
    record.state = 'applied';
    this.#journal(id, record);
    return { path: preview.path, historyId: id, version: record.afterVersion };
  }

  #record(id) {
    this.#check();
    if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid history ID');
    const file = join(this.#history, `${id}.json`);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES * 2) throw new Error('Invalid history file');
      const buffer = Buffer.alloc(MAX_BYTES * 2 + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readBounded(fd, buffer, length);
        if (!count) break;
        length += count;
      }
      if (length > MAX_BYTES * 2) throw new Error('History exceeds size limit');
      const record = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      if (record.format !== 1 || record.workspace !== this.#root || record.state !== 'applied' || typeof record.before !== 'string' ||
          typeof record.afterVersion !== 'string' || typeof record.beforeExists !== 'boolean' || typeof record.beforeHash !== 'string' ||
          !Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o777) throw new Error('History unavailable for rollback');
      const original = Buffer.from(record.before, 'base64');
      if (original.length > MAX_BYTES || digest(original) !== record.beforeHash) throw new Error('Backup content invalid');
      if (this.#snapshot(record.path).version !== record.afterVersion) throw new Error('Rollback conflict');
      return record;
    } finally { closeSync(fd); }
  }

  validateRollback(id) { this.#record(id); return true; }

  rollback(id, { signal } = {}) {
    const record = this.#record(id);
    signal?.throwIfAborted();
    if (record.beforeExists) {
      const bytes = Buffer.from(record.before, 'base64');
      if (bytes.length > MAX_BYTES) throw new Error('Invalid backup size');
      text(bytes);
      this.#replace(record.path, record.afterVersion, bytes, record.mode, signal);
    } else {
      const path = this.#path(record.path);
      if (this.#snapshot(record.path).version !== record.afterVersion) throw new Error('Rollback conflict');
      signal?.throwIfAborted();
      unlinkSync(path);
    }
    record.state = 'rolled-back';
    this.#journal(id, record);
    return { path: record.path, restored: record.beforeExists };
  }

  search({ query = '', pattern = '**/*', limit = 200, maxEntries = 10000, timeLimitMs = 2000 } = {}) {
    this.#check();
    if (typeof query !== 'string' || query.length > 4096 || !Number.isInteger(limit) || limit < 1 || limit > 1000 ||
        !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000 ||
        !Number.isInteger(timeLimitMs) || timeLimitMs < 1 || timeLimitMs > 10000) throw new Error('Invalid search limits');
    const matching = glob(pattern);
    const results = [];
    let scanned = 0; let truncated = false; let reason = null;
    const deadline = performance.now() + timeLimitMs;
    const needle = query.toLocaleLowerCase();
    const walk = (directory, inherited) => {
      if (truncated) return;
      const rules = [...inherited];
      const ignorePath = directory ? `${directory}/.gitignore` : '.gitignore';
      if (statOrNull(join(this.#root, ignorePath))) {
        const ignore = this.read(ignorePath).text;
        for (let line of ignore.split('\n')) {
          line = line.trim();
          if (!line || line.startsWith('#')) continue;
          const negative = line.startsWith('!');
          if (negative) line = line.slice(1);
          const dirOnly = line.endsWith('/');
          if (dirOnly) line = line.slice(0, -1);
          const anchored = line.startsWith('/') || line.includes('/');
          if (line.startsWith('/')) line = line.slice(1);
          rules.push({ base: directory, negative, dirOnly, anchored, matcher: glob(line) });
        }
      }
      const folder = directory ? this.#path(directory) : this.#root;
      for (const item of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (performance.now() > deadline) { truncated = true; reason = 'time'; return; }
        if (++scanned > maxEntries) { truncated = true; reason = 'entries'; return; }
        const path = directory ? `${directory}/${item.name}` : item.name;
        if (item.isSymbolicLink() || sensitive(item.name) || item.name.startsWith('.deskforge-write-') || item.name === '.gitignore') continue;
        let ignored = false;
        for (const rule of rules) {
          if (rule.base && !path.startsWith(`${rule.base}/`)) continue;
          const part = rule.base ? path.slice(rule.base.length + 1) : path;
          if ((!rule.dirOnly || item.isDirectory()) && rule.matcher.test(rule.anchored ? part : basename(part))) ignored = !rule.negative;
        }
        if (ignored) continue;
        if (item.isDirectory()) { walk(path, rules); if (truncated) return; continue; }
        if (!item.isFile() || !matching.test(path)) continue;
        let document;
        try { document = this.read(path); } catch (error) {
          if (/Binary file|Invalid UTF-8|Only bounded regular/.test(error.message)) continue;
          throw error;
        }
        const lines = document.text.split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (performance.now() > deadline) { truncated = true; reason = 'time'; return; }
          if (!query || lines[index].toLocaleLowerCase().includes(needle)) {
            if (results.length === limit) { truncated = true; reason = 'results'; return; }
            const position = query ? lines[index].toLocaleLowerCase().indexOf(needle) : 0;
            const start = Math.max(0, position - 100);
            results.push({ path, line: index + 1, text: lines[index].slice(start, start + 4096),
              textTruncated: start > 0 || lines[index].length > start + 4096, version: document.version });
            if (!query) break;
          }
        }
      }
    };
    walk('', []);
    return { results, scanned, truncated, reason };
  }

  capabilities() {
    // First file adapter always asks for writes. Auto mode waits for OS-level race protection review.
    return {
      read_text: { access: 'read', validate: args => { this.#path(args.path); return true; }, execute: async args => this.read(args.path) },
      search_text: { access: 'read', validate: () => { this.#check(); return true; }, execute: async args => this.search(args) },
      write_preview: { access: 'read', validate: args => { this.#path(args.path, true); return true; }, execute: async args => this.prepareWrite(args.path, args.text) },
      write_text: { access: 'write', validate: args => this.validateWrite(args.previewId), execute: async (args, context) => this.commitWrite(args.previewId, context) },
      rollback_write: { access: 'destructive', validate: args => this.validateRollback(args.historyId), execute: async (args, context) => this.rollback(args.historyId, context) },
    };
  }
}

function previewChanges(before, after) {
  // A single replacement region is intentionally coarse; no claim of a minimal edit diff.
  const oldLines = before ? before.split('\n') : [];
  const newLines = after ? after.split('\n') : [];
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
      oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const displayed = [...removed.slice(0, 200).map((line, i) => ({ kind: 'remove', line: prefix + i + 1, text: line.slice(0, 4096) })),
    ...added.slice(0, 200).map((line, i) => ({ kind: 'add', line: prefix + i + 1, text: line.slice(0, 4096) }))];
  return { removed: removed.length, added: added.length, lines: displayed,
    truncated: removed.length > 200 || added.length > 200 || displayed.some(item =>
      (item.kind === 'remove' ? oldLines : newLines)[item.line - 1].length > 4096) };
}
