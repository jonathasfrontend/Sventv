/**
 * Supabase client helper (Storage uploads)
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config/app');
const logger = require('./logger');

let supabase = null;

if (config.supabase.url && config.supabase.serviceRoleKey) {
  supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
} else {
  logger.warn('⚠️ Supabase não configurado (defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY). Upload de avatar ficará indisponível.');
}

const getSupabaseClient = () => {
  if (!supabase) {
    const err = new Error('Supabase não configurado para upload de arquivos.');
    err.statusCode = 500;
    throw err;
  }
  return supabase;
};

module.exports = { getSupabaseClient };
