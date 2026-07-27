/**
 * Utilitários auxiliares para a aplicação
 */

/**
 * Valida se uma URL é válida
 * @param {string} url - URL para validar
 * @returns {boolean} - Verdadeiro se a URL for válida
 */
const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

/**
 * Sanitiza uma string removendo caracteres especiais
 * @param {string} str - String para sanitizar
 * @returns {string} - String sanitizada
 */
const sanitizeString = (str) => {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/[<>\"'&]/g, '');
};

/**
 * Formata o tempo de atividade do servidor
 * @param {number} uptime - Tempo em segundos
 * @returns {string} - Tempo formatado
 */
const formatUptime = (uptime) => {
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  
  return `${hours}h ${minutes}m ${seconds}s`;
};

/**
 * Gera um ID único baseado em timestamp
 * @returns {string} - ID único
 */
const generateUniqueId = () => {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Converte bytes em formato legível
 * @param {number} bytes - Número de bytes
 * @returns {string} - Tamanho formatado
 */
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * Debounce function para limitar chamadas
 * @param {Function} func - Função para debounce
 * @param {number} wait - Tempo de espera em ms
 * @returns {Function} - Função com debounce
 */
const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

/**
 * Valida parâmetros de paginação
 * @param {Object} query - Query parameters
 * @returns {Object} - Parâmetros validados
 */
const validatePagination = (query) => {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 20;
  
  return {
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
    skip: (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit))
  };
};

/**
 * Aplica paginação em array
 * @param {Array} array - Array para paginar
 * @param {number} page - Página atual
 * @param {number} limit - Limite por página
 * @returns {Object} - Dados paginados
 */
const paginate = (array, page = 1, limit = 20) => {
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;
  
  const results = {
    data: array.slice(startIndex, endIndex),
    pagination: {
      current: page,
      total: Math.ceil(array.length / limit),
      hasNext: endIndex < array.length,
      hasPrev: startIndex > 0,
      totalItems: array.length,
      itemsPerPage: limit
    }
  };
  
  return results;
};

/**
 * Remove acentos e caracteres especiais de uma string
 * @param {string} str - String para normalizar
 * @returns {string} - String normalizada
 */
const normalizeString = (str) => {
  if (!str || typeof str !== 'string') return '';
  
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove acentos
    .replace(/[^\w\s]/gi, '') // Remove caracteres especiais
    .trim();
};

/**
 * Calcula a similaridade entre duas strings (Algoritmo de Levenshtein simplificado)
 * @param {string} str1 - Primeira string
 * @param {string} str2 - Segunda string
 * @returns {number} - Percentual de similaridade (0-1)
 */
const calculateSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;
  
  const s1 = normalizeString(str1);
  const s2 = normalizeString(str2);
  
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;
  
  // Verifica se uma string contém a outra
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;
  
  // Algoritmo simples de distância
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  
  if (longer.length === 0) return 1;
  
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
};

/**
 * Calcula a distância de Levenshtein entre duas strings
 * @param {string} str1 - Primeira string
 * @param {string} str2 - Segunda string
 * @returns {number} - Distância de Levenshtein
 */
const levenshteinDistance = (str1, str2) => {
  const matrix = [];
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
};

module.exports = {
  isValidUrl,
  sanitizeString,
  formatUptime,
  generateUniqueId,
  formatBytes,
  debounce,
  validatePagination,
  paginate,
  normalizeString,
  calculateSimilarity,
  levenshteinDistance
};
