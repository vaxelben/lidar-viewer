"""
ANALYSE AUTOMATIQUE DE TUILE LIDAR
==================================

Analyse le fichier COPC/LAZ pour déduire les paramètres DBSCAN optimaux
Génère rapport + recommandations de calibration

Usage:
    python analyze_lidar_tile.py
"""

import numpy as np
import open3d as o3d
import laspy
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import logging
import json
import matplotlib.pyplot as plt
from sklearn.neighbors import NearestNeighbors

# Configuration logging
logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)-8s %(message)s'
)
logger = logging.getLogger(__name__)


class LidarTileAnalyzer:
    """Analyse les caractéristiques d'une tuile LIDAR"""

    def __init__(self, tile_path: Path, sample_fraction: float = 1.0):
        """
        Args:
            tile_path: Chemin du fichier .laz/.copc.laz
            sample_fraction: Fraction de points à analyser (0.0-1.0)
                            Utile pour gros fichiers
        """
        self.tile_path = Path(tile_path)
        self.sample_fraction = sample_fraction
        self.results = {}

    def load_tile(self) -> Tuple[np.ndarray, np.ndarray]:
        """Charge la tuile et ses classifications"""
        logger.info(f"Chargement: {self.tile_path.name}")
        las = laspy.read(str(self.tile_path))

        points = np.vstack((las.x, las.y, las.z)).transpose()
        classifications = np.array(las.classification)

        logger.info(f"Total: {len(points):,} points")
        logger.info(f"Classes: {sorted(np.unique(classifications))}")

        # Sampling si demandé
        if self.sample_fraction < 1.0:
            n_sample = int(len(points) * self.sample_fraction)
            indices = np.random.choice(len(points), n_sample, replace=False)
            points = points[indices]
            classifications = classifications[indices]
            logger.info(f"Réduit à {len(points):,} points ({self.sample_fraction*100:.0f}%)")

        return points, classifications

    def analyze_global_distribution(self, points: np.ndarray) -> Dict:
        """Analyse la distribution globale des points"""
        logger.info("\n📊 ANALYSE GLOBALE")
        logger.info("=" * 60)

        bbox_min = points.min(axis=0)
        bbox_max = points.max(axis=0)
        bbox_size = bbox_max - bbox_min

        density_m3 = len(points) / (bbox_size[0] * bbox_size[1] * bbox_size[2])
        density_m2 = len(points) / (bbox_size[0] * bbox_size[1])

        result = {
            'n_points': len(points),
            'bbox_min': bbox_min.tolist(),
            'bbox_max': bbox_max.tolist(),
            'bbox_size': bbox_size.tolist(),
            'density_points_m3': density_m3,
            'density_points_m2': density_m2,
            'z_range': float(bbox_size[2])
        }

        logger.info(f"Bounding box: ({bbox_size[0]:.1f} x {bbox_size[1]:.1f} x {bbox_size[2]:.1f}) m")
        logger.info(f"Densité: {density_m2:.1f} pts/m² (2D)")
        logger.info(f"Densité: {density_m3:.2f} pts/m³ (3D)")
        logger.info(f"Hauteur: {bbox_size[2]:.1f} m")

        return result

    def analyze_by_classification(self, points: np.ndarray,
                                  classifications: np.ndarray) -> Dict:
        """Analyse par classe LAS"""
        logger.info("\n📋 CLASSES LAS")
        logger.info("=" * 60)

        class_names = {
            1: "Unclassified",
            2: "Ground",
            3: "Low Vegetation",
            4: "Medium Vegetation",
            5: "High Vegetation",
            6: "Building",
            7: "Low Point (noise)",
            8: "Reserved",
            9: "Water",
            10: "Rail",
            11: "Road Surface",
            12: "Reserved",
            13: "Wire - Guard (Shield)",
            14: "Wire - Conductor (Phase)",
            15: "Transmission Tower",
            17: "Bridge Deck",
            18: "High Noise",
            19: "Overhead Structure",
            20: "Ignored Ground",
            64: "Override (Processing)",
            66: "Unclassified Data",
            67: "Ignored",
        }

        result = {}
        total_points = len(points)

        for class_id in sorted(np.unique(classifications)):
            mask = classifications == class_id
            count = np.sum(mask)
            percentage = 100 * count / total_points
            class_name = class_names.get(class_id, f"Unknown ({class_id})")

            result[int(class_id)] = {
                'name': class_name,
                'count': count,
                'percentage': percentage
            }

            if percentage > 1.0:  # Afficher si > 1%
                logger.info(f" {class_id:2d} ({class_name:25s}): {count:10,} pts ({percentage:5.1f}%)")

        return result

    def analyze_buildings_distribution(self, points: np.ndarray,
                                      classifications: np.ndarray) -> Dict:
        """Analyse les points classifiés comme bâtiments"""
        logger.info("\n🏢 ANALYSE BÂTIMENTS (classe 6)")
        logger.info("=" * 60)

        mask = classifications == 6
        building_points = points[mask]

        if len(building_points) == 0:
            logger.warning("Aucun point de bâtiment trouvé!")
            return {'n_points': 0}

        # Géométrie
        bbox_min = building_points.min(axis=0)
        bbox_max = building_points.max(axis=0)
        bbox_size = bbox_max - bbox_min

        # Densité spatiale
        volume = bbox_size[0] * bbox_size[1] * bbox_size[2]
        area = bbox_size[0] * bbox_size[1]
        density_3d = len(building_points) / volume if volume > 0 else 0
        density_2d = len(building_points) / area if area > 0 else 0

        # Analyse verticale (histogramme hauteurs)
        z_min, z_max = building_points[:, 2].min(), building_points[:, 2].max()
        z_range = z_max - z_min

        # Distribution par tranches
        n_bins = 10
        z_bins, z_edges = np.histogram(building_points[:, 2], bins=n_bins)
        z_percentiles = np.percentile(building_points[:, 2], [10, 25, 50, 75, 90])

        result = {
            'n_points': len(building_points),
            'percentage_total': 100 * len(building_points) / len(points),
            'bbox_size': bbox_size.tolist(),
            'z_range': float(z_range),
            'z_min': float(z_min),
            'z_max': float(z_max),
            'density_2d': float(density_2d),
            'density_3d': float(density_3d),
            'z_percentiles': {
                'p10': float(z_percentiles[0]),
                'p25': float(z_percentiles[1]),
                'p50': float(z_percentiles[2]),
                'p75': float(z_percentiles[3]),
                'p90': float(z_percentiles[4])
            }
        }

        logger.info(f"Points bâtiments: {len(building_points):,} ({100*len(building_points)/len(points):.1f}%)")
        logger.info(f"Emprise: {bbox_size[0]:.0f} x {bbox_size[1]:.0f} m")
        logger.info(f"Hauteur: {z_range:.1f} m (min={z_min:.1f}, max={z_max:.1f})")
        logger.info(f"Densité 2D: {density_2d:.1f} pts/m²")
        logger.info(f"Densité 3D: {density_3d:.2f} pts/m³")
        logger.info(f"Percentiles Z: p25={z_percentiles[1]:.1f}, p50={z_percentiles[2]:.1f}, p75={z_percentiles[3]:.1f}")

        return result

    def estimate_point_spacing(self, points: np.ndarray,
                               sample_size: int = 10000) -> Dict:
        """Estime l'espacement moyen entre points"""
        logger.info("\n📐 ESPACEMENT MOYEN")
        logger.info("=" * 60)

        # Sampling pour performance
        if len(points) > sample_size:
            indices = np.random.choice(len(points), sample_size, replace=False)
            sample = points[indices]
        else:
            sample = points

        # Calcul k-NN pour k=4 (2*dim)
        logger.info("Calcul distances k-NN (k=4)...")
        nbrs = NearestNeighbors(n_neighbors=5).fit(sample)  # 5 = 4 + lui-même
        distances, _ = nbrs.kneighbors(sample)

        # k-distance = distance au 4ème voisin
        k_distances = distances[:, 4]

        stats = {
            'min': float(np.min(k_distances)),
            'max': float(np.max(k_distances)),
            'mean': float(np.mean(k_distances)),
            'median': float(np.median(k_distances)),
            'std': float(np.std(k_distances)),
            'p10': float(np.percentile(k_distances, 10)),
            'p25': float(np.percentile(k_distances, 25)),
            'p50': float(np.percentile(k_distances, 50)),
            'p75': float(np.percentile(k_distances, 75)),
            'p90': float(np.percentile(k_distances, 90))
        }

        logger.info(f"k-distance (k=4) - min: {stats['min']:.2f}m, max: {stats['max']:.2f}m")
        logger.info(f"k-distance (k=4) - mean: {stats['mean']:.2f}m, median: {stats['median']:.2f}m")
        logger.info(f"k-distance percentiles:")
        logger.info(f"  p10: {stats['p10']:.2f}m")
        logger.info(f"  p25: {stats['p25']:.2f}m")
        logger.info(f"  p50: {stats['p50']:.2f}m (MÉDIANE)")
        logger.info(f"  p75: {stats['p75']:.2f}m")
        logger.info(f"  p90: {stats['p90']:.2f}m")

        return stats

    def find_elbow_point(self, points: np.ndarray,
                        k: int = 4,
                        sample_size: int = 10000) -> float:
        """Trouve le point d'inflexion (elbow) de la courbe k-distance"""
        logger.info(f"\n🔍 RECHERCHE POINT D'INFLEXION (elbow)")
        logger.info("=" * 60)

        # Sampling
        if len(points) > sample_size:
            indices = np.random.choice(len(points), sample_size, replace=False)
            sample = points[indices]
        else:
            sample = points

        logger.info(f"Analyse k-distance sur {len(sample):,} points...")

        nbrs = NearestNeighbors(n_neighbors=k+1).fit(sample)
        distances, _ = nbrs.kneighbors(sample)
        k_distances = np.sort(distances[:, k])

        # Méthode 1: Dérivée maximale
        diffs = np.diff(k_distances)
        elbow_idx_1 = np.argmax(diffs)
        elbow_value_1 = k_distances[elbow_idx_1]

        # Méthode 2: Courbure maximale (kneedle algorithm approximé)
        second_diffs = np.diff(diffs)
        elbow_idx_2 = np.argmax(np.abs(second_diffs))
        elbow_value_2 = k_distances[elbow_idx_2]

        # Utiliser la moyenne des deux méthodes
        elbow_value = (elbow_value_1 + elbow_value_2) / 2

        logger.info(f"Élbow détecté: {elbow_value:.2f}m")
        logger.info(f"  Méthode 1 (dérivée max): {elbow_value_1:.2f}m")
        logger.info(f"  Méthode 2 (courbure max): {elbow_value_2:.2f}m")

        return float(elbow_value)

    def estimate_building_count(self, points: np.ndarray,
                               classifications: np.ndarray,
                               eps: float) -> Dict:
        """Estime le nombre de bâtiments avec un eps donné"""
        mask = classifications == 6
        building_points = points[mask]

        if len(building_points) == 0:
            return {'estimated_buildings': 0}

        # DBSCAN rapide sur un subset
        sample_size = min(100000, len(building_points))
        if len(building_points) > sample_size:
            indices = np.random.choice(len(building_points), sample_size, replace=False)
            sample = building_points[indices]
        else:
            sample = building_points

        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(sample)

        # Tester avec min_points petit pour l'estimation
        labels = np.array(pcd.cluster_dbscan(
            eps=eps,
            min_points=10,
            print_progress=False
        ))

        n_clusters = len(np.unique(labels)) - (1 if -1 in labels else 0)

        # Extrapoler au dataset complet
        estimated_total = int(n_clusters * len(building_points) / len(sample))

        return {
            'estimated_buildings': estimated_total,
            'clusters_in_sample': n_clusters,
            'sample_size': len(sample)
        }

    def recommend_parameters(self, points: np.ndarray,
                             classifications: np.ndarray,
                             building_points: np.ndarray) -> Dict:
        """Recommande les paramètres DBSCAN optimaux"""
        logger.info("\n💡 RECOMMANDATIONS DBSCAN")
        logger.info("=" * 60)

        # Analyser l'espacement
        spacing = self.estimate_point_spacing(building_points, sample_size=5000)

        # Trouver elbow
        elbow = self.find_elbow_point(building_points, k=4, sample_size=5000)

        # Recommandations basées sur la densité
        density_2d = len(building_points) / (
            (building_points[:, 0].max() - building_points[:, 0].min()) *
            (building_points[:, 1].max() - building_points[:, 1].min())
        )

        logger.info(f"\nParamètres basés sur densité: {density_2d:.1f} pts/m²")

        recommendations = []

        # Recommandation 1: Conservateur (peu de fusion)
        eps_1 = min(spacing['p25'] * 1.2, elbow * 0.8)
        min_pts_1 = max(15, int(np.sqrt(len(building_points)) / 500))
        est_1 = self.estimate_building_count(points, classifications, eps_1)

        recommendations.append({
            'strategy': 'Conservateur (min fusion)',
            'eps': eps_1,
            'min_points': min_pts_1,
            'reason': 'eps faible pour éviter la fusion de bâtiments distincts',
            'estimated_buildings': est_1['estimated_buildings'],
            'quality': 'Bonne séparation, peu de fusions'
        })

        logger.info(f"\n1️⃣  CONSERVATEUR")
        logger.info(f"    eps: {eps_1:.2f}m")
        logger.info(f"    min_points: {min_pts_1}")
        logger.info(f"    → ~{est_1['estimated_buildings']} bâtiments estimés")
        logger.info(f"    → Bonne séparation, peu de fusions")

        # Recommandation 2: Équilibré (recommandé)
        eps_2 = elbow
        min_pts_2 = max(20, int(np.sqrt(len(building_points)) / 400))
        est_2 = self.estimate_building_count(points, classifications, eps_2)

        recommendations.append({
            'strategy': 'Équilibré (RECOMMANDÉ)',
            'eps': eps_2,
            'min_points': min_pts_2,
            'reason': 'Point d\'inflexion optimal (elbow)',
            'estimated_buildings': est_2['estimated_buildings'],
            'quality': 'Bon compromis séparation/connexion'
        })

        logger.info(f"\n2️⃣  ÉQUILIBRÉ (RECOMMANDÉ)")
        logger.info(f"    eps: {eps_2:.2f}m")
        logger.info(f"    min_points: {min_pts_2}")
        logger.info(f"    → ~{est_2['estimated_buildings']} bâtiments estimés")
        logger.info(f"    → Bon compromis séparation/connexion")

        # Recommandation 3: Agressif (permet fusion)
        eps_3 = spacing['p75'] * 1.5
        min_pts_3 = max(10, int(np.sqrt(len(building_points)) / 600))
        est_3 = self.estimate_building_count(points, classifications, eps_3)

        recommendations.append({
            'strategy': 'Agressif (fusion acceptable)',
            'eps': eps_3,
            'min_points': min_pts_3,
            'reason': 'eps élevé pour connecter les bâtiments fragmentés',
            'estimated_buildings': est_3['estimated_buildings'],
            'quality': 'Moins de fragments, quelques fusions possibles'
        })

        logger.info(f"\n3️⃣  AGRESSIF (fusion acceptable)")
        logger.info(f"    eps: {eps_3:.2f}m")
        logger.info(f"    min_points: {min_pts_3}")
        logger.info(f"    → ~{est_3['estimated_buildings']} bâtiments estimés")
        logger.info(f"    → Moins de fragments, quelques fusions possibles")

        return {
            'spacing': spacing,
            'elbow': elbow,
            'density_2d': density_2d,
            'recommendations': recommendations
        }

    def generate_report(self, output_path: Optional[Path] = None) -> Dict:
        """Génère le rapport d'analyse complet"""
        logger.info("\n" + "=" * 70)
        logger.info("ANALYSE TUILE LIDAR - CALIBRATION DBSCAN")
        logger.info("=" * 70)

        # Charger
        points, classifications = self.load_tile()

        # Analyses
        global_analysis = self.analyze_global_distribution(points)
        classification_analysis = self.analyze_by_classification(points, classifications)
        building_analysis = self.analyze_buildings_distribution(points, classifications)

        mask = classifications == 6
        building_points = points[mask]

        if len(building_points) > 0:
            params = self.recommend_parameters(points, classifications, building_points)
        else:
            params = {'recommendations': []}

        # Résumé
        report = {
            'file': str(self.tile_path.name),
            'analysis_date': str(np.datetime64('today')),
            'global': global_analysis,
            'classifications': classification_analysis,
            'buildings': building_analysis,
            'dbscan_parameters': params
        }

        self.results = report

        # Affichage résumé
        logger.info("\n" + "=" * 70)
        logger.info("📄 RÉSUMÉ RECOMMANDATIONS")
        logger.info("=" * 70)

        if params.get('recommendations'):
            for i, rec in enumerate(params['recommendations'], 1):
                logger.info(f"\nOption {i}: {rec['strategy']}")
                logger.info(f"  eps = {rec['eps']:.2f}m,  min_points = {rec['min_points']}")
                logger.info(f"  Estimé: ~{rec['estimated_buildings']} bâtiments")

        # Sauvegarder
        if output_path:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)

            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(report, f, indent=2, ensure_ascii=False, default=str)

            logger.info(f"\n✓ Rapport: {output_path}")

        return report

    def plot_k_distance_curve(self, points: np.ndarray,
                             output_path: Optional[Path] = None):
        """Plot la courbe k-distance"""
        logger.info("\n📈 Génération graphique k-distance...")

        sample_size = min(50000, len(points))
        if len(points) > sample_size:
            indices = np.random.choice(len(points), sample_size, replace=False)
            sample = points[indices]
        else:
            sample = points

        nbrs = NearestNeighbors(n_neighbors=5).fit(sample)
        distances, _ = nbrs.kneighbors(sample)
        k_distances = np.sort(distances[:, 4])

        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

        # Courbe k-distance
        ax1.plot(k_distances, linewidth=0.5, color='blue')
        ax1.axhline(y=self.results.get('dbscan_parameters', {}).get('elbow', 0),
                   color='red', linestyle='--', label='Elbow (recommandé)')
        ax1.set_xlabel('Point index (sorted)')
        ax1.set_ylabel('k-distance (4-ème voisin)')
        ax1.set_title('Courbe k-distance - Points triés')
        ax1.grid(True, alpha=0.3)
        ax1.legend()

        # Histogramme
        ax2.hist(k_distances, bins=100, color='green', alpha=0.7, edgecolor='black')
        ax2.axvline(x=self.results.get('dbscan_parameters', {}).get('elbow', 0),
                   color='red', linestyle='--', linewidth=2, label='Elbow')
        ax2.set_xlabel('k-distance (m)')
        ax2.set_ylabel('Fréquence')
        ax2.set_title('Distribution k-distance')
        ax2.grid(True, alpha=0.3, axis='y')
        ax2.legend()

        plt.tight_layout()

        if output_path:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            plt.savefig(output_path, dpi=150, bbox_inches='tight')
            logger.info(f"✓ Graphique: {output_path}")
        else:
            plt.show()

        plt.close()


