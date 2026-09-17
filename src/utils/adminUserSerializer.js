/**
 * SvenTV API — Serializer do usuário para o painel administrativo
 *
 * É a ÚNICA forma autorizada de expor usuários nas rotas admin. Garante que
 * campos sensíveis (password, apiToken, apiTokenVersion, apiTokenActive,
 * sessionVersion, loginAttempts, lockUntil) NUNCA vazem — mesmo que uma
 * query do admin busque um objeto completo.
 */

'use strict';

const serializeAdminUser = (user) => {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar || '',
    role: user.role || 'user',
    status: user.status || 'active',
    accountRestricted: Boolean(user.accountRestricted),
    restrictedReason: user.restrictedReason || null,
    lastLogin: user.lastLogin || null,
    lastLoginIp: user.lastLoginIp || null,
    termsAcceptedAt: user.termsAcceptedAt || null,
    termsVersion: user.termsVersion || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};

const serializeAdminUserList = (users) => (Array.isArray(users) ? users.map(serializeAdminUser) : []);

module.exports = { serializeAdminUser, serializeAdminUserList };