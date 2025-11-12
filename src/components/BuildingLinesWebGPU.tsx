import { useMemo, useRef, useEffect, useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { nodeDataCache } from './DirectLazViewer';

interface BuildingLinesWebGPUProps {
  nodesToRender: { fileUrl: string; nodeKey: string; level: number; distance: number }[];
  globalBounds: { min: THREE.Vector3; max: THREE.Vector3 };
}

// Classification pour les bâtiments
const BUILDING_CLASSIFICATION = 6;
// Seuil pour trouver les plus proches voisins
const MAX_THRESHOLD = 10.0;  // 10 cm maximum - ajustez selon votre densité de points
const PLAYER_RADIUS = 200;
const MAX_VALENCE = 3;
const MAX_POINTS = 25000;
const DEBUG_POINT_INDEX = 0; // On va débugger le premier point en détail

// Compute shader WGSL simplifié pour calculer les connexions
// Stratégie : chaque thread cherche les N plus proches voisins (jusqu'à MAX_THRESHOLD)
const computeShaderCode = `
struct Params {
  pointCount: u32,
  maxThresholdSquared: f32,
  maxValence: u32,
  padding: u32,  // Alignement 16 bytes
};

// Buffer de points : array de floats (x, y, z pour chaque point, sans padding)
@group(0) @binding(0) var<storage, read> points: array<f32>;
@group(0) @binding(1) var<storage, read_write> connections: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

// Fonction helper pour lire un point depuis le buffer
fn readPoint(index: u32) -> vec3<f32> {
  let base = index * 3u;
  return vec3<f32>(
    points[base],
    points[base + 1u],
    points[base + 2u]
  );
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let index = global_id.x;
  
  if (index >= params.pointCount) {
    return;
  }
  
  let point1 = readPoint(index);
  
  // Trouver les MAX_VALENCE plus proches voisins (jusqu'à MAX_THRESHOLD)
  var bestIndices: array<u32, 3>;
  var bestDistances: array<f32, 3>;
  
  // Initialiser avec des valeurs invalides
  for (var i: u32 = 0u; i < 3u; i++) {
    bestIndices[i] = 0xFFFFFFFFu;
    bestDistances[i] = 999999.0;
  }
  
  // Parcourir tous les autres points
  for (var j: u32 = 0u; j < params.pointCount; j++) {
    // Ne pas se connecter à soi-même
    if (j == index) {
      continue;
    }
    
    let point2 = readPoint(j);
    let diff = point2 - point1;
    let distSquared = dot(diff, diff);
    
    // Vérifier si la distance est <= MAX_THRESHOLD (PAS de minimum !)
    // On veut les PLUS PROCHES voisins, donc on accepte toutes les distances jusqu'au max
    if (distSquared <= params.maxThresholdSquared) {
      // Trouver où insérer cette connexion (tri par distance croissante)
      for (var k: u32 = 0u; k < params.maxValence; k++) {
        if (distSquared < bestDistances[k]) {
          // Décaler les éléments suivants
          for (var m = params.maxValence - 1u; m > k; m--) {
            bestIndices[m] = bestIndices[m - 1u];
            bestDistances[m] = bestDistances[m - 1u];
          }
          // Insérer le nouveau
          bestIndices[k] = j;
          bestDistances[k] = distSquared;
          break;
        }
      }
    }
  }
  
  // Écrire les connexions dans le buffer
  let baseIndex = index * params.maxValence;
  for (var i: u32 = 0u; i < params.maxValence; i++) {
    connections[baseIndex + i] = bestIndices[i];
  }
}
`;

export function BuildingLinesWebGPU({
  nodesToRender,
  globalBounds
}: BuildingLinesWebGPUProps) {
  const { camera } = useThree();
  const geometryRef = useRef<THREE.BufferGeometry>(new THREE.BufferGeometry());
  const lastUpdateFrameRef = useRef<number>(0);
  const webGPUDeviceRef = useRef<any>(null);
  const webGPUInitializedRef = useRef<boolean>(false);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const globalCenter = useMemo(() => new THREE.Vector3(
    (globalBounds.min.x + globalBounds.max.x) / 2,
    (globalBounds.min.y + globalBounds.max.y) / 2,
    (globalBounds.min.z + globalBounds.max.z) / 2
  ), [globalBounds]);
  
  const radiusSquared = PLAYER_RADIUS * PLAYER_RADIUS;
  const maxThresholdSquared = MAX_THRESHOLD * MAX_THRESHOLD;
  
  // Initialiser WebGPU
  useEffect(() => {
    async function initWebGPU() {
      console.log('[BUILDING LINES WebGPU] Tentative d\'initialisation WebGPU...');
      const gpu = (navigator as any).gpu;
      if (!gpu) {
        console.error('[BUILDING LINES WebGPU] WebGPU n\'est pas disponible');
        return;
      }
      
      try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          console.error('[BUILDING LINES WebGPU] Aucun adaptateur WebGPU trouvé');
          return;
        }
        
        const device = await adapter.requestDevice();
        webGPUDeviceRef.current = device;
        webGPUInitializedRef.current = true;
        console.log('[BUILDING LINES WebGPU] WebGPU initialisé avec succès');
      } catch (error) {
        console.error('[BUILDING LINES WebGPU] Erreur lors de l\'initialisation WebGPU:', error);
      }
    }
    
    initWebGPU();
    
    return () => {
      if (webGPUDeviceRef.current) {
        webGPUDeviceRef.current.destroy();
        webGPUDeviceRef.current = null;
        webGPUInitializedRef.current = false;
      }
    };
  }, []);
  
  // Mettre à jour les lignes à chaque frame
  useFrame(() => {
    lastUpdateFrameRef.current++;
    
    // Mettre à jour toutes les 10 frames
    if (lastUpdateFrameRef.current % 10 !== 0) {
      return;
    }
    
    // Si WebGPU n'est pas disponible ou en cours de traitement, ne rien faire
    if (!webGPUInitializedRef.current || !webGPUDeviceRef.current || isProcessing) {
      return;
    }
    
    // Exécuter le calcul de manière asynchrone
    setIsProcessing(true);
    
    (async () => {
      try {
        const playerPosition = camera.position.clone();
        const buildingPoints: THREE.Vector3[] = [];
        let totalBuildingPointsScanned = 0;
      
        // Collecter les points de bâtiment dans le rayon
        for (const node of nodesToRender) {
          const cacheKey = `${node.fileUrl}_${node.nodeKey}`;
          const nodeData = nodeDataCache.get(cacheKey);
          
          if (!nodeData) continue;
          
          const { positions, classifications } = nodeData;
          const pointCount = positions.length / 3;
          
          for (let i = 0; i < pointCount; i++) {
            if (classifications[i] === BUILDING_CLASSIFICATION) {
              totalBuildingPointsScanned++;
              const x = positions[i * 3] - globalCenter.x;
              const y = positions[i * 3 + 1] - globalCenter.y;
              const z = positions[i * 3 + 2] - globalCenter.z;
              
              const pointPos = new THREE.Vector3(x, y, z);
              const distanceSquared = playerPosition.distanceToSquared(pointPos);
              
              if (distanceSquared <= radiusSquared && buildingPoints.length < MAX_POINTS) {
                buildingPoints.push(pointPos);
              }
            }
          }
        }
      
        if (lastUpdateFrameRef.current % 100 === 0) {
          console.log(`[BUILDING LINES WebGPU] Points bâtiment scannés: ${totalBuildingPointsScanned}, Points dans rayon: ${buildingPoints.length}`);
        }
      
        if (buildingPoints.length === 0) {
          geometryRef.current.setDrawRange(0, 0);
          setIsProcessing(false);
          return;
        }
      
        const pointsToProcess = buildingPoints.slice(0, MAX_POINTS);
        const pointCount = pointsToProcess.length;
      
        const device = webGPUDeviceRef.current!;
        
        // Créer les buffers GPU
        const STORAGE = 0x0080;
        const COPY_DST = 0x0008;
        const COPY_SRC = 0x0004;
        const UNIFORM = 0x0040;
        const MAP_READ = 0x0001;
        
        const pointsBuffer = device.createBuffer({
          size: pointCount * 3 * 4,
          usage: STORAGE | COPY_DST,
        });
        
        const connectionsBuffer = device.createBuffer({
          size: pointCount * MAX_VALENCE * 4,
          usage: STORAGE | COPY_SRC | COPY_DST,  // COPY_DST nécessaire pour writeBuffer
        });
        
        // CRITIQUE : Initialiser le buffer à 0xFFFFFFFF (valeur invalide)
        // Sans cela, le buffer contient des données aléatoires !
        const connectionsInit = new Uint32Array(pointCount * MAX_VALENCE);
        connectionsInit.fill(0xFFFFFFFF);
        device.queue.writeBuffer(connectionsBuffer, 0, connectionsInit);
        
        const paramsBuffer = device.createBuffer({
          size: 32,
          usage: UNIFORM | COPY_DST,
        });
        
        // Copier les données des points vers le GPU
        const pointsData = new Float32Array(pointCount * 3);
        for (let i = 0; i < pointCount; i++) {
          pointsData[i * 3] = pointsToProcess[i].x;
          pointsData[i * 3 + 1] = pointsToProcess[i].y;
          pointsData[i * 3 + 2] = pointsToProcess[i].z;
        }
        
        device.queue.writeBuffer(pointsBuffer, 0, pointsData);
        
        // Vérification de débogage : afficher quelques points pour confirmer l'écriture
        if (lastUpdateFrameRef.current % 100 === 0 && pointCount > 0) {
          console.log(`[BUILDING LINES WebGPU] Buffer points initialisé: ${pointCount} points`);
          console.log(`[BUILDING LINES WebGPU] Exemple point 0: [${pointsData[0].toFixed(4)}, ${pointsData[1].toFixed(4)}, ${pointsData[2].toFixed(4)}]`);
          if (pointCount > 1) {
            console.log(`[BUILDING LINES WebGPU] Exemple point 1: [${pointsData[3].toFixed(4)}, ${pointsData[4].toFixed(4)}, ${pointsData[5].toFixed(4)}]`);
          }
        }
        
        // Écrire les paramètres (structure alignée sur 16 bytes)
        const paramsData = new ArrayBuffer(16);
        const paramsView = new DataView(paramsData);
        paramsView.setUint32(0, pointCount, true);
        paramsView.setFloat32(4, maxThresholdSquared, true);
        paramsView.setUint32(8, MAX_VALENCE, true);
        paramsView.setUint32(12, 0, true); // padding
        device.queue.writeBuffer(paramsBuffer, 0, paramsData);
        
        // Créer le compute shader
        const shaderModule = device.createShaderModule({
          code: computeShaderCode,
        });
        
        // Créer le bind group layout
        const COMPUTE_STAGE = 0x0004;
        const bindGroupLayout = device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: COMPUTE_STAGE,
              buffer: { type: 'read-only-storage' },
            },
            {
              binding: 1,
              visibility: COMPUTE_STAGE,
              buffer: { type: 'storage' },
            },
            {
              binding: 2,
              visibility: COMPUTE_STAGE,
              buffer: { type: 'uniform' },
            },
          ],
        });
        
        // Créer le compute pipeline
        const computePipeline = device.createComputePipeline({
          layout: device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout],
          }),
          compute: {
            module: shaderModule,
            entryPoint: 'main',
          },
        });
        
        // Créer le bind group
        const bindGroup = device.createBindGroup({
          layout: bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: pointsBuffer } },
            { binding: 1, resource: { buffer: connectionsBuffer } },
            { binding: 2, resource: { buffer: paramsBuffer } },
          ],
        });
        
        // Exécuter le compute shader
        const commandEncoder = device.createCommandEncoder();
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(computePipeline);
        computePass.setBindGroup(0, bindGroup);
        const workgroupCount = Math.ceil(pointCount / 64);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();
        
        // Lire les résultats
        const readbackBuffer = device.createBuffer({
          size: pointCount * MAX_VALENCE * 4,
          usage: COPY_DST | MAP_READ,
        });
        
        commandEncoder.copyBufferToBuffer(
          connectionsBuffer,
          0,
          readbackBuffer,
          0,
          pointCount * MAX_VALENCE * 4
        );
        
        device.queue.submit([commandEncoder.finish()]);
        
        // Attendre et lire les résultats
        await readbackBuffer.mapAsync(MAP_READ);
        const connectionsData = new Uint32Array(readbackBuffer.getMappedRange());
        
        // Construire les lignes à partir des connexions
        // Pour éviter les doublons, on utilise un Set pour tracker les paires déjà dessinées
        const drawnPairs = new Set<string>();
        const lineVertices: number[] = [];
        let validConnections = 0;
        
        for (let i = 0; i < pointCount; i++) {
          const point1 = pointsToProcess[i];
          const baseIndex = i * MAX_VALENCE;
          
          for (let j = 0; j < MAX_VALENCE; j++) {
            const targetIndex = connectionsData[baseIndex + j];
            
            // Vérifier que c'est un index valide
            if (targetIndex !== 0xFFFFFFFF && targetIndex < pointCount) {
              // Créer une clé unique pour cette paire (ordre canonique pour éviter les doublons)
              const pairKey = i < targetIndex ? `${i}-${targetIndex}` : `${targetIndex}-${i}`;
              
              // Ne dessiner que si on n'a pas déjà dessiné cette paire
              if (!drawnPairs.has(pairKey)) {
                drawnPairs.add(pairKey);
                
                const point2 = pointsToProcess[targetIndex];
                lineVertices.push(
                  point1.x, point1.y, point1.z,
                  point2.x, point2.y, point2.z
                );
                validConnections++;
              }
            }
          }
        }
        
        readbackBuffer.unmap();
        
        // ===== DEBUG CPU-SIDE : Vérifier l'algorithme =====
        if (lastUpdateFrameRef.current % 100 === 0 && pointCount > DEBUG_POINT_INDEX) {
          console.log(`\n========== DEBUG POINT ${DEBUG_POINT_INDEX} ==========`);
          const debugPoint = pointsToProcess[DEBUG_POINT_INDEX];
          console.log(`Position: [${debugPoint.x.toFixed(4)}, ${debugPoint.y.toFixed(4)}, ${debugPoint.z.toFixed(4)}]`);
          
          // Calculer TOUS les voisins et leurs distances (CPU-side)
          const allNeighbors: Array<{index: number, distance: number}> = [];
          for (let i = 0; i < pointCount; i++) {
            if (i === DEBUG_POINT_INDEX) continue;
            const dist = debugPoint.distanceTo(pointsToProcess[i]);
            allNeighbors.push({ index: i, distance: dist });
          }
          
          // Trier par distance croissante
          allNeighbors.sort((a, b) => a.distance - b.distance);
          
          // Afficher les 10 plus proches voisins réels
          console.log(`\n10 PLUS PROCHES VOISINS (CPU) :`);
          for (let i = 0; i < Math.min(10, allNeighbors.length); i++) {
            const n = allNeighbors[i];
            const inRange = n.distance <= MAX_THRESHOLD ? '✅' : '❌';
            console.log(`  ${i+1}. Point ${n.index} à ${(n.distance * 100).toFixed(2)}cm ${inRange}`);
          }
          
          // Afficher ce que le GPU a trouvé
          console.log(`\nVOISINS TROUVÉS PAR LE GPU :`);
          const baseIndex = DEBUG_POINT_INDEX * MAX_VALENCE;
          for (let j = 0; j < MAX_VALENCE; j++) {
            const targetIndex = connectionsData[baseIndex + j];
            if (targetIndex !== 0xFFFFFFFF && targetIndex < pointCount) {
              const dist = debugPoint.distanceTo(pointsToProcess[targetIndex]);
              console.log(`  ${j+1}. Point ${targetIndex} à ${(dist * 100).toFixed(2)}cm`);
            } else {
              console.log(`  ${j+1}. (vide)`);
            }
          }
          
          // Vérifier si le GPU a bien trouvé les plus proches
          const gpuNeighbors: number[] = [];
          for (let j = 0; j < MAX_VALENCE; j++) {
            const targetIndex = connectionsData[baseIndex + j];
            if (targetIndex !== 0xFFFFFFFF && targetIndex < pointCount) {
              gpuNeighbors.push(targetIndex);
            }
          }
          
          const expectedNeighbors = allNeighbors
            .filter(n => n.distance <= MAX_THRESHOLD)
            .slice(0, MAX_VALENCE)
            .map(n => n.index);
          
          const match = gpuNeighbors.length === expectedNeighbors.length &&
                       gpuNeighbors.every((idx, i) => idx === expectedNeighbors[i]);
          
          if (match) {
            console.log(`\nGPU ET CPU CORRESPONDENT ! L'algorithme fonctionne correctement.`);
          } else {
            console.log(`\n❌ DIFFÉRENCE ENTRE GPU ET CPU !`);
            console.log(`Attendu (CPU): [${expectedNeighbors.join(', ')}]`);
            console.log(`Trouvé (GPU):  [${gpuNeighbors.join(', ')}]`);
          }
          
          console.log(`\nMAX_THRESHOLD actuel: ${MAX_THRESHOLD}m (${(MAX_THRESHOLD*100).toFixed(1)}cm)`);
          console.log(`Voisins dans la plage: ${allNeighbors.filter(n => n.distance <= MAX_THRESHOLD).length}`);
          console.log(`========================================\n`);
        }
        // ===== FIN DEBUG =====
        
        // Nettoyer les buffers
        pointsBuffer.destroy();
        connectionsBuffer.destroy();
        paramsBuffer.destroy();
        readbackBuffer.destroy();
        
        // Log de débogage
        if (lastUpdateFrameRef.current % 100 === 0) {
          console.log(`[BUILDING LINES WebGPU] Points: ${pointCount}, Connexions uniques: ${validConnections}, Lignes: ${lineVertices.length / 6}`);
          
          // Analyser les distances réelles des connexions
          const actualDistances: number[] = [];
          for (let i = 0; i < pointCount; i++) {
            const point1 = pointsToProcess[i];
            const baseIndex = i * MAX_VALENCE;
            for (let j = 0; j < MAX_VALENCE; j++) {
              const targetIndex = connectionsData[baseIndex + j];
              if (targetIndex !== 0xFFFFFFFF && targetIndex < pointCount) {
                const point2 = pointsToProcess[targetIndex];
                const dist = point1.distanceTo(point2);
                actualDistances.push(dist);
              }
            }
          }
          
          if (actualDistances.length > 0) {
            const minDist = Math.min(...actualDistances);
            const maxDist = Math.max(...actualDistances);
            const avgDist = actualDistances.reduce((a, b) => a + b, 0) / actualDistances.length;
            console.log(`[BUILDING LINES WebGPU] 📏 Distances des connexions - Min: ${minDist.toFixed(4)}m, Max: ${maxDist.toFixed(4)}m, Moy: ${avgDist.toFixed(4)}m`);
            console.log(`[BUILDING LINES WebGPU] 📐 Seuil MAX_THRESHOLD: ${MAX_THRESHOLD}m (${(MAX_THRESHOLD*100).toFixed(1)}cm) - Trouve les ${MAX_VALENCE} plus proches voisins`);
          }
          
          // Analyser les connexions par point
          const connectionsPerPoint = new Array(pointCount).fill(0);
          for (let i = 0; i < pointCount; i++) {
            const baseIndex = i * MAX_VALENCE;
            for (let j = 0; j < MAX_VALENCE; j++) {
              const targetIndex = connectionsData[baseIndex + j];
              if (targetIndex !== 0xFFFFFFFF && targetIndex < pointCount) {
                connectionsPerPoint[i]++;
              }
            }
          }
          
          const avgConnections = connectionsPerPoint.reduce((a, b) => a + b, 0) / pointCount;
          const maxConnections = Math.max(...connectionsPerPoint);
          const minConnections = Math.min(...connectionsPerPoint);
          console.log(`[BUILDING LINES WebGPU] Connexions par point - Min: ${minConnections}, Max: ${maxConnections}, Moy: ${avgConnections.toFixed(2)}`);
          
          // Échantillonner quelques distances entre points voisins pour debug
          if (pointCount > 5) {
            const sampleDistances: number[] = [];
            for (let i = 0; i < Math.min(5, pointCount - 1); i++) {
              const dist = pointsToProcess[i].distanceTo(pointsToProcess[i + 1]);
              sampleDistances.push(dist);
            }
            console.log(`[BUILDING LINES WebGPU] Échantillon distances entre points consécutifs: ${sampleDistances.map(d => d.toFixed(4)).join('m, ')}m`);
          }
          
          if (validConnections === 0 && pointCount > 1) {
            const dist = pointsToProcess[0].distanceTo(pointsToProcess[1]);
            console.warn(`[BUILDING LINES WebGPU] AUCUNE CONNEXION ! Distance entre les 2 premiers points: ${dist.toFixed(4)}m (${(dist*100).toFixed(2)}cm)`);
            console.warn(`[BUILDING LINES WebGPU] Suggestion: Augmentez MAX_THRESHOLD à au moins ${(dist * 1.2).toFixed(3)}m`);
          }
        }
        
        // Mettre à jour la géométrie
        if (lineVertices.length > 0) {
          const positions = new Float32Array(lineVertices);
          const positionAttribute = geometryRef.current.getAttribute('position');
          
          if (positionAttribute && positionAttribute.array.length === positions.length) {
            (positionAttribute.array as Float32Array).set(positions);
            positionAttribute.needsUpdate = true;
          } else {
            geometryRef.current.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometryRef.current.computeBoundingSphere();
          }
          
          const vertexCount = lineVertices.length / 3;
          geometryRef.current.setDrawRange(0, vertexCount);
          
          if (lastUpdateFrameRef.current % 100 === 0) {
            console.log(`[BUILDING LINES WebGPU] Géométrie mise à jour: ${vertexCount} vertices, ${validConnections} lignes`);
          }
        } else {
          geometryRef.current.setDrawRange(0, 0);
        }
      } catch (error) {
        console.error('[BUILDING LINES WebGPU] Erreur lors du calcul:', error);
        if (error instanceof Error) {
          console.error('[BUILDING LINES WebGPU] Détails:', error.message, error.stack);
        }
        geometryRef.current.setDrawRange(0, 0);
      } finally {
        setIsProcessing(false);
      }
    })();
  });
  
  // Initialiser la géométrie
  useEffect(() => {
    console.log('[BUILDING LINES WebGPU] Composant monté');
    const emptyPositions = new Float32Array(0);
    geometryRef.current.setAttribute('position', new THREE.BufferAttribute(emptyPositions, 3));
    geometryRef.current.setDrawRange(0, 0);
  }, []);
  
  return (
    <lineSegments geometry={geometryRef.current}>
      <lineBasicMaterial 
        color={0xffffff}
        transparent={true}
        opacity={0.6}
        depthTest={true}
        depthWrite={true}
      />
    </lineSegments>
  );
}
