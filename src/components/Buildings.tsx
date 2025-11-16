import React, { useEffect, useMemo, useState } from 'react';
import { OBJLoader } from 'three-stdlib';
import { RigidBody, TrimeshCollider } from '@react-three/rapier';
import * as THREE from 'three';
import { resolveDataUrl } from '../utils/dataUrlResolver';

interface BuildingsProps {
  // Props optionnelles pour personnaliser l'affichage si nécessaire
  visible?: boolean;
  showEdges?: boolean;
  edgeColor?: string;
  edgeThickness?: number;
  onLoadStart?: () => void;
  onLoadProgress?: (progress: number) => void;
  onLoadComplete?: () => void;
}

// Cache global pour le modèle OBJ chargé
const modelCache = new Map<string, THREE.Group>();
const loadingPromises = new Map<string, Promise<THREE.Group>>();

// Fonction pour charger le modèle OBJ manuellement
async function loadOBJModel(url: string, onProgress?: (progress: number) => void): Promise<THREE.Group> {
  // Vérifier le cache
  if (modelCache.has(url)) {
    console.log('[Buildings] Modèle récupéré du cache:', url);
    return modelCache.get(url)!;
  }
  
  // Vérifier si un chargement est déjà en cours
  if (loadingPromises.has(url)) {
    console.log('[Buildings] Attente du chargement en cours:', url);
    return loadingPromises.get(url)!;
  }
  
  // Créer une nouvelle promesse de chargement
  const loadingPromise = new Promise<THREE.Group>((resolve, reject) => {
    const loader = new OBJLoader();
    
    console.log('[Buildings] Début du chargement du modèle OBJ:', url);
    
    loader.load(
      url,
      (object) => {
        console.log('[Buildings] Modèle OBJ chargé avec succès');
        modelCache.set(url, object);
        loadingPromises.delete(url);
        resolve(object);
      },
      (progressEvent) => {
        if (progressEvent.lengthComputable && onProgress) {
          const progress = progressEvent.loaded / progressEvent.total;
          onProgress(progress);
        }
      },
      (error) => {
        console.error('[Buildings] Erreur lors du chargement du modèle OBJ:', error);
        loadingPromises.delete(url);
        reject(error);
      }
    );
  });
  
  loadingPromises.set(url, loadingPromise);
  return loadingPromise;
}

