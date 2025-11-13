import subprocess
import os
import glob
import json
from qgis.core import QgsRasterFileWriter, QgsRasterPipe, QgsRectangle, QgsProject, QgsRasterLayer

# === FONCTION POUR LIRE L'EMPRISE AVEC PDAL ===
def get_lidar_extent(las_file):
    """Récupère l'emprise d'un fichier LiDAR avec pdal info"""
    result = subprocess.run(
        ["pdal", "info", "--summary", las_file],
        capture_output=True,
        text=True
    )
    
    if result.returncode == 0:
        info = json.loads(result.stdout)
        bounds = info['summary']['bounds']
        return {
            'xmin': bounds['minx'],
            'xmax': bounds['maxx'],
            'ymin': bounds['miny'],
            'ymax': bounds['maxy']
        }
    else:
        print(f"    ✗ Erreur lecture emprise : {result.stderr}")
        return None

# === CONFIGURATION ===
input_folder = r"C:/XXX/lidar-viewer/public/data/metz"
output_folder = r"C:/XXX/lidar-viewer/public/data/metz_colorized"
temp_folder = r"C:/XXX/lidar-viewer/public/data/metz/temp_orthophotos"

# Nom de votre couche orthophoto
ortho_layer_name = "Légende générique"  # Votre couche !

# Créer les dossiers
os.makedirs(output_folder, exist_ok=True)
os.makedirs(temp_folder, exist_ok=True)

# === RÉCUPÉRER LA COUCHE D'ORTHOPHOTO ===
print("Recherche de la couche d'orthophoto...")
ortho_layer = None

# Chercher par nom
for layer in QgsProject.instance().mapLayers().values():
    if ortho_layer_name in layer.name():
        ortho_layer = layer
        print(f"✓ Couche trouvée : {layer.name()} (type: {layer.type()})")
        break

if not ortho_layer:
    print(f"✗ Couche '{ortho_layer_name}' non trouvée !")
    print("\nCouches disponibles :")
    for layer in QgsProject.instance().mapLayers().values():
        print(f"  - {layer.name()} (type: {layer.type()})")
else:
    # Vérifier que la couche a un dataProvider (c'est une couche raster ou WMS)
    if not hasattr(ortho_layer, 'dataProvider'):
        print(f"✗ La couche '{ortho_layer.name()}' n'est pas une couche raster valide")
        print("Essayez d'utiliser le script avec téléchargement direct depuis l'IGN")
    else:
        print(f"✓ Couche valide, prête pour l'export\n")
        
        # === TRAITER TOUS LES FICHIERS ===
        fichiers_las = glob.glob(os.path.join(input_folder, "*.copc.laz"))
        
        if not fichiers_las:
            print(f"\n✗ Aucun fichier .copc.laz trouvé dans : {input_folder}")
        else:
            print(f"✓ Trouvé {len(fichiers_las)} fichiers à traiter\n")
            
            for i, input_las in enumerate(fichiers_las, 1):
                print(f"{'='*70}")
                print(f"Traitement {i}/{len(fichiers_las)} : {os.path.basename(input_las)}")
                print(f"{'='*70}")
                
                # Chemins de sortie
                basename = os.path.basename(input_las)
                output_las = os.path.join(output_folder, basename.replace('.copc.laz', '_colorise.copc.laz'))
                temp_orthophoto = os.path.join(temp_folder, basename.replace('.copc.laz', '_ortho.tif'))
                
                try:
                    # 1. LIRE L'EMPRISE DU LIDAR
                    print("  [1/3] Lecture de l'emprise du LiDAR...")
                    extent_dict = get_lidar_extent(input_las)
                    
                    if not extent_dict:
                        print("  ✗ Impossible de lire l'emprise, fichier ignoré")
                        continue
                    
                    xmin = extent_dict['xmin']
                    xmax = extent_dict['xmax']
                    ymin = extent_dict['ymin']
                    ymax = extent_dict['ymax']
                    
                    print(f"        Emprise : X=[{xmin:.0f}, {xmax:.0f}], Y=[{ymin:.0f}, {ymax:.0f}]")
                    
                    # 2. EXPORTER L'ORTHOPHOTO DEPUIS QGIS
                    print("  [2/3] Export de l'orthophoto depuis QGIS...")
                    
                    # Créer l'emprise rectangulaire
                    extent_rect = QgsRectangle(xmin, ymin, xmax, ymax)
                    
                    # Calculer les dimensions en pixels (résolution ~0.2m)
                    width = int((xmax - xmin) / 0.2)
                    height = int((ymax - ymin) / 0.2)
                    
                    # Limiter la taille
                    max_dim = 10000
                    if width > max_dim or height > max_dim:
                        ratio = max_dim / max(width, height)
                        width = int(width * ratio)
                        height = int(height * ratio)
                    
                    print(f"        Dimensions : {width}x{height} pixels")
                    
                    # Configuration du pipeline d'export
                    pipe = QgsRasterPipe()
                    provider = ortho_layer.dataProvider()
                    
                    if not pipe.set(provider.clone()):
                        print("        ✗ Erreur configuration pipeline")
                        continue
                    
                    # Export vers GeoTIFF
                    file_writer = QgsRasterFileWriter(temp_orthophoto)
                    error = file_writer.writeRaster(
                        pipe,
                        width,
                        height,
                        extent_rect,
                        ortho_layer.crs()
                    )
                    
                    if error != QgsRasterFileWriter.NoError:
                        print(f"        ✗ Erreur export : {error}")
                        continue
                    
                    print(f"        ✓ Orthophoto exportée")
                    
                    # Vérifier que le fichier existe
                    if not os.path.exists(temp_orthophoto):
                        print(f"        ✗ Fichier orthophoto non créé")
                        continue
                    
                    # 3. COLORISATION PDAL
                    print("  [3/3] Colorisation en cours...")
                    cmd = [
                        "pdal", "translate",
                        input_las, output_las,
                        "colorization",
                        f"--filters.colorization.raster={temp_orthophoto}"
                    ]
                    
                    result = subprocess.run(cmd, capture_output=True, text=True)
                    
                    if result.returncode == 0:
                        print(f"        ✓ Colorisation terminée !")
                        print(f"        Fichier : {os.path.basename(output_las)}")
                        
                        # Nettoyer
                      a  try:
                            os.remove(temp_orthophoto)
                        except:
                            pass
                    else:
                        print(f"        ✗ Erreur PDAL :")
                        print(f"        {result.stderr}")
                        
                except Exception as e:
                    print(f"  ✗ Erreur : {e}")
                    import traceback
                    traceback.print_exc()
                    continue
            
            print(f"\n{'='*70}")
            print(f"✓ Traitement terminé !")
            print(f"{'='*70}")
            
            # === CHARGER LES RÉSULTATS ===
            print("\nChargement des résultats dans QGIS...")
            for output_file in glob.glob(os.path.join(output_folder, "*_colorise.copc.laz")):
                layer_name = os.path.basename(output_file).replace('.copc.laz', '')
                layer = iface.addVectorLayer(output_file, layer_name, "ogr")
                if layer and layer.isValid():
                    print(f"  ✓ Chargé : {layer_name}")
                else:
                    print(f"  ✗ Erreur chargement : {layer_name}")
            
            print("\n✓ Terminé !")