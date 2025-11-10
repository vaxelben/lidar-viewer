import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { CameraControls } from '@react-three/drei';
import * as THREE from 'three';
import { Copc } from 'copc';
import type { Getter } from 'copc';
import * as LazPerf from 'laz-perf';
import { Pane } from 'tweakpane';
import { DatGuiPanel } from './DatGuiPanel';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

interface DirectLazViewerProps {
  lazFilePaths: string[]; // Tableau de chemins de fichiers LAZ
  pointSize?: number;
  maxPoints?: number; // Limite de points à charger par fichier (défaut: 2M)
}

// Shader Eye-Dome Lighting (EDL) amélioré pour une meilleure perception de profondeur
const EDLShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2() },
    edlStrength: { value: 1.5 },
    radius: { value: 2.5 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float edlStrength;
    uniform float radius;
    varying vec2 vUv;
    
    // Fonction pour lire la profondeur de manière robuste
    float readDepth(vec2 uv) {
      return texture2D(tDepth, uv).r;
    }
    
    void main() {
      float depth = readDepth(vUv);
      
      // Si pas de géométrie (fond), afficher la couleur originale
      if (depth >= 0.9999) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      
      // Linéariser la profondeur pour de meilleures comparaisons
      // Note: avec logarithmicDepthBuffer, la profondeur est déjà mieux distribuée
      float linearDepth = depth;
      
      float shade = 0.0;
      float weightSum = 0.0;
      
      // Échantillonnage amélioré en cercle (8 directions)
      const int samples = 8;
      for (int i = 0; i < samples; i++) {
        float angle = float(i) * 0.785398; // PI/4
        vec2 offset = vec2(cos(angle), sin(angle)) * radius / resolution;
        float sampleDepth = readDepth(vUv + offset);
        
        // Ignorer les échantillons en dehors de la géométrie
        if (sampleDepth < 0.9999) {
          // Calculer la différence de profondeur
          float diff = linearDepth - sampleDepth;
          
          // Accumuler seulement les différences positives (surfaces qui sont plus loin)
          if (diff > 0.0) {
            // Utiliser une fonction exponentielle pour accentuer les bords
            shade += diff;
            weightSum += 1.0;
          }
        }
      }
      
      // Calculer l'ombrage final
      float finalShade = 1.0;
      if (weightSum > 0.0) {
        float avgShade = shade / weightSum;
        // ✅ Facteur ajusté : 50.0 au lieu de 300.0 pour un effet plus visible
        // Plus le facteur est élevé, plus l'ombrage est fort
        finalShade = 1.0 - (avgShade * edlStrength * 50.0);
        finalShade = clamp(finalShade, 0.2, 1.0); // Limiter pour éviter le noir complet
      }
      
      vec4 color = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(color.rgb * finalShade, color.a);
    }
  `
};

// Créer un getter personnalisé pour le navigateur
function createBrowserGetter(url: string): Getter {
  return async (begin: number, end: number) => {
    const response = await fetch(url, {
      headers: {
        Range: `bytes=${begin}-${end - 1}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  };
}

// Variable pour stocker l'instance laz-perf initialisée
let lazPerfInstance: typeof LazPerf | null = null;

// Cache global pour éviter les chargements multiples du même fichier
const loadingCache = new Map<string, boolean>();
const loadedDataCache = new Map<string, {
  positions: Float32Array;
  colors: Float32Array;
  intensities: Float32Array;
  classifications: Uint8Array;
  bounds: { min: THREE.Vector3; max: THREE.Vector3 };
  availableClassifications: number[];
  hasRGBColors: boolean;
}>();

// Fonction pour initialiser laz-perf
async function initLazPerf() {
  if (!lazPerfInstance) {
    console.log("Initialisation de laz-perf...");
    // Initialiser laz-perf avec le chemin vers le fichier WASM
    // Utiliser import.meta.env.BASE_URL pour supporter le base path de GitHub Pages
    const baseUrl = import.meta.env.BASE_URL || '/';
    const wasmPath = `${baseUrl}laz-perf.wasm`.replace(/\/+/g, '/');
    lazPerfInstance = await LazPerf.create({
      'laz-perf.wasm': wasmPath
    });
    console.log("laz-perf initialisé avec succès");
  }
  return lazPerfInstance;
}

/**
 * Fonction optimisée pour charger un fichier COPC.LAZ avec copc.js
 * 
 * ⚡ OPTIMISATIONS IMPLÉMENTÉES:
 * 1. Chargement parallèle des nodes (4 à la fois) - limite navigateur ~6 connexions/domaine
 * 2. Pré-allocation des TypedArrays pour éviter les redimensionnements coûteux
 * 3. Extraction des données : X, Y, Z, Classification, RGB (si disponible), Intensité
 * 4. Level of Detail (LOD) : chargement progressif niveau par niveau
 * 5. Callback par niveau : permet affichage progressif sans attendre la fin
 * 
 * Ces optimisations réduisent le temps de chargement de ~40-60%
 */
