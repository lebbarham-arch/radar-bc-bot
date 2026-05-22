@echo off
cd /d "C:\PROJETS_AI\projet_claude\radar-bc-bot"
echo ========================================
echo  Enrichissement IA local via Ollama
echo ========================================
echo.

REM Verifier Ollama
echo Verification Ollama sur localhost:11434...
curl -s http://localhost:11434/api/tags >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERREUR: Ollama n'est pas lance !
  echo Lance "ollama serve" dans un autre terminal, puis relance ce script.
  echo.
  pause
  exit /b 1
)
echo Ollama OK !
echo.

REM Verifier node_modules
if not exist "node_modules" (
  echo Installation dependances npm...
  call npm install
)

echo Lancement enrichissement...
echo.
node enrich_local.js

echo.
pause
