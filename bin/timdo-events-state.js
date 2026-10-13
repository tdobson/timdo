#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_STATE_BYTES = 16 * 1024;
const MAX_CURSOR_LENGTH = 2048;
const OWNER_ONLY = 0o600;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
});
process.on('SIGTERM', () => {
  interrupted = true;
});

function fail(message) {
  throw new Error(message);
}

function checkInterrupted() {
  if (interrupted) fail('operation interrupted');
}

function readInput() {
  let input;
  try {
    input = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(0));
  } catch {
    fail('invalid JSON input');
  }
  try {
    return JSON.parse(input);
  } catch {
    fail('invalid JSON input');
  }
}

function normalizeApi(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail('API base must be an absolute HTTP or HTTPS URL');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('API base must be an absolute HTTP or HTTPS URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes('?') ||
    value.includes('#')
  ) {
    fail('API base must not contain credentials, a query or a fragment');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${url.pathname}`;
}

function resolvedPath(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('state file path is required');
  return path.resolve(value);
}

function assertPathNoSymlinks(filePath) {
  const resolved = path.resolve(filePath);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') fail('state file path or parent directory does not exist');
      throw error;
    }
    if (stat.isSymbolicLink()) fail('symlink paths are not allowed for checkpoint files');
    if (i < parts.length - 1 && !stat.isDirectory())
      fail('state file parent path is not a directory');
  }
  return resolved;
}

function assertTargetPath(filePath, required = false) {
  const resolved = path.resolve(filePath);
  assertPathNoSymlinks(path.dirname(resolved));
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) fail('symlink paths are not allowed for checkpoint files');
    if (!stat.isFile()) fail('checkpoint path must be a regular file');
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (required) fail('checkpoint file does not exist');
    } else {
      throw error;
    }
  }
  return resolved;
}

function assertPrivateDirectory(filePath) {
  const parent = path.dirname(filePath);
  assertPathNoSymlinks(parent);
  const stat = fs.statSync(parent);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    fail(
      'checkpoint parent directory must be owned by the current user and not group- or world-writable'
    );
  }
}

function validateCursor(cursor, allowBootstrap = true) {
  if (allowBootstrap && (cursor === '0' || cursor === 'latest')) return;
  if (
    typeof cursor !== 'string' ||
    cursor.length < 20 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !/^c1\.[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    fail('cursor must be a bounded opaque events cursor');
  }
}

function validateCheckpointCursor(cursor) {
  if (cursor === '0') return;
  validateCursor(cursor, false);
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('checkpoint is invalid');
  const allowed = ['api', 'cursor', 'include', 'principal', 'types', 'version', 'workspace'];
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(allowed)) fail('checkpoint has an invalid shape');
  if (value.version !== 1) fail('checkpoint version is unsupported');
  if (typeof value.api !== 'string' || normalizeApi(value.api) !== value.api)
    fail('checkpoint API base is invalid');
  if (
    typeof value.principal !== 'string' ||
    value.principal.length < 1 ||
    value.principal.length > 200
  )
    fail('checkpoint principal is invalid');
  if (
    value.workspace !== null &&
    (typeof value.workspace !== 'string' ||
      value.workspace.length < 1 ||
      value.workspace.length > 200)
  ) {
    fail('checkpoint workspace scope is invalid');
  }
  if (
    !Array.isArray(value.types) ||
    value.types.length < 1 ||
    value.types.length > 100 ||
    value.types.some((item) => typeof item !== 'string' || item.length < 3 || item.length > 100) ||
    JSON.stringify(value.types) !== JSON.stringify([...new Set(value.types)].sort())
  ) {
    fail('checkpoint event types are invalid');
  }
  if (
    !Array.isArray(value.include) ||
    value.include.length > 2 ||
    value.include.some((item) => item !== 'refs' && item !== 'text') ||
    JSON.stringify(value.include) !== JSON.stringify([...new Set(value.include)].sort())
  ) {
    fail('checkpoint include options are invalid');
  }
  validateCheckpointCursor(value.cursor);
  const serializedSize = Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8');
  if (serializedSize < 2 || serializedSize > MAX_STATE_BYTES) fail('checkpoint size is invalid');
  return value;
}

function readStateFile(filePath, allowInitTempLink = false) {
  const resolved = assertTargetPath(filePath, true);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== OWNER_ONLY ||
      (stat.nlink !== 1 && !(allowInitTempLink && stat.nlink === 2))
    ) {
      fail('checkpoint must be a regular owner-only 0600 file');
    }
    if (stat.size < 2 || stat.size > MAX_STATE_BYTES) fail('checkpoint size is invalid');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd));
    } catch {
      fail('checkpoint JSON is corrupt');
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail('checkpoint JSON is corrupt');
    }
    return validateState(value);
  } finally {
    fs.closeSync(fd);
  }
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function recoverLinkedInitTemp(filePath) {
  const resolved = assertTargetPath(filePath, true);
  assertPrivateDirectory(resolved);
  const targetStat = fs.lstatSync(resolved);
  const uid = typeof process.getuid === 'function' ? process.getuid() : targetStat.uid;
  if (
    !targetStat.isFile() ||
    targetStat.uid !== uid ||
    (targetStat.mode & 0o777) !== OWNER_ONLY ||
    targetStat.nlink !== 2
  ) {
    fail('checkpoint hard links are not a verified interrupted init; no file was removed');
  }
  readStateFile(resolved, true);

  const basename = path.basename(resolved);
  const prefix = `.${basename}.timdo-`;
  const candidates = [];
  for (const name of fs.readdirSync(path.dirname(resolved))) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const suffix = name.slice(prefix.length, -4);
    if (!/^\d+-[a-f0-9]{16}$/.test(suffix)) continue;
    const candidatePath = path.join(path.dirname(resolved), name);
    let candidateStat;
    try {
      candidateStat = fs.lstatSync(candidatePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (
      candidateStat.isFile() &&
      candidateStat.uid === uid &&
      (candidateStat.mode & 0o777) === OWNER_ONLY &&
      candidateStat.nlink === 2 &&
      sameInode(candidateStat, targetStat)
    ) {
      candidates.push({ path: candidatePath, stat: candidateStat });
    }
  }
  if (candidates.length !== 1) {
    fail('checkpoint init temp link could not be identified safely; no file was removed');
  }

  const [candidate] = candidates;
  const currentTarget = fs.lstatSync(resolved);
  const currentTemp = fs.lstatSync(candidate.path);
  if (
    !currentTarget.isFile() ||
    !currentTemp.isFile() ||
    currentTarget.nlink !== 2 ||
    currentTemp.nlink !== 2 ||
    !sameInode(currentTarget, targetStat) ||
    !sameInode(currentTemp, targetStat)
  ) {
    fail('checkpoint changed during interrupted init recovery; no file was removed');
  }
  cleanupOwned(candidate.path, targetStat);
  syncDirectory(resolved);
  if (fs.lstatSync(resolved).nlink !== 1) {
    fail('checkpoint init recovery did not leave one private file link');
  }
}

function readState(filePath, lockHeld = false) {
  const resolved = assertTargetPath(filePath, true);
  assertPrivateDirectory(resolved);
  try {
    return readStateFile(resolved);
  } catch (error) {
    let current;
    try {
      current = fs.lstatSync(resolved);
    } catch {
      throw error;
    }
    if (current.nlink === 1) throw error;
    const recover = () => {
      recoverLinkedInitTemp(resolved);
      return readStateFile(resolved);
    };
    if (lockHeld) return recover();
    return withLock(resolved, recover);
  }
}

function syncDirectory(filePath) {
  const fd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function openOwnedTemp(filePath, contents) {
  const parent = path.dirname(filePath);
  const tempPath = path.join(
    parent,
    `.${path.basename(filePath)}.timdo-${process.pid}-${randomBytes(8).toString('hex')}.tmp`
  );
  const fd = fs.openSync(
    tempPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
    OWNER_ONLY
  );
  const stat = fs.fstatSync(fd);
  try {
    fs.fchmodSync(fd, OWNER_ONLY);
    fs.writeFileSync(fd, contents, { encoding: 'utf8' });
    checkInterrupted();
    fs.fsyncSync(fd);
    checkInterrupted();
  } catch (error) {
    fs.closeSync(fd);
    cleanupOwned(tempPath, stat);
    throw error;
  }
  fs.closeSync(fd);
  return { tempPath, stat };
}

function cleanupOwned(filePath, ownedStat) {
  try {
    const current = fs.lstatSync(filePath);
    if (
      current.dev === ownedStat.dev &&
      current.ino === ownedStat.ino &&
      !current.isSymbolicLink()
    ) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  assertTargetPath(filePath, false);
  assertPrivateDirectory(filePath);
  let fd;
  try {
    fd = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW,
      OWNER_ONLY
    );
  } catch (error) {
    if (error.code === 'EEXIST') {
      try {
        const existing = fs.lstatSync(lockPath);
        if (existing.isSymbolicLink()) fail('checkpoint lock path is a symlink');
      } catch (inspectError) {
        if (inspectError.code !== 'ENOENT') throw inspectError;
      }
      fail('another checkpoint operation holds the lock; it was left untouched');
    }
    throw error;
  }
  const stat = fs.fstatSync(fd);
  try {
    fs.fchmodSync(fd, OWNER_ONLY);
    fs.writeFileSync(fd, `${randomBytes(16).toString('hex')}\n`, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    cleanupOwned(lockPath, stat);
    throw error;
  }
  fs.closeSync(fd);
  return { lockPath, stat };
}

function releaseLock(lock) {
  if (!lock) return;
  cleanupOwned(lock.lockPath, lock.stat);
}

function atomicCreate(filePath, value) {
  const resolved = assertTargetPath(filePath, false);
  assertPrivateDirectory(resolved);
  validateState(value);
  let temp;
  try {
    temp = openOwnedTemp(resolved, `${JSON.stringify(value)}\n`);
    checkInterrupted();
    assertTargetPath(resolved, false);
    try {
      fs.linkSync(temp.tempPath, resolved);
    } catch (error) {
      if (error.code === 'EEXIST')
        fail('checkpoint already exists; init never replaces an existing file');
      throw error;
    }
    try {
      cleanupOwned(temp.tempPath, temp.stat);
    } catch {
      recoverLinkedInitTemp(resolved);
    }
    temp = null;
    syncDirectory(resolved);
  } finally {
    if (temp) cleanupOwned(temp.tempPath, temp.stat);
  }
}

function atomicReplace(filePath, oldState, nextState) {
  const resolved = assertTargetPath(filePath, true);
  assertPrivateDirectory(resolved);
  validateState(nextState);
  let temp;
  try {
    temp = openOwnedTemp(resolved, `${JSON.stringify(nextState)}\n`);
    checkInterrupted();
    const current = readState(resolved, true);
    if (
      current.cursor !== oldState.cursor ||
      current.api !== oldState.api ||
      current.principal !== oldState.principal ||
      current.workspace !== oldState.workspace ||
      JSON.stringify(current.types) !== JSON.stringify(oldState.types) ||
      JSON.stringify(current.include) !== JSON.stringify(oldState.include)
    ) {
      fail('checkpoint conflict: file changed during acknowledgement');
    }
    const currentStat = fs.lstatSync(resolved);
    if (currentStat.isSymbolicLink() || !currentStat.isFile())
      fail('checkpoint path changed during acknowledgement');
    checkInterrupted();
    fs.renameSync(temp.tempPath, resolved);
    temp = null;
    syncDirectory(resolved);
  } finally {
    if (temp) cleanupOwned(temp.tempPath, temp.stat);
  }
}

function withLock(filePath, work) {
  let lock;
  try {
    lock = acquireLock(filePath);
    checkInterrupted();
    return work();
  } finally {
    releaseLock(lock);
  }
}

function main() {
  const [operation, rawPath] = process.argv.slice(2);
  if (operation === 'normalize-api') {
    const input = readInput();
    process.stdout.write(`${normalizeApi(input.api)}\n`);
    return;
  }
  const filePath = resolvedPath(rawPath);
  if (operation === 'read') {
    process.stdout.write(`${JSON.stringify(readState(filePath))}\n`);
    return;
  }
  if (operation === 'init') {
    const state = validateState(readInput());
    withLock(filePath, () => atomicCreate(filePath, state));
    process.stdout.write('{"initialized":true}\n');
    return;
  }
  if (operation === 'ack') {
    const input = readInput();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'from,to'
    ) {
      fail('ack requires only from and to cursors');
    }
    validateCursor(input.from);
    validateCursor(input.to, false);
    const result = withLock(filePath, () => {
      const state = readState(filePath, true);
      if (state.cursor === input.to)
        return { acknowledged: true, cursor: state.cursor, alreadyNext: true };
      if (state.cursor !== input.from)
        fail('checkpoint conflict: stored cursor does not match --from');
      const next = { ...state, cursor: input.to };
      atomicReplace(filePath, state, next);
      return { acknowledged: true, cursor: input.to, alreadyNext: false };
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  fail('unknown checkpoint operation');
}

try {
  main();
} catch (error) {
  const message =
    error && typeof error.message === 'string' ? error.message : 'checkpoint operation failed';
  process.stderr.write(`Checkpoint error: ${message}\n`);
  process.exitCode = 1;
}
