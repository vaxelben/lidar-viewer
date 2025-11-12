import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as dat from 'dat.gui';

/**
 * 📊 Composant DatGuiPanel avec dat.gui
 * 
 * INSTALLATION:
 * yarn add dat.gui
 * yarn add -D @types/dat.gui
 * 
 * Affiche et contrôle :
 * - FPS en temps réel
 * - Frame time
 * - Nombre de points
 * - Paramètres du viewer (taille points, EDL, etc.)
 */

interface DatGuiPanelProps {
  pointCount: number;
  pointSize: number;
  onPointSizeChange: (size: number) => void;
  edlEnabled: boolean;
  onEdlEnabledChange: (enabled: boolean) => void;
  edlStrength: number;
  onEdlStrengthChange: (strength: number) => void;
  edlRadius: number;
  onEdlRadiusChange: (radius: number) => void;
  colorMode: 'classification' | 'altitude' | 'natural';
  onColorModeChange: (mode: 'classification' | 'altitude' | 'natural') => void;
  maxLOD: number;
  onMaxLODChange: (lod: number) => void;
  maxAvailableLevel: number;
  closed: boolean;
}

// Composant de monitoring FPS (dans le Canvas)
export function DatGuiStatsMonitor({ 
  onStatsUpdate 
}: { 
  onStatsUpdate: (fps: number, frameTime: number) => void 
}) {
  const lastTime = useRef(performance.now());
  const frames = useRef(0);
  const fpsUpdateInterval = useRef(0);
  const frameTimes = useRef<number[]>([]); // Garder les 10 derniers frame times
  const maxFrameTimeHistory = 10;

  useFrame(() => {
    const now = performance.now();
    const delta = now - lastTime.current;
    
    // Mesurer le temps réel de cette frame
    frameTimes.current.push(delta);
    if (frameTimes.current.length > maxFrameTimeHistory) {
      frameTimes.current.shift();
    }
    
    frames.current++;
    fpsUpdateInterval.current += delta;

    // Mettre à jour toutes les 200ms
    if (fpsUpdateInterval.current >= 200) {
      const fps = Math.round((frames.current * 1000) / fpsUpdateInterval.current);
      
      // Calculer le frame time moyen et max pour détecter les pics
      const avgFrameTime = fpsUpdateInterval.current / frames.current;
      const maxFrameTime = Math.max(...frameTimes.current);
      
      // Utiliser le frame time max si il est significativement plus élevé que la moyenne
      // Cela permet de détecter les saccades même si la moyenne est bonne
      const frameTime = maxFrameTime > avgFrameTime * 1.5 ? maxFrameTime : avgFrameTime;
      
      onStatsUpdate(fps, frameTime);
      frames.current = 0;
      fpsUpdateInterval.current = 0;
    }

    lastTime.current = now;
  });

  return null;
}

