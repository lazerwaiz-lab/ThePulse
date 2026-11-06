// config.js
const API_CONFIG = {
    // Si l'URL contient "localhost" ou "127.0.0.1", on est en local, sinon en prod
    API_BASE_URL: (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? 'http://localhost:3000'                  // URL en local
        : 'https://api.ton-domaine-de-production.com' // URL en production
};

// Rend la configuration accessible globalement
window.API_BASE_URL = API_CONFIG.API_BASE_URL;