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
    const response = await fetch('/data-config.json');
    if (!response.ok) {
      console.warn('Impossible de charger data-config.json, utilisation de la configuration par défaut');
      cachedConfig = { dataBaseUrl: '' };
      return cachedConfig;
    }
    cachedConfig = await response.json();
    return cachedConfig;
  } catch (error) {
    console.warn('Erreur lors du chargement de data-config.json:', error);
    cachedConfig = { dataBaseUrl: '' };
    return cachedConfig;
  }
}

/**
 * Résout l'URL complète d'un fichier de données
 * @param relativePath Chemin relatif du fichier (ex: '/data/metz/file.copc.laz')
 * @returns URL complète du fichier
 */
export async function resolveDataUrl(relativePath: string): Promise<string> {
  const config = await loadDataConfig();
  
  // Si aucune URL de base n'est configurée, utiliser le chemin relatif tel quel
  if (!config.dataBaseUrl || config.dataBaseUrl.trim() === '') {
    return relativePath;
  }

  // Nettoyer le chemin relatif (enlever le slash initial si présent)
  const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  
  // Construire l'URL complète
  const baseUrl = config.dataBaseUrl.endsWith('/') 
    ? config.dataBaseUrl.slice(0, -1) 
    : config.dataBaseUrl;
  
  return `${baseUrl}/${cleanPath}`;
}

/**
 * Résout plusieurs URLs en une seule fois
 * @param relativePaths Tableau de chemins relatifs
 * @returns Tableau d'URLs complètes
 */
export async function resolveDataUrls(relativePaths: string[]): Promise<string[]> {
  const config = await loadDataConfig();
  
  if (!config.dataBaseUrl || config.dataBaseUrl.trim() === '') {
    return relativePaths;
  }

  const baseUrl = config.dataBaseUrl.endsWith('/') 
    ? config.dataBaseUrl.slice(0, -1) 
    : config.dataBaseUrl;

  return relativePaths.map(path => {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    return `${baseUrl}/${cleanPath}`;
  });
}

