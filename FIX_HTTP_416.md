# 🔧 Correction de l'erreur HTTP 416

## 📋 Résumé du problème

**Erreur rencontrée** : `HTTP error! status: 416` lors du chargement des fichiers COPC LAZ

**Cause** : GitHub Pages ne supporte pas Git LFS. Seuls les pointeurs LFS (petits fichiers texte) sont déployés au lieu des vrais fichiers volumineux. Quand l'application fait une requête de plage (Range request) pour lire une partie du fichier, le serveur ne peut pas satisfaire la requête.

## ✅ Solution implémentée

**Hébergement des fichiers sur GitHub Releases** (gratuit, illimité en taille)

### 📝 Changements effectués

1. **`.github/workflows/deploy.yml`** - Workflow mis à jour :
   - ✅ Ajout de la gestion de concurrence pour éviter les artifacts multiples
   - ✅ Séparation en 2 jobs (build + deploy)
   - ✅ Configuration automatique de `data-config.json` pour pointer vers GitHub Releases
   - ✅ Suppression du checkout LFS (plus nécessaire)

2. **`HEBERGEMENT_DONNEES.md`** - Guide complet créé :
   - 📖 Documentation de 4 solutions d'hébergement
   - 📖 Instructions détaillées pour chaque option
   - 📖 FAQ et dépannage

3. **`upload-to-github-releases.ps1`** - Script d'automatisation créé :
   - 🤖 Upload automatique de tous les fichiers `.copc.laz`
   - 🤖 Création automatique de la release si nécessaire
   - 🤖 Gestion des erreurs et des réessais

4. **`README.md`** - Documentation mise à jour :
   - 📚 Section GitHub Releases ajoutée
   - 📚 Instructions d'installation de GitHub CLI
   - 📚 Référence au guide d'hébergement

## 🚀 Prochaines étapes

### Étape 1 : Installer GitHub CLI

```powershell
# Option 1 : avec winget
winget install --id GitHub.cli

# Option 2 : télécharger depuis
# https://cli.github.com/
```

Puis authentifiez-vous :
```powershell
gh auth login
```

### Étape 2 : Uploader les fichiers vers GitHub Releases

```powershell
.\upload-to-github-releases.ps1
```

Le script va :
- 🔍 Détecter tous les fichiers `.copc.laz` dans `public/data/`
- 📊 Afficher un résumé (nombre, taille totale)
- 📦 Créer la release `v1.0.0-data` si elle n'existe pas
- ⬆️ Uploader tous les fichiers vers GitHub Releases

**Durée estimée** : Dépend de votre connexion et de la taille des fichiers (quelques minutes à quelques heures)

### Étape 3 : Committer et pousser les changements

```powershell
git add .
git commit -m "Fix: Correction de l'erreur HTTP 416 - Hébergement sur GitHub Releases"
git push
```

### Étape 4 : Vérifier le déploiement

1. Allez dans l'onglet **Actions** de votre dépôt GitHub
2. Attendez que le workflow se termine (build + deploy)
3. Ouvrez votre application : `https://vaxelben.github.io/lidar-viewer/`
4. Les fichiers COPC LAZ devraient maintenant se charger correctement ! ✅

## 🧪 Test en local (optionnel)

Pour tester la configuration avant de pousser :

1. Modifiez `public/data-config.json` :
   ```json
   {
     "dataBaseUrl": "https://github.com/vaxelben/lidar-viewer/releases/download/v1.0.0-data"
   }
   ```

2. Lancez le serveur de dev :
   ```powershell
   yarn dev
   ```

3. Ouvrez `http://localhost:5173` et vérifiez que les fichiers se chargent

## 📊 Résumé des fichiers modifiés

```
Modifiés :
  - .github/workflows/deploy.yml  (workflow corrigé)
  - README.md                      (documentation mise à jour)

Créés :
  - HEBERGEMENT_DONNEES.md        (guide d'hébergement)
  - upload-to-github-releases.ps1 (script d'upload)
  - FIX_HTTP_416.md               (ce fichier)
```

## 🔗 Liens utiles

- **GitHub Releases du projet** : https://github.com/vaxelben/lidar-viewer/releases
- **GitHub CLI** : https://cli.github.com/
- **Guide d'hébergement complet** : [HEBERGEMENT_DONNEES.md](./HEBERGEMENT_DONNEES.md)

## ❓ Questions fréquentes

**Q : Combien de temps prend l'upload ?**  
R : Dépend de votre connexion. Pour référence : ~100 MB prend environ 1-2 minutes avec une bonne connexion.

**Q : Puis-je utiliser un autre service d'hébergement ?**  
R : Oui ! Consultez [HEBERGEMENT_DONNEES.md](./HEBERGEMENT_DONNEES.md) pour les alternatives (Cloudflare R2, AWS S3, Google Cloud Storage).

**Q : Les fichiers seront-ils encore dans Git LFS ?**  
R : Oui, vous pouvez les garder dans LFS pour le versioning local, mais ils seront servis depuis GitHub Releases en production.

**Q : Ça coûte quelque chose ?**  
R : Non ! GitHub Releases est gratuit sans limite de taille (seulement 2 GB max par fichier via l'interface web, mais illimité via CLI).

## ⚠️ Attention

- Le tag de release doit correspondre à celui dans le workflow : `v1.0.0-data`
- Les fichiers doivent respecter la structure : `data/ville/fichier.copc.laz`
- GitHub Releases supporte les requêtes de plage (Range requests), nécessaires pour COPC

## 🎉 Après la correction

Une fois tout en place, votre application pourra :
- ✅ Charger les fichiers COPC LAZ depuis GitHub Releases
- ✅ Faire des requêtes de plage pour un chargement efficace
- ✅ Afficher les nuages de points sans erreur HTTP 416
- ✅ Fonctionner parfaitement sur GitHub Pages

---

**Besoin d'aide ?** Consultez [HEBERGEMENT_DONNEES.md](./HEBERGEMENT_DONNEES.md) pour plus de détails ou créez une issue sur GitHub.

