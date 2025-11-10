# LIDAR Viewer

Une application web pour visualiser et analyser des données LIDAR (LAS, LAZ, COPC.LAZ). Ce projet permet de charger des nuages de points 3D et de les visualiser à l'aide de React Three Fiber (R3F).

## Fonctionnalités

- Visualisation de fichiers LIDAR au format R3F JSON (converti à partir de LAS/LAZ)
- Support pour les grands ensembles de données via le downsampling
- Interface utilisateur intuitive pour afficher les nuages de points
- Contrôles de caméra interactifs

## Prérequis

Pour utiliser cette application, vous aurez besoin de :

- [Node.js](https://nodejs.org/) (version 14 ou supérieure)
- [Yarn](https://yarnpkg.com/) ou [npm](https://www.npmjs.com/)

Pour le traitement des fichiers LIDAR :
- [PDAL](https://pdal.io/en/latest/download.html) - Point Data Abstraction Library

## Installation

1. Cloner ce dépôt :
   ```bash
   git clone https://github.com/votre-nom/lidar-viewer.git
   cd lidar-viewer
   ```

2. Installer les dépendances :
   ```bash
   yarn install
   # ou
   npm install
   ```

3. Lancer l'application en développement :
   ```bash
   yarn dev
   # ou
   npm run dev
   ```

4. Ouvrir votre navigateur à l'adresse `http://localhost:5173`

## Utilisation des fichiers LIDAR

### Formats supportés

L'application est optimisée pour utiliser les fichiers convertis au format R3F JSON :

- **Format R3F JSON** : Un format de données converti à partir de LAS/LAZ pour une utilisation efficace avec React Three Fiber

### Outils de prétraitement

Le projet inclut des scripts Node.js pour prétraiter les fichiers LIDAR complexes ou volumineux :

1. Placez vos fichiers LIDAR (LAS/LAZ/COPC.LAZ) dans le dossier `public/data/`

2. Exécutez l'outil de traitement :
   ```bash
   node scripts/lidar-tools.js
   ```

3. Suivez les instructions à l'écran pour convertir vos fichiers dans les formats appropriés

Pour plus d'informations, consultez la [documentation des scripts](scripts/README.md).

## Déploiement sur GitHub Pages

Le projet est configuré pour être déployé automatiquement sur GitHub Pages via GitHub Actions.

### Activation

1. **Activez GitHub Pages dans les paramètres du dépôt** :
   - Allez dans Settings → Pages
   - Source : sélectionnez "GitHub Actions"

2. **Poussez vos changements** :
   ```bash
   git add .
   git commit -m "Configure GitHub Pages deployment"
   git push
   ```

3. **Le workflow se déclenchera automatiquement** et déploiera votre application sur :
   `https://vaxelben.github.io/lidar-viewer/`

### Fichiers volumineux (Git LFS)

Les fichiers `.copc.laz` volumineux sont gérés avec Git LFS. Le workflow GitHub Actions télécharge automatiquement ces fichiers lors du déploiement.

**Note** : Si vous avez un compte GitHub gratuit, vous disposez de :
- 1 GB de stockage Git LFS
- 1 GB de bande passante par mois

Pour plus de détails, consultez [DEPLOYMENT.md](./DEPLOYMENT.md).

## Guide de développement

Si vous souhaitez étendre cette application :

- Les composants React se trouvent dans `src/components/`
- Les scripts de traitement sont dans `scripts/`

## Licences et crédits

Ce projet est sous licence MIT.

Il utilise les bibliothèques suivantes :
- [Three.js](https://threejs.org/) pour la visualisation 3D
- [React Three Fiber](https://docs.pmnd.rs/react-three-fiber/getting-started/introduction) pour l'intégration de Three.js avec React
- [PDAL](https://pdal.io/) pour le traitement des données LIDAR

## Capture d'écran

![Screenshot de l'application](./screenshot.png)
