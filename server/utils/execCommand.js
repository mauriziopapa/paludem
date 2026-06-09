const { execFile } = require('child_process');
const { createLogger } = require('./logger');

const log = createLogger('exec');

const FILE_ID_PATTERN = /^[a-zA-Z0-9_\-]{1,128}$/;

function validateFileId(fileId) {
  if (!fileId || typeof fileId !== 'string') return false;
  return FILE_ID_PATTERN.test(fileId);
}

function sanitizeArg(arg) {
  return String(arg).replace(/[^\w\-./=:@]/g, '');
}

function buildCliCommand(config) {
  if (config.plaud.cliMode === 'npx') {
    return {
      binary: 'npx',
      prefixArgs: ['-y', config.plaud.npxPackage],
    };
  }
  return {
    binary: config.plaud.cliBinary,
    prefixArgs: [],
  };
}

function buildCliEnv(config) {
  const env = { ...process.env };
  if (config.plaud.home) {
    env.PLAUD_HOME = config.plaud.home;
    const parent = require('path').dirname(config.plaud.home);
    if (parent && parent !== '/' && parent !== '.') {
      env.HOME = parent;
    }
  }
  return env;
}

function runCommand(binary, args, options = {}) {
  const { timeout = 60_000, cwd, env } = options;

  const safeArgs = args.map(a => String(a));

  return new Promise((resolve, reject) => {
    log.debug(`${binary} ${safeArgs.join(' ')}`);

    execFile(binary, safeArgs, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      cwd,
      env: env || { ...process.env },
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed || err.signal === 'SIGTERM') {
          return reject(new Error(`Command timed out after ${timeout}ms`));
        }
        const msg = (stderr || err.message || '').substring(0, 500);
        return reject(new Error(`Command failed (exit ${err.code}): ${msg}`));
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

module.exports = { runCommand, validateFileId, sanitizeArg, buildCliCommand, buildCliEnv };
