/**
 * Helpers para estado da conexão do banco (Supabase/Postgres).
 */

'use strict';

let connected = false;

const setDatabaseConnected = (status) => {
  connected = Boolean(status);
};

const isDatabaseConnected = () => connected;

const createDatabaseUnavailableError = (message) => {
  const err = new Error(message || 'Serviço temporariamente indisponível.');
  err.statusCode = 503;
  return err;
};

module.exports = {
  setDatabaseConnected,
  isDatabaseConnected,
  createDatabaseUnavailableError,
};
