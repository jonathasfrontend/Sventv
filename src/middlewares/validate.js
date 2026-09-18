'use strict';

const Joi = require('joi');
const { exceedsBcryptLimit } = require('../utils/passwordPolicy');

const PASSWORD_BYTES = 72;

const schemas = {
  register: Joi.object({
    name: Joi.string().trim().min(2).max(80).required().messages({
      'string.min': 'O nome deve ter pelo menos 2 caracteres.',
      'string.max': 'O nome deve ter no máximo 80 caracteres.',
      'any.required': 'O nome é obrigatório.',
    }),
    email: Joi.string().trim().email().lowercase().max(254).required().messages({
      'string.email': 'Informe um e-mail válido.',
      'string.max': 'O e-mail deve ter no máximo 254 caracteres.',
      'any.required': 'O e-mail é obrigatório.',
    }),
    password: Joi.string()
      .min(8)
      .max(128)
      .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .required()
      .custom((value, helpers) => {
        if (exceedsBcryptLimit(value)) {
          return helpers.error('any.custom', {
            message: `A senha deve ter no máximo ${PASSWORD_BYTES} bytes (limite do bcrypt).`,
          });
        }
        return value;
      })
      .messages({
        'string.min': 'A senha deve ter pelo menos 8 caracteres.',
        'string.pattern.base':
          'A senha deve conter pelo menos uma letra minúscula, uma maiúscula e um número.',
        'any.custom': '{{#message}}',
        'any.required': 'A senha é obrigatória.',
      }),
    confirmPassword: Joi.string().min(1).max(128).required()
      .valid(Joi.ref('password'))
      .messages({
        'any.only': 'As senhas não coincidem.',
        'any.required': 'A confirmação de senha é obrigatória.',
      }),
    acceptedTerms: Joi.any()
      .custom((value, helpers) => {
        if (value === true) return value;
        return helpers.error('any.custom');
      })
      .required()
      .messages({
        'any.custom': 'Você deve aceitar os Termos de Uso para criar uma conta.',
        'any.required': 'Você deve aceitar os Termos de Uso.',
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
      .custom((value, helpers) => {
        if (exceedsBcryptLimit(value)) {
          return helpers.error('any.custom', {
            message: `A nova senha deve ter no máximo ${PASSWORD_BYTES} bytes (limite do bcrypt).`,
          });
        }
        return value;
      })
      .messages({
        'string.min': 'A nova senha deve ter pelo menos 8 caracteres.',
        'string.pattern.base':
          'A nova senha deve conter pelo menos uma letra minúscula, uma maiúscula e um número.',
        'any.custom': '{{#message}}',
        'any.required': 'A nova senha é obrigatória.',
      }),
  }),

  forgotPassword: Joi.object({
    email: Joi.string().trim().email().lowercase().required().messages({
      'string.email': 'Informe um e-mail válido.',
      'any.required': 'O e-mail é obrigatório.',
    }),
  }),

  resetPassword: Joi.object({
    email: Joi.string().trim().email().lowercase().required().messages({
      'string.email': 'Informe um e-mail válido.',
      'any.required': 'O e-mail é obrigatório.',
    }),
    code: Joi.string().trim().length(6).pattern(/^\d{6}$/).required().messages({
      'string.length': 'O código deve conter exatamente 6 dígitos.',
      'string.pattern.base': 'O código deve conter apenas números.',
      'any.required': 'O código de recuperação é obrigatório.',
    }),
    newPassword: Joi.string()
      .min(8)
      .max(128)
      .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .required()
      .custom((value, helpers) => {
        if (exceedsBcryptLimit(value)) {
          return helpers.error('any.custom', {
            message: `A nova senha deve ter no máximo ${PASSWORD_BYTES} bytes (limite do bcrypt).`,
          });
        }
        return value;
      })
      .messages({
        'string.min': 'A nova senha deve ter pelo menos 8 caracteres.',
        'string.pattern.base':
          'A nova senha deve conter pelo menos uma letra minúscula, uma maiúscula e um número.',
        'any.custom': '{{#message}}',
        'any.required': 'A nova senha é obrigatória.',
      }),
    confirmPassword: Joi.string().min(1).max(128).required()
      .valid(Joi.ref('newPassword'))
      .messages({
        'any.only': 'As senhas não coincidem.',
        'any.required': 'A confirmação de senha é obrigatória.',
      }),
  }),

  adminChangeRole: Joi.object({
    role: Joi.string().trim().valid('user', 'admin').required(),
  }),

  // Admin — atualização de perfil de outro usuário (whitelist explícita:
  // nome e e-mail. NUNCA aceita role/status/password/avatar por aqui —
  // mass assignment bloqueado por schema + stripUnknown do middleware).
  adminUpdateProfile: Joi.object({
    name: Joi.string().trim().min(2).max(80).optional().messages({
      'string.min': 'O nome deve ter pelo menos 2 caracteres.',
      'string.max': 'O nome deve ter no máximo 80 caracteres.',
    }),
    email: Joi.string().trim().email().lowercase().max(254).optional().messages({
      'string.email': 'Informe um e-mail válido.',
      'string.max': 'O e-mail deve ter no máximo 254 caracteres.',
    }),
  }).min(1),

  // Admin — redefinição de senha de outro usuário (não exige a senha atual
  // do alvo; a autenticação do admin já foi validada no middleware).
  adminChangePassword: Joi.object({
    newPassword: Joi.string()
      .min(8)
      .max(128)
      .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .required()
      .custom((value, helpers) => {
        if (exceedsBcryptLimit(value)) {
          return helpers.error('any.custom', {
            message: `A nova senha deve ter no máximo ${PASSWORD_BYTES} bytes (limite do bcrypt).`,
          });
        }
        return value;
      })
      .messages({
        'string.min': 'A nova senha deve ter pelo menos 8 caracteres.',
        'string.pattern.base':
          'A nova senha deve conter pelo menos uma letra minúscula, uma maiúscula e um número.',
        'any.custom': '{{#message}}',
        'any.required': 'A nova senha é obrigatória.',
      }),
    confirmPassword: Joi.string().min(1).max(128).required()
      .valid(Joi.ref('newPassword'))
      .messages({
        'any.only': 'As senhas não coincidem.',
        'any.required': 'A confirmação de senha é obrigatória.',
      }),
  }),

  // Admin — exclusão de usuário exige confirmação explícita no corpo
  // (nunca por `confirm()` do navegador sozinha).
  adminDeleteUser: Joi.object({
    confirm: Joi.boolean().valid(true).required().messages({
      'any.only': 'A exclusão precisa ser confirmada.',
      'any.required': 'A exclusão precisa ser confirmada com "confirm: true".',
    }),
  }),

  adminBlockUser: Joi.object({
    blocked: Joi.boolean().required(),
    reason: Joi.string().trim().max(255).allow('', null).optional(),
  }),

  adminChannelState: Joi.object({
    state: Joi.string().trim().valid('live', 'maintenance', 'blocked').required().messages({
      'any.only': 'Estado inválido. Use "live", "maintenance" ou "blocked".',
      'any.required': 'O estado é obrigatório.',
    }),
    reason: Joi.string().trim().max(255).allow('', null).optional(),
  }),

  // Admin — lote de estados de canais (máx. 50; um item inválido NUNCA
  // derruba o lote — o controller processa cada um independentemente).
  adminBulkChannelState: Joi.object({
    items: Joi.array()
      .min(1)
      .max(50)
      .required()
      .items(
        Joi.object({
          channelId: Joi.string().trim().max(255).required().messages({
            'any.required': 'channelId é obrigatório por item.',
          }),
          state: Joi.string().trim().valid('live', 'maintenance', 'blocked').required().messages({
            'any.only': 'Estado inválido. Use "live", "maintenance" ou "blocked".',
            'any.required': 'state é obrigatório por item.',
          }),
          reason: Joi.string().trim().max(255).allow('', null).optional(),
        })
      )
      .messages({
        'array.min': 'Envie ao menos um canal.',
        'array.max': 'Limite de 50 canais por lote.',
        'any.required': 'items é obrigatório.',
      }),
  }),

  // Admin — lote de ações sobre usuários (proteções por item: self-lockout,
  // último admin ativo e confirm:true para exclusão são aplicados no
  // controller, nunca contornados pelo schema).
  adminBulkUsers: Joi.object({
    items: Joi.array()
      .min(1)
      .max(50)
      .required()
      .items(
        Joi.object({
          userId: Joi.string().trim().max(255).required().messages({
            'any.required': 'userId é obrigatório por item.',
          }),
          action: Joi.string()
            .trim()
            .valid('block', 'unblock', 'promote', 'demote', 'delete')
            .required()
            .messages({
              'any.only': 'Ação inválida. Use block, unblock, promote, demote ou delete.',
              'any.required': 'action é obrigatória por item.',
            }),
          reason: Joi.string().trim().max(255).allow('', null).optional(),
          // Obrigatório apenas para delete; o controller exige por item.
          confirm: Joi.boolean().valid(true).optional(),
        })
      )
      .messages({
        'array.min': 'Envie ao menos um usuário.',
        'array.max': 'Limite de 50 usuários por lote.',
        'any.required': 'items é obrigatório.',
      }),
  }),

  playbackEvent: Joi.object({
    sessionId: Joi.string().trim().min(8).max(80).required().messages({
      'any.required': 'sessionId é obrigatório.',
      'string.min': 'sessionId inválido.',
    }),
    event: Joi.string().trim().valid('play', 'pause', 'resume', 'stop', 'ended').required().messages({
      'any.only': 'Evento inválido. Use play, pause, resume, stop ou ended.',
      'any.required': 'event é obrigatório.',
    }),
    channelId: Joi.string().trim().max(255).required().messages({
      'any.required': 'channelId é obrigatório.',
    }),
    watchDurationMs: Joi.number().integer().min(0).max(1_000_000_000).default(0).messages({
      'number.base': 'watchDurationMs deve ser um número.',
      'number.max': 'watchDurationMs excede o limite permitido.',
    }),
  }),

  heartbeat: Joi.object({
    sessionId: Joi.string().trim().min(8).max(80).required().messages({
      'any.required': 'sessionId é obrigatório.',
      'string.min': 'sessionId inválido.',
    }),
    channelId: Joi.string().trim().max(255).required().messages({
      'any.required': 'channelId é obrigatório.',
    }),
    watchDurationMs: Joi.number().integer().min(0).max(1_000_000_000).required().messages({
      'any.required': 'watchDurationMs é obrigatório.',
      'number.base': 'watchDurationMs deve ser um número.',
    }),
  }),

  createPlaylist: Joi.object({
    name: Joi.string().trim().min(1).max(80).required().messages({
      'any.required': 'O nome da playlist é obrigatório.',
      'string.empty': 'O nome da playlist é obrigatório.',
      'string.max': 'O nome deve ter no máximo 80 caracteres.',
    }),
    description: Joi.string().trim().max(280).allow('').default('').messages({
      'string.max': 'A descrição deve ter no máximo 280 caracteres.',
    }),
  }),

  updatePlaylist: Joi.object({
    name: Joi.string().trim().min(1).max(80).optional().messages({
      'string.empty': 'O nome da playlist é obrigatório.',
      'string.max': 'O nome deve ter no máximo 80 caracteres.',
    }),
    description: Joi.string().trim().max(280).allow('').optional().messages({
      'string.max': 'A descrição deve ter no máximo 280 caracteres.',
    }),
  }).min(1),

  addPlaylistChannel: Joi.object({
    channelId: Joi.string().trim().max(255).required().messages({
      'any.required': 'channelId é obrigatório.',
    }),
  }),

  createPlaylistWithChannel: Joi.object({
    name: Joi.string().trim().min(1).max(80).required().messages({
      'any.required': 'O nome da playlist é obrigatório.',
      'string.empty': 'O nome da playlist é obrigatório.',
      'string.max': 'O nome deve ter no máximo 80 caracteres.',
    }),
    description: Joi.string().trim().max(280).allow('').default('').messages({
      'string.max': 'A descrição deve ter no máximo 280 caracteres.',
    }),
    channelId: Joi.string().trim().max(255).required().messages({
      'any.required': 'channelId é obrigatório.',
    }),
  }),

  // Avise-me — lembrete de programação. Aceita o contrato canônico
  // (title/startsAt) OU o contrato do player (programTitle/programStart,
  // este último podendo ser ISO 8601 ou timestamp numérico). A normalização
  // para o formato canônico acontece AQUI (o controller não conhece aliases).
  // channelId/título/datas são strings validados; a existência do canal e a
  // janela futura são validadas no reminderService, que conversa com a M3U.
  createReminder: Joi.object({
    channelId: Joi.string().trim().min(1).max(255).required().messages({
      'any.required': 'channelId é obrigatório.',
      'string.empty': 'channelId é obrigatório.',
      'string.max': 'channelId deve ter no máximo 255 caracteres.',
    }),
    title: Joi.string().trim().min(1).max(255).optional().messages({
      'string.max': 'O título deve ter no máximo 255 caracteres.',
    }),
    programTitle: Joi.string().trim().min(1).max(255).optional().messages({
      'string.max': 'O título deve ter no máximo 255 caracteres.',
    }),
    startsAt: Joi.date().iso().optional().messages({
      'date.iso': 'startsAt deve ser uma data em formato ISO 8601.',
    }),
    programStart: Joi.alternatives().try(
      Joi.date().iso(),
      Joi.number().integer().min(0)
    ).optional().messages({
      'alternatives.types': 'programStart deve ser ISO 8601 ou timestamp numérico.',
      'number.integer': 'programStart deve ser ISO 8601 ou timestamp numérico.',
    }),
    stopAt: Joi.date().iso().allow(null).optional().messages({
      'date.iso': 'stopAt deve ser uma data em formato ISO 8601.',
    }),
  }).custom((value, helpers) => {
    const title = value.title !== undefined ? value.title : value.programTitle;
    const startsAt = value.startsAt !== undefined ? value.startsAt : value.programStart;
    if (!title) {
      return helpers.message('O título do programa é obrigatório.');
    }
    if (startsAt === undefined) {
      return helpers.message('O horário de início é obrigatório.');
    }
    return { channelId: value.channelId, title, startsAt, stopAt: value.stopAt !== undefined ? value.stopAt : null };
  }),
};

const validate = (schemaName) => {
  const schema = schemas[schemaName];

  if (!schema) {
    throw new Error(`Schema de validação desconhecido: "${schemaName}"`);
  }

  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
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

    req.body = value;
    next();
  };
};

module.exports = { validate, schemas };