# Reconstruction 3D de Metz - Pipeline Complet

Guide pour transformer vos nuages de points .copc.laz en modèles 3D affichables dans React Three Fiber.

## 📋 Vue d'ensemble

```
.copc.laz (Nuages de points)
    ↓
[Backend Python]
    ├─ Extraction des bâtiments (classification)
    ├─ Segmentation (DBSCAN)
    ├─ Reconstruction (RANSAC)
    └─ Export .glb
        ↓
[Frontend R3F]
    └─ Affichage 3D interactif
```

## 🗂️ Structure des fichiers

```
votre-projet/
├── public/
│   ├── data/
│   │   └── metz/
│   │       ├── zone1.copc.laz
│   │       ├── zone2.copc.laz
│   │       └── ...
│   └── models/              # ⬅️ Généré par Python
│       ├── buildings/
│       │   ├── building_0001.glb
│       │   ├── building_0002.glb
│       │   └── ...
│       ├── buildings_merged.glb
│       └── metadata.json
│
├── scripts/
│   └── process_metz_buildings.py
│
└── src/
    └── components/
        └── MetzBuildings.jsx
```

## 🚀 Étape 1: Installation Python

```bash
# Créer un environnement virtuel
python -m venv venv
source venv/bin/activate  # ou venv\Scripts\activate sur Windows

# Installer les dépendances
pip install open3d laspy numpy
```

### Versions recommandées
- Python 3.8+
- open3d >= 0.18.0
- laspy >= 2.5.0
- numpy >= 1.24.0

## 🔧 Étape 2: Traitement des nuages de points

```bash
# Lancer le script de traitement
python scripts/process_metz_buildings.py
```

### Ce que fait le script:

1. **Chargement** des fichiers .copc.laz depuis `/public/data/metz/`
2. **Filtrage** des points classifiés "Bâtiment" (classe 6)
3. **Segmentation** des bâtiments individuels (DBSCAN)
4. **Extraction** des plans avec RANSAC
5. **Reconstruction** des meshes 3D
6. **Export** en .glb (format optimisé Three.js)

### Paramètres ajustables

Dans `process_metz_buildings.py`, ligne 344:

```python
processor = MetzBuildingProcessor(
    input_dir="/public/data/metz",
    output_dir="/public/models",
    distance_threshold=0.3  # ⬅️ Ajuster selon la densité du nuage
)
```

**`distance_threshold`** (seuil RANSAC):
- `0.1-0.2m`: Nuages très denses, bâtiments modernes
- `0.3-0.5m`: Nuages moyens (recommandé)
- `0.5-1.0m`: Nuages peu denses, anciens relevés

### Sorties générées

**1. Fichiers GLB individuels**
```
/public/models/buildings/building_0001.glb
/public/models/buildings/building_0002.glb
...
```
- Un fichier par bâtiment
- Idéal pour chargement à la demande
- ~10-500 Ko par bâtiment selon complexité

**2. Fichier merged**
```
/public/models/buildings_merged.glb
```
- Tous les bâtiments en un seul fichier
- Plus rapide pour petites scènes (<100 bâtiments)
- ~1-50 Mo selon le nombre de bâtiments

**3. Métadonnées JSON**
```json
{
  "buildings": [
    {
      "id": "building_0001",
      "num_points": 5234,
      "num_planes": 6,
      "bbox_min": [6.1234, 49.1234, 150.5],
      "bbox_max": [6.1256, 49.1256, 165.2],
      "center": [6.1245, 49.1245, 157.8],
      "area_m2": 245.6,
      "height_m": 14.7
    },
    ...
  ],
  "total_buildings": 42,
  "processing_params": {...}
}
```

## 🎨 Étape 3: Intégration dans R3F

### Installation des dépendances React

```bash
npm install three @react-three/fiber @react-three/drei
# ou
yarn add three @react-three/fiber @react-three/drei
```

### Option 1: Fichier merged (Simple)

**Recommandé pour:** <100 bâtiments, performances optimales

```jsx
import { Canvas } from '@react-three/fiber';
import { useGLTF, OrbitControls } from '@react-three/drei';

function MetzScene() {
  const { scene } = useGLTF('/models/buildings_merged.glb');
  
  return (
    <Canvas>
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 5]} />
      <OrbitControls />
      <primitive object={scene} />
    </Canvas>
  );
}

// Précharger pour de meilleures performances
useGLTF.preload('/models/buildings_merged.glb');
```

### Option 2: Bâtiments individuels (Flexible)

**Recommandé pour:** >100 bâtiments, interaction par bâtiment

```jsx
import { useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';

function Building({ id, onClick }) {
  const { scene } = useGLTF(`/models/buildings/${id}.glb`);
  
  return (
    <primitive 
      object={scene.clone()}
      onClick={() => onClick(id)}
    />
  );
}

function MetzScene() {
  const [metadata, setMetadata] = useState(null);
  
  useEffect(() => {
    fetch('/models/metadata.json')
      .then(r => r.json())
      .then(setMetadata);
  }, []);
  
  if (!metadata) return <div>Loading...</div>;
  
  return (
    <Canvas>
      <ambientLight />
      <directionalLight position={[10, 10, 5]} />
      <OrbitControls />
      
      {metadata.buildings.map(building => (
        <Building
          key={building.id}
          id={building.id}
          onClick={(id) => console.log('Clicked:', id)}
        />
      ))}
    </Canvas>
  );
}
```

### Option 3: Chargement progressif (Optimal)

**Recommandé pour:** Grandes scènes, centaines de bâtiments

```jsx
function MetzScene() {
  const [visibleBuildings, setVisibleBuildings] = useState([]);
  const [metadata, setMetadata] = useState(null);
  
  useEffect(() => {
    fetch('/models/metadata.json')
      .then(r => r.json())
      .then(data => {
        setMetadata(data);
        // Charger les 20 premiers
        setVisibleBuildings(data.buildings.slice(0, 20));
      });
  }, []);
  
  const loadMore = () => {
    const current = visibleBuildings.length;
    const next = metadata.buildings.slice(current, current + 20);
    setVisibleBuildings([...visibleBuildings, ...next]);
  };
  
  return (
    <>
      <Canvas>
        {/* ... */}
        {visibleBuildings.map(b => (
          <Building key={b.id} id={b.id} />
        ))}
      </Canvas>
      
      <button onClick={loadMore}>
        Charger plus ({visibleBuildings.length}/{metadata.total_buildings})
      </button>
    </>
  );
}
```

## 🎯 Utilisation dans votre App.jsx

```jsx
import { MetzBuildingsViewer } from './components/MetzBuildings';

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <MetzBuildingsViewer />
    </div>
  );
}
```

## ⚡ Optimisations

### 1. Préchargement des assets

```javascript
import { useGLTF } from '@react-three/drei';

// En dehors du composant
useGLTF.preload('/models/buildings_merged.glb');
```

### 2. Compression des GLB

Après génération, compresser avec gltf-pipeline:

```bash
npm install -g gltf-pipeline

# Compresser un fichier
gltf-pipeline -i building_0001.glb -o building_0001_compressed.glb -d
```

Économie typique: 30-50% de taille

### 3. Level of Detail (LOD)

Générer plusieurs versions avec différents niveaux de détail:

```python
# Dans process_metz_buildings.py, ajouter:
def create_lod_meshes(mesh, levels=[1.0, 0.5, 0.25]):
    """Crée plusieurs LOD"""
    lods = []
    for level in levels:
        simplified = mesh.simplify_quadric_decimation(
            target_number_of_triangles=int(len(mesh.triangles) * level)
        )
        lods.append(simplified)
    return lods
```

### 4. Frustum Culling

Ne charger que les bâtiments visibles:

```jsx
import { useFrustumCulling } from '@react-three/drei';

function Building({ position, id }) {
  const isVisible = useFrustumCulling(position, 10); // rayon 10m
  
  if (!isVisible) return null;
  
  return <primitive object={...} />;
}
```

## 🐛 Résolution de problèmes

### Problème: "Aucun point de bâtiment trouvé"

**Solution:** Vérifier les classifications dans vos fichiers LAZ

```python
# Ajouter dans le script pour débugger:
print("Classes uniques:", np.unique(classifications))
print("Distribution:", np.bincount(classifications))

# Si classe 6 absente, essayer d'autres classes:
# Classe 2: Sol
# Classe 5: Végétation haute
# Classe 6: Bâtiment (standard)
# Classe 17: Pont
```

### Problème: Meshes avec trous ou artefacts

**Solution:** Ajuster `distance_threshold`

```python
# Augmenter pour nuages peu denses
distance_threshold=0.5  # au lieu de 0.3

# Ou augmenter min_points_per_plane
min_points_per_plane=100  # au lieu de 50
```

### Problème: Performance lente dans R3F

**Solutions:**
1. Utiliser le fichier merged au lieu des individuels
2. Activer les Suspense boundaries
3. Réduire le nombre de triangles (simplification)
4. Utiliser le chargement progressif

```jsx
// Suspense pour loading async
<Suspense fallback={<Loader />}>
  <Buildings />
</Suspense>
```

## 📊 Métriques de performance attendues

**Traitement Python:**
- 1M points: ~5 secondes
- 10M points: ~30-60 secondes
- 100M points: ~5-10 minutes

**Affichage R3F:**
- 10 bâtiments (merged): 60 FPS
- 100 bâtiments (merged): 30-60 FPS
- 1000 bâtiments (LOD): 30+ FPS

## 🔗 Formats alternatifs

Si GLB pose problème:

```python
# Export OBJ + MTL
o3d.io.write_triangle_mesh("building.obj", mesh)

# Export PLY (avec couleurs)
o3d.io.write_triangle_mesh("building.ply", mesh)

# Export STL (pour impression 3D)
o3d.io.write_triangle_mesh("building.stl", mesh)
```

Chargement dans R3F:

```jsx
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader';
```

## 📚 Ressources additionnelles

- [Three.js Documentation](https://threejs.org/docs/)
- [React Three Fiber](https://docs.pmnd.rs/react-three-fiber)
- [Open3D Documentation](http://www.open3d.org/docs/)
- [COPC Specification](https://copc.io/)
- [LAS Classification Codes](https://desktop.arcgis.com/en/arcmap/latest/manage-data/las-dataset/lidar-point-classification.htm)

## ⏭️ Prochaines étapes

1. **Textures:** Ajouter des textures photoréalistes
2. **Éclairage:** Simuler l'éclairage du soleil selon l'heure
3. **Interactions:** Clic sur bâtiments pour afficher infos
4. **LoD automatique:** Basculer selon distance caméra
5. **API REST:** Servir les bâtiments par zone géographique