// Composant interne qui charge le modèle une fois l'URL résolue
function BuildingsLoader({ 
  objUrl,
  visible,
  showEdges,
  edgeColor,
  edgeThickness,
  onLoadStart,
  onLoadProgress,
  onLoadComplete
}: { 
  objUrl: string;
  visible: boolean;
  showEdges: boolean;
  edgeColor: string;
  edgeThickness: number;
  onLoadStart?: () => void;
  onLoadProgress?: (progress: number) => void;
  onLoadComplete?: () => void;
}) {
  // État pour stocker le modèle chargé
  const [obj, setObj] = useState<THREE.Group | null>(null);
  
  // Charger le modèle OBJ au montage du composant
  useEffect(() => {
    let isMounted = true;
    
    if (onLoadStart) {
      onLoadStart();
    }
    
    loadOBJModel(objUrl, onLoadProgress)
      .then((loadedObj) => {
        if (isMounted) {
          setObj(loadedObj);
          if (onLoadComplete) {
            onLoadComplete();
          }
        }
      })
      .catch((error) => {
        console.error('[Buildings] Erreur lors du chargement:', error);
      });
    
    return () => {
      isMounted = false;
    };
  }, [objUrl, onLoadStart, onLoadProgress, onLoadComplete]);

  // Cloner l'objet pour éviter les problèmes de réutilisation
  const clonedScene = React.useMemo(() => {
    if (!obj) return null;
    
    const cloned = obj.clone();
    
    // Calculer la bounding box AVANT toute modification
    const box = new THREE.Box3().setFromObject(cloned);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    
    console.log('[Buildings] Modèle chargé (coordonnées LAMB93):', {
      center: center.toArray(),
      size: size.toArray(),
      min: box.min.toArray(),
      max: box.max.toArray()
    });
    
    // ÉTAPE 1 : APLATIR LA HIÉRARCHIE
    // Appliquer toutes les transformations des parents aux géométries
    cloned.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        // Mettre à jour la matrice du monde
        child.updateMatrixWorld(true);
        
        // Cloner la géométrie
        const geometry = child.geometry.clone();
        
        // Appliquer la matrice du monde (transformations hiérarchiques)
        geometry.applyMatrix4(child.matrixWorld);
        
        // Remplacer la géométrie
        child.geometry.dispose();
        child.geometry = geometry;
        
        // Réinitialiser les transformations
        child.position.set(0, 0, 0);
        child.rotation.set(0, 0, 0);
        child.scale.set(1, 1, 1);
        child.updateMatrix();
      }
    });
    
    // Réinitialiser la transformation de la scène racine
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.set(1, 1, 1);
    
    // Recalculer la bounding box après l'aplatissement
    const flattenedBox = new THREE.Box3().setFromObject(cloned);
    const lamb93Center = flattenedBox.getCenter(new THREE.Vector3());
    
    console.log('[Buildings] Centre LAMB93 à soustraire:', lamb93Center.toArray());
    
    // ÉTAPE 2 : RECENTRER LES VERTICES DIRECTEMENT DANS LES GÉOMÉTRIES
    // C'est la clé pour éliminer les vibrations avec de grandes coordonnées
    cloned.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const geometry = child.geometry;
        const positions = geometry.attributes.position;
        
        if (positions) {
          // Soustraire le centre LAMB93 de chaque vertex
          // Cela ramène toutes les coordonnées près de zéro
          for (let i = 0; i < positions.count; i++) {
            positions.setX(i, positions.getX(i) - lamb93Center.x);
            positions.setY(i, positions.getY(i) - lamb93Center.y);
            positions.setZ(i, positions.getZ(i) - lamb93Center.z);
          }
          
          // Indiquer que les positions ont été modifiées
          positions.needsUpdate = true;
          
          // Recalculer les bounding sphere/box pour le culling
          geometry.computeBoundingSphere();
          geometry.computeBoundingBox();
        }
        
        // CORRECTION DU Z-FIGHTING : Configurer le matériau
        // ET appliquer la couleur personnalisée #fcf9e6
        const customColor = new THREE.Color('#fcf9e6');
        const newMaterial = new THREE.MeshStandardMaterial({
          color: customColor,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
          side: THREE.FrontSide,
          // Ajouter le flatShading pour un rendu plus propre
          flatShading: true,
          // Ajouter le depthTest et depthWrite pour éviter les conflits de depth
          depthTest: true,
          depthWrite: true,
          // Ajouter le transparent et l'opacity pour la transparence
          transparent: true,
          opacity: 1.0,
          // Ajouter le blending pour le rendu par-dessus
          blending: THREE.NormalBlending,
        });
        
        // Disposer l'ancien matériau pour libérer la mémoire
        if (child.material) {
          const oldMaterial = Array.isArray(child.material) ? child.material : [child.material];
          oldMaterial.forEach((mat) => mat.dispose());
        }
        
        // Appliquer le nouveau matériau
        child.material = newMaterial;
      }
    });
    
    // ÉTAPE 3 : Appliquer une petite translation pour positionner dans la scène
    // Les vertices sont maintenant centrés à l'origine, on peut appliquer une petite translation
    cloned.position.set(0, 0, -7);
    
    // OBJET STATIQUE : Désactiver matrixAutoUpdate pour éliminer les vibrations
    // Les matrices seront calculées UNE SEULE FOIS et figées
    cloned.matrixAutoUpdate = false;
    
    // S'assurer que tous les enfants sont visibles et ont matrixAutoUpdate DÉSACTIVÉ
    cloned.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh) {
        child.visible = true;
        // CRITIQUE : Désactiver matrixAutoUpdate pour éviter les recalculs à chaque frame
        child.matrixAutoUpdate = false;
        child.frustumCulled = true;
        
        // Calculer la matrice locale une dernière fois
        child.updateMatrix();
      }
    });
    
    // Mettre à jour la matrice de la scène racine une dernière fois
    cloned.updateMatrix();
    
    // Calculer TOUTES les matrices du monde (parent + enfants) UNE DERNIÈRE FOIS
    // Après cet appel, les matrices sont figées et ne seront plus jamais recalculées
    cloned.updateMatrixWorld(true);
    
    // Vérifier que le recentrage a fonctionné
    const finalBox = new THREE.Box3().setFromObject(cloned);
    const finalCenter = finalBox.getCenter(new THREE.Vector3());
    
    console.log('[Buildings] Recentrage terminé:', {
      'Centre LAMB93 original': lamb93Center.toArray(),
      'Centre final (devrait être proche de [0,0,-7])': finalCenter.toArray(),
      'Taille': finalBox.getSize(new THREE.Vector3()).toArray()
    });
    
    return cloned;
  }, [obj]);

  // Créer les arêtes directement dans la scène
  useEffect(() => {
    if (!showEdges || !clonedScene) return;

    const edgesToClean: THREE.LineSegments[] = [];

    clonedScene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.visible && child.geometry) {
        // Les géométries ont été recentrées à l'origine (vertices modifiés directement)
        // Les arêtes seront créées à partir de ces vertices recentrés
        
        // Créer un EdgesGeometry avec un seuil d'angle (15 degrés)
        const edgesGeometry = new THREE.EdgesGeometry(child.geometry, 15);
        const edgesMaterial = new THREE.LineBasicMaterial({ 
          color: new THREE.Color(edgeColor),
          linewidth: edgeThickness,
          transparent: false,
          opacity: 1.0,
          // CORRECTION DU Z-FIGHTING : Les arêtes doivent être rendues PAR-DESSUS les faces
          depthTest: true,
          depthWrite: false,  // Ne pas écrire dans le depth buffer pour éviter les conflits
          // Utiliser polygonOffset pour décaler les arêtes vers l'avant
          polygonOffset: true,
          polygonOffsetFactor: -1,  // Valeur négative pour rapprocher de la caméra
          polygonOffsetUnits: -1
        });
        const line = new THREE.LineSegments(edgesGeometry, edgesMaterial);
        
        // OBJET STATIQUE : Désactiver matrixAutoUpdate pour les arêtes aussi
        // Les arêtes doivent être complètement figées comme les meshes
        line.matrixAutoUpdate = false;
        
        // renderOrder plus élevé = rendu après (donc par-dessus)
        // Les faces du mesh ont renderOrder = 0 par défaut
        line.renderOrder = 1;
        
        // Désactiver frustumCulling pour éviter que les arêtes disparaissent
        line.frustumCulled = false;
        
        // Ajouter les arêtes comme enfant direct du mesh
        child.add(line);
        
        // Calculer la matrice de la ligne une dernière fois et la figer
        line.updateMatrix();
        
        edgesToClean.push(line);
      }
    });
    
    // Mettre à jour toutes les matrices du monde UNE DERNIÈRE FOIS
    // Cela inclut maintenant les arêtes qui viennent d'être ajoutées
    clonedScene.updateMatrixWorld(true);
    
    console.log('[Buildings] Arêtes créées et figées:', edgesToClean.length);
    
    return () => {
      // Nettoyer les arêtes lors du démontage
      edgesToClean.forEach((line) => {
        line.parent?.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      });
    };
  }, [clonedScene, showEdges, edgeColor, edgeThickness]);

  // Extraire les données de collision pour chaque mesh
  const collisionData = useMemo(() => {
    if (!clonedScene) return [];
    
    const meshesData: Array<{
      vertices: Float32Array;
      indices: Uint32Array;
      name: string;
    }> = [];
    
    clonedScene.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const geometry = child.geometry;
        const positions = geometry.attributes.position;
        
        if (!positions) return;
        
        // Extraire les vertices
        const vertices = new Float32Array(positions.count * 3);
        for (let i = 0; i < positions.count; i++) {
          vertices[i * 3] = positions.getX(i);
          vertices[i * 3 + 1] = positions.getY(i);
          vertices[i * 3 + 2] = positions.getZ(i);
        }
        
        // Extraire les indices
        let indices: Uint32Array;
        if (geometry.index) {
          indices = new Uint32Array(geometry.index.array);
        } else {
          // Si pas d'indices, créer des indices séquentiels
          indices = new Uint32Array(positions.count);
          for (let i = 0; i < positions.count; i++) {
            indices[i] = i;
          }
        }
        
        meshesData.push({
          vertices,
          indices,
          name: child.name || 'unnamed_mesh'
        });
      }
    });
    
    console.log(`[Buildings] ${meshesData.length} meshes préparés pour les collisions, total vertices:`, 
      meshesData.reduce((acc, m) => acc + m.vertices.length / 3, 0));
    
    return meshesData;
  }, [clonedScene]);

  useEffect(() => {
    if (clonedScene) {
      console.log('[Buildings] Scène clonée prête, nombre d\'enfants:', clonedScene.children.length);
      
      // Vérifier que la scène est bien dans le graphe
      clonedScene.traverse((child: THREE.Object3D) => {
        if (child instanceof THREE.Mesh) {
          console.log('[Buildings] Mesh trouvé:', {
            name: child.name,
            visible: child.visible,
            position: child.position.toArray(),
            geometry: child.geometry ? {
              vertices: child.geometry.attributes.position?.count || 0,
              type: child.geometry.type
            } : null,
            material: child.material ? {
              type: child.material.type,
              visible: child.material.visible !== false
            } : null
          });
        }
      });
    }
  }, [clonedScene]);

  // Ne rien afficher si le modèle n'est pas chargé ou si pas visible
  if (!visible || !clonedScene) {
    return null;
  }

  // Rendre la scène complète avec les collisions physiques
  // Les arêtes sont ajoutées directement dans la scène
  // Les colliders sont créés à partir des mêmes géométries recentrées
  return (
    <RigidBody type="fixed" colliders={false}>
      {/* Créer un TrimeshCollider pour chaque mesh */}
      {collisionData.map((mesh, index) => (
        <TrimeshCollider 
          key={`collider-${index}-${mesh.name}`}
          args={[mesh.vertices, mesh.indices]}
        />
      ))}
      
      {/* Le mesh visuel */}
      <primitive object={clonedScene} />
    </RigidBody>
  );
}

