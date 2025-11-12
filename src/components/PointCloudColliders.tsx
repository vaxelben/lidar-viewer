import { useMemo, useRef } from 'react';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import * as THREE from 'three';
import { nodeDataCache } from './DirectLazViewer';

interface PointCloudCollidersProps {
  nodesToRender: { fileUrl: string; nodeKey: string; level: number; distance: number }[];
  globalBounds: { min: THREE.Vector3; max: THREE.Vector3 };
  pointSize: number; // Taille des points affichés (non utilisé mais gardé pour compatibilité)
  visible?: boolean; // Afficher ou masquer le mesh visuel (les collisions restent actives)
}

export function PointCloudColliders({ nodesToRender, globalBounds, visible = false }: PointCloudCollidersProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  // Ref pour stocker les nodes de niveau 0 une fois qu'ils sont chargés (ne jamais les mettre à jour)
  const level0NodesRef = useRef<Array<{ fileUrl: string; nodeKey: string; level: number; distance: number }>>([]);
  
  // Centre du nuage global pour centrer les positions
  const globalCenter = useMemo(() => new THREE.Vector3(
    (globalBounds.min.x + globalBounds.max.x) / 2,
    (globalBounds.min.y + globalBounds.max.y) / 2,
    (globalBounds.min.z + globalBounds.max.z) / 2
  ), [globalBounds]);

  // Stocker les nodes de niveau 1 (niveau le moins détaillé) une fois qu'ils sont disponibles (ne jamais les mettre à jour)
  // Utiliser un effet pour mettre à jour le ref quand des nodes de niveau 1 sont disponibles
  const currentLevel1 = nodesToRender.filter(node => node.level === 1);
  if (currentLevel1.length > 0 && level0NodesRef.current.length === 0) {
    level0NodesRef.current = currentLevel1;
    console.log(`[PointCloudColliders] ${currentLevel1.length} nodes de niveau 1 stockés pour la grille:`, currentLevel1.map(n => n.nodeKey));
  }
  
  // Log pour déboguer
  if (currentLevel1.length === 0 && nodesToRender.length > 0) {
    const levels = [...new Set(nodesToRender.map(n => n.level))].sort();
    console.log(`[PointCloudColliders] Aucun node de niveau 1 trouvé. Niveaux disponibles: ${levels.join(', ')}`);
  }

  // Créer une grille déformée qui suit le relief des points
  // Utiliser uniquement le niveau le moins détaillé (niveau 1) et ne pas recalculer
  const gridGeometry = useMemo(() => {
    // Résolution de la grille (nombre de cellules par dimension)
    const GRID_RESOLUTION = 100;
    
    // Taille de la zone couverte par les points
    const sizeX = globalBounds.max.x - globalBounds.min.x;
    const sizeY = globalBounds.max.y - globalBounds.min.y;
    const cellSizeX = sizeX / GRID_RESOLUTION;
    const cellSizeY = sizeY / GRID_RESOLUTION;
    
    // Utiliser les nodes de niveau 1 stockés dans le ref (ne changent jamais après le premier chargement)
    const lowestLevelNodes = level0NodesRef.current;
    
    if (lowestLevelNodes.length === 0) {
      console.log('[PointCloudColliders] Aucun node de niveau 1 trouvé, grille non créée');
      return null;
    }
    
    // Collecter uniquement les points avec classification "Sol" (2) du niveau 1
    const GROUND_CLASSIFICATION = 2; // Classification pour "Sol"
    const allPoints: Array<{ x: number; y: number; z: number }> = [];
    let totalPointsAvailable = 0;
    let totalGroundPoints = 0;
    
    // Compter d'abord le nombre total de points du niveau 1 avec classification "Sol"
    for (const { fileUrl, nodeKey } of lowestLevelNodes) {
      const cacheKey = `${fileUrl}_${nodeKey}`;
      const nodeData = nodeDataCache.get(cacheKey);
      
      if (!nodeData) continue;
      
      const { positions, classifications } = nodeData;
      const pointCount = positions.length / 3;
      
      // Compter les points avec classification "Sol"
      for (let i = 0; i < pointCount; i++) {
        if (classifications[i] === GROUND_CLASSIFICATION) {
          totalGroundPoints++;
        }
      }
      totalPointsAvailable += pointCount;
    }
    
    // Échantillonner les points (limiter pour les performances)
    const MAX_POINTS_FOR_GRID = 10000;
    const samplingStep = Math.max(1, Math.floor(totalGroundPoints / MAX_POINTS_FOR_GRID));
    
    // Échantillonner uniquement les points avec classification "Sol" du niveau 1
    for (const { fileUrl, nodeKey } of lowestLevelNodes) {
      const cacheKey = `${fileUrl}_${nodeKey}`;
      const nodeData = nodeDataCache.get(cacheKey);
      
      if (!nodeData) continue;
      
      const { positions, classifications } = nodeData;
      const pointCount = positions.length / 3;
      
      // Filtrer et échantillonner uniquement les points avec classification "Sol"
      let sampledCount = 0;
      for (let i = 0; i < pointCount; i++) {
        if (classifications[i] === GROUND_CLASSIFICATION) {
          // Prendre un point sur samplingStep parmi les points "Sol"
          if (sampledCount % samplingStep === 0) {
            allPoints.push({
              x: positions[i * 3],
              y: positions[i * 3 + 1],
              z: positions[i * 3 + 2]
            });
          }
          sampledCount++;
        }
      }
    }
    
    if (allPoints.length === 0) {
      console.log(`[PointCloudColliders] Aucun point avec classification "Sol" (${GROUND_CLASSIFICATION}) trouvé dans le niveau 1`);
      return null;
    }
    
    console.log(`[PointCloudColliders] ${allPoints.length} points "Sol" échantillonnés du niveau 1 (sur ${totalGroundPoints} points "Sol" disponibles, ${totalPointsAvailable} points totaux) pour créer la grille`);
    
    // Créer une grille de hauteurs
    const heightMap: number[][] = [];
    const searchRadius = Math.max(cellSizeX, cellSizeY) * 1.5; // Rayon de recherche pour chaque cellule
    
    for (let gy = 0; gy <= GRID_RESOLUTION; gy++) {
      heightMap[gy] = [];
      for (let gx = 0; gx <= GRID_RESOLUTION; gx++) {
        // Position mondiale de la cellule
        const worldX = globalBounds.min.x + (gx / GRID_RESOLUTION) * sizeX;
        const worldY = globalBounds.min.y + (gy / GRID_RESOLUTION) * sizeY;
        
        // Trouver les points proches de cette cellule
        const nearbyPoints: number[] = [];
        for (const point of allPoints) {
          const dx = point.x - worldX;
          const dy = point.y - worldY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance < searchRadius) {
            nearbyPoints.push(point.z);
          }
        }
        
        // Calculer la hauteur des points proches
        // Utiliser la hauteur moyenne au lieu de minimale pour être au niveau des points visibles
        if (nearbyPoints.length > 0) {
          // Calculer la moyenne des hauteurs
          const sum = nearbyPoints.reduce((acc, z) => acc + z, 0);
          const avgHeight = sum / nearbyPoints.length;
          heightMap[gy][gx] = avgHeight;
        } else {
          // Si aucun point proche, utiliser la hauteur moyenne globale
          heightMap[gy][gx] = (globalBounds.min.z + globalBounds.max.z) / 2;
        }
      }
    }
    
    // Créer la géométrie de la grille déformée
    const geometry = new THREE.PlaneGeometry(sizeX, sizeY, GRID_RESOLUTION, GRID_RESOLUTION);
    const positions = geometry.attributes.position;
    
    // Déformer la géométrie selon la height map
    // PlaneGeometry est centrée par défaut, donc x et y vont de -size/2 à +size/2
    for (let i = 0; i < positions.count; i++) {
      const localX = positions.getX(i);
      const localY = positions.getY(i);
      
      // Convertir les coordonnées locales (-size/2 à +size/2) en coordonnées mondiales
      const worldX = globalCenter.x + localX;
      const worldY = globalCenter.y + localY;
      
      // Convertir en indices de grille
      const gx = Math.round(((worldX - globalBounds.min.x) / sizeX) * GRID_RESOLUTION);
      const gy = Math.round(((worldY - globalBounds.min.y) / sizeY) * GRID_RESOLUTION);
      
      const clampedGx = Math.max(0, Math.min(GRID_RESOLUTION, gx));
      const clampedGy = Math.max(0, Math.min(GRID_RESOLUTION, gy));
      
      // Définir la hauteur Z selon la height map (centrée)
      const height = heightMap[clampedGy][clampedGx] - globalCenter.z;
      
      // Les positions X et Y sont déjà centrées (PlaneGeometry est centré par défaut)
      positions.setZ(i, height);
    }
    
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    
    // Calculer les statistiques de hauteur pour le débogage
    const heights: number[] = [];
    for (let gy = 0; gy <= GRID_RESOLUTION; gy++) {
      for (let gx = 0; gx <= GRID_RESOLUTION; gx++) {
        heights.push(heightMap[gy][gx]);
      }
    }
    const minHeight = Math.min(...heights);
    const maxHeight = Math.max(...heights);
    const avgHeight = heights.reduce((a, b) => a + b, 0) / heights.length;
    
    console.log(`[PointCloudColliders] Grille créée: ${GRID_RESOLUTION}x${GRID_RESOLUTION} cellules`);
    console.log(`[PointCloudColliders] Statistiques de hauteur: min=${minHeight.toFixed(2)}, max=${maxHeight.toFixed(2)}, avg=${avgHeight.toFixed(2)}`);
    console.log(`[PointCloudColliders] GlobalBounds Z: min=${globalBounds.min.z.toFixed(2)}, max=${globalBounds.max.z.toFixed(2)}, center=${globalCenter.z.toFixed(2)}`);
    
    return geometry;
    // Ne dépendre que de globalBounds et globalCenter pour ne pas recalculer quand d'autres niveaux sont chargés
    // level0NodesRef.current est utilisé directement dans le useMemo et ne change jamais après le premier chargement
  }, [globalBounds, globalCenter]);

  // Extraire les vertices et indices pour TrimeshCollider
  const { vertices, indices } = useMemo(() => {
    if (!gridGeometry) return { vertices: null, indices: null };
    
    const positions = gridGeometry.attributes.position;
    const vertices = new Float32Array(positions.count * 3);
    
    for (let i = 0; i < positions.count; i++) {
      vertices[i * 3] = positions.getX(i);
      vertices[i * 3 + 1] = positions.getY(i);
      vertices[i * 3 + 2] = positions.getZ(i);
    }
    
    // Les indices sont déjà dans la géométrie
    const indexAttr = gridGeometry.index;
    const indices = indexAttr ? new Uint32Array(indexAttr.array) : null;
    
    return { vertices, indices };
  }, [gridGeometry]);

  if (!gridGeometry || !vertices || !indices) {
    console.log('[PointCloudColliders] Grille non créée ou données manquantes:', {
      gridGeometry: !!gridGeometry,
      vertices: !!vertices,
      indices: !!indices
    });
    return null;
  }

  console.log('[PointCloudColliders] Rendu de la grille:', {
    verticesCount: vertices.length / 3,
    indicesCount: indices.length,
    geometryBoundingBox: gridGeometry.boundingBox
  });

  return (
    <RigidBody type="fixed" colliders={false}>
      <TrimeshCollider args={[vertices, indices]} />
      {/* Le mesh visuel est conditionnel, mais le collider est toujours actif */}
      {visible && (
        <mesh ref={meshRef} geometry={gridGeometry}>
          <meshStandardMaterial 
            color="#ff0000" 
            opacity={0.7} 
            transparent 
            wireframe={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
    </RigidBody>
  );
}
