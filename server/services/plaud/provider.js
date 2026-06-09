const config = require('../../config');
const { createLogger } = require('../../utils/logger');

const log = createLogger('plaud-provider');

let adapter = null;

function getAdapter() {
  if (adapter) return adapter;

  const mode = config.plaud.mode;
  log.info(`Initializing PLAUD adapter: ${mode}`);

  switch (mode) {
    case 'legacy_debug':
      adapter = require('./legacyAdapter');
      break;
    case 'cli':
    default:
      adapter = require('./cliAdapter');
      break;
  }

  return adapter;
}

module.exports = {
  getStatus:        (...args) => getAdapter().getStatus(...args),
  listFiles:        (...args) => getAdapter().listFiles(...args),
  getFile:          (...args) => getAdapter().getFile(...args),
  getTranscript:    (...args) => getAdapter().getTranscript(...args),
  getNote:          (...args) => getAdapter().getNote(...args),
  getFullRecording: (...args) => getAdapter().getFullRecording(...args),
};
