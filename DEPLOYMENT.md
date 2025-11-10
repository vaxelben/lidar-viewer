# Guide de Déploiement sur GitHub Pages

Ce guide explique comment déployer votre visualiseur LiDAR sur GitHub Pages lorsque vos fichiers de données sont trop volumineux pour être stockés directement dans le dépôt.

## Problème

Les fichiers `.copc.laz` dans `public/data/metz/` sont trop volumineux pour être stockés dans GitHub. GitHub a des limitations :
- 100 MB par fichier
- 1 GB par dépôt (recommandé)
- GitHub Pages a également des limitations de taille

## Solution

Le projet est maintenant configuré pour charger les fichiers de données depuis une source externe (CDN, service de stockage, etc.) au lieu du dossier `public` local.

## Configuration

### 1. Fichier de configuration

Le fichier `public/data-config.json` permet de configurer l'URL de base pour les fichiers de données :

```json
{
  "dataBaseUrl": "",
  "description": "...",
  "examples": {
    "local": "",
    "githubReleases": "https://github.com/votre-username/votre-repo/releases/download/v1.0.0",
    "awsS3": "https://votre-bucket.s3.amazonaws.com/lidar-data",
    "googleCloudStorage": "https://storage.googleapis.com/votre-bucket/lidar-data",
    "cloudflareR2": "https://votre-compte.r2.cloudflarestorage.com/lidar-data",
    "jsdelivr": "https://cdn.jsdelivr.net/gh/votre-username/votre-repo@main/data"
  }
}
```

### 2. Options de stockage

#### Option A : GitHub Releases (Gratuit, simple)

1. Créez une release sur GitHub
2. Téléversez vos fichiers `.copc.laz` comme assets de la release
3. Configurez `dataBaseUrl` dans `data-config.json` :
   ```json
   {
     "dataBaseUrl": "https://github.com/votre-username/votre-repo/releases/download/v1.0.0"
   }
   ```

**Note** : Les fichiers doivent être téléchargés individuellement, ce qui peut être lent.

#### Option B : AWS S3 (Payant, mais très performant)

1. Créez un bucket S3
2. Activez le CORS pour permettre les requêtes depuis votre site
3. Téléversez vos fichiers dans le bucket
4. Configurez `dataBaseUrl` :
   ```json
   {
     "dataBaseUrl": "https://votre-bucket.s3.amazonaws.com/lidar-data"
   }
   ```

**Configuration CORS pour S3** :
```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["Content-Range", "Content-Length"]
  }
]
```

#### Option C : Cloudflare R2 (Gratuit jusqu'à 10 GB, compatible S3)

1. Créez un compte Cloudflare R2
2. Créez un bucket
3. Téléversez vos fichiers
4. Configurez `dataBaseUrl` :
   ```json
   {
     "dataBaseUrl": "https://votre-compte.r2.cloudflarestorage.com/lidar-data"
   }
   ```

#### Option D : Google Cloud Storage (Payant, mais performant)

1. Créez un bucket GCS
2. Configurez les permissions publiques en lecture
3. Téléversez vos fichiers
4. Configurez `dataBaseUrl` :
   ```json
   {
     "dataBaseUrl": "https://storage.googleapis.com/votre-bucket/lidar-data"
   }
   ```

#### Option E : jsDelivr CDN (Gratuit, depuis un dépôt GitHub)

1. Créez un dépôt séparé pour les données
2. Téléversez vos fichiers dans ce dépôt
3. Configurez `dataBaseUrl` :
   ```json
   {
     "dataBaseUrl": "https://cdn.jsdelivr.net/gh/votre-username/donnees-repo@main/data"
   }
   ```

## Déploiement

### 1. Préparer les fichiers

Assurez-vous que les fichiers volumineux sont exclus du dépôt (déjà configuré dans `.gitignore`) :
```
/public/data/metz/
/public/data/boulay/
/public/data/strasbourg/
```

### 2. Configurer l'URL de base

Modifiez `public/data-config.json` avec l'URL de votre service de stockage.

### 3. Tester localement

```bash
npm run dev
```

Vérifiez que les fichiers se chargent correctement depuis l'URL configurée.

### 4. Déployer sur GitHub Pages

#### Avec GitHub Actions (Recommandé)

1. Créez un fichier `.github/workflows/deploy.yml` :
```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - uses: actions/deploy-pages@v4
```

2. Activez GitHub Pages dans les paramètres du dépôt :
   - Settings → Pages
   - Source : GitHub Actions

#### Avec gh-pages (Alternative)

```bash
npm install --save-dev gh-pages
```

Ajoutez dans `package.json` :
```json
{
  "scripts": {
    "deploy": "npm run build && gh-pages -d dist"
  }
}
```

Puis :
```bash
npm run deploy
```

## Structure des fichiers

Les fichiers doivent être organisés de la même manière que dans `public/data/` :

```
votre-service-storage/
  └── data/
      └── metz/
          ├── LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz
          ├── LHD_FXX_0927_6896_PTS_LAMB93_IGN69.copc.laz
          └── ...
```

## Vérification

Après le déploiement, vérifiez :

1. Ouvrez la console du navigateur (F12)
2. Vérifiez que les requêtes vers vos fichiers se font bien vers l'URL configurée
3. Vérifiez qu'il n'y a pas d'erreurs CORS
4. Vérifiez que les fichiers se chargent correctement

## Support des requêtes Range

⚠️ **Important** : Votre service de stockage doit supporter les requêtes HTTP Range (requêtes par plages d'octets). C'est nécessaire pour le chargement efficace des fichiers COPC.LAZ.

Les services suivants supportent les requêtes Range :
- ✅ AWS S3
- ✅ Cloudflare R2
- ✅ Google Cloud Storage
- ✅ GitHub Releases (limité)
- ✅ jsDelivr CDN

## Dépannage

### Erreur CORS

Si vous voyez des erreurs CORS, configurez les en-têtes appropriés sur votre service de stockage :
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, HEAD`
- `Access-Control-Expose-Headers: Content-Range, Content-Length`

### Fichiers non trouvés

Vérifiez que :
1. L'URL dans `data-config.json` est correcte
2. Les fichiers sont bien téléversés au bon emplacement
3. Les permissions de lecture sont correctement configurées

### Chargement lent

- Utilisez un CDN (Cloudflare, jsDelivr)
- Activez la compression sur votre service de stockage
- Vérifiez que les requêtes Range fonctionnent correctement

