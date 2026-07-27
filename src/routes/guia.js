const express = require('express');
const axios = require('axios');
const router = express.Router();

// Função auxiliar para obter a data formatada no padrão ISO de hoje à meia-noite até o final do dia
const getFormattedDateRange = () => {
  const today = new Date();
  const startOfDay = new Date(today.setHours(0, 0, 0, 0)).toISOString();
  const endOfDay = new Date(today.setHours(23, 59, 59, 999)).toISOString();
  return { startOfDay, endOfDay };
};

router.get('/canais-programacao', async (req, res) => {
  try {
    // URLs das APIs
    const canaisUrl =
      'https://programacao.claro.com.br/gatekeeper/canal/select?q=id_cidade:210&wt=json&rows=600&start=0&sort=cn_canal+asc&fl=id_canal+st_canal+cn_canal+nome+url_imagem+id_cidade&fq=nome:*&fq=id_categoria:*';

    // Buscar os canais
    const canaisResponse = await axios.get(canaisUrl);
    const canais = canaisResponse.data.response.docs;

    // Montar a URL para a programação
    const idsCanais = canais.map((canal) => canal.id_canal).join('+');
    const { startOfDay, endOfDay } = getFormattedDateRange();
    const programacaoUrl = `https://programacao.claro.com.br/gatekeeper/exibicao/select?q=id_canal:(${idsCanais})+AND+id_cidade:210&wt=json&rows=100000&start=0&sort=id_canal+asc,dh_inicio+asc&fl=dh_fim+dh_inicio+st_titulo+titulo+id_programa+id_canal+id_cidade&fq=dh_inicio:%5B${startOfDay}+TO+${endOfDay}%5D`;

    // Buscar a programação
    const programacaoResponse = await axios.get(programacaoUrl);
    const programacao = programacaoResponse.data.response.docs;

    // Hora atual - Ajustando para fuso horário do Brasil (UTC-3)
    const agora = new Date();
    const currentTime = new Date(agora.getTime() - (3 * 60 * 60 * 1000)).toISOString(); // UTC-3

    // Processar canais com programação
    const canaisComProgramacao = canais.map((canal) => {
      // Filtrar e ordenar a programação do canal
      const programacaoDoCanal = programacao
        .filter((p) => p.id_canal === canal.id_canal)
        .sort((a, b) => new Date(a.dh_inicio) - new Date(b.dh_inicio));

      // Se não há programação para o canal, retorna vazio
      if (programacaoDoCanal.length === 0) {
        return {
          id_canal: canal.id_canal,
          nome: canal.nome,
          st_canal: canal.st_canal,
          url_imagem: canal.url_imagem,
          programacao_atual: { mensagem: 'Nenhuma programação encontrada para hoje' },
          programacao_proximas: { mensagem: 'Nenhuma programação encontrada para hoje' },
        };
      }

      // Converter hora atual para timestamp para comparação mais precisa
      const currentTimestamp = new Date(currentTime).getTime();

      // Encontrar programa atual - aquele que está acontecendo AGORA
      let programaAtual = null;
      let proximoPrograma = null;
      
      for (let i = 0; i < programacaoDoCanal.length; i++) {
        const programa = programacaoDoCanal[i];
        const inicioPrograma = new Date(programa.dh_inicio).getTime();
        const fimPrograma = new Date(programa.dh_fim).getTime();
        
        // Se o programa está acontecendo agora
        if (inicioPrograma <= currentTimestamp && currentTimestamp < fimPrograma) {
          programaAtual = programa;
          // O próximo programa é o seguinte na lista (se existir)
          if (i + 1 < programacaoDoCanal.length) {
            proximoPrograma = programacaoDoCanal[i + 1];
          }
          break;
        }
      }

      // Se não encontrou programa atual, pegar o próximo que vai começar
      if (!programaAtual) {
        for (let i = 0; i < programacaoDoCanal.length; i++) {
          const programa = programacaoDoCanal[i];
          const inicioPrograma = new Date(programa.dh_inicio).getTime();
          
          if (inicioPrograma > currentTimestamp) {
            programaAtual = programa;
            if (i + 1 < programacaoDoCanal.length) {
              proximoPrograma = programacaoDoCanal[i + 1];
            }
            break;
          }
        }
      }

      return {
        id_canal: canal.id_canal,
        nome: canal.nome,
        st_canal: canal.st_canal,
        url_imagem: canal.url_imagem,
        programacao_atual: programaAtual
          ? {
              titulo: programaAtual.titulo,
              inicio: programaAtual.dh_inicio,
              fim: programaAtual.dh_fim,
            }
          : { mensagem: 'Nenhuma programação no momento' },
        programacao_proximas: proximoPrograma
          ? {
              titulo: proximoPrograma.titulo,
              inicio: proximoPrograma.dh_inicio,
              fim: proximoPrograma.dh_fim,
            }
          : { mensagem: 'Nenhuma programação próxima encontrada' },
      };
    });

    res.json(canaisComProgramacao);
  } catch (error) {
    console.error('Erro ao buscar os dados:', error.message);
    res.status(500).json({ error: 'Erro ao buscar os dados' });
  }
});

module.exports = router;
