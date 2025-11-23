import React from 'react';
import { useThree } from '@react-three/fiber';
import { useKeyboardControls } from '@react-three/drei';
import { DatGuiPanel } from './DatGuiPanel';
import { 
  DynamicNodeLODManager, 
  DynamicNodeRenderer, 
  EDLEffect 
} from './DirectLazViewer';
// import { PointCloudColliders } from './PointCloudColliders';
import { Buildings } from './Buildings';
import { ErrorBoundary } from './ErrorBoundary';
// import { BuildingLinesWebGPU } from './BuildingLinesWebGPU';
// import { BuildingTrianglesWebGPU } from './BuildingTrianglesWebGPU';
// import { BuildingTrianglesDelaunay } from './BuildingTrianglesDelaunay';
import * as THREE from 'three';

interface WorldProps {
  lazFilePaths: string[];
  pointData: {
    positions: Float32Array;
    colors: Float32Array;
    intensities: Float32Array;
    classifications: Uint8Array;
    bounds: { min: THREE.Vector3; max: THREE.Vector3 };
    availableClassifications: number[];
    hasRGBColors: boolean;
  } | null;
  metadataLoaded: boolean;
  nodesToRender: { fileUrl: string; nodeKey: string; level: number; distance: number }[];
  nodesToRenderKeys: Set<string>;
  setNodesToRender: (nodes: { fileUrl: string; nodeKey: string; level: number; distance: number }[]) => void;
  visibleClassifications: Set<number>;
  colorMode: 'classification' | 'altitude' | 'natural';
  currentPointSize: number;
  edlEnabled: boolean;
  edlStrength: number;
  edlRadius: number;
  totalPointsDisplayed: number;
  setCurrentPointSize: (size: number) => void;
  setEdlEnabled: (enabled: boolean) => void;
  setEdlStrength: (strength: number) => void;
  setEdlRadius: (radius: number) => void;
  setColorMode: (mode: 'classification' | 'altitude' | 'natural') => void;
  onBuildingsLoadStart: () => void;
  onBuildingsLoadProgress: (progress: number) => void;
  onBuildingsLoadComplete: () => void;
  showPointCloud: boolean;
  // showCollisionGrid: boolean;
}

export function World({
  lazFilePaths,
  pointData,
  metadataLoaded,
  nodesToRender,
  nodesToRenderKeys,
  setNodesToRender,
  visibleClassifications,
  colorMode,
  currentPointSize,
  edlEnabled,
  edlStrength,
  edlRadius,
  totalPointsDisplayed,
  setCurrentPointSize,
  setEdlEnabled,
  setEdlStrength,
  setEdlRadius,
  setColorMode,
  onBuildingsLoadStart,
  onBuildingsLoadProgress,
  onBuildingsLoadComplete,
  showPointCloud,
  // showCollisionGrid,
}: WorldProps) {
  const { camera } = useThree();
  const [, get] = useKeyboardControls();
  
  // État pour la visibilité des bâtiments
  const [buildingsVisible, setBuildingsVisible] = React.useState(true);

  // Configurer la caméra pour le mode FPS
  React.useEffect(() => {
    camera.position.set(0, 0, 1.75); // Hauteur des yeux
    camera.rotation.set(0, 0, 0);
  }, [camera]);

  // Gérer le raccourci clavier pour afficher/masquer les bâtiments
  const prevBuildingsPressed = React.useRef(false);
  
  React.useEffect(() => {
    const handleKeyCheck = () => {
      const buildingsPressed = get().buildings;
      // Détecter le front montant (passage de false à true)
      if (buildingsPressed && !prevBuildingsPressed.current) {
        setBuildingsVisible(prev => !prev);
      }
      prevBuildingsPressed.current = buildingsPressed;
    };

    const interval = setInterval(handleKeyCheck, 50); // Vérifier toutes les 50ms
    
    return () => clearInterval(interval);
  }, [get]);


  return (
    <>
      {/* Lumière directionnelle */}
      <directionalLight 
        position={[100, 100, 100]}
        intensity={1.5}
        color="#ffffff"
        castShadow={false}
      />
      
      {/* Lumière ambiante - augmentée pour mieux éclairer les textures */}
      <ambientLight intensity={0.6} color="#ffffff" />

      {/* AxesHelper pour visualiser les axes */}
      <axesHelper args={[10]} />

      {/* Modèle 3D des bâtiments avec chargement progressif */}
      <ErrorBoundary>
        <Buildings 
          visible={buildingsVisible}
          onLoadStart={onBuildingsLoadStart}
          onLoadProgress={onBuildingsLoadProgress}
          onLoadComplete={onBuildingsLoadComplete}
        />
      </ErrorBoundary>

      {/* Les contrôles de pointeur sont gérés dans le composant Player */}

      {/* Colliders pour les points du nuage - toujours actifs, mais visibilité contrôlable */}
      {/* {pointData && metadataLoaded && (
        <PointCloudColliders
          nodesToRender={nodesToRender}
          globalBounds={pointData.bounds}
          pointSize={currentPointSize}
          visible={showCollisionGrid}
        />
      )} */}

      {/* Gestionnaire de LOD dynamique par node */}
      {pointData && metadataLoaded && (
        <DynamicNodeLODManager
          filePaths={lazFilePaths}
          globalBounds={pointData.bounds}
          onNodesUpdate={setNodesToRender}
        />
      )}

      {/* Panneau de contrôle */}
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
        maxLOD={0}
        onMaxLODChange={() => {}}
        maxAvailableLevel={0}
        closed={false}
      />

      {/* Rendu dynamique des nodes */}
      {pointData && metadataLoaded && showPointCloud && (
        <DynamicNodeRenderer
          nodesToRenderKeys={nodesToRenderKeys}
          allNodes={nodesToRender}
          globalBounds={pointData.bounds}
          visibleClassifications={visibleClassifications}
          colorMode={colorMode}
          pointSize={currentPointSize}
        />
      )}

      {/* Lignes entre les points de bâtiments proches (WebGPU) */}
      {/* {pointData && metadataLoaded && (
        <BuildingLinesWebGPU
          nodesToRender={nodesToRender}
          globalBounds={pointData.bounds}
        />
      )} */}

      {/* Triangles entre les points de bâtiments proches (WebGPU) */}
      {/* {pointData && metadataLoaded && (
        <BuildingTrianglesWebGPU
          nodesToRender={nodesToRender}
          globalBounds={pointData.bounds}
        />
      )} */}

      {/* Triangles entre les points de bâtiments proches (Delaunay) */}
      {/* {pointData && metadataLoaded && (
        <BuildingTrianglesDelaunay
          nodesToRender={nodesToRender}
          globalBounds={pointData.bounds}
        />
      )} */}

      {/* Effet EDL */}
      {edlEnabled && (
        <EDLEffect 
          edlStrength={edlStrength} 
          edlRadius={edlRadius} 
        />
      )}
    </>
  );
}

