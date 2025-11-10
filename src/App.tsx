import { useState } from 'react'
import './App.css'
import DirectLazViewer from './components/DirectLazViewer'

function App() {
  // Initialiser directement avec le chemin par défaut pour éviter un double rendu
  const [lazFilePaths] = useState<string[]>([
    '/data/metz/LHD_FXX_0927_6895_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0927_6896_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0927_6897_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0928_6895_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0928_6896_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0928_6897_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0929_6895_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0929_6896_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0929_6897_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0930_6895_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0930_6896_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0930_6897_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0931_6895_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0931_6896_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0931_6897_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0932_6895_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0932_6896_PTS_LAMB93_IGN69.copc.laz',
    // '/data/metz/LHD_FXX_0932_6897_PTS_LAMB93_IGN69.copc.laz',
    // '/data/boulay/LHD_FXX_0953_6903_PTS_LAMB93_IGN69.copc.laz',
    // '/data/boulay/LHD_FXX_0953_6904_PTS_LAMB93_IGN69.copc.laz',
    // '/data/boulay/LHD_FXX_0953_6905_PTS_LAMB93_IGN69.copc.laz',
    // '/data/boulay/LHD_FXX_0954_6903_PTS_LAMB93_IGN69.copc.laz',
    // '/data/boulay/LHD_FXX_0954_6904_PTS_LAMB93_IGN69.copc.laz',
    // '/data/boulay/LHD_FXX_0954_6905_PTS_LAMB93_IGN69.copc.laz',
    // '/data/boulay/LHD_FXX_0955_6903_PTS_LAMB93_IGN69.copc.laz',
    // '/data/boulay/LHD_FXX_0955_6904_PTS_LAMB93_IGN69.copc.laz',
    // '/data/boulay/LHD_FXX_0955_6905_PTS_LAMB93_IGN69.copc.laz',
    // '/data/strasbourg/LHD_FXX_1047_6842_PTS_LAMB93_IGN69.copc.laz',
    // '/data/strasbourg/LHD_FXX_1047_6843_PTS_LAMB93_IGN69.copc.laz',
    // '/data/strasbourg/LHD_FXX_1048_6842_PTS_LAMB93_IGN69.copc.laz',
    // '/data/strasbourg/LHD_FXX_1048_6843_PTS_LAMB93_IGN69.copc.laz',
    // '/data/strasbourg/LHD_FXX_1049_6842_PTS_LAMB93_IGN69.copc.laz',
    // '/data/strasbourg/LHD_FXX_1049_6843_PTS_LAMB93_IGN69.copc.laz',
    // '/data/strasbourg/LHD_FXX_1050_6842_PTS_LAMB93_IGN69.copc.laz',
    // '/data/strasbourg/LHD_FXX_1050_6843_PTS_LAMB93_IGN69.copc.laz',
  ]);

  return (
    <div className="app-container" style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, overflow: 'hidden' }}>
      {/* Affichage du visualiseur */}
      <DirectLazViewer 
        lazFilePaths={lazFilePaths}
      />
    </div>
  )
}

export default App
