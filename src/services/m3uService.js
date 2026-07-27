const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Serviço responsável pelo processamento do arquivo M3U
 * Extrai informações dos canais de TV e organiza os dados
 * Suporta múltiplos formatos de arquivo M3U
 */
class M3UService {
  constructor() {
    this.channels = [];
    this.m3uFiles = [
      
      // url de arquivo local
      path.join(__dirname, '../../SvenTvChannels.m3u')

      // urls externas como https://raw.githubusercontent.com/helenfernanda/gratis/main/iptvlegal.m3u


    ];
    this.loadChannels();
  }

  /**
   * Carrega e processa os arquivos M3U filtrados
   * O arquivo já foi processado pelo filtro M3U que mantém apenas canais FHD válidos
   */
  loadChannels() {
    let totalChannels = 0;
    let loadedFiles = 0;
    
    // Verifica se o arquivo filtrado existe
    const filteredFile = path.join(__dirname, '../../SvenTvChannels.m3u');
    
    if (!fs.existsSync(filteredFile)) {
      console.log('🔍 Arquivo filtrado não encontrado.');
      console.log('💡 Execute: npm run m3u:clean para gerar o arquivo filtrado');
    }
    
    this.m3uFiles.forEach((filePath) => {
      try {
        if (fs.existsSync(filePath)) {
          const m3uContent = fs.readFileSync(filePath, 'utf-8');
          const fileName = path.basename(filePath);
          const channelsBeforeLoad = this.channels.length;
          
          this.parseM3U(m3uContent, fileName);
          
          const channelsLoaded = this.channels.length - channelsBeforeLoad;
          totalChannels += channelsLoaded;
          loadedFiles++;
          
          console.log(`✅ ${fileName}: ${channelsLoaded} canais carregados`);
        } else {
          console.log(`⚠️  Arquivo não encontrado: ${path.basename(filePath)}`);
          console.log('💡 Certifique-se de que o arquivo SvenTvChannels.m3u está na raiz do projeto');
        }
      } catch (error) {
        console.error(`❌ Erro ao carregar ${path.basename(filePath)}:`, error.message);
      }
    });
    
    console.log(`📺 Total: ${this.channels.length} canais de ${loadedFiles} arquivo(s)`);
    
    // Remove duplicatas baseadas no nome e URL
    this.removeDuplicates();
    
    console.log(`🔄 Após remoção de duplicatas: ${this.channels.length} canais únicos`);
  }

