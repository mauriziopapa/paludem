const config = require('../config');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? (config.isDev ? LEVELS.debug : LEVELS.info);

function fmt(level, tag, msg) {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] [${tag}] ${msg}`;
}

function createLogger(tag) {
  return {
    debug: (...args) => { if (MIN_LEVEL <= LEVELS.debug) console.debug(fmt('debug', tag, args.join(' '))); },
    info:  (...args) => { if (MIN_LEVEL <= LEVELS.info)  console.log(fmt('info', tag, args.join(' '))); },
    warn:  (...args) => { if (MIN_LEVEL <= LEVELS.warn)  console.warn(fmt('warn', tag, args.join(' '))); },
    error: (...args) => { if (MIN_LEVEL <= LEVELS.error) console.error(fmt('error', tag, args.join(' '))); },
  };
}

module.exports = { createLogger };
