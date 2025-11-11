# 🌐 Configuration Cloudflare R2 pour les fichiers COPC LAZ

## ✅ Avantages de Cloudflare R2
- 🆓 **Gratuit** jusqu'à 10 GB de stockage
- 🚀 **Bande passante gratuite** (pas de frais d'egress)
- 🔒 **CORS natif** - fonctionne directement sans proxy
- ⚡ **Très rapide** - CDN global
- 🔧 **Compatible S3** - facile à utiliser

## 📋 Étapes de configuration

### 1. Créer un compte Cloudflare (gratuit)

1. Allez sur https://dash.cloudflare.com/sign-up
2. Créez un compte gratuit
3. Vérifiez votre email

### 2. Activer Cloudflare R2

1. Connectez-vous à https://dash.cloudflare.com/
2. Dans le menu latéral gauche, cliquez sur **R2**
3. Si c'est la première fois, cliquez sur **Get Started** (gratuit)
4. Acceptez les conditions

### 3. Créer un bucket R2

1. Dans la page R2, cliquez sur **Create bucket**
2. Donnez un nom à votre bucket, par exemple : `lidar-viewer-data`
   - Le nom doit être unique globalement
   - Utilisez uniquement des lettres minuscules, chiffres et tirets
3. Choisissez un emplacement proche de vos utilisateurs (ex: `Western Europe`)
4. Cliquez sur **Create bucket**

### 4. Configurer l'accès public au bucket

#### Option A : Domaine personnalisé R2.dev (Recommandé - Gratuit)

1. Dans votre bucket, cliquez sur l'onglet **Settings**
2. Descendez jusqu'à **Public Access**
3. Cliquez sur **Connect Domain**
4. Sélectionnez **R2.dev subdomain**
5. Cliquez sur **Enable R2.dev subdomain**
6. Notez l'URL générée, par exemple : `https://pub-xxxxx.r2.dev`

#### Option B : Domaine personnalisé (Si vous avez un domaine)

1. Dans **Settings** > **Public Access**
2. Cliquez sur **Connect Domain**
3. Entrez votre domaine (ex: `cdn.votre-domaine.com`)
4. Suivez les instructions DNS

### 5. Configurer CORS (Sécurisé)

Pour n'autoriser l'accès **uniquement depuis votre site GitHub Pages** :

1. Dans votre bucket, allez dans l'onglet **Settings**
2. Descendez jusqu'à **CORS Policy**
3. Cliquez sur **Add CORS policy**
4. Copiez-collez cette configuration **sécurisée** :

```json
[
  {
    "AllowedOrigins": ["https://vaxelben.github.io"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

5. Cliquez sur **Save**

⚠️ **Important** : 
- Cette configuration n'autorise que votre site `https://vaxelben.github.io`
- Les requêtes depuis d'autres domaines seront bloquées
- Pour tester en local (`http://localhost:5173`), ajoutez temporairement cette configuration de test :

```json
[
  {
    "AllowedOrigins": ["https://vaxelben.github.io"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  },
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

🔒 **Après avoir testé en local**, supprimez la règle localhost pour plus de sécurité.

### 6. Uploader vos fichiers COPC LAZ

#### Option A : Interface web (pour < 10 fichiers)

1. Dans votre bucket, cliquez sur **Upload**
2. Glissez-déposez vos fichiers `.copc.laz` depuis `public/data/metz/`
3. ⚠️ **Important** : Uploadez les fichiers **à la racine** du bucket, pas dans des sous-dossiers
4. Attendez la fin de l'upload

#### Option B : Wrangler CLI (pour beaucoup de fichiers - Recommandé)

1. **Installer Wrangler** (outil CLI de Cloudflare) :
   ```powershell
   npm install -g wrangler
   # ou
   yarn global add wrangler
   ```

2. **Authentifier Wrangler** :
   ```powershell
   wrangler login
   ```
   - Une page web s'ouvrira pour vous connecter

3. **Créer un script d'upload** (`upload-to-r2.ps1`) :
   ```powershell
   # Script pour uploader les fichiers vers Cloudflare R2
   param(
       [string]$BucketName = "lidar-viewer-data",
       [string]$DataFolder = "public\data\metz"
   )

   Write-Host "Upload des fichiers vers Cloudflare R2" -ForegroundColor Cyan
   Write-Host "=======================================" -ForegroundColor Cyan
   Write-Host ""

   # Lister tous les fichiers .copc.laz
   $lazFiles = Get-ChildItem -Path $DataFolder -Filter "*.copc.laz" -Recurse
   $totalFiles = $lazFiles.Count
   $uploadedCount = 0

   Write-Host "Fichiers trouvés: $totalFiles" -ForegroundColor Green
   Write-Host ""

   foreach ($file in $lazFiles) {
       $uploadedCount++
       $fileName = $file.Name
       Write-Host "[$uploadedCount/$totalFiles] Upload de $fileName..." -ForegroundColor White
       
       try {
           # Uploader le fichier à la racine du bucket
           wrangler r2 object put "$BucketName/$fileName" --file="$($file.FullName)" --content-type="application/octet-stream"
           Write-Host "  ✓ OK" -ForegroundColor Green
       } catch {
           Write-Host "  ✗ Erreur: $_" -ForegroundColor Red
       }
       Write-Host ""
   }

   Write-Host "=======================================" -ForegroundColor Cyan
   Write-Host "Upload terminé: $uploadedCount/$totalFiles fichiers" -ForegroundColor Green
   ```

4. **Exécuter le script** :
   ```powershell
   .\upload-to-r2.ps1 -BucketName "lidar-viewer-data"
   ```

### 7. Tester l'accès aux fichiers

1. Récupérez votre URL R2.dev (ex: `https://pub-xxxxx.r2.dev`)
2. Testez l'accès à un fichier dans votre navigateur :
   ```
   https://pub-xxxxx.r2.dev/LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz
   ```
3. Le fichier devrait se télécharger

### 8. Configurer votre application

1. **Ouvrez** `public/data-config.json`
2. **Remplacez** `dataBaseUrl` par votre URL R2.dev :
   ```json
   {
     "dataBaseUrl": "https://pub-xxxxx.r2.dev",
     "description": "Fichiers COPC LAZ hébergés sur Cloudflare R2"
   }
   ```
3. **Sauvegardez** le fichier

### 9. Mettre à jour le workflow GitHub Pages

1. **Ouvrez** `.github/workflows/deploy.yml`
2. **Modifiez** la section `Configure data URL` (ligne 43-52) :
   ```yaml
   - name: Configure data URL for Cloudflare R2
     run: |
       # Configurer l'URL de base pour pointer vers Cloudflare R2
       cat > dist/data-config.json << 'EOF'
       {
         "dataBaseUrl": "https://pub-xxxxx.r2.dev",
         "description": "Configuration pour les fichiers de données LiDAR hébergés sur Cloudflare R2"
       }
       EOF
       
       # Copier laz-perf.wasm (nécessaire pour la décompression LAZ)
       if [ -f "public/laz-perf.wasm" ]; then
         cp public/laz-perf.wasm dist/ 2>/dev/null || true
       fi
   ```
3. **Remplacez** `https://pub-xxxxx.r2.dev` par votre vraie URL R2.dev

### 10. Tester en local

1. **Rafraîchissez** votre navigateur (ou redémarrez `yarn dev`)
2. **Ouvrez la console** du navigateur
3. **Vérifiez** les logs - vous devriez voir :
   ```
   🔍 Résolution URL: baseUrl="https://pub-xxxxx.r2.dev", isGitHubReleases=false, ...
   📦 URL finale: https://pub-xxxxx.r2.dev/LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz
   ```
4. Les fichiers devraient se charger sans erreur CORS !

### 11. Déployer sur GitHub Pages

1. **Committez** les changements :
   ```powershell
   git add .
   git commit -m "Configure Cloudflare R2 for data hosting"
   git push
   ```
2. **Attendez** que le workflow GitHub Actions se termine
3. **Ouvrez** votre site : `https://vaxelben.github.io/lidar-viewer/`
4. Les fichiers devraient se charger depuis Cloudflare R2 ! 🎉

## 📊 Monitoring et gestion

### Vérifier l'utilisation

1. Allez dans votre bucket R2
2. L'onglet **Metrics** montre :
   - Espace de stockage utilisé
   - Nombre de requêtes
   - Bande passante (toujours gratuite !)

### Gérer les fichiers

- **Lister** : `wrangler r2 object list lidar-viewer-data`
- **Supprimer** : `wrangler r2 object delete lidar-viewer-data/fichier.copc.laz`
- **Télécharger** : `wrangler r2 object get lidar-viewer-data/fichier.copc.laz --file=fichier.copc.laz`

## ❓ FAQ

**Q : Combien coûte Cloudflare R2 ?**  
R : Gratuit jusqu'à 10 GB de stockage. Au-delà : $0.015/GB/mois (très peu cher). La bande passante est toujours gratuite.

**Q : Puis-je utiliser mon propre domaine ?**  
R : Oui ! Allez dans **Settings** > **Public Access** > **Connect Domain**

**Q : Les requêtes Range sont-elles supportées ?**  
R : Oui ! Cloudflare R2 supporte nativement les requêtes Range, nécessaires pour COPC.

**Q : Y a-t-il une limite de taille par fichier ?**  
R : Non, pas de limite pratique. Vos fichiers de ~170 MB sont parfaits.

**Q : Puis-je migrer de GitHub Releases vers R2 ?**  
R : Oui ! Uploadez simplement les fichiers sur R2 et changez `dataBaseUrl`. Les anciennes versions sur GitHub Releases resteront disponibles.

## 🎉 Résultat final

Après configuration, vous aurez :
- ✅ Fichiers hébergés gratuitement sur Cloudflare R2
- ✅ CORS fonctionnel (pas de proxy nécessaire)
- ✅ Chargement rapide grâce au CDN global
- ✅ Pas de limite de bande passante
- ✅ Interface web pour gérer vos fichiers

## 🔗 Liens utiles

- Dashboard Cloudflare R2 : https://dash.cloudflare.com/r2
- Documentation R2 : https://developers.cloudflare.com/r2/
- Wrangler CLI : https://developers.cloudflare.com/workers/wrangler/

