# 📦 Hébergement des Fichiers COPC LAZ

## ⚠️ Problème

GitHub Pages ne supporte pas Git LFS nativement. Les fichiers `.copc.laz` dans LFS ne sont pas déréférencés lors du déploiement, causant l'erreur HTTP 416.

## ✅ Solutions

### 🎯 Option 1 : GitHub Releases (Recommandé - Gratuit)

**Avantages :**
- Gratuit
- Pas de limite de taille par fichier
- Supporte les requêtes de plage (Range requests)
- Facile à mettre en place

**Étapes :**

1. **Créer une release sur GitHub**
   - Allez sur : https://github.com/vaxelben/lidar-viewer/releases/new
   - Tag : `v1.0.0-data`
   - Titre : `LIDAR Data Files`
   - Description : `Fichiers COPC LAZ pour le visualiseur LIDAR`

2. **Uploader vos fichiers**
   - Glissez-déposez tous vos fichiers `.copc.laz` depuis `public/data/`
   - Structure à respecter :
     ```
     data/metz/LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz
     data/boulay/LHD_FXX_0953_6903_PTS_LAMB93_IGN69.copc.laz
     data/strasbourg/LHD_FXX_1047_6842_PTS_LAMB93_IGN69.copc.laz
     ...
     ```
   
   ⚠️ **Important** : Créez un dossier compressé pour chaque ville ou uploadez fichier par fichier en respectant la structure.

3. **Publier la release**
   - Cliquez sur "Publish release"

4. **Le workflow est déjà configuré !**
   - Le fichier `.github/workflows/deploy.yml` a été mis à jour
   - Il pointe automatiquement vers : `https://github.com/vaxelben/lidar-viewer/releases/download/v1.0.0-data`
   - L'application chargera les fichiers depuis GitHub Releases

5. **Test**
   - Committez et pushez les changements
   - Le déploiement devrait maintenant fonctionner !

---

### 🌐 Option 2 : Cloudflare R2 (Alternative gratuite)

**Avantages :**
- 10 GB de stockage gratuit
- Bande passante sortante gratuite (pas de frais d'egress)
- Très rapide (CDN global)
- Compatible S3

**Étapes :**

1. **Créer un bucket Cloudflare R2**
   - Allez sur : https://dash.cloudflare.com/
   - R2 → Create bucket
   - Nom : `lidar-data`

2. **Configurer l'accès public**
   - Settings → Public Access → Enable
   - Notez l'URL publique : `https://pub-xxxxx.r2.dev`

3. **Uploader les fichiers**
   - Via l'interface web ou avec wrangler CLI :
   ```bash
   npx wrangler r2 object put lidar-data/data/metz/LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz --file=public/data/metz/LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz
   ```

4. **Mettre à jour `dist/data-config.json`**
   - Dans le workflow `.github/workflows/deploy.yml`, changez :
   ```json
   {
     "dataBaseUrl": "https://pub-xxxxx.r2.dev"
   }
   ```

---

### ☁️ Option 3 : AWS S3

**Avantages :**
- Très fiable
- Bon pour production
- Intégration facile

**Coût :**
- ~$0.023/GB/mois de stockage
- ~$0.09/GB de transfert sortant

**Étapes :**

1. **Créer un bucket S3**
   ```bash
   aws s3 mb s3://votre-lidar-data
   ```

2. **Configurer CORS**
   ```json
   [
     {
       "AllowedHeaders": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedOrigins": ["https://vaxelben.github.io"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```

3. **Uploader les fichiers**
   ```bash
   aws s3 sync public/data/ s3://votre-lidar-data/data/ --acl public-read
   ```

4. **Mettre à jour `dist/data-config.json`**
   ```json
   {
     "dataBaseUrl": "https://votre-lidar-data.s3.amazonaws.com"
   }
   ```

---

### 🗄️ Option 4 : Google Cloud Storage

Similaire à AWS S3, avec des prix comparables.

---

## 🔧 Modification du Workflow

Si vous choisissez une option autre que GitHub Releases, modifiez `.github/workflows/deploy.yml` :

```yaml
- name: Configure data URL
  run: |
    cat > dist/data-config.json << 'EOF'
    {
      "dataBaseUrl": "VOTRE_URL_ICI"
    }
    EOF
```

---

## 📝 Structure des Fichiers

Quelle que soit la solution choisie, respectez cette structure :

```
data/
  metz/
    LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz
  boulay/
    LHD_FXX_0953_6903_PTS_LAMB93_IGN69.copc.laz
    ...
  strasbourg/
    LHD_FXX_1047_6842_PTS_LAMB93_IGN69.copc.laz
    ...
```

L'application construira automatiquement les URLs :
```
{dataBaseUrl}/data/metz/LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz
```

---

## 🧪 Test en Local

Pour tester avec une URL externe :

1. Modifiez `public/data-config.json` :
   ```json
   {
     "dataBaseUrl": "https://votre-url.com"
   }
   ```

2. Lancez le serveur de dev :
   ```bash
   yarn dev
   ```

---

## ❓ FAQ

**Q : Puis-je mixer local et distant ?**  
R : Oui, si `dataBaseUrl` est vide, les fichiers sont chargés depuis `public/` en dev et `dist/` en prod.

**Q : Combien coûte GitHub Releases ?**  
R : Gratuit ! Pas de limite de taille par fichier, seulement 2 GB par fichier uploadé via l'interface web.

**Q : Mes fichiers sont très volumineux (>100 GB au total)**  
R : Utilisez Cloudflare R2 (10 GB gratuit) ou AWS S3/GCS.

**Q : Puis-je utiliser jsDeliv CDN ?**  
R : Non, jsDeliv ne supporte pas les requêtes de plage pour les gros fichiers.