def main():
    """Point d'entrée principal"""

    # Obtenir la racine du projet
    project_root = Path(__file__).parent.parent

    # Trouver les fichiers .laz
    data_dir = project_root / "public" / "data" / "metz"
    if not data_dir.exists():
        logger.error(f"Dossier non trouvé: {data_dir}")
        logger.info("Usage: python analyze_lidar_tile.py /path/to/file.laz")
        return

    laz_files = list(data_dir.glob("*.laz")) + list(data_dir.glob("*.copc.laz"))

    if not laz_files:
        logger.error(f"Aucun fichier .laz trouvé dans {data_dir}")
        return

    # Analyser le premier fichier
    tile_file = laz_files[0]
    logger.info(f"\nAnalyse de: {tile_file.name}")

    # Créer l'analyseur
    analyzer = LidarTileAnalyzer(tile_file, sample_fraction=1.0)

    # Générer le rapport
    report = analyzer.generate_report(
        output_path=data_dir.parent / "tile_analysis_report.json"
    )

    # Générer le graphique
    points, _ = analyzer.load_tile()
    mask = np.array(laspy.read(str(tile_file)).classification) == 6
    building_points = points[mask]

    if len(building_points) > 0:
        analyzer.plot_k_distance_curve(
            building_points,
            output_path=data_dir.parent / "k_distance_curve.png"
        )

    logger.info("\n" + "=" * 70)
    logger.info("✓ ANALYSE TERMINÉE")
    logger.info("=" * 70)
    logger.info("\nUtilisez ces paramètres dans process_buildings_improved.py :")
    if report.get('dbscan_parameters', {}).get('recommendations'):
        rec = report['dbscan_parameters']['recommendations'][1]  # Équilibré
        logger.info(f"\n  processor = ImprovedBuildingProcessor(")
        logger.info(f"      dbscan_eps = {rec['eps']:.2f},")
        logger.info(f"      dbscan_min_points = {rec['min_points']}")
        logger.info(f"  )")


if __name__ == "__main__":
    main()
