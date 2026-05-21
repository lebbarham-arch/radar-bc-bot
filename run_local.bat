@echo off
REM ============================================================
REM  Radar Marches Publics - Execution locale v8.1
REM  Prerequis : Node.js, Ollama (optionnel), fichier .env
REM ============================================================
cd /d "%~dp0"

echo ============================================================
echo   RADAR MARCHES PUBLICS - Execution locale v8.1
echo ============================================================

REM Verifier que Node.js est dispo
where node >nul 2>&1
if errorlevel 1 (
    echo ERREUR: Node.js non trouve. Telecharger: https://nodejs.org
    pause
    exit /b 1
)

REM Verifier que .env existe
if not exist ".env" (
    echo ERREUR: fichier .env manquant.
    echo Copier .env.example en .env et remplir les variables.
    pause
    exit /b 1
)

REM Installer les dependances si node_modules absent
if not exist "node_modules" (
    echo Installation des dependances npm...
    call npm install
    if errorlevel 1 ( echo ERREUR npm install & pause & exit /b 1 )
)

REM Verification syntaxe avant lancement
echo Verification syntaxe...
node --check radar-bc-bot.js
if errorlevel 1 ( echo ERREUR SYNTAXE & pause & exit /b 1 )
echo Syntaxe OK

REM Detecter Ollama
echo.
echo Detection Ollama...
curl -s http://localhost:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo Ollama non detecte sur localhost:11434
    echo   - Si vous voulez Ollama : lancer "ollama serve" puis "ollama pull qwen2.5:32b"
    echo   - Sans Ollama : le bot utilisera Claude Haiku si ANTHROPIC_API_KEY est defini
) else (
    echo Ollama OK sur localhost:11434
)

echo.
echo Demarrage du bot...
echo Logs: Ctrl+C pour arreter
echo ============================================================
node radar-bc-bot.js
