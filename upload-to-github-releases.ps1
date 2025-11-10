# Script pour uploader les fichiers COPC LAZ vers GitHub Releases
# Necessite: GitHub CLI (gh) - https://cli.github.com/

param(
    [string]$ReleaseTag = "v1.0.0-data",
    [string]$DataFolder = "public\data"
)

Write-Host "Upload des fichiers COPC LAZ vers GitHub Releases" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Verifier si gh est installe
try {
    $ghVersion = gh --version 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI non trouve"
    }
    Write-Host "[OK] GitHub CLI detecte: $($ghVersion[0])" -ForegroundColor Green
} catch {
    Write-Host "[ERREUR] GitHub CLI (gh) n'est pas installe" -ForegroundColor Red
    Write-Host ""
    Write-Host "Installation:" -ForegroundColor Yellow
    Write-Host "  1. Telechargez depuis: https://cli.github.com/" -ForegroundColor Yellow
    Write-Host "  2. Ou avec winget: winget install --id GitHub.cli" -ForegroundColor Yellow
    Write-Host "  3. Puis authentifiez-vous: gh auth login" -ForegroundColor Yellow
    exit 1
}

# Verifier l'authentification
Write-Host "Verification de l'authentification..." -ForegroundColor Cyan
try {
    $authStatus = gh auth status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERREUR] Non authentifie avec GitHub" -ForegroundColor Red
        Write-Host "Executez: gh auth login" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "[OK] Authentifie avec GitHub" -ForegroundColor Green
} catch {
    Write-Host "[ERREUR] Erreur d'authentification" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Verifier si le dossier existe
if (-not (Test-Path $DataFolder)) {
    Write-Host "[ERREUR] Le dossier '$DataFolder' n'existe pas" -ForegroundColor Red
    exit 1
}

# Lister tous les fichiers .copc.laz
$lazFiles = Get-ChildItem -Path $DataFolder -Filter "*.copc.laz" -Recurse
$totalFiles = $lazFiles.Count
$totalSize = ($lazFiles | Measure-Object -Property Length -Sum).Sum / 1GB

Write-Host "Fichiers trouves:" -ForegroundColor Cyan
Write-Host "  - Nombre: $totalFiles fichiers" -ForegroundColor White
Write-Host "  - Taille totale: $([math]::Round($totalSize, 2)) GB" -ForegroundColor White
Write-Host ""

if ($totalFiles -eq 0) {
    Write-Host "[ERREUR] Aucun fichier .copc.laz trouve dans '$DataFolder'" -ForegroundColor Red
    exit 1
}

# Afficher les fichiers
Write-Host "Fichiers a uploader:" -ForegroundColor Cyan
foreach ($file in $lazFiles) {
    $relativePath = $file.FullName.Substring((Get-Item $DataFolder).FullName.Length + 1)
    $sizeMB = [math]::Round($file.Length / 1MB, 2)
    Write-Host "  - $relativePath ($sizeMB MB)" -ForegroundColor Gray
}
Write-Host ""

# Demander confirmation
$confirmation = Read-Host "Voulez-vous creer/mettre a jour la release '$ReleaseTag' et uploader ces fichiers ? (o/N)"
if ($confirmation -ne 'o' -and $confirmation -ne 'O') {
    Write-Host "[ANNULE] Annule par l'utilisateur" -ForegroundColor Yellow
    exit 0
}

Write-Host ""

# Verifier si la release existe
Write-Host "Verification de la release '$ReleaseTag'..." -ForegroundColor Cyan
$releaseExists = $false
try {
    $release = gh release view $ReleaseTag 2>$null
    if ($LASTEXITCODE -eq 0) {
        $releaseExists = $true
        Write-Host "[OK] La release '$ReleaseTag' existe deja" -ForegroundColor Green
    }
} catch {
    Write-Host "[INFO] La release '$ReleaseTag' n'existe pas encore" -ForegroundColor Yellow
}

# Creer la release si elle n'existe pas
if (-not $releaseExists) {
    Write-Host "Creation de la release '$ReleaseTag'..." -ForegroundColor Cyan
    try {
        gh release create $ReleaseTag `
            --title "LIDAR Data Files" `
            --notes "Fichiers COPC LAZ pour le visualiseur LIDAR`n`nCes fichiers sont automatiquement charges par l'application deployee sur GitHub Pages." `
            --prerelease 2>$null
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Release creee avec succes" -ForegroundColor Green
        } else {
            throw "Erreur lors de la creation de la release"
        }
    } catch {
        Write-Host "[ERREUR] Erreur lors de la creation de la release: $_" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""

# Upload des fichiers
Write-Host "Upload des fichiers vers la release..." -ForegroundColor Cyan
Write-Host ""

$uploadedCount = 0
$errorCount = 0

foreach ($file in $lazFiles) {
    $relativePath = $file.FullName.Substring((Get-Item $DataFolder).FullName.Length + 1)
    $fileName = $file.Name
    $sizeMB = [math]::Round($file.Length / 1MB, 2)
    
    Write-Host "  [$($uploadedCount + 1)/$totalFiles] Uploading $relativePath ($sizeMB MB)..." -ForegroundColor White
    
    try {
        # Upload le fichier
        gh release upload $ReleaseTag $file.FullName --clobber 2>$null
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "    [OK] Uploade avec succes" -ForegroundColor Green
            $uploadedCount++
        } else {
            throw "Erreur lors de l'upload"
        }
    } catch {
        Write-Host "    [ERREUR] Erreur lors de l'upload: $_" -ForegroundColor Red
        $errorCount++
    }
    
    Write-Host ""
}

# Resume
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "Resume:" -ForegroundColor Cyan
Write-Host "  - Fichiers uploades: $uploadedCount/$totalFiles" -ForegroundColor $(if ($uploadedCount -eq $totalFiles) { "Green" } else { "Yellow" })
Write-Host "  - Erreurs: $errorCount" -ForegroundColor $(if ($errorCount -eq 0) { "Green" } else { "Red" })
Write-Host ""

if ($uploadedCount -eq $totalFiles) {
    Write-Host "[SUCCES] Tous les fichiers ont ete uploades avec succes !" -ForegroundColor Green
    Write-Host ""
    Write-Host "URL de la release: https://github.com/vaxelben/lidar-viewer/releases/tag/$ReleaseTag" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Prochaines etapes:" -ForegroundColor Yellow
    Write-Host "  1. Verifiez la release sur GitHub" -ForegroundColor White
    Write-Host "  2. Committez et pushez les changements du workflow" -ForegroundColor White
    Write-Host "  3. Le deploiement GitHub Pages devrait maintenant fonctionner !" -ForegroundColor White
} else {
    Write-Host "[ATTENTION] Certains fichiers n'ont pas pu etre uploades" -ForegroundColor Yellow
    Write-Host "Reexecutez le script pour reessayer (les fichiers existants seront ecrases)" -ForegroundColor Yellow
}

Write-Host ""