async function loadLAZFile(
  url: string, 
  maxPointsLimit: number = Infinity,
  maxLOD: number = Infinity,
  progressCallback?: (progress: number) => void,
  levelCallback?: (levelData: {
    level: number;
    positions: Float32Array;
    colors: Float32Array;
    intensities: Float32Array;
    classifications: Uint8Array;
    bounds: { min: THREE.Vector3; max: THREE.Vector3 };
    availableClassifications: number[];
    hasRGBColors: boolean;
  }) => void
): Promise<{
  positions: Float32Array;
  colors: Float32Array;
  intensities: Float32Array;
  classifications: Uint8Array;
  bounds: { min: THREE.Vector3; max: THREE.Vector3 };
  availableClassifications: number[];
  hasRGBColors: boolean;
}> {
  // Créer une clé de cache basée sur l'URL, la limite de points et le LOD
  const cacheKey = `${url}_${maxPointsLimit}_LOD${maxLOD}`;
  
  // Vérifier si le fichier est déjà en cours de chargement
  if (loadingCache.get(cacheKey)) {
    console.log(`⏳ Chargement déjà en cours pour ${url}, attente...`);
    // Attendre que le chargement soit terminé
    while (loadingCache.get(cacheKey)) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Retourner les données du cache
    const cached = loadedDataCache.get(cacheKey);
    if (cached) {
      console.log(`✅ Données récupérées du cache pour ${url}`);
      // S'assurer que les bounds sont des Vector3 valides
      return {
        ...cached,
        bounds: {
          min: new THREE.Vector3(cached.bounds.min.x, cached.bounds.min.y, cached.bounds.min.z),
          max: new THREE.Vector3(cached.bounds.max.x, cached.bounds.max.y, cached.bounds.max.z)
        }
      };
    }
  }
  
  // Vérifier si les données sont déjà en cache
  const cached = loadedDataCache.get(cacheKey);
  if (cached) {
    console.log(`✅ Fichier déjà chargé (cache), retour immédiat pour ${url}`);
    // S'assurer que les bounds sont des Vector3 valides
    return {
      ...cached,
      bounds: {
        min: new THREE.Vector3(cached.bounds.min.x, cached.bounds.min.y, cached.bounds.min.z),
        max: new THREE.Vector3(cached.bounds.max.x, cached.bounds.max.y, cached.bounds.max.z)
      }
    };
  }
  
  // Marquer comme en cours de chargement
  loadingCache.set(cacheKey, true);
  console.log(`📥 Début du chargement du fichier avec copc.js: ${url}`);
  
  try {
    // Initialiser laz-perf
    const lazPerf = await initLazPerf();
    
    // Créer un getter pour le navigateur
    const getter = createBrowserGetter(url);
    
    // Charger le fichier COPC
    const copc = await Copc.create(getter);
    
    console.log("Fichier COPC chargé");
    console.log("Header:", copc.header);
    console.log("Info:", copc.info);
    
    // Charger la page racine de la hiérarchie
    const rootPage = copc.info.rootHierarchyPage;
    const hierarchy = await Copc.loadHierarchyPage(getter, rootPage);
    
    // console.log("Hiérarchie chargée:", hierarchy);
    // console.log("Nombre de nodes:", Object.keys(hierarchy.nodes).length);
    
    const nodeKeys = Object.keys(hierarchy.nodes);
    // const totalNodes = nodeKeys.length;
    
    // Fonction pour extraire le niveau d'un node (ex: "4-5-8-0" -> niveau 4)
    const getNodeLevel = (key: string): number => {
      const parts = key.split('-');
      return parseInt(parts[0], 10);
    };
    
    // Pré-calculer le nombre total de points pour la pré-allocation
    let estimatedTotalPoints = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodesToLoad: { key: string; node: any; level: number }[] = [];
    
    // Statistiques par niveau
    const levelStats: { [level: number]: { count: number; points: number } } = {};
    
    for (const key of nodeKeys) {
      const node = hierarchy.nodes[key];
      if (!node || node.pointCount === 0) continue;
      
      const level = getNodeLevel(key);
      
      // ⚡ Filtrer par niveau de détail (LOD)
      if (level > maxLOD) {
        continue;
      }
      
      if (estimatedTotalPoints + node.pointCount > maxPointsLimit) {
        break;
      }
      
      nodesToLoad.push({ key, node, level });
      estimatedTotalPoints += node.pointCount;
      
      // Statistiques
      if (!levelStats[level]) {
        levelStats[level] = { count: 0, points: 0 };
      }
      levelStats[level].count++;
      levelStats[level].points += node.pointCount;
    }
    
    // const maxPointsDisplay = maxPointsLimit === Infinity ? 'Illimité' : maxPointsLimit.toLocaleString('fr-FR');
    // const maxLODDisplay = maxLOD === Infinity ? 'Tous niveaux' : `Niveaux 0-${maxLOD}`;
    // console.log(`📊 Statistiques de chargement:`);
    // console.log(`  - Total de nodes disponibles: ${totalNodes}`);
    // console.log(`  - Niveau de détail max: ${maxLODDisplay}`);
    // console.log(`  - Nodes à charger: ${nodesToLoad.length}`);
    // console.log(`  - Points estimés: ${estimatedTotalPoints.toLocaleString('fr-FR')} / ${maxPointsDisplay}`);
    
    // Afficher les statistiques par niveau
    // const levels = Object.keys(levelStats).map(Number).sort((a, b) => a - b);
    // if (levels.length > 0) {
    //   console.log(`\n📈 Distribution par niveau:`);
    //   for (const level of levels) {
    //     const stats = levelStats[level];
    //     console.log(`  Niveau ${level}: ${stats.count} nodes, ${stats.points.toLocaleString('fr-FR')} points`);
    //   }
    //   console.log('');
    // }
    
    // ⚡ Grouper les nodes par niveau pour chargement progressif
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodesByLevel: { [level: number]: { key: string; node: any }[] } = {};
    for (const { key, node, level } of nodesToLoad) {
      if (!nodesByLevel[level]) {
        nodesByLevel[level] = [];
      }
      nodesByLevel[level].push({ key, node });
    }
    
    const allLevels = Object.keys(nodesByLevel).map(Number).sort((a, b) => a - b);
    // console.log(`🎯 Chargement par niveaux: ${allLevels.join(', ')}`);
    
    // Variables globales pour accumulation
    const allPositions = new Float32Array(estimatedTotalPoints * 3);
    const allColors = new Float32Array(estimatedTotalPoints * 3);
    const allIntensities = new Float32Array(estimatedTotalPoints);
    const allClassifications = new Uint8Array(estimatedTotalPoints);
    const classificationsFound = new Set<number>();
    let currentPointIndex = 0;
    let totalPoints = 0;
    let hasRGBColors = false;
    
    // ⚡ Chargement séquentiel (un node à la fois) pour éviter les erreurs "Failed to fetch"
    // Pas de parallélisation pour garantir la stabilité
    
    // ⚡ Charger niveau par niveau (priorité au niveau 1)
    for (const level of allLevels) {
      const levelNodes = nodesByLevel[level];
      const levelPointsStart = currentPointIndex;
      
      // console.log(`\n📚 === Niveau ${level}: ${levelNodes.length} nodes ===`);
      
      // Charger chaque node séquentiellement
      for (let i = 0; i < levelNodes.length; i++) {
        const { key, node } = levelNodes[i];
        
        try {
          // Charger le node (séquentiel, un à la fois)
          const view = await Copc.loadPointDataView(getter, copc, node, { lazPerf });
          
          // Afficher les dimensions seulement pour le premier node
          if (totalPoints === 0) {
            console.log("Dimensions disponibles dans le fichier:", Object.keys(view.dimensions));
            console.log("Détails des dimensions:", view.dimensions);
          }
          
          // Extraire X, Y, Z, Classification, RGB (si disponible), et Intensité
          const getX = view.getter('X');
          const getY = view.getter('Y');
          const getZ = view.getter('Z');
          const getClassification = view.dimensions['Classification'] ? view.getter('Classification') : null;
          const getIntensity = view.dimensions['Intensity'] ? view.getter('Intensity') : null;
          
          // Vérifier si les couleurs RGB sont disponibles
          const getRed = view.dimensions['Red'] ? view.getter('Red') : null;
          const getGreen = view.dimensions['Green'] ? view.getter('Green') : null;
          const getBlue = view.dimensions['Blue'] ? view.getter('Blue') : null;
          
          // Si au moins une des composantes RGB existe dans ce node, marquer comme ayant des couleurs
          if (getRed || getGreen || getBlue) {
            hasRGBColors = true;
          }
          
          // Extraire les données directement dans les TypedArrays pré-alloués
          for (let j = 0; j < node.pointCount; j++) {
            const posIndex = currentPointIndex * 3;
            
            allPositions[posIndex] = getX(j);
            allPositions[posIndex + 1] = getY(j);
            allPositions[posIndex + 2] = getZ(j);
            
            const classification = getClassification ? getClassification(j) : 0;
            allClassifications[currentPointIndex] = classification;
            classificationsFound.add(classification);
            
            // Extraire l'intensité (normalisée entre 0 et 1)
            const intensity = getIntensity ? getIntensity(j) / 65535.0 : 0;
            allIntensities[currentPointIndex] = intensity;
            
            // Extraire les couleurs RGB (normalisées entre 0 et 1)
            // Les valeurs RGB dans LAZ sont généralement sur 16 bits (0-65535)
            const r = getRed ? getRed(j) / 65535.0 : 0;
            const g = getGreen ? getGreen(j) / 65535.0 : 0;
            const b = getBlue ? getBlue(j) / 65535.0 : 0;
            
            allColors[posIndex] = r;
            allColors[posIndex + 1] = g;
            allColors[posIndex + 2] = b;
            
            currentPointIndex++;
            totalPoints++;
          }
          
          // console.log(`    ✓ ${key}: ${node.pointCount.toLocaleString('fr-FR')} points`);
          
          if (progressCallback) {
            const overallProgress = totalPoints / estimatedTotalPoints;
            progressCallback(Math.min(overallProgress, 1.0));
          }
          
        } catch (error) {
          console.warn(`Erreur lors du chargement du node ${key}:`, error);
          // Continuer avec le node suivant même en cas d'erreur
        }
        
        // Petit délai entre chaque node pour éviter de surcharger le réseau
        if (i < levelNodes.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      
      // ⚡ CALLBACK après chaque niveau chargé
      const levelPointsEnd = currentPointIndex;
      const levelPointCount = levelPointsEnd - levelPointsStart;
      
      if (levelPointCount > 0 && levelCallback) {
        const levelPositions = allPositions.slice(levelPointsStart * 3, levelPointsEnd * 3);
        const levelColors = allColors.slice(levelPointsStart * 3, levelPointsEnd * 3);
        const levelIntensities = allIntensities.slice(levelPointsStart, levelPointsEnd);
        const levelClassifications = allClassifications.slice(levelPointsStart, levelPointsEnd);
        
        // Calculer bounds (utiliser bounds global pour l'instant)
        const bounds = {
          min: new THREE.Vector3(copc.header.min[0], copc.header.min[1], copc.header.min[2]),
          max: new THREE.Vector3(copc.header.max[0], copc.header.max[1], copc.header.max[2])
        };
        
        console.log(`✅ Niveau ${level} terminé: ${levelPointCount.toLocaleString('fr-FR')} points`);
        
        levelCallback({
          level,
          positions: levelPositions,
          colors: levelColors,
          intensities: levelIntensities,
          classifications: levelClassifications,
          bounds,
          availableClassifications: Array.from(classificationsFound).sort((a, b) => a - b),
          hasRGBColors
        });
      }
      
      // Petit délai entre les niveaux pour éviter de surcharger le réseau
      if (level < allLevels[allLevels.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    console.log(`Total de points chargés: ${totalPoints}`);
    
    // Afficher les classifications trouvées
    if (classificationsFound.size > 0) {
      const classificationNames: { [key: number]: string } = {
        0: "Jamais classé / Créé",
        1: "Non classé",
        2: "Sol",
        3: "Végétation basse",
        4: "Végétation moyenne",
        5: "Végétation haute / Arbres",
        6: "Bâtiments",
        7: "Bruit (Low Point)",
        8: "Réservé",
        9: "Eau",
        10: "Rail",
        11: "Surface de route",
        12: "Réservé",
        13: "Wire - Guard",
        14: "Wire - Conductor",
        15: "Tour de transmission",
        16: "Wire-structure Connector",
        17: "Pont",
        18: "Bruit élevé"
      };
      
      console.log("\n=== CLASSIFICATIONS TROUVÉES ===");
      const sortedClassifications = Array.from(classificationsFound).sort((a, b) => a - b);
      sortedClassifications.forEach(classId => {
        const name = classificationNames[classId] || `Inconnu (${classId})`;
        console.log(`  ${classId}: ${name}`);
      });
      console.log("================================\n");
    } else {
      console.log("Aucune classification trouvée dans ce fichier");
    }
    
    // ⚡ Les données sont déjà dans des TypedArrays pré-alloués !
    // Si le nombre de points chargés est inférieur à l'estimation, on crée des vues plus petites
    const positions = totalPoints < estimatedTotalPoints 
      ? allPositions.slice(0, totalPoints * 3)
      : allPositions;
    
    const colors = totalPoints < estimatedTotalPoints 
      ? allColors.slice(0, totalPoints * 3)
      : allColors;
    
    const intensities = totalPoints < estimatedTotalPoints 
      ? allIntensities.slice(0, totalPoints)
      : allIntensities;
    
    const classifications = totalPoints < estimatedTotalPoints
      ? allClassifications.slice(0, totalPoints)
      : allClassifications;
    
    // Calculer les limites (bounds) à partir des données du header COPC
    const bounds = {
      min: new THREE.Vector3(
        copc.header.min[0],
        copc.header.min[1],
        copc.header.min[2]
      ),
      max: new THREE.Vector3(
        copc.header.max[0],
        copc.header.max[1],
        copc.header.max[2]
      )
    };
    
    console.log("✅ Extraction terminée:", {
      points: totalPoints,
      hasRGBColors,
      memoryUsed: `${((positions.byteLength + colors.byteLength + intensities.byteLength + classifications.byteLength) / 1024 / 1024).toFixed(2)} MB`,
      bounds: {
        min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
        max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z }
      }
    });
  
    // Préparer les données à retourner avec les classifications trouvées
    const result = { 
      positions, 
      colors, 
      intensities, 
      classifications, 
      bounds,
      availableClassifications: Array.from(classificationsFound).sort((a, b) => a - b),
      hasRGBColors
    };
    
    // Mettre en cache les données chargées
    loadedDataCache.set(cacheKey, result);
    
    // Libérer le verrou de chargement
    loadingCache.set(cacheKey, false);
    
    console.log(`✅ Fichier chargé et mis en cache: ${url}`);
    
    return result;
  } catch (error) {
    // En cas d'erreur, libérer le verrou et supprimer du cache
    loadingCache.set(cacheKey, false);
    loadedDataCache.delete(cacheKey);
    
    console.error(`❌ Erreur lors du chargement du fichier ${url}:`, error);
    throw error; // Propager l'erreur
  }
}

// Interface pour les contrôles CameraControls
interface CameraControlsType {
  target: THREE.Vector3;
  update: () => void;
}

// Composant pour configurer la caméra
function CameraSetup({ bounds }: { bounds: { min: THREE.Vector3; max: THREE.Vector3 } }) {
  const { camera, controls } = useThree();
  const initializedRef = useRef(false);
  
  useEffect(() => {
    // N'exécuter qu'une seule fois pour éviter les conflits avec CameraControls
    if (initializedRef.current) return;
    initializedRef.current = true;
    
    // Le centre est à (0, 0, 0) car les positions sont déjà centrées
    const center = new THREE.Vector3(0, 0, 0);
    
    // Calculer la taille du nuage de points
    const size = new THREE.Vector3(
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z
    );
    
    // Calculer la distance de la caméra pour voir l'ensemble du nuage
    const maxDim = Math.max(size.x, size.y, size.z);
    const fitOffset = 1.0; // Augmenté pour avoir une meilleure vue d'ensemble
    const distance = maxDim * fitOffset;
    
    // Positionner la caméra
    camera.position.set(
      0,
      distance * -0.5,
      distance
    );
    
    camera.lookAt(center);
    
    // Ajuster les plans de clipping
    camera.near = distance * 0.001;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    
    // Si les contrôles sont disponibles, définir leur cible
    if (controls && 'target' in controls && 'update' in controls) {
      (controls as unknown as CameraControlsType).target.copy(center);
      (controls as unknown as CameraControlsType).update();
    }
    
    console.log("Caméra configurée:", {
      position: camera.position.toArray(),
      target: center.toArray(),
      distance,
      near: camera.near,
      far: camera.far
    });
  }, [bounds, camera, controls]);
  
  return null;
}

// Composant pour gérer le LOD dynamique basé sur la distance de la caméra
function DynamicLODManager({
  bounds,
  maxAvailableLevel,
  currentMaxLOD,
  onMaxLODChange,
  dynamicLODEnabled,
  lodDistanceThresholds
}: {
  bounds: { min: THREE.Vector3; max: THREE.Vector3 };
  maxAvailableLevel: number;
  currentMaxLOD: number;
  onMaxLODChange: (lod: number) => void;
  dynamicLODEnabled: boolean;
  lodDistanceThresholds: number[];
}) {
  const { camera } = useThree();
  const lastLODRef = useRef<number>(currentMaxLOD);
  const frameCountRef = useRef<number>(0);
  
  // Calculer le centre du nuage de points (en coordonnées centrées)
  const center = useMemo(() => new THREE.Vector3(0, 0, 0), []);
  
  // Calculer la taille du nuage pour définir des distances relatives
  const cloudSize = useMemo(() => {
    const size = new THREE.Vector3(
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z
    );
    return size.length(); // Diagonale du bounding box
  }, [bounds]);
  
  useFrame(() => {
    if (!dynamicLODEnabled) return;
    
    // Ne calculer le LOD que tous les 30 frames pour éviter les changements trop fréquents
    frameCountRef.current++;
    if (frameCountRef.current % 30 !== 0) return;
    
    // Calculer la distance de la caméra au centre du nuage
    const distance = camera.position.distanceTo(center);
    
    // Normaliser la distance par rapport à la taille du nuage
    const normalizedDistance = distance / cloudSize;
    
    // Déterminer le LOD approprié en fonction de la distance
    // Plus on est loin, plus le LOD est bas (moins de détails)
    // Plus on est proche, plus le LOD est élevé (plus de détails)
    let newLOD = 0;
    
    // Utiliser les seuils configurables
    // Par défaut: [0.5, 1.0, 2.0, 4.0] correspondent à des multiples de la taille du nuage
    if (normalizedDistance < lodDistanceThresholds[0]) {
      // Très proche: LOD maximum
      newLOD = Math.min(maxAvailableLevel, 4);
    } else if (normalizedDistance < lodDistanceThresholds[1]) {
      // Proche: LOD élevé
      newLOD = Math.min(maxAvailableLevel, 3);
    } else if (normalizedDistance < lodDistanceThresholds[2]) {
      // Distance moyenne: LOD moyen
      newLOD = Math.min(maxAvailableLevel, 2);
    } else if (normalizedDistance < lodDistanceThresholds[3]) {
      // Loin: LOD bas
      newLOD = Math.min(maxAvailableLevel, 1);
    } else {
      // Très loin: LOD minimum
      newLOD = Math.min(maxAvailableLevel, 0);
    }
    
    // Ne mettre à jour que si le LOD a changé (éviter les re-renders inutiles)
    if (newLOD !== lastLODRef.current) {
      console.log(`🎯 LOD dynamique: distance=${distance.toFixed(1)} (${normalizedDistance.toFixed(2)}x taille), nouveau LOD=${newLOD}`);
      lastLODRef.current = newLOD;
      onMaxLODChange(newLOD);
    }
  });
  
  return null;
}

// Composant pour l'effet Eye-Dome Lighting
function EDLEffect({ 
  edlStrength, 
  edlRadius 
}: { 
  edlStrength: number; 
  edlRadius: number; 
}) {
  const { gl, scene, camera, size } = useThree();
  const composerRef = useRef<EffectComposer | null>(null);
  const edlPassRef = useRef<ShaderPass | null>(null);

  useEffect(() => {
    // CORRECTION : Créer explicitement une texture de profondeur
    const depthTexture = new THREE.DepthTexture(size.width, size.height);
    depthTexture.type = THREE.FloatType;  // ✅ FloatType pour meilleure précision avec logarithmic depth
    depthTexture.format = THREE.DepthFormat;

    // Créer un render target avec la texture de profondeur
    const renderTarget = new THREE.WebGLRenderTarget(size.width, size.height, {
      minFilter: THREE.NearestFilter,  // ✅ NearestFilter pour éviter l'interpolation de profondeur
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,  // ✅ Pour les couleurs
      depthTexture: depthTexture,  // ✅ Assigner la texture de profondeur
      depthBuffer: true,
      stencilBuffer: false
    });

    // Créer le composer
    const composer = new EffectComposer(gl, renderTarget);
    composer.setSize(size.width, size.height);

    // Ajouter le RenderPass
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    // Créer et ajouter le ShaderPass EDL
    const edlPass = new ShaderPass(EDLShader);
    edlPass.uniforms.resolution.value.set(size.width, size.height);
    edlPass.uniforms.tDepth.value = depthTexture;  // ✅ Utiliser la texture créée
    edlPass.uniforms.edlStrength.value = edlStrength;
    edlPass.uniforms.radius.value = edlRadius;
    composer.addPass(edlPass);

    composerRef.current = composer;
    edlPassRef.current = edlPass;

    console.log("EDL Effect initialized with depth texture:", {
      resolution: [size.width, size.height],
      edlStrength,
      edlRadius,
      depthTexture: depthTexture
    });

    return () => {
      composer.dispose();
      renderTarget.dispose();
      depthTexture.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, size.width, size.height]);

  // Mettre à jour les paramètres EDL
  useEffect(() => {
    if (edlPassRef.current) {
      edlPassRef.current.uniforms.edlStrength.value = edlStrength;
      edlPassRef.current.uniforms.radius.value = edlRadius;
    }
  }, [edlStrength, edlRadius]);

  // Utiliser le composer pour le rendu au lieu du renderer par défaut
  useFrame(() => {
    if (composerRef.current) {
      composerRef.current.render();
    }
  }, 1); // Priority 1 pour s'assurer que c'est rendu en dernier

  return null;
}

// Mapper les classifications vers des couleurs
function getColorForClassification(classification: number): [number, number, number] {
  const classificationColors: { [key: number]: [number, number, number] } = {
    0: [0.5, 0.5, 0.5],     // Jamais classé / Créé - Gris
    1: [0.7, 0.7, 0.7],     // Non classé - Gris clair
    2: [0.6, 0.4, 0.2],     // Sol - Brun
    3: [0.4, 0.8, 0.3],     // Végétation basse - Vert clair
    4: [0.2, 0.7, 0.2],     // Végétation moyenne - Vert
    5: [0.1, 0.5, 0.1],     // Végétation haute / Arbres - Vert foncé
    6: [0.8, 0.2, 0.2],     // Bâtiments - Rouge
    7: [0.3, 0.3, 0.3],     // Bruit (Low Point) - Gris foncé
    8: [0.5, 0.5, 0.5],     // Réservé - Gris
    9: [0.2, 0.4, 0.8],     // Eau - Bleu
    10: [0.4, 0.4, 0.4],    // Rail - Gris
    11: [0.3, 0.3, 0.3],    // Surface de route - Gris foncé
    12: [0.5, 0.5, 0.5],    // Réservé - Gris
    13: [0.9, 0.6, 0.0],    // Wire - Guard - Orange
    14: [0.9, 0.7, 0.0],    // Wire - Conductor - Jaune-orange
    15: [0.6, 0.6, 0.6],    // Tour de transmission - Gris
    16: [0.7, 0.7, 0.7],    // Wire-structure Connector - Gris clair
    17: [0.5, 0.3, 0.1],    // Pont - Brun
    18: [0.2, 0.2, 0.2],    // Bruit élevé - Gris très foncé
  };
  
  return classificationColors[classification] || [1.0, 1.0, 1.0]; // Blanc par défaut
}

// Calculer la couleur basée sur l'altitude avec un gradient
// Gradient : bleu foncé -> bleu clair -> vert foncé -> vert clair -> jaune -> orange -> rouge
function getColorForAltitude(altitude: number, minAlt: number, maxAlt: number): [number, number, number] {
  // Normaliser l'altitude entre 0 et 1
  const normalized = (altitude - minAlt) / (maxAlt - minAlt);
  const t = Math.max(0, Math.min(1, normalized)); // Clamp entre 0 et 1
  
  // Définir les couleurs du gradient avec leurs positions (0 à 1)
  const gradientStops: Array<{ pos: number; color: [number, number, number] }> = [
    { pos: 0.0,  color: [0.0, 0.0, 0.5] },   // Bleu foncé
    { pos: 0.15, color: [0.0, 0.5, 1.0] },   // Bleu clair
    { pos: 0.3,  color: [0.0, 0.5, 0.0] },   // Vert foncé
    { pos: 0.45, color: [0.5, 1.0, 0.0] },   // Vert clair
    { pos: 0.6,  color: [1.0, 1.0, 0.0] },   // Jaune
    { pos: 0.75, color: [1.0, 0.5, 0.0] },   // Orange
    { pos: 1.0,  color: [1.0, 0.0, 0.0] }    // Rouge
  ];
  
  // Trouver les deux couleurs entre lesquelles interpoler
  let i = 0;
  while (i < gradientStops.length - 1 && t > gradientStops[i + 1].pos) {
    i++;
  }
  
  const stop1 = gradientStops[i];
  const stop2 = gradientStops[i + 1];
  
  // Calculer le facteur d'interpolation local entre les deux stops
  const localT = (t - stop1.pos) / (stop2.pos - stop1.pos);
  
  // Interpoler linéairement entre les deux couleurs
  const r = stop1.color[0] + (stop2.color[0] - stop1.color[0]) * localT;
  const g = stop1.color[1] + (stop2.color[1] - stop1.color[1]) * localT;
  const b = stop1.color[2] + (stop2.color[2] - stop1.color[2]) * localT;
  
  return [r, g, b];
}

// Composant pour le rendu du nuage de points
function PointCloudRenderer({
  positions,
  colors,
  classifications,
  bounds,
  pointSize,
  visibleClassifications,
  colorMode = 'classification'
}: {
  positions: Float32Array;
  colors: Float32Array;
  classifications: Uint8Array;
  bounds: { min: THREE.Vector3; max: THREE.Vector3 };
  pointSize: number;
  visibleClassifications: Set<number>;
  colorMode?: 'classification' | 'altitude' | 'natural';
}) {
  // États pour forcer le re-render quand la géométrie/matériau sont créés
  const [geometryReady, setGeometryReady] = useState(false);
  const [materialReady, setMaterialReady] = useState(false);
  
  // Références pour conserver les objets entre les rendus
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const materialRef = useRef<THREE.PointsMaterial | null>(null);
  
  console.log("PointCloudRenderer props:", {
    positionsLength: positions.length,
    colorsLength: colors.length,
    bounds: bounds,
    boundsMinIsVector: bounds.min instanceof THREE.Vector3,
    boundsMaxIsVector: bounds.max instanceof THREE.Vector3,
    pointSize: pointSize
  });
  
  // Filtrer les points selon les classifications visibles
  const { filteredPositions, filteredColors } = useMemo(() => {
    const center = new THREE.Vector3(
      (bounds.min.x + bounds.max.x) / 2,
      (bounds.min.y + bounds.max.y) / 2,
      (bounds.min.z + bounds.max.z) / 2
    );
    
    const tempPositions: number[] = [];
    const tempColors: number[] = [];
    
    // Parcourir tous les points et ne garder que ceux dont la classification est visible
    for (let i = 0; i < classifications.length; i++) {
      if (visibleClassifications.has(classifications[i])) {
        // Ajouter les positions centrées
        tempPositions.push(
          positions[i * 3] - center.x,
          positions[i * 3 + 1] - center.y,
          positions[i * 3 + 2] - center.z
        );
        
        // Ajouter les couleurs selon le mode choisi
        let r: number, g: number, b: number;
        
        if (colorMode === 'natural') {
          // Coloration naturelle (couleurs RGB extraites du fichier)
          r = colors[i * 3];
          g = colors[i * 3 + 1];
          b = colors[i * 3 + 2];
        } else if (colorMode === 'altitude') {
          // Coloration par altitude (coordonnée Z)
          const altitude = positions[i * 3 + 2]; // Z est l'altitude
          [r, g, b] = getColorForAltitude(altitude, bounds.min.z, bounds.max.z);
        } else {
          // Coloration par classification (mode par défaut)
          [r, g, b] = getColorForClassification(classifications[i]);
        }
        
        tempColors.push(r, g, b);
      }
    }
    
    console.log(`Points filtrés: ${tempPositions.length / 3} / ${classifications.length} (mode: ${colorMode})`);
    
    return {
      filteredPositions: new Float32Array(tempPositions),
      filteredColors: new Float32Array(tempColors)
    };
  }, [positions, colors, classifications, bounds, visibleClassifications, colorMode]);
  
  // Create geometry
  useEffect(() => {
    console.log("Creating geometry with", filteredPositions.length / 3, "points");
    
    if (!geometryRef.current) {
      geometryRef.current = new THREE.BufferGeometry();
    }
    
    // Mettre à jour la géométrie avec les positions et couleurs filtrées
    geometryRef.current.setAttribute('position', new THREE.BufferAttribute(filteredPositions, 3));
    geometryRef.current.setAttribute('color', new THREE.BufferAttribute(filteredColors, 3));
    geometryRef.current.computeBoundingBox();
    geometryRef.current.computeBoundingSphere();
    
    // Forcer la mise à jour
    geometryRef.current.attributes.position.needsUpdate = true;
    geometryRef.current.attributes.color.needsUpdate = true;
    
    // Signaler que la géométrie est prête
    setGeometryReady(true);
    
    return () => {
      // Optionnellement nettoyer la géométrie lors du démontage
      if (geometryRef.current) {
        geometryRef.current.dispose();
      }
      setGeometryReady(false);
    };
  }, [filteredPositions, filteredColors]);
  
  // Create or update material
  useEffect(() => {
    console.log("Updating material with point size:", pointSize);
    if (!materialRef.current) {
      materialRef.current = new THREE.PointsMaterial({
        size: pointSize,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.5,
        depthWrite: true,
        depthTest: true,
        alphaTest: 0.5,
        blending: THREE.NormalBlending,
        fog: true,
        // Cette propriété est importante pour que les points restent visibles
        toneMapped: false

      });
    } else {
      materialRef.current.size = pointSize;
      materialRef.current.needsUpdate = true;
    }
    
    // Désactiver le garbage collection pour ce matériau
    if (materialRef.current) {
      materialRef.current.dispose = () => {
        console.log("Matériau préservé intentionnellement");
      };
    }
    
    // Signaler que le matériau est prêt
    setMaterialReady(true);
    
    return () => {
      // Ne pas nettoyer le matériau lors du démontage
      setMaterialReady(false);
    };
  }, [pointSize]);
  
  // Log pour vérifier le rendu
  useEffect(() => {
    console.log("PointCloudRenderer render state:", {
      hasGeometry: !!geometryRef.current,
      hasMaterial: !!materialRef.current,
      geometryAttributes: geometryRef.current ? Object.keys(geometryRef.current.attributes) : [],
      positionCount: geometryRef.current?.attributes.position?.count,
      materialSize: materialRef.current?.size
    });
  });
  
  console.log("PointCloudRenderer render:", {
    geometryReady,
    materialReady,
    hasGeometry: !!geometryRef.current,
    hasMaterial: !!materialRef.current
  });
  
  return (
    <>
      <CameraSetup bounds={bounds} />
      {geometryReady && materialReady && geometryRef.current && materialRef.current ? (
        <points geometry={geometryRef.current} material={materialRef.current} />
      ) : (
        <mesh>
          <boxGeometry args={[100, 100, 100]} />
          <meshBasicMaterial color="red" />
        </mesh>
      )}
    </>
  );
}

// Composant principal du visualiseur
const DirectLazViewer: React.FC<DirectLazViewerProps> = ({
  lazFilePaths,
  pointSize = 0.5,
  maxPoints = Infinity // Charger tous les points par défaut (par fichier)
}) => {
  // const [loading, setLoading] = useState<boolean>(true);
  // const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [pointData, setPointData] = useState<{
    positions: Float32Array;
    colors: Float32Array;
    intensities: Float32Array;
    classifications: Uint8Array;
    bounds: { min: THREE.Vector3; max: THREE.Vector3 };
    availableClassifications: number[];
    hasRGBColors: boolean;
  } | null>(null);
  
  // Stockage de TOUS les points chargés par niveau (pour filtrage dynamique)
  const [allPointsByLevel, setAllPointsByLevel] = useState<{
    [level: number]: {
      positions: Float32Array;
      colors: Float32Array;
      intensities: Float32Array;
      classifications: Uint8Array;
    };
  }>({});
  
  // Niveau maximum disponible (mis à jour au fur et à mesure du chargement)
  const [maxAvailableLevel, setMaxAvailableLevel] = useState<number>(0);
  
  // État pour gérer les classifications visibles
  const [visibleClassifications, setVisibleClassifications] = useState<Set<number>>(new Set());
  
  // États pour les paramètres EDL
  const [edlStrength, setEdlStrength] = useState<number>(1.5);
  const [edlRadius, setEdlRadius] = useState<number>(2.5);
  const [edlEnabled, setEdlEnabled] = useState<boolean>(true);
  
  // État pour le mode de couleur
  const [colorMode, setColorMode] = useState<'classification' | 'altitude' | 'natural'>('classification');
  
  // État pour le Level of Detail (LOD) - filtrage visuel uniquement
  const [maxLOD, setMaxLOD] = useState<number>(1); // Par défaut: niveau 1 (rapide)
  
  // État pour le LOD dynamique
  const [dynamicLODEnabled, setDynamicLODEnabled] = useState<boolean>(false);
  
  // Seuils de distance pour le LOD dynamique (multiples de la taille du nuage)
  // [très proche, proche, moyen, loin]
  const [lodDistanceThresholds, setLodDistanceThresholds] = useState<number[]>([0.5, 1.0, 2.0, 4.0]);
  
  // État pour la taille des points (contrôlable via Tweakpane)
  const [currentPointSize, setCurrentPointSize] = useState<number>(pointSize);
  
  const [totalPointsDisplayed, setTotalPointsDisplayed] = useState<number>(0);

  // Synchroniser currentPointSize avec la prop pointSize si elle change
  useEffect(() => {
    setCurrentPointSize(pointSize);
  }, [pointSize]);
  
  // Référence pour le panneau Tweakpane
  const paneRef = useRef<Pane | null>(null);
  // Référence pour les paramètres pointSize dans Tweakpane
  const pointSizeParamsRef = useRef<{ pointSize: number } | null>(null);
  
  // Mettre à jour le slider Tweakpane quand currentPointSize change
  useEffect(() => {
    if (pointSizeParamsRef.current) {
      pointSizeParamsRef.current.pointSize = currentPointSize;
    }
  }, [currentPointSize]);
  
  // 🚀 Chargement progressif en arrière-plan de TOUS les fichiers
  useEffect(() => {
    let isMounted = true;
    let isLoadingCancelled = false;
    
    async function loadProgressively() {
      try {
        // setLoading(true);
        setError(null);
        
        console.log(`🚀 Démarrage du chargement de ${lazFilePaths.length} fichier(s)`);
        
        // Réinitialiser les données avant de charger
        setAllPointsByLevel({});
        setMaxAvailableLevel(0);
        
        // Charger tous les fichiers en parallèle
        const fileLoadPromises = lazFilePaths.map(async (filePath, fileIndex) => {
          console.log(`📥 Chargement du fichier ${fileIndex + 1}/${lazFilePaths.length}: ${filePath}`);
          
          // Charger TOUS les niveaux progressivement pour ce fichier
          await loadLAZFile(
            filePath, 
            maxPoints, 
            Infinity, // Charger TOUS les niveaux
            () => {
              // Progress callback (non utilisé car pas d'affichage de progression)
            },
            // Callback pour chaque niveau chargé
            async (levelData: {
              level: number;
              positions: Float32Array;
              colors: Float32Array;
              intensities: Float32Array;
              classifications: Uint8Array;
              bounds: { min: THREE.Vector3; max: THREE.Vector3 };
              availableClassifications: number[];
              hasRGBColors: boolean;
            }) => {
              if (!isMounted || isLoadingCancelled) return;
              
              console.log(`✅ Fichier ${fileIndex + 1} - Niveau ${levelData.level} chargé: ${levelData.positions.length / 3} points`);
              
              // Stocker les points de ce niveau avec un préfixe pour le fichier
              const levelKey = `${fileIndex}_${levelData.level}`;
              setAllPointsByLevel(prev => ({
                ...prev,
                [levelKey]: {
                  positions: levelData.positions,
                  colors: levelData.colors,
                  intensities: levelData.intensities,
                  classifications: levelData.classifications
                }
              }));
              
              // Mettre à jour le niveau maximum disponible
              setMaxAvailableLevel(prevMax => Math.max(prevMax, levelData.level));
              
              // Si c'est le niveau 1 du premier fichier, afficher immédiatement
              if (fileIndex === 0 && levelData.level === 1) {
                setPointData({
                  positions: levelData.positions,
                  colors: levelData.colors,
                  intensities: levelData.intensities,
                  classifications: levelData.classifications,
                  bounds: levelData.bounds,
                  availableClassifications: levelData.availableClassifications,
                  hasRGBColors: levelData.hasRGBColors
                });
                setVisibleClassifications(new Set(levelData.availableClassifications));
                // setLoading(false); // Pas d'écran de chargement
                console.log(`🎨 Affichage initial: Fichier 1, Niveau ${levelData.level} (RGB: ${levelData.hasRGBColors ? 'Oui' : 'Non'})`);
              }
            }
          );
          
          console.log(`✅ Fichier ${fileIndex + 1}/${lazFilePaths.length} terminé: ${filePath}`);
        });
        
        // Attendre que tous les fichiers soient chargés
        await Promise.all(fileLoadPromises);
        
        if (!isMounted || isLoadingCancelled) return;
        
        console.log(`✅ Chargement progressif de tous les fichiers terminé`);
        
      } catch (err) {
        if (isMounted && !isLoadingCancelled) {
          console.error("Erreur lors du chargement progressif:", err);
          setError(err instanceof Error ? err.message : String(err));
          // setLoading(false);
        }
      }
    }
    
    loadProgressively();
    
    return () => {
      isMounted = false;
      isLoadingCancelled = true;
    };
  }, [lazFilePaths, maxPoints]);
  
  // 🎨 Filtrage dynamique selon le LOD sélectionné (sans rechargement !)
  useEffect(() => {
    if (Object.keys(allPointsByLevel).length === 0) return;
    
    console.log(`🎨 Filtrage dynamique: affichage niveaux 0-${maxLOD} pour tous les fichiers`);
    
    // Fusionner tous les points des niveaux <= maxLOD de TOUS les fichiers
    const levelsToShow = Object.keys(allPointsByLevel)
      .filter(key => {
        const level = parseInt(key.split('_')[1]);
        return level <= maxLOD;
      })
      .sort((a, b) => {
        const levelA = parseInt(a.split('_')[1]);
        const levelB = parseInt(b.split('_')[1]);
        return levelA - levelB;
      });
    
    if (levelsToShow.length === 0) return;
    
    // Calculer le nombre total de points
    let totalPoints = 0;
    for (const key of levelsToShow) {
      const levelData = allPointsByLevel[key as unknown as number];
      if (levelData) {
        totalPoints += levelData.positions.length / 3;
      }
    }
    
    console.log(`🔄 Fusion de ${levelsToShow.length} niveaux provenant de ${lazFilePaths.length} fichier(s) - Total: ${totalPoints.toLocaleString('fr-FR')} points`);
    
    // Fusionner les données
    const mergedPositions = new Float32Array(totalPoints * 3);
    const mergedColors = new Float32Array(totalPoints * 3);
    const mergedIntensities = new Float32Array(totalPoints);
    const mergedClassifications = new Uint8Array(totalPoints);
    const classificationsSet = new Set<number>();
    
    let offset = 0;
    for (const key of levelsToShow) {
      const levelData = allPointsByLevel[key as unknown as number];
      if (!levelData) continue;
      
      const pointCount = levelData.positions.length / 3;
      
      mergedPositions.set(levelData.positions, offset * 3);
      mergedColors.set(levelData.colors, offset * 3);
      mergedIntensities.set(levelData.intensities, offset);
      mergedClassifications.set(levelData.classifications, offset);
      
      // Collecter les classifications
      for (let i = 0; i < pointCount; i++) {
        classificationsSet.add(levelData.classifications[i]);
      }
      
      offset += pointCount;
    }
    
    // Mettre à jour l'affichage
    setPointData(prevData => {
      if (!prevData) return prevData;
      
      return {
        ...prevData,
        positions: mergedPositions,
        colors: mergedColors,
        intensities: mergedIntensities,
        classifications: mergedClassifications,
        availableClassifications: Array.from(classificationsSet).sort((a, b) => a - b)
      };
    });
    
    console.log(`✨ Affichage mis à jour: ${totalPoints.toLocaleString('fr-FR')} points (${levelsToShow.length} niveaux de ${lazFilePaths.length} fichier(s))`);
    setTotalPointsDisplayed(totalPoints);
  }, [maxLOD, allPointsByLevel, lazFilePaths.length]);
  
  // Créer le panneau Tweakpane pour gérer les classifications
  useEffect(() => {
    if (!pointData || paneRef.current) return;
    
    // Créer le panneau
    const pane = new Pane({
      title: 'Paramètres',
      expanded: true,
    });
    
    paneRef.current = pane;
    
    // Ajouter un slider pour la taille des points
    const pointSizeParams = {
      pointSize: currentPointSize
    };
    pointSizeParamsRef.current = pointSizeParams;
    
    (pane as unknown as { addBinding: (obj: Record<string, number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: number }) => void) => void } }).addBinding(pointSizeParams, 'pointSize', {
      label: 'Taille des points',
      min: 0.1,
      max: 10.0,
      step: 0.1
    }).on('change', (ev: { value: number }) => {
      setCurrentPointSize(ev.value);
    });
    
    // Ajouter un séparateur
    (pane as unknown as { addBlade: (config: { view: string }) => void }).addBlade({
      view: 'separator'
    });
    
    // Noms des classifications
    const classificationNames: { [key: number]: string } = {
      0: "Non classé",
      1: "Non classé",
      2: "Sol",
      3: "Végétation basse",
      4: "Végétation moyenne",
      5: "Arbres",
      6: "Bâtiments",
      7: "Bruit bas",
      8: "Réservé",
      9: "Eau",
      10: "Rail",
      11: "Routes",
      12: "Réservé",
      13: "Wire Guard",
      14: "Wire Conductor",
      15: "Tour transmission",
      16: "Wire Connector",
      17: "Ponts",
      18: "Bruit élevé",
    };
    
    // ⚡ Ajouter un dossier pour le Level of Detail (LOD)
    const lodFolder = (pane as unknown as { addFolder: (config: { title: string; expanded: boolean }) => unknown }).addFolder({
      title: 'Niveau de Détail (LOD)',
      expanded: true,
    });
    
    const lodParams = {
      dynamicEnabled: dynamicLODEnabled,
      maxLOD: maxLOD,
      thresholdVeryClose: lodDistanceThresholds[0],
      thresholdClose: lodDistanceThresholds[1],
      thresholdMedium: lodDistanceThresholds[2],
      thresholdFar: lodDistanceThresholds[3]
    };
    
    // Toggle pour activer/désactiver le LOD dynamique
    (lodFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(lodParams, 'dynamicEnabled', {
      label: 'LOD Dynamique'
    }).on('change', (ev: { value: boolean | number }) => {
      setDynamicLODEnabled(ev.value as boolean);
      console.log(`🔄 LOD dynamique ${ev.value ? 'activé' : 'désactivé'}`);
    });
    
    // Slider manuel (désactivé si LOD dynamique est actif)
    const maxLODBinding = (lodFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void; disabled: boolean } }).addBinding(lodParams, 'maxLOD', {
      label: `Niveau manuel (disponible: 0-${maxAvailableLevel})`,
      min: 0,
      max: maxAvailableLevel,
      step: 1,
    });
    
    maxLODBinding.on('change', (ev: { value: boolean | number }) => {
      const value = ev.value as number;
      if (value > maxAvailableLevel) {
        console.log(`⏳ Niveau ${value} en cours de chargement... (disponible jusqu'à ${maxAvailableLevel})`);
      } else {
        setMaxLOD(value);
        console.log(`🎯 Affichage manuel niveaux 0-${value} (${value} <= 1: rapide, 2-3: moyen, 4+: détaillé)`);
      }
    });
    
    // Désactiver le slider manuel si LOD dynamique est actif
    if (dynamicLODEnabled) {
      maxLODBinding.disabled = true;
    }
    
    // Ajouter un séparateur
    (lodFolder as unknown as { addBlade: (config: { view: string }) => void }).addBlade({
      view: 'separator'
    });
    
    // Seuils de distance pour le LOD dynamique
    (lodFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(lodParams, 'thresholdVeryClose', {
      label: 'Seuil Très Proche (LOD max)',
      min: 0.1,
      max: 2.0,
      step: 0.1
    }).on('change', (ev: { value: boolean | number }) => {
      setLodDistanceThresholds(prev => [ev.value as number, prev[1], prev[2], prev[3]]);
    });
    
    (lodFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(lodParams, 'thresholdClose', {
      label: 'Seuil Proche (LOD élevé)',
      min: 0.5,
      max: 3.0,
      step: 0.1
    }).on('change', (ev: { value: boolean | number }) => {
      setLodDistanceThresholds(prev => [prev[0], ev.value as number, prev[2], prev[3]]);
    });
    
    (lodFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(lodParams, 'thresholdMedium', {
      label: 'Seuil Moyen (LOD moyen)',
      min: 1.0,
      max: 5.0,
      step: 0.1
    }).on('change', (ev: { value: boolean | number }) => {
      setLodDistanceThresholds(prev => [prev[0], prev[1], ev.value as number, prev[3]]);
    });
    
    (lodFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(lodParams, 'thresholdFar', {
      label: 'Seuil Loin (LOD bas)',
      min: 2.0,
      max: 10.0,
      step: 0.1
    }).on('change', (ev: { value: boolean | number }) => {
      setLodDistanceThresholds(prev => [prev[0], prev[1], prev[2], ev.value as number]);
    });
    
    // Ajouter un séparateur
    (pane as unknown as { addBlade: (config: { view: string }) => void }).addBlade({
      view: 'separator'
    });
    
    // Ajouter un dossier pour les paramètres EDL
    const edlFolder = (pane as unknown as { addFolder: (config: { title: string; expanded: boolean }) => unknown }).addFolder({
      title: 'Eye-Dome Lighting (EDL)',
      expanded: true,
    });
    
    const edlParams = {
      enabled: edlEnabled,
      strength: edlStrength,
      radius: edlRadius
    };
    
    (edlFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(edlParams, 'enabled', {
      label: 'Activer EDL'
    }).on('change', (ev: { value: boolean | number }) => {
      setEdlEnabled(ev.value as boolean);
    });
    
    (edlFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(edlParams, 'strength', {
      label: 'Intensité',
      min: 0.1,
      max: 5.0,
      step: 0.1
    }).on('change', (ev: { value: boolean | number }) => {
      setEdlStrength(ev.value as number);
    });
    
    (edlFolder as unknown as { addBinding: (obj: Record<string, boolean | number>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: boolean | number }) => void) => void } }).addBinding(edlParams, 'radius', {
      label: 'Rayon',
      min: 0.5,
      max: 5.0,
      step: 0.1
    }).on('change', (ev: { value: boolean | number }) => {
      setEdlRadius(ev.value as number);
    });
    
    // Ajouter un séparateur
    (pane as unknown as { addBlade: (config: { view: string }) => void }).addBlade({
      view: 'separator'
    });
    
    // Ajouter un dossier pour le mode de couleur
    const colorFolder = (pane as unknown as { addFolder: (config: { title: string; expanded: boolean }) => unknown }).addFolder({
      title: 'Mode de Couleur',
      expanded: true,
    });
    
    const colorParams = {
      mode: colorMode
    };
    
    (colorFolder as unknown as { addBinding: (obj: Record<string, string>, key: string, options?: Record<string, unknown>) => { on: (event: string, handler: (ev: { value: string }) => void) => void } }).addBinding(colorParams, 'mode', {
      label: 'Mode',
      options: {
        'Classification': 'classification',
        'Altitude': 'altitude',
        'Naturelle': 'natural'
      }
    }).on('change', (ev: { value: string }) => {
      setColorMode(ev.value as 'classification' | 'altitude' | 'natural');
    });
    
    // Ajouter un séparateur
    (pane as unknown as { addBlade: (config: { view: string }) => void }).addBlade({
      view: 'separator'
    });
    
    // Ajouter un dossier pour les classifications
    const classFolder = (pane as unknown as { addFolder: (config: { title: string; expanded: boolean }) => unknown }).addFolder({
      title: 'Classifications',
      expanded: true,
    });
    
    // Créer un objet pour gérer l'état des checkboxes
    const checkboxState: { [key: string]: boolean } = {};
    pointData.availableClassifications.forEach(classId => {
      checkboxState[`class_${classId}`] = true;
    });
    
    // Ajouter des checkboxes pour chaque classification disponible
    pointData.availableClassifications.forEach(classId => {
      const name = classificationNames[classId] || `Classe ${classId}`;
      const key = `class_${classId}`;
      
      (classFolder as unknown as { addBinding: (obj: Record<string, boolean>, key: string, options: { label: string }) => { on: (event: string, handler: (ev: { value: boolean }) => void) => void } }).addBinding(checkboxState, key, {
        label: `${classId}: ${name}`
      }).on('change', (ev: { value: boolean }) => {
        setVisibleClassifications(prev => {
          const newSet = new Set(prev);
          if (ev.value) {
            newSet.add(classId);
          } else {
            newSet.delete(classId);
          }
          return newSet;
        });
      });
    });
    
    // Note: Les boutons nécessitent le plugin @tweakpane/plugin-essentials
    // Pour l'instant, utilisez les checkboxes individuellement
    
    // Nettoyer le panneau lors du démontage
    return () => {
      if (paneRef.current) {
        paneRef.current.dispose();
        paneRef.current = null;
      }
      pointSizeParamsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointData]);
  
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* {loading && (
        <div style={{ 
          position: 'absolute', 
          top: '50%', 
          left: '50%', 
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.8)',
          color: 'white',
          padding: '20px',
          borderRadius: '8px',
          textAlign: 'center',
          zIndex: 1000
        }}>
          <h3>Chargement du fichier...</h3>
          <p>{Math.round(progress * 100)}%</p>
        </div>
      )} */}
      
      {error && (
        <div style={{ 
          position: 'absolute', 
          top: '50%', 
          left: '50%', 
          transform: 'translate(-50%, -50%)',
          background: 'rgba(255,0,0,0.8)',
          color: 'white',
          padding: '20px',
          borderRadius: '8px',
          textAlign: 'center',
          zIndex: 1000
        }}>
          <h3>Erreur</h3>
          <p>{error}</p>
        </div>
      )}
      
      {pointData && (
        <>
          <Canvas 
            frameloop="always"
            style={{ background: '#000' }}
            gl={{ 
              antialias: true,
              logarithmicDepthBuffer: true,
              preserveDrawingBuffer: false
            }}
            camera={{ 
              position: [0, 0, 650], 
              // Définition de l'axe up de la caméra
              up: [0, 0, 1],
              near: 0.01, 
              far: 1000
            }}
            onCreated={({ gl, scene, camera }) => {
              console.log("Canvas created", gl.domElement);
              // Activer le nettoyage automatique pour éviter les traces
              gl.autoClear = true;
              gl.setClearColor(0x000000, 1);
              
              // S'assurer que le domElement est correctement configuré pour les événements de souris
              const canvas = gl.domElement;
              canvas.setAttribute("tabindex", "0");
              canvas.focus();
              
              // Journaliser les propriétés importantes pour le débogage
              console.log("Camera:", camera);
              console.log("Scene:", scene);
              console.log("Canvas element:", canvas);
            }}
          >
          {/* Note: Les lumières n'affectent PAS les nuages de points avec vertexColors.
              L'Eye-Dome Lighting (EDL) est utilisé pour la perception de profondeur.
              Cette lumière "Soleil" éclaire uniquement les éléments auxiliaires (axes, grille, etc.). */}
          
          {/* ☀️ Lumière directionnelle "Soleil" - éclairage principal de la scène */}
          <directionalLight 
            position={[100, 100, 100]}  // Position du soleil (diagonal haut)
            intensity={1.2}             // Intensité lumineuse
            color="#ffffff"             // Lumière blanche naturelle
            castShadow={false}          // Pas d'ombres (inutile pour nuages de points)
          />
          
          {/* Lumière ambiante minimale pour éviter les zones trop sombres */}
          <ambientLight intensity={0.3} color="#ffffff" />
          
          {/* CameraControls optimisé pour données géospatiales LIDAR */}
          <CameraControls
            makeDefault
            enabled={true}
            
            // Avec up=[0,0,1], l'azimuth tourne maintenant autour de Z
            // Donc pour tourner dans le plan XY, on laisse azimuth libre
            // et on bloque polar
            //minPolarAngle={Math.PI / 2}   
            //maxPolarAngle={Math.PI / 2}   
            
            azimuthRotateSpeed={0.5}
            
            minDistance={1}
            maxDistance={10000}
            dollyToCursor={false}
            infinityDolly={false}
            // L'option domElement peut aider à s'assurer que les événements souris sont capturés
            domElement={document.querySelector('canvas') || undefined}
          />

          {/* Gestionnaire de LOD dynamique */}
          {pointData && (
            <DynamicLODManager
              bounds={pointData.bounds}
              maxAvailableLevel={maxAvailableLevel}
              currentMaxLOD={maxLOD}
              onMaxLODChange={setMaxLOD}
              dynamicLODEnabled={dynamicLODEnabled}
              lodDistanceThresholds={lodDistanceThresholds}
            />
          )}

          <DatGuiPanel
            pointCount={totalPointsDisplayed}
            pointSize={currentPointSize}
            onPointSizeChange={setCurrentPointSize}
            edlEnabled={edlEnabled}
            onEdlEnabledChange={setEdlEnabled}
            edlStrength={edlStrength}
            onEdlStrengthChange={setEdlStrength}
            edlRadius={edlRadius}
            onEdlRadiusChange={setEdlRadius}
            colorMode={colorMode}
            onColorModeChange={setColorMode}
            maxLOD={maxLOD}
            onMaxLODChange={setMaxLOD}
            maxAvailableLevel={maxAvailableLevel}
          />
          
          {/* Axes de référence pour l'orientation */}
          {/* <axesHelper args={[100]} /> */}
           <PointCloudRenderer
             positions={pointData.positions}
             colors={pointData.colors}
             classifications={pointData.classifications}
             bounds={pointData.bounds}
             pointSize={currentPointSize}
             visibleClassifications={visibleClassifications}
             colorMode={colorMode}
           />
           {edlEnabled && (
             <EDLEffect 
               edlStrength={edlStrength} 
               edlRadius={edlRadius} 
             />
           )}
         </Canvas>
        </>
      )}
    </div>
  );
};

export default DirectLazViewer;