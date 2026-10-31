@echo off
rem Rebuild the memory graph (graph.db + graph.json).
rem Prefer the Python bundled with the DSH runtime; fall back to python on PATH.
setlocal
set "PY=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0build.py" %*