// Composant principal qui résout l'URL et charge le modèle
export function Buildings({ 
  visible = true, 
  showEdges = true,
  edgeColor = '#000000',
  edgeThickness = 1,
  onLoadStart,
  onLoadProgress,
  onLoadComplete
}: BuildingsProps) {
  // Résoudre l'URL du fichier OBJ (local en dev, R2 en prod)
  const [objUrl, setObjUrl] = useState<string | null>(null);
  
  useEffect(() => {
    // Résoudre l'URL du fichier OBJ
    resolveDataUrl('/models/buildings_LHD_FXX_0932_6896_PTS_LAMB93_IGN69.obj')
      .then(url => {
        console.log('[Buildings] URL résolue pour le modèle OBJ:', url);
        setObjUrl(url);
      })
      .catch(error => {
        console.error('[Buildings] Erreur lors de la résolution de l\'URL du modèle OBJ:', error);
      });
  }, []);
  
  // Ne rien afficher tant que l'URL n'est pas résolue ou si pas visible
  if (!visible || !objUrl) {
    return null;
  }
  
  // Charger le modèle avec l'URL résolue
  return (
    <BuildingsLoader 
      objUrl={objUrl}
      visible={visible}
      showEdges={showEdges}
      edgeColor={edgeColor}
      edgeThickness={edgeThickness}
      onLoadStart={onLoadStart}
      onLoadProgress={onLoadProgress}
      onLoadComplete={onLoadComplete}
    />
  );
}

// Précharger le modèle pour améliorer les performances
// Note: useLoader gère automatiquement le cache, mais on peut précharger manuellement si nécessaire

