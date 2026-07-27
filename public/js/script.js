const API_BASE = window.location.origin + '/api';
let allChannels = [];
let currentChannels = [];

// Inicialização
document.addEventListener('DOMContentLoaded', function () {
    loadStats();
    loadCategories();
    loadChannels();
    setupModal();
    setupSearch();
    checkServerHealth(); // Verificar saúde do servidor

    // Verificar saúde do servidor a cada 30 segundos
    setInterval(checkServerHealth, 30000);
});

// Função para verificar a saúde do servidor
async function checkServerHealth(manual = false) {
    const healthCard = document.getElementById('serverHealthCard');
    const healthText = document.getElementById('healthText');

    // Estado de verificação
    healthCard.className = 'stat-card server-health checking';
    healthText.textContent = 'Verificando...';

    try {
        const response = await fetch(`${API_BASE}/health`);

        if (response.status === 200) {
            // Estado saudável
            healthCard.className = 'stat-card server-health healthy';
            healthText.textContent = 'Online';
        } else {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (error) {
        // Estado com problema
        healthCard.className = 'stat-card server-health unhealthy';
        healthText.textContent = 'Offline';
    }
}

// Função para formatar uptime
function formatUptime(seconds) {
    const days = Math.floor(seconds / (24 * 60 * 60));
    const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
    const minutes = Math.floor((seconds % (60 * 60)) / 60);
    const secs = Math.floor(seconds % 60);

    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

// Carrega estatísticas
async function loadStats() {
    try {
        const response = await fetch(`${API_BASE}/channels/stats`);
        const data = await response.json();

        if (data.success) {
            document.querySelectorAll('#totalChannels').forEach(element => {
                element.textContent = data.data.totalChannels;
            });
            document.getElementById('totalCategories').textContent = data.data.categories;
            document.getElementById('lastUpdated').textContent = new Date(data.data.lastUpdated).toLocaleDateString();
        }
    } catch (error) {
        console.error('Erro ao carregar estatísticas:', error);
    }
}

// Carrega categorias
async function loadCategories() {
    try {
        const response = await fetch(`${API_BASE}/channels/categories`);
        const data = await response.json();

        if (data.success) {
            const categoriesContainer = document.getElementById('categories');

            data.data.categories.forEach(category => {
                const button = document.createElement('button');
                button.className = 'category-btn';
                button.textContent = category;
                button.onclick = () => filterByCategory(category, button);
                categoriesContainer.appendChild(button);
            });
        }
    } catch (error) {
        console.error('Erro ao carregar categorias:', error);
    }
}

// Carrega todos os canais
async function loadChannels() {
    try {
        // Remove active class de todos os botões
        document.querySelectorAll('.category-btn').forEach(btn => btn.classList.remove('active'));
        
        // Adiciona active class no botão "Todas"
        const todasButton = document.querySelector('.category-btn');
        if (todasButton) {
            todasButton.classList.add('active');
        }

        document.getElementById('channelsContainer').innerHTML = '<div class="loading">Carregando canais...</div>';

        const response = await fetch(`${API_BASE}/channels`);
        const data = await response.json();

        if (data.success) {
            allChannels = data.data.channels;
            currentChannels = allChannels;
            renderChannels(currentChannels);
        } else {
            throw new Error(data.message);
        }
    } catch (error) {
        console.error('Erro ao carregar canais:', error);
        document.getElementById('channelsContainer').innerHTML =
            `<div class="error">Erro ao carregar canais: ${error.message}</div>`;
    }
}

// Renderiza a lista de canais
function renderChannels(channels) {
    const container = document.getElementById('channelsContainer');

    if (channels.length === 0) {
        container.innerHTML = '<div class="loading">Nenhum canal encontrado</div>';
        return;
    }

    // Limpa o container antes de adicionar novos canais
    container.innerHTML = '';

    channels.forEach(channel => {
        // Cria um elemento div para cada canal
        const channelCard = document.createElement('div');
        channelCard.className = 'channel-card';
        channelCard.innerHTML = `
            <div class="channel-header">
                <div class="content-header">
                    <img src="${channel.logo}" alt="${channel.name}" title="${channel.name}">
                    <div>
                        <h3>${channel.cleanName}</h3>
                    </div>
                </div>
            </div>  
            <div class="channel-info">
                <div class="content-info">
                    <span class="info-title">Qualidade:</span> 
                    <span class="info-value-quality">${channel.quality}</span>
                </div>
                <div class="content-info">
                    <span class="info-title">Disponibilidade:</span> 
                    <span class="info-value-availability">${channel.availability}</span>
                </div>
            </div>
            <div class="category-tags">
                ${channel.category ? `<span class="channel-category">${channel.category}</span>` : ''}
            </div>
            <div class="channel-actions">
                <button class="watching-btn" onclick="playChannel('${channel.id}', '${channel.name}')">
                    <img src="./img/play.svg" alt="Assistir">
                    Assistir
                </button>
                <button class="embed-btn-copy" onclick="copyEmbedCode('${channel.id}')">
                    <img src="./img/copy.svg" alt="Embed">
                    Embed
                </button>
            </div>
        `;
        
        // Adiciona o card ao container
        container.appendChild(channelCard);
    });
}

// Função para copiar código de embed para a área de transferência
async function copyEmbedCode(channelId) {
    const embedCode = `<iframe src="${API_BASE}/channels/${channelId}/stream" allow="encrypted-media" allowfullscreen frameborder="0" width="100%" height="400"></iframe>`;

    try {
        await navigator.clipboard.writeText(embedCode);
        // div temporária para mostrar mensagem de sucesso  
        const tempDiv = document.createElement('div');
        tempDiv.className = 'copy-success';
        tempDiv.textContent = 'Copiado!';
        document.body.appendChild(tempDiv);
        setTimeout(() => {
            tempDiv.remove();
        }, 2000);
    } catch (error) {
        console.error('Erro ao copiar código de embed:', error);
        alert('Erro ao copiar código de embed. Tente novamente.');
    }
} 

// Filtra canais por categoria
async function filterByCategory(category, button) {
    try {
        // Remove active class de todos os botões
        document.querySelectorAll('.category-btn').forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');

        const response = await fetch(`${API_BASE}/channels/category/${encodeURIComponent(category)}`);
        const data = await response.json();

        if (data.success) {
            currentChannels = data.data.channels;
            renderChannels(currentChannels);
        }
    } catch (error) {
        console.error('Erro ao filtrar por categoria:', error);
    }
}

// Pesquisa canais
async function searchChannels() {
    const query = document.getElementById('searchInput').value.trim();

    if (!query) {
        loadChannels();
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/channels/search?q=${encodeURIComponent(query)}`);
        const data = await response.json();

        if (data.success) {
            currentChannels = data.data.channels;
            renderChannels(currentChannels);

            // Remove active class dos botões de categoria
            document.querySelectorAll('.category-btn').forEach(btn => btn.classList.remove('active'));
        }
    } catch (error) {
        console.error('Erro ao pesquisar canais:', error);
    }
}

// Configura pesquisa por Enter
function setupSearch() {
    document.getElementById('searchInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            searchChannels();
        }
    });
}

// Reproduz canal
function playChannel(channelId, channelName) {
    const modal = document.getElementById('videoModal');
    const frame = document.getElementById('videoFrame');

    frame.src = `${API_BASE}/channels/${channelId}/stream`;
    modal.style.display = 'block';
    
    document.querySelector('.modal-content').appendChild(title);
}

// Configura modal
function setupModal() {
    const modal = document.getElementById('videoModal');
    const span = document.querySelector('.close');

    span.onclick = function () {
        modal.style.display = 'none';
        document.getElementById('videoFrame').src = '';
    }

    window.onclick = function (event) {
        if (event.target === modal) {
            modal.style.display = 'none';
            document.getElementById('videoFrame').src = '';
        }
    }
}

// Função para alternar detalhes do servidor
function toggleServerDetails() {
    let details = document.getElementById('serverDetails');

    if (!details) {
        // Se não existir, fazer uma verificação manual para criar
        checkServerHealth(true);
    } else {
        // Se existir, alternar visibilidade
        details.classList.toggle('expanded');
    }
}
