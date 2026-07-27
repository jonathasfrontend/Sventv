/**
 * SvenTV API - Middleware de Validação com Joi
 *
 * Centraliza a validação dos corpos de requisição.
 * Qualquer erro de validação retorna 422 Unprocessable Entity
 * com detalhes estruturados para o cliente.
 */

'use strict';

const Joi = require('joi');

// ─────────────────────────────────────────────────────────────
// Schemas de validação
// ─────────────────────────────────────────────────────────────

const schemas = {
  register: Joi.object({
    name: Joi.string().trim().min(2).max(80).required().messages({
      'string.min': 'O nome deve ter pelo menos 2 caracteres.',
      'string.max': 'O nome deve ter no máximo 80 caracteres.',
      'any.required': 'O nome é obrigatório.',
    }),
    email: Joi.string().trim().email().lowercase().required().messages({
      'string.email': 'Informe um e-mail válido.',
      'any.required': 'O e-mail é obrigatório.',
    }),
    password: Joi.string()
      .min(8)
      .max(128)
      .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .required()
      .messages({
        'string.min': 'A senha deve ter pelo menos 8 caracteres.',
        'string.pattern.base':
          'A senha deve conter pelo menos uma letra minúscula, uma maiúscula e um número.',
        'any.required': 'A senha é obrigatória.',
      }),
    avatar: Joi.string().uri().max(500).allow('').optional(),
  }),

  login: Joi.object({
    email: Joi.string().trim().email().lowercase().required().messages({
      'string.email': 'Informe um e-mail válido.',
      'any.required': 'O e-mail é obrigatório.',
    }),
    password: Joi.string().min(1).max(128).required().messages({
      'any.required': 'A senha é obrigatória.',
    }),
  }),

  updateProfile: Joi.object({
    name: Joi.string().trim().min(2).max(80).optional(),
    avatar: Joi.string().uri().max(500).allow('').optional(),
  }).min(1),

  changePassword: Joi.object({
    currentPassword: Joi.string().required().messages({
      'any.required': 'A senha atual é obrigatória.',
    }),
    newPassword: Joi.string()
      .min(8)
      .max(128)
      .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .required()
      .messages({
        'string.min': 'A nova senha deve ter pelo menos 8 caracteres.',
        'string.pattern.base':
          'A nova senha deve conter pelo menos uma letra minúscula, uma maiúscula e um número.',
        'any.required': 'A nova senha é obrigatória.',
      }),
  }),

  adminChangeRole: Joi.object({
    role: Joi.string().trim().valid('user', 'admin').required(),
  }),

  adminBlockUser: Joi.object({
    blocked: Joi.boolean().required(),
    reason: Joi.string().trim().max(255).allow('', null).optional(),
  }),
};

// ─────────────────────────────────────────────────────────────
// Fábrica de middleware de validação
// ─────────────────────────────────────────────────────────────

/**
 * Cria um middleware que valida `req.body` contra o schema informado.
 * @param {'register'|'login'|'updateProfile'|'changePassword'} schemaName
 * @returns {import('express').RequestHandler}
 */
const validate = (schemaName) => {
  const schema = schemas[schemaName];

  if (!schema) {
    throw new Error(`Schema de validação desconhecido: "${schemaName}"`);
  }

  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,   // Coleta todos os erros de uma vez
      stripUnknown: true,  // Remove campos não definidos no schema
    });

    if (error) {
      const errors = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
      }));

      return res.status(422).json({
        success: false,
        message: 'Dados de entrada inválidos.',
        errors,
      });
    }

    // Substitui req.body pelos dados sanitizados/validados pelo Joi
    req.body = value;
    next();
  };
};

module.exports = { validate, schemas };
