# Script pour uploader les fichiers vers Cloudflare R2
param(
    [string]$BucketName = "lidar-viewer-data",
    [string]$DataFolder = "public\data\metz"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Upload des fichiers vers Cloudflare R2" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Vérifier si wrangler est installé
try {
    $wranglerVersion = wrangler --version 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler non trouvé"
    }
    Write-Host "[OK] Wrangler détecté: $wranglerVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERREUR] Wrangler CLI n'est pas installé" -ForegroundColor Red
    Write-Host ""
    Write-Host "Installation:" -ForegroundColor Yellow
    Write-Host "  npm install -g wrangler" -ForegroundColor Yellow
    Write-Host "  # ou" -ForegroundColor Yellow
    Write-Host "  yarn global add wrangler" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Puis authentifiez-vous:" -ForegroundColor Yellow
    Write-Host "  wrangler login" -ForegroundColor Yellow
    exit 1
}

# Vérifier l'authentification
Write-Host "Vérification de l'authentification..." -ForegroundColor Cyan
try {
    $whoami = wrangler whoami 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Non authentifié"
    }
    Write-Host "[OK] Authentifié avec Cloudflare" -ForegroundColor Green
} catch {
    Write-Host "[ERREUR] Non authentifié avec Cloudflare" -ForegroundColor Red
    Write-Host "Exécutez: wrangler login" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# Vérifier si le dossier existe
if (-not (Test-Path $DataFolder)) {
    Write-Host "[ERREUR] Le dossier '$DataFolder' n'existe pas" -ForegroundColor Red
    exit 1
}

# Lister tous les fichiers .copc.laz
$lazFiles = Get-ChildItem -Path $DataFolder -Filter "*.copc.laz" -Recurse
$totalFiles = $lazFiles.Count
$totalSize = ($lazFiles | Measure-Object -Property Length -Sum).Sum / 1GB

Write-Host "Fichiers trouvés:" -ForegroundColor Cyan
Write-Host "  - Nombre: $totalFiles fichiers" -ForegroundColor White
Write-Host "  - Taille totale: $([math]::Round($totalSize, 2)) GB" -ForegroundColor White
Write-Host ""

if ($totalFiles -eq 0) {
    Write-Host "[ERREUR] Aucun fichier .copc.laz trouvé dans '$DataFolder'" -ForegroundColor Red
    exit 1
}

# Afficher les fichiers
Write-Host "Fichiers à uploader:" -ForegroundColor Cyan
foreach ($file in $lazFiles) {
    $fileName = $file.Name
    $sizeMB = [math]::Round($file.Length / 1MB, 2)
    Write-Host "  - $fileName ($sizeMB MB)" -ForegroundColor Gray
}
Write-Host ""

# Demander confirmation
$confirmation = Read-Host "Voulez-vous uploader ces fichiers vers le bucket '$BucketName' ? (o/N)"
if ($confirmation -ne 'o' -and $confirmation -ne 'O') {
    Write-Host "[ANNULE] Annulé par l'utilisateur" -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Upload en cours..." -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$uploadedCount = 0
$errorCount = 0

foreach ($file in $lazFiles) {
    $fileName = $file.Name
    $sizeMB = [math]::Round($file.Length / 1MB, 2)
    
    Write-Host "[$($uploadedCount + 1)/$totalFiles] Upload de $fileName ($sizeMB MB)..." -ForegroundColor White
    
    try {
        # Uploader le fichier à la racine du bucket
        # Note: On utilise le nom du fichier uniquement, pas le chemin complet
        $result = wrangler r2 object put "$BucketName/$fileName" --file="$($file.FullName)" --content-type="application/octet-stream" 2>&1
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "    [OK] Uploadé avec succès" -ForegroundColor Green
            $uploadedCount++
        } else {
            throw "Erreur lors de l'upload: $result"
        }
    } catch {
        Write-Host "    [ERREUR] Erreur lors de l'upload: $_" -ForegroundColor Red
        $errorCount++
    }
    
    Write-Host ""
    
    # Petit délai pour éviter de surcharger l'API
    Start-Sleep -Milliseconds 100
}

# Résumé
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Résumé:" -ForegroundColor Cyan
Write-Host "  - Fichiers uploadés: $uploadedCount/$totalFiles" -ForegroundColor $(if ($uploadedCount -eq $totalFiles) { "Green" } else { "Yellow" })
Write-Host "  - Erreurs: $errorCount" -ForegroundColor $(if ($errorCount -eq 0) { "Green" } else { "Red" })
Write-Host ""

if ($uploadedCount -eq $totalFiles) {
    Write-Host "[SUCCES] Tous les fichiers ont été uploadés avec succès !" -ForegroundColor Green
    Write-Host ""
    Write-Host "Prochaines étapes:" -ForegroundColor Yellow
    Write-Host "  1. Activez l'accès public R2.dev dans le dashboard Cloudflare" -ForegroundColor White
    Write-Host "  2. Récupérez l'URL R2.dev de votre bucket" -ForegroundColor White
    Write-Host "  3. Mettez à jour 'dataBaseUrl' dans public/data-config.json" -ForegroundColor White
    Write-Host "  4. Testez en local: yarn dev" -ForegroundColor White
    Write-Host "  5. Déployez: git add . && git commit -m 'Configure R2' && git push" -ForegroundColor White
} else {
    Write-Host "[ATTENTION] Certains fichiers n'ont pas pu être uploadés" -ForegroundColor Yellow
    Write-Host "Réexécutez le script pour réessayer" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Dashboard R2: https://dash.cloudflare.com/r2" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

