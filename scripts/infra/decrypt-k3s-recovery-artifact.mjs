#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [artifactPath, keyPath, outputPath, expectedSha256] = process.argv.slice(2);
const TMPFS_MAGIC = 0x01021994;
const HEADER_BYTES = 33;

class RecoveryError extends Error {}

function fail(message) {
  throw new RecoveryError(message);
}

if (!artifactPath || !keyPath || !outputPath || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) {
  process.stderr.write('usage: decrypt-k3s-recovery-artifact.mjs ARTIFACT KEY_FILE TMPFS_OUTPUT EXPECTED_SHA256\n');
  process.exit(2);
}

let key;
let artifactFd;
let outputFd;
let temporaryPath;
let plaintextBytes = 0;

try {
  const artifactStat = fs.lstatSync(artifactPath);
  const keyStat = fs.lstatSync(keyPath);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink() || (artifactStat.mode & 0o077) !== 0) {
    fail('artifact must be a regular file with no group/other permissions');
  }
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || (keyStat.mode & 0o077) !== 0 || keyStat.size !== 32) {
    fail('key must be a protected 32-byte regular file');
  }

  const outputParent = fs.realpathSync(path.dirname(outputPath));
  const resolvedOutput = path.join(outputParent, path.basename(outputPath));
  if (!outputParent.startsWith('/dev/shm/')) {
    fail('plaintext output must be under a private directory in /dev/shm');
  }
  const parentStat = fs.statSync(outputParent);
  const parentFs = fs.statfsSync(outputParent);
  if ((parentStat.mode & 0o777) !== 0o700 || parentStat.uid !== process.getuid() || (parentFs.type >>> 0) !== TMPFS_MAGIC) {
    fail('output parent must be an owned mode-0700 tmpfs directory');
  }
  try {
    fs.lstatSync(resolvedOutput);
    fail('output path already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  key = fs.readFileSync(keyPath);
  artifactFd = fs.openSync(artifactPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const header = Buffer.alloc(HEADER_BYTES);
  const headerRead = fs.readSync(artifactFd, header, 0, HEADER_BYTES, 0);
  if (headerRead !== HEADER_BYTES || header.subarray(0, 5).toString('ascii') !== 'PRAE1') {
    fail('invalid PRAE1 envelope');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(5, 17));
  decipher.setAuthTag(header.subarray(17, 33));
  const artifactHash = crypto.createHash('sha256').update(header);
  const suffix = crypto.randomBytes(12).toString('hex');
  temporaryPath = path.join(outputParent, `.${path.basename(outputPath)}.decrypt-${process.pid}-${suffix}`);
  outputFd = fs.openSync(temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);

  const ciphertextBuffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = HEADER_BYTES;
  while (true) {
    const bytesRead = fs.readSync(artifactFd, ciphertextBuffer, 0, ciphertextBuffer.length, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    const ciphertext = ciphertextBuffer.subarray(0, bytesRead);
    artifactHash.update(ciphertext);
    const plaintext = decipher.update(ciphertext);
    let written = 0;
    while (written < plaintext.length) written += fs.writeSync(outputFd, plaintext, written, plaintext.length - written);
    plaintextBytes += plaintext.length;
    plaintext.fill(0);
  }

  let finalBytes;
  try {
    finalBytes = decipher.final();
  } catch {
    fail('artifact authentication failed');
  }
  let finalOffset = 0;
  while (finalOffset < finalBytes.length) finalOffset += fs.writeSync(outputFd, finalBytes, finalOffset, finalBytes.length - finalOffset);
  plaintextBytes += finalBytes.length;
  finalBytes.fill(0);
  if (artifactHash.digest('hex') !== expectedSha256) fail('artifact digest does not match expected SHA-256');

  fs.fsyncSync(outputFd);
  fs.closeSync(outputFd);
  outputFd = undefined;
  fs.closeSync(artifactFd);
  artifactFd = undefined;

  fs.linkSync(temporaryPath, resolvedOutput);
  fs.unlinkSync(temporaryPath);
  temporaryPath = undefined;

  const outputStat = fs.lstatSync(resolvedOutput);
  if (!outputStat.isFile() || outputStat.isSymbolicLink() || (outputStat.mode & 0o777) !== 0o600) {
    fs.unlinkSync(resolvedOutput);
    fail('plaintext output did not retain mode 0600');
  }
  process.stdout.write(`PASS: authenticated PRAE1 artifact; ${plaintextBytes} plaintext bytes written mode 0600 to tmpfs\n`);
} catch (error) {
  if (outputFd !== undefined) fs.closeSync(outputFd);
  if (artifactFd !== undefined) fs.closeSync(artifactFd);
  if (temporaryPath) {
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
  if (error instanceof RecoveryError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else if (error?.code === 'ERR_OSSL_EVP_BAD_DECRYPT' || error?.code === 'ERR_CRYPTO_AUTH_TAG_MISMATCH') {
    process.stderr.write('artifact authentication failed\n');
    process.exitCode = 2;
  } else if (error?.code === 'EEXIST') {
    process.stderr.write('output path already exists\n');
    process.exitCode = 2;
  } else if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
    process.stderr.write('required protected input or tmpfs path is unavailable\n');
    process.exitCode = 2;
  } else {
    process.stderr.write(`recovery artifact check failed (${error?.code ?? 'unknown error'})\n`);
    process.exitCode = 2;
  }
} finally {
  key?.fill(0);
}
