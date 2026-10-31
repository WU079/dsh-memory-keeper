@echo off
rem Rebuild the memory graph (graph.db + graph.json).
rem Also settles the forgetting curve first (decay.py tick), so weights are fresh.
rem Prefer the Python shipped with the DSH runtime; fall back to whatever python is on PATH.
setlocal
set "PY=python"
if defined DSH_HOME if exist "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

"%PY%" "%~dp0decay.py" tick >nul 2>&1
"%PY%" "%~dp0build.py" %*