  /**
   * Processa o conteúdo do arquivo M3U
   * @param {string} content - Conteúdo do arquivo M3U
   * @param {string} fileName - Nome do arquivo sendo processado
   */
  parseM3U(content, fileName) {
    const lines = content.split('\n').filter(line => line.trim());
    let currentChannel = {};
    let channelCount = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Pula linhas de metadados que não são canais
      if (line.startsWith('#EXT-X-SESSION-DATA:') || 
          line.startsWith('#EXTM3U') ||
          line === '') {
        continue;
      }
      
        if (line.startsWith('#EXTINF:')) {
          currentChannel = this.parseExtinf(line, fileName);
        } else if ((line.startsWith('http') || line.startsWith('https')) && currentChannel.name) {
          currentChannel.url = line;
          currentChannel.source = fileName;
          // Gera ID determinístico baseado em nome + fonte + índice para estabilidade
          currentChannel.id = this.generateChannelId(currentChannel.name, channelCount, currentChannel.source);
          currentChannel.slug = this.generateSlug(currentChannel.name);
        
        // Adiciona informações extras
        currentChannel.isLive = true;
        currentChannel.quality = this.extractQuality(currentChannel.name);
        currentChannel.availability = this.extractAvailability(currentChannel.name);
        currentChannel.format = this.detectFormat(currentChannel.url);
        currentChannel.encryption = this.detectEncryption(currentChannel.name);
        
        // Valida se é uma URL válida
        if (this.isValidUrl(currentChannel.url)) {
          this.channels.push({ ...currentChannel });
          channelCount++;
        }
        
        currentChannel = {};
      }
    }
  }

  /**
   * Processa a linha EXTINF do M3U
   * @param {string} line - Linha EXTINF
   * @param {string} fileName - Nome do arquivo sendo processado
   * @returns {Object} - Dados do canal
   */
  parseExtinf(line, fileName) {
    const channel = {};
    
    // Extrai o nome do canal (última parte após as vírgulas)
    const nameMatch = line.match(/,(.+)$/);
    if (nameMatch) {
      channel.name = nameMatch[1].trim();
    }
    
    // Extrai tvg-id
    const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
    if (tvgIdMatch) {
      channel.tvgId = tvgIdMatch[1];
    }
    
    // Extrai tvg-name (usado no ec1328_plus.m3u)
    const tvgNameMatch = line.match(/tvg-name="([^"]+)"/);
    if (tvgNameMatch && !channel.name) {
      channel.name = tvgNameMatch[1].trim();
    }
    
    // Extrai tvg-logo
    const logoMatch = line.match(/tvg-logo="([^"]+)"/);
    if (logoMatch) {
      channel.logo = logoMatch[1];
    }
    
    // Extrai group-title (categoria) - limpa prefixos como "Canais |"
    const groupMatch = line.match(/group-title="([^"]+)"/);
    if (groupMatch) {
      let category = groupMatch[1].trim();
      // Remove prefixos comuns do ec1328_plus.m3u
      category = category.replace(/^Canais \| /, '');
      channel.category = category;
    }
    
    // Extrai informações adicionais do nome/tvg-name
    if (channel.name) {
      channel.originalName = channel.name;
      // Limpa o nome removendo tags de qualidade para facilitar busca
      channel.cleanName = this.cleanChannelName(channel.name);
    }
    
    return channel;
  }

  /**
   * Gera um ID único para o canal
   * @param {string} name - Nome do canal
   * @param {number} index - Índice para garantir unicidade
   * @returns {string} - ID do canal
   */
  generateChannelId(name, index = 0, source = '') {
    const baseId = name.toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\w\-_]/g, '')
      .substring(0, 45);

    // Usa hash curto de name+source para estabilidade entre reloads
    const hash = crypto.createHash('sha1').update(`${name}::${source}`).digest('hex').slice(0, 8);

    return `${baseId}_${hash}_${index}`;
  }

  /**
   * Gera um slug amigável para URLs
   * @param {string} name - Nome do canal
   * @returns {string} - Slug do canal
   */
  generateSlug(name) {
    return name.toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\w\-]/g, '')
      .replace(/--+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Extrai informações de qualidade do nome do canal
   * Todos os canais são FHD pois o arquivo já foi filtrado
   * @param {string} name - Nome do canal
   * @returns {string} - Qualidade do vídeo (sempre FHD)
   */
  extractQuality(name) {
    // Como o arquivo foi filtrado, todos os canais são FHD
    return 'FHD (Full HD)';
  }

  /**
   * Extrai informações de disponibilidade
   * @param {string} name - Nome do canal
   * @returns {string} - Status de disponibilidade
   */
  extractAvailability(name) {
    if (name.includes('[Not 24/7]')) return 'Disponibilidade limitada';
    if (name.includes('[Geo-blocked]')) return 'Bloqueado geograficamente';
    return 'Disponível';
  }

  /**
   * Limpa o nome do canal removendo tags de qualidade
   * @param {string} name - Nome original do canal
   * @returns {string} - Nome limpo
   */
  cleanChannelName(name) {
    return name
      .replace(/\[(FHD|HD|SD|4K|H265|HDR)\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Detecta o formato do stream pela URL
   * @param {string} url - URL do stream
   * @returns {string} - Formato detectado
   */
  detectFormat(url) {
    if (url.includes('.m3u8')) return 'HLS';
    if (url.includes('.ts')) return 'MPEG-TS';
    if (url.includes('.mp4')) return 'MP4';
    if (url.includes('.flv')) return 'FLV';
    return 'Desconhecido';
  }

  /**
   * Detecta se o canal tem codificação especial
   * @param {string} name - Nome do canal
   * @returns {string} - Tipo de codificação
   */
  detectEncryption(name) {
    if (name.includes('[H265]')) return 'H.265/HEVC';
    if (name.includes('[HDR]')) return 'HDR';
    if (name.includes('[4K]')) return '4K UHD';
    return 'Padrão';
  }

  /**
   * Valida se uma URL é válida
   * @param {string} url - URL para validar
   * @returns {boolean} - Verdadeiro se válida
   */
  isValidUrl(url) {
    try {
      const urlObj = new URL(url);
      return ['http:', 'https:'].includes(urlObj.protocol);
    } catch {
      return false;
    }
  }

  /**
   * Remove canais duplicados
   */
  removeDuplicates() {
    const seen = new Set();
    const uniqueChannels = [];
    
    this.channels.forEach(channel => {
      const key = `${channel.cleanName || channel.name}_${channel.quality}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueChannels.push(channel);
      }
    });
    
    this.channels = uniqueChannels;
  }

  /**
   * Retorna todos os canais
   * @returns {Array} - Lista de canais
   */
  getAllChannels() {
    return this.channels;
  }

  /**
   * Busca um canal pelo ID
   * @param {string} id - ID do canal
   * @returns {Object|null} - Canal encontrado ou null
   */
  getChannelById(id) {
    return this.channels.find(channel => channel.id === id) || null;
  }

  /**
   * Busca canais por categoria
   * @param {string} category - Categoria dos canais
   * @returns {Array} - Lista de canais da categoria
   */
  getChannelsByCategory(category) {
    return this.channels.filter(channel => 
      channel.category && 
      channel.category.toLowerCase().includes(category.toLowerCase())
    );
  }

  /**
   * Busca canais por nome
   * @param {string} searchTerm - Termo de busca
   * @returns {Array} - Lista de canais encontrados
   */
  searchChannels(searchTerm) {
    const term = searchTerm.toLowerCase();
    return this.channels.filter(channel =>
      channel.name.toLowerCase().includes(term) ||
      (channel.cleanName && channel.cleanName.toLowerCase().includes(term)) ||
      (channel.category && channel.category.toLowerCase().includes(term)) ||
      (channel.tvgId && channel.tvgId.toLowerCase().includes(term))
    );
  }

  /**
   * Retorna estatísticas dos canais
   * @returns {Object} - Estatísticas
   */
  getStats() {
    const categories = {};
    const formats = {};
    const sources = {};
    
    this.channels.forEach(channel => {
      // Contagem por categoria
      if (channel.category) {
        categories[channel.category] = (categories[channel.category] || 0) + 1;
      }
      
      // Contagem por formato
      if (channel.format) {
        formats[channel.format] = (formats[channel.format] || 0) + 1;
      }
      
      // Contagem por fonte
      if (channel.source) {
        sources[channel.source] = (sources[channel.source] || 0) + 1;
      }
    });

    return {
      totalChannels: this.channels.length,
      categories: Object.keys(categories).length,
      categoriesBreakdown: categories,
      formatsBreakdown: formats,
      sourcesBreakdown: sources,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Obtém todas as categorias únicas
   * @returns {Array} - Lista de categorias
   */
  getCategories() {
    const categories = new Set();
    this.channels.forEach(channel => {
      if (channel.category) {
        // Divide categorias múltiplas separadas por ;
        const cats = channel.category.split(';');
        cats.forEach(cat => categories.add(cat.trim()));
      }
    });
    return Array.from(categories).sort();
  }



  /**
   * Busca canais por formato
   * @param {string} format - Formato desejado (HLS, MPEG-TS, etc.)
   * @returns {Array} - Lista de canais do formato
   */
  getChannelsByFormat(format) {
    return this.channels.filter(channel =>
      channel.format && channel.format.toLowerCase() === format.toLowerCase()
    );
  }

  /**
   * Busca canais por fonte
   * @param {string} source - Arquivo fonte
   * @returns {Array} - Lista de canais da fonte
   */
  getChannelsBySource(source) {
    return this.channels.filter(channel =>
      channel.source && channel.source.toLowerCase().includes(source.toLowerCase())
    );
  }





  /**
   * Obtém todos os formatos disponíveis
   * @returns {Array} - Lista de formatos únicos
   */
  getFormats() {
    const formats = new Set();
    this.channels.forEach(channel => {
      if (channel.format) {
        formats.add(channel.format);
      }
    });
    return Array.from(formats).sort();
  }



  /**
   * Cria arquivo filtrado com apenas canais de TV brasileiros
   */
  createFilteredFile() {
    const allowedCategories = [
      'Canais | Abertos', 'Canais | Esportes', 'Canais | Notícias', 'Canais | Variedades', 
      'Canais | Documentários', 'Canais | Infantis', 'Canais | Art & Music', 'Canais | Religiosos',
      'Canais | Filmes e Séries', 'Canais | Globo Sudeste', 'Canais | Globo Sul', 'Canais | Globo Nordeste',
      'Canais | Globo Centro-Oeste', 'Canais | Globo Norte', 'Canais | Globo Capital', 'Canais | SporTV',
      'Canais | Premiere', 'Canais | HBO', 'Canais | Telecine', 'Canais | 4K', 'Canais | NBA',
      'Canais | HBO Max', 'Canais | Disney Plus', 'Canais | Amazon Prime Video', 'Canais | Apple TV',
      'Canais | Paramount +', 'Canais | Brasileirao', 'Canais | Fazenda', 'Canais | Estrela da Casa',
      'Canais | Jogos & Eventos', 'Canais | Musicas [24H]', 'Canais | Series [24H]', 'Canais | 24 Horas',
      'Canais | DAZN', 'Canais | GOAT', 'Canais | MLS', 'Canais | SportyNET', 'Canais | SBT+',
      'Canais | Eventos de Hoje', 'Canais | Legendados', 'RADIOS', 'Esportes', 'Documentarios',
      'Shows', 'Stand Up Commedy', 'GamePlay'
    ];

    const inputFile = path.join(__dirname, '../../ec1328_plus.m3u');
    const outputFile = path.join(__dirname, '../../brazil_tv_channels.m3u');
    
    const content = fs.readFileSync(inputFile, 'utf-8');
    const lines = content.split('\n');
    
    const filteredLines = ['#EXTM3U'];
    let currentEntry = null;
    let channelsCount = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.startsWith('#EXTINF:')) {
        const groupMatch = line.match(/group-title="([^"]+)"/);
        const category = groupMatch ? groupMatch[1] : '';
        
        if (allowedCategories.includes(category)) {
          currentEntry = line;
        } else {
          currentEntry = null;
        }
      } else if (line.startsWith('http') && currentEntry) {
        filteredLines.push(currentEntry);
        filteredLines.push(line);
        channelsCount++;
        currentEntry = null;
      }
    }
    
    const filteredContent = filteredLines.join('\n');
    fs.writeFileSync(outputFile, filteredContent, 'utf-8');
    
    console.log(`🎯 Arquivo filtrado criado: ${channelsCount} canais de TV brasileiros`);
  }

  /**
   * Recarrega os canais do arquivo M3U
   */
  reloadChannels() {
    this.channels = [];
    this.loadChannels();
  }
}

module.exports = M3UService;