// Composant principal dat.gui
export function DatGuiPanel({
  pointCount,
  pointSize,
  onPointSizeChange,
  edlEnabled,
  onEdlEnabledChange,
  edlStrength,
  onEdlStrengthChange,
  edlRadius,
  onEdlRadiusChange,
  colorMode,
  onColorModeChange,
  maxLOD,
  onMaxLODChange,
  maxAvailableLevel,
  closed
}: DatGuiPanelProps) {
  const guiRef = useRef<dat.GUI | null>(null);

  // Objet pour dat.gui (doit être un objet avec des propriétés mutables)
  const controlsRef = useRef({
    // Stats (lecture seule, mais dat.gui les affichera)
    FPS: 60,
    'Frame Time (ms)': 16.7,
    'Frame Time Max (ms)': 16.7,
    'Points affichés': 0,
    'Mémoire (MB)': 0,
    
    // Contrôles modifiables
    'Taille des points': pointSize,
    'EDL activé': edlEnabled,
    'EDL Intensité': edlStrength,
    'EDL Rayon': edlRadius,
    'Mode couleur': colorMode,
    'Niveau de détail': maxLOD,
    
    // Actions
    'Réinitialiser caméra': () => {
      console.log('Réinitialisation de la caméra...');
      // Cette fonction sera appelée quand on clique sur le bouton
    }
  });

  const frameTimeMaxRef = useRef(0);
  const maxResetCounterRef = useRef(0);
  
  const handleStatsUpdate = (newFps: number, newFrameTime: number) => {
    // Mettre à jour les valeurs dans l'objet controls
    controlsRef.current.FPS = newFps;
    controlsRef.current['Frame Time (ms)'] = Math.round(newFrameTime * 100) / 100;
    
    // Suivre le frame time max (réinitialiser toutes les 2 secondes = 10 mises à jour à 200ms)
    maxResetCounterRef.current++;
    if (newFrameTime > frameTimeMaxRef.current) {
      frameTimeMaxRef.current = newFrameTime;
    }
    
    // Réinitialiser le max toutes les 2 secondes
    if (maxResetCounterRef.current >= 10) {
      frameTimeMaxRef.current = newFrameTime;
      maxResetCounterRef.current = 0;
    }
    
    controlsRef.current['Frame Time Max (ms)'] = Math.round(frameTimeMaxRef.current * 100) / 100;
    
    // Forcer la mise à jour de dat.gui
    if (guiRef.current) {
      guiRef.current.updateDisplay();
    }
  };

  // Mettre à jour le compteur de points et la mémoire
  useEffect(() => {
    controlsRef.current['Points affichés'] = pointCount;
    controlsRef.current['Mémoire (MB)'] = Math.round((pointCount * 24) / (1024 * 1024) * 10) / 10;
    
    if (guiRef.current) {
      guiRef.current.updateDisplay();
    }
  }, [pointCount]);

  // Initialiser dat.gui
  useEffect(() => {
    // Créer le GUI
    const gui = new dat.GUI({ 
      width: 320,
      autoPlace: true 
    });
    
    // Positionner le GUI en haut à droite
    gui.domElement.style.position = 'absolute';
    gui.domElement.style.top = '0px';
    gui.domElement.style.left = '0px';
    gui.domElement.style.zIndex = '1000';
    
    guiRef.current = gui;

    // ========================================
    // 📊 DOSSIER PERFORMANCE (lecture seule)
    // ========================================
    const perfFolder = gui.addFolder('Performance');
    
    perfFolder.add(controlsRef.current, 'FPS')
      .listen() // Écouter les changements
      .name('FPS');
    
    perfFolder.add(controlsRef.current, 'Frame Time (ms)')
      .listen()
      .name('Frame Time');
    
    perfFolder.add(controlsRef.current, 'Frame Time Max (ms)')
      .listen()
      .name('Frame Time Max');
    
    perfFolder.add(controlsRef.current, 'Points affichés')
      .listen()
      .name('Points affichés');
    
    perfFolder.add(controlsRef.current, 'Mémoire (MB)')
      .listen()
      .name('Mémoire (MB)');
    
    // Ouvrir le dossier Performance par défaut
    perfFolder.open();
    
    // Ouvrir ou fermer le GUI selon la prop closed
    if (closed) {
      gui.close();
    } else {
      gui.open();
    }

    // Nettoyer au démontage
    return () => {
      gui.destroy();
      guiRef.current = null;
    };
  }, [
    maxAvailableLevel, 
    closed,
    onPointSizeChange, 
    onEdlEnabledChange, 
    onEdlStrengthChange, 
    onEdlRadiusChange,
    onColorModeChange,
    onMaxLODChange
  ]);

  // Mettre à jour les valeurs quand les props changent
  useEffect(() => {
    controlsRef.current['Taille des points'] = pointSize;
    controlsRef.current['EDL activé'] = edlEnabled;
    controlsRef.current['EDL Intensité'] = edlStrength;
    controlsRef.current['EDL Rayon'] = edlRadius;
    controlsRef.current['Mode couleur'] = colorMode;
    controlsRef.current['Niveau de détail'] = maxLOD;
    
    if (guiRef.current) {
      guiRef.current.updateDisplay();
    }
  }, [pointSize, edlEnabled, edlStrength, edlRadius, colorMode, maxLOD]);

  // Mettre à jour l'état d'ouverture/fermeture quand la prop closed change
  useEffect(() => {
    if (guiRef.current) {
      if (closed) {
        guiRef.current.close();
      } else {
        guiRef.current.open();
      }
    }
  }, [closed]);

  return <DatGuiStatsMonitor onStatsUpdate={handleStatsUpdate} />;
}

export default DatGuiPanel;
