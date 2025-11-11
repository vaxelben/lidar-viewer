/**
 * Utilitaire pour résoudre les URLs des fichiers de données LiDAR
 * Permet de charger les fichiers depuis une source externe (CDN, S3, etc.)
 * ou depuis le dossier public local si aucune URL de base n'est configurée
 */

interface DataConfig {
  dataBaseUrl: string;
  description?: string;
  examples?: Record<string, string>;
}

let cachedConfig: DataConfig | null = null;

/**
 * Charge la configuration depuis le fichier data-config.json
 */
async function loadDataConfig(): Promise<DataConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    // Utiliser import.meta.env.BASE_URL pour supporter le base path de GitHub Pages
    const baseUrl = import.meta.env.BASE_URL || '/';
    const configPath = `${baseUrl}data-config.json`.replace(/\/+/g, '/'); // Normaliser les slashes
    const response = await fetch(configPath);
    if (!response.ok) {
      console.warn('Impossible de charger data-config.json, utilisation de la configuration par défaut');
      cachedConfig = { dataBaseUrl: '' };
      return cachedConfig;
    }
    const config = await response.json() as DataConfig;
    cachedConfig = config;
    return config;
  } catch (error) {
    console.warn('Erreur lors du chargement de data-config.json:', error);
    cachedConfig = { dataBaseUrl: '' };
    return cachedConfig;
  }
}

/**
 * Extrait le nom du fichier depuis un chemin (pour GitHub Releases)
 * GitHub Releases stocke les fichiers à la racine, pas dans une structure de dossiers
 * @param path Chemin du fichier (ex: '/data/metz/file.copc.laz' ou 'data/metz/file.copc.laz')
 * @returns Nom du fichier uniquement (ex: 'file.copc.laz')
 */
function extractFileName(path: string): string {
  // Enlever le slash initial si présent
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  // Extraire le nom du fichier (dernière partie après le dernier slash)
  const parts = cleanPath.split('/');
  return parts[parts.length - 1];
}

/**
 * Ajoute un proxy CORS si nécessaire pour les URLs GitHub Releases
 * GitHub Releases ne supporte pas CORS, donc on utilise un proxy
 * Note: Cloudflare R2, AWS S3, Google Cloud Storage supportent CORS nativement
 * @param url URL à vérifier et potentiellement proxifier
 * @returns URL avec proxy CORS si nécessaire
 */
function addCorsProxyIfNeeded(url: string): string {
  // Détecter si c'est une URL GitHub Releases (qui ne supporte pas CORS)
  if (url.includes('github.com') && url.includes('/releases/download/')) {
    // Utiliser corsproxy.io qui supporte les requêtes Range pour les fichiers binaires
    // Note: corsproxy.io transmet les headers Range correctement
    return `https://corsproxy.io/?${encodeURIComponent(url)}`;
  }
  
  // Pour Cloudflare R2, AWS S3, GCS, etc. : pas de proxy nécessaire (CORS natif)
  return url;
}

/**
 * Résout l'URL complète d'un fichier de données
 * @param relativePath Chemin relatif du fichier (ex: '/data/metz/file.copc.laz')
 * @returns URL complète du fichier (avec proxy CORS si nécessaire)
 */
export async function resolveDataUrl(relativePath: string): Promise<string> {
  const config = await loadDataConfig();
  
  // Si aucune URL de base n'est configurée, utiliser le chemin relatif avec le base path de Vite
  if (!config.dataBaseUrl || config.dataBaseUrl.trim() === '') {
    const baseUrl = import.meta.env.BASE_URL || '/';
    // Si le chemin commence par /, on le garde, sinon on l'ajoute au base path
    let url: string;
    if (relativePath.startsWith('/')) {
      url = `${baseUrl}${relativePath.slice(1)}`.replace(/\/+/g, '/');
    } else {
      url = `${baseUrl}${relativePath}`.replace(/\/+/g, '/');
    }
    return addCorsProxyIfNeeded(url);
  }

  // Construire l'URL complète
  const baseUrl = config.dataBaseUrl.endsWith('/') 
    ? config.dataBaseUrl.slice(0, -1) 
    : config.dataBaseUrl;
  
  // Pour GitHub Releases, utiliser uniquement le nom du fichier (pas le chemin)
  // car les fichiers sont uploadés à la racine de la release
  // Pour R2/S3/GCS, on peut aussi uploader à la racine OU conserver la structure
  const githubReleasesPattern = /github\.com\/.*\/releases\/download\//i;
  const isGitHubReleases = githubReleasesPattern.test(baseUrl);
  
  // Détecter Cloudflare R2 (optionnel - pour utiliser uniquement le nom de fichier)
  const isCloudflareR2 = baseUrl.includes('.r2.dev') || baseUrl.includes('r2.cloudflarestorage.com');
  
  console.log(`🔍 Résolution URL: baseUrl="${baseUrl}", isGitHubReleases=${isGitHubReleases}, isR2=${isCloudflareR2}, relativePath="${relativePath}"`);
  
  let filePath: string;
  if (isGitHubReleases || isCloudflareR2) {
    // Pour GitHub Releases et R2 : utiliser uniquement le nom du fichier
    filePath = extractFileName(relativePath);
    console.log(`✅ ${isGitHubReleases ? 'GitHub Releases' : 'Cloudflare R2'}: ${relativePath} -> ${filePath}`);
  } else {
    // Pour les autres sources (S3, GCS avec structure de dossiers), garder le chemin complet
    const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    filePath = cleanPath;
  }
  
  const url = `${baseUrl}/${filePath}`;
  const finalUrl = addCorsProxyIfNeeded(url);
  console.log(`📦 URL finale: ${finalUrl}`);
  return finalUrl;
}

/**
 * Résout plusieurs URLs en une seule fois
 * @param relativePaths Tableau de chemins relatifs
 * @returns Tableau d'URLs complètes (avec proxy CORS si nécessaire)
 */
export async function resolveDataUrls(relativePaths: string[]): Promise<string[]> {
  const config = await loadDataConfig();
  
  if (!config.dataBaseUrl || config.dataBaseUrl.trim() === '') {
    const baseUrl = import.meta.env.BASE_URL || '/';
    return relativePaths.map(path => {
      let url: string;
      if (path.startsWith('/')) {
        url = `${baseUrl}${path.slice(1)}`.replace(/\/+/g, '/');
      } else {
        url = `${baseUrl}${path}`.replace(/\/+/g, '/');
      }
      return addCorsProxyIfNeeded(url);
    });
  }

  const baseUrl = config.dataBaseUrl.endsWith('/') 
    ? config.dataBaseUrl.slice(0, -1) 
    : config.dataBaseUrl;

  // Pour GitHub Releases et Cloudflare R2, utiliser uniquement le nom du fichier
  const githubReleasesPattern = /github\.com\/.*\/releases\/download\//i;
  const isGitHubReleases = githubReleasesPattern.test(baseUrl);
  const isCloudflareR2 = baseUrl.includes('.r2.dev') || baseUrl.includes('r2.cloudflarestorage.com');

  return relativePaths.map(path => {
    let filePath: string;
    if (isGitHubReleases || isCloudflareR2) {
      filePath = extractFileName(path);
    } else {
      // Pour les autres sources (S3, GCS avec structure de dossiers), garder le chemin complet
      const cleanPath = path.startsWith('/') ? path.slice(1) : path;
      filePath = cleanPath;
    }
    const url = `${baseUrl}/${filePath}`;
    return addCorsProxyIfNeeded(url);
  });
}

