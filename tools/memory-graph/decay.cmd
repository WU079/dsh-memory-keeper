@echo off
rem Settle the forgetting curve: tick / status / touch <key> / weights
rem Prefer the Python shipped with the DSH runtime; fall back to whatever python is on PATH.
setlocal
set "PY=python"
if defined DSH_HOME if exist "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

set "PYTHONIOENCODING=utf-8"
"%PY%" "%~dp0decay.py" %*
