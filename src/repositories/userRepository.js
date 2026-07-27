'use strict';

const prisma = require('../prisma/client');

const normalizeEmail = (email) => String(email || '').toLowerCase().trim();

const userRepository = {
  async create(data) {
    return prisma.user.create({ data });
  },

  async findById(id) {
    return prisma.user.findUnique({ where: { id } });
  },

  async findByEmail(email) {
    return prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  },

  async findByApiToken(apiToken) {
    return prisma.user.findUnique({ where: { apiToken } });
  },

  async updateById(id, data) {
    return prisma.user.update({ where: { id }, data });
  },

  async findOne(criteria) {
    if (criteria.email) {
      return this.findByEmail(criteria.email);
    }

    if (criteria.apiToken) {
      return this.findByApiToken(criteria.apiToken);
    }

    if (criteria.id) {
      return this.findById(criteria.id);
    }

    throw new Error('Critério de busca não suportado em User.findOne.');
  },

  async findRoleByCode(code) {
    if (!prisma.role) return null;
    return prisma.role.findUnique({ where: { code: String(code || '').toLowerCase().trim() } });
  },

  async findPlanByCode(code) {
    if (!prisma.plan) return null;
    return prisma.plan.findUnique({ where: { code: String(code || '').toLowerCase().trim() } });
  },
};

module.exports = { userRepository, normalizeEmail };