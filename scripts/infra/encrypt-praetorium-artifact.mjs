#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [artifactPath, keyPath, manifestPath, sourceLabel = 'unspecified'] = process.argv.slice(2);
const HEADER = Buffer.alloc(33);
HEADER.write('PRAE1', 0, 'ascii');
const NONCE_OFFSET = 5;
const TAG_OFFSET = 17;

class EncryptError extends Error {}

function fail(message) {
  throw new EncryptError(message);
}

function ensurePrivateDirectory(filePath) {
  const parent = fs.realpathSync(path.dirname(filePath));
  const stat = fs.statSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    fail('artifact, key, and manifest parent directories must be owned mode-0700 directories');
  }
  return path.join(parent, path.basename(filePath));
}

function ensureAbsent(filePath) {
  try {
    fs.lstatSync(filePath);
    fail('refusing to overwrite an existing artifact, key, or manifest');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

if (!artifactPath || !keyPath || !manifestPath) {
  process.stderr.write('usage: encrypt-praetorium-artifact.mjs ARTIFACT KEY_FILE MANIFEST [SOURCE_LABEL]\n');
  process.exit(2);
}

let key;
let artifactFd;
let artifactPathResolved;
let keyPathResolved;
let manifestPathResolved;
let artifactCreated = false;
let keyCreated = false;
let manifestCreated = false;
let plaintextBytes = 0;
let plaintextHash;

try {
  const artifact = ensurePrivateDirectory(artifactPath);
  const keyFile = ensurePrivateDirectory(keyPath);
  const manifest = ensurePrivateDirectory(manifestPath);
  artifactPathResolved = artifact;
  keyPathResolved = keyFile;
  manifestPathResolved = manifest;
  ensureAbsent(artifact);
  ensureAbsent(keyFile);
  ensureAbsent(manifest);

  key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  nonce.copy(HEADER, NONCE_OFFSET);
  artifactFd = fs.openSync(artifact, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  artifactCreated = true;
  fs.writeSync(artifactFd, HEADER);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const inputHash = crypto.createHash('sha256');
  for await (const chunk of process.stdin) {
    const plaintext = Buffer.from(chunk);
    inputHash.update(plaintext);
    plaintextBytes += plaintext.length;
    const ciphertext = cipher.update(plaintext);
    let written = 0;
    while (written < ciphertext.length) written += fs.writeSync(artifactFd, ciphertext, written, ciphertext.length - written);
    plaintext.fill(0);
  }
  const finalBytes = cipher.final();
  let finalOffset = 0;
  while (finalOffset < finalBytes.length) finalOffset += fs.writeSync(artifactFd, finalBytes, finalOffset, finalBytes.length - finalOffset);
  finalBytes.fill(0);
  if (plaintextBytes === 0) fail('refusing to encrypt an empty input stream');

  const tag = cipher.getAuthTag();
  fs.writeSync(artifactFd, tag, 0, tag.length, TAG_OFFSET);
  fs.fsyncSync(artifactFd);
  fs.closeSync(artifactFd);
  artifactFd = undefined;

  const keyFd = fs.openSync(keyFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  keyCreated = true;
  try {
    fs.writeSync(keyFd, key);
    fs.fsyncSync(keyFd);
  } finally {
    fs.closeSync(keyFd);
  }

  const artifactHash = crypto.createHash('sha256');
  const artifactReadStream = fs.createReadStream(artifact);
  for await (const chunk of artifactReadStream) artifactHash.update(chunk);
  const artifactStat = fs.statSync(artifact);
  const keyStat = fs.statSync(keyFile);
  if (artifactStat.mode & 0o077 || keyStat.mode & 0o077 || keyStat.size !== 32) {
    fail('created artifact or key permissions failed verification');
  }

  const metadata = {
    schema: 'praetorium.encrypted-artifact/v1',
    format: 'PRAE1',
    cipher: 'AES-256-GCM',
    envelope: 'magic|12-byte nonce|16-byte tag|ciphertext',
    aad: 'none',
    artifact: path.basename(artifact),
    artifactBytes: artifactStat.size,
    artifactSha256: artifactHash.digest('hex'),
    keyPath: keyFile,
    keyMode: '0600',
    plaintextBytes,
    plaintextSha256: inputHash.digest('hex'),
    sourceLabel,
    createdAtUtc: new Date().toISOString(),
  };
  const manifestFd = fs.openSync(manifest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  manifestCreated = true;
  try {
    fs.writeFileSync(manifestFd, `${JSON.stringify(metadata, null, 2)}\n`);
    fs.fsyncSync(manifestFd);
  } finally {
    fs.closeSync(manifestFd);
  }

  process.stdout.write(`PASS: encrypted stream; ${plaintextBytes} bytes authenticated with PRAE1 AES-256-GCM\n`);
} catch (error) {
  if (artifactFd !== undefined) fs.closeSync(artifactFd);
  if (manifestCreated) {
    try { fs.unlinkSync(manifestPathResolved); } catch {}
  }
  if (keyCreated) {
    try { fs.unlinkSync(keyPathResolved); } catch {}
  }
  if (artifactCreated) {
    try { fs.unlinkSync(artifactPathResolved); } catch {}
  }
  const message = error instanceof EncryptError ? error.message : `artifact encryption failed (${error?.code ?? 'unknown error'})`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
} finally {
  key?.fill(0);
}
