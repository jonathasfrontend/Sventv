/**
 * SvenTV API - Repositório/Modelo de Usuário (Prisma/Postgres)
 *
 * Mantém a mesma semântica de regras do modelo anterior:
 * hashing de senha, geração/regeneração de API token, controle de bloqueio,
 * status de conta e serialização segura.
 */

'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { Prisma } = require('@prisma/client');
const config = require('../config/app');
const { userRepository, normalizeEmail } = require('../repositories/userRepository');

const VALID_STATUS = new Set(['active', 'inactive', 'banned', 'pending']);
const VALID_ROLES = new Set(['user', 'admin']);

const mapRowToModel = (row, includeSensitive = false) => {
  if (!row) return null;

  return new User({
    _id: row.id,
    id: row.id,
    name: row.name,
    email: row.email,
    password: includeSensitive ? row.password || null : undefined,
    avatar: row.avatar || '',
    apiToken: includeSensitive ? row.apiToken || null : undefined,
    status: row.status,
    role: row.role,
    roleId: row.roleId || null,
    loginAttempts: includeSensitive ? row.loginAttempts || 0 : undefined,
    lockUntil: includeSensitive ? row.lockUntil || null : undefined,
    apiTokenVersion: includeSensitive ? row.apiTokenVersion || 0 : undefined,
    apiTokenActive: includeSensitive ? Boolean(row.apiTokenActive) : undefined,
    accountRestricted: includeSensitive ? Boolean(row.accountRestricted) : undefined,
    restrictedReason: includeSensitive ? row.restrictedReason || null : undefined,
    lastLogin: row.lastLogin || null,
    lastLoginIp: row.lastLoginIp || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

const toPublicJson = (user) => {
  const ret = {
    _id: user._id,
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    status: user.status,
    role: user.role,
    roleId: user.roleId || null,
    lastLogin: user.lastLogin,
    lastLoginIp: user.lastLoginIp,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
  return ret;
};

const handleDbError = (error, duplicateField) => {
  if (!error) return;

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const err = new Error(`Já existe um registro com ${duplicateField || 'campo'} duplicado.`);
    err.statusCode = 409;
    throw err;
  }

  const err = new Error(error.message || 'Erro ao acessar base de usuários.');
  err.statusCode = 500;
  throw err;
};

class User {
  constructor(data) {
    Object.assign(this, data);
  }

  get isLocked() {
    return Boolean(this.lockUntil && new Date(this.lockUntil).getTime() > Date.now());
  }

  toJSON() {
    return toPublicJson(this);
  }

  async comparePassword(candidatePassword) {
    if (!this.password) {
      const fresh = await User.findByIdWithSensitive(this._id);
      if (!fresh || !fresh.password) return false;
      return bcrypt.compare(candidatePassword, fresh.password);
    }
    return bcrypt.compare(candidatePassword, this.password);
  }

  generateSessionToken() {
    return jwt.sign(
      {
        id: this._id,
        email: this.email,
        role: this.role,
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );
  }

  async regenerateApiToken() {
    const apiToken = this._generateApiToken();

    try {
      const updated = await userRepository.updateById(this._id, { apiToken });
      Object.assign(this, mapRowToModel(updated, true));
    } catch (error) {
      handleDbError(error, 'apiToken');
    }

    return this.apiToken;
  }

  getApiToken() {
    return this.apiToken;
  }

  async incLoginAttempts() {
    const maxAttempts = config.security.maxLoginAttempts;
    const lockMinutes = config.security.lockTimeMinutes;

    if (this.lockUntil && new Date(this.lockUntil).getTime() < Date.now()) {
      try {
        const updated = await userRepository.updateById(this._id, { loginAttempts: 1, lockUntil: null });
        Object.assign(this, mapRowToModel(updated, true));
      } catch (error) {
        handleDbError(error);
      }
      return;
    }

    const nextAttempts = (this.loginAttempts || 0) + 1;
    const updates = { loginAttempts: nextAttempts };

    if (nextAttempts >= maxAttempts && !this.isLocked) {
      updates.lockUntil = new Date(Date.now() + lockMinutes * 60 * 1000);
    }

    try {
      const updated = await userRepository.updateById(this._id, updates);
      Object.assign(this, mapRowToModel(updated, true));
    } catch (error) {
      handleDbError(error);
    }
  }

  async resetLoginAttempts() {
    try {
      const updated = await userRepository.updateById(this._id, {
        loginAttempts: 0,
        lockUntil: null,
        lastLogin: new Date(),
      });
      Object.assign(this, mapRowToModel(updated, true));
    } catch (error) {
      handleDbError(error);
    }
  }

  _generateApiToken() {
    return jwt.sign(
      {
        id: this._id,
        uuid: randomUUID(),
        type: 'api',
        tv: this.apiTokenVersion || 0,
      },
      config.jwtApi.secret,
      { expiresIn: config.jwtApi.expiresIn }
    );
  }

  static async create({ name, email, password, avatar }) {
    const normalizedEmail = normalizeEmail(email);

    const rounds = config.security.bcryptRounds;
    const passwordHash = await bcrypt.hash(password, rounds);

    const defaultRole = await userRepository.findRoleByCode('user');

    const payload = {
      name: String(name || '').trim(),
      email: normalizedEmail,
      password: passwordHash,
      avatar: avatar || '',
      status: 'active',
      role: 'user',
      roleId: defaultRole?.id || null,
      loginAttempts: 0,
      lockUntil: null,
      lastLogin: null,
      lastLoginIp: null,
      apiTokenVersion: 0,
      apiTokenActive: true,
      accountRestricted: false,
      restrictedReason: null,
      apiToken: null,
    };

    let created;
    try {
      created = await userRepository.create(payload);
    } catch (error) {
      handleDbError(error, 'email');
    }

    const user = mapRowToModel(created, true);
    const apiToken = user._generateApiToken();

    try {
      const withToken = await userRepository.updateById(user._id, { apiToken });
      return mapRowToModel(withToken, false);
    } catch (error) {
      handleDbError(error, 'apiToken');
    }
  }

  static async findOne(criteria) {
    try {
      const row = await userRepository.findOne(criteria);
      return mapRowToModel(row, false);
    } catch (error) {
      handleDbError(error);
    }
  }

  static async findById(userId) {
    try {
      const row = await userRepository.findById(userId);
      return mapRowToModel(row, false);
    } catch (error) {
      handleDbError(error);
    }
  }

  static async findByIdWithSensitive(userId) {
    try {
      const row = await userRepository.findById(userId);
      return mapRowToModel(row, true);
    } catch (error) {
      handleDbError(error);
    }
  }

  static async findByIdAndUpdate(userId, updates) {
    const normalized = updates?.$set ? updates.$set : updates;

    const payload = {};
    if (normalized.name !== undefined) payload.name = String(normalized.name).trim();
    if (normalized.avatar !== undefined) payload.avatar = normalized.avatar;
    if (normalized.lastLoginIp !== undefined) payload.lastLoginIp = normalized.lastLoginIp;

    if (normalized.status !== undefined) {
      if (!VALID_STATUS.has(normalized.status)) {
        const err = new Error('Status inválido.');
        err.statusCode = 422;
        throw err;
      }
      payload.status = normalized.status;
    }

    if (normalized.role !== undefined) {
      if (!VALID_ROLES.has(normalized.role)) {
        const err = new Error('Papel inválido.');
        err.statusCode = 422;
        throw err;
      }
      payload.role = normalized.role;
    }

    if (normalized.roleId !== undefined) {
      payload.roleId = normalized.roleId;
    }

    try {
      const data = await userRepository.updateById(userId, payload);
      return mapRowToModel(data, false);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      handleDbError(error);
    }
  }

  static async findByEmailWithPassword(email) {
    try {
      const row = await userRepository.findByEmail(email);
      return mapRowToModel(row, true);
    } catch (error) {
      handleDbError(error);
    }
  }

  static async findByApiToken(token) {
    try {
      const row = await userRepository.findByApiToken(token);
      return mapRowToModel(row, true);
    } catch (error) {
      handleDbError(error);
    }
  }

  static async updatePassword(userId, newPassword) {
    const rounds = config.security.bcryptRounds;
    const hash = await bcrypt.hash(newPassword, rounds);

    try {
      const data = await userRepository.updateById(userId, { password: hash });
      return mapRowToModel(data, true);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      handleDbError(error);
    }
  }
}

module.exports = User;
