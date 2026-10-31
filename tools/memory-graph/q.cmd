@echo off
rem Diffuse-activation recall over the memory graph.
rem Usage: q.cmd "voice tags"   /   q.cmd --stats
setlocal
set "PY=python"
if defined DSH_HOME if exist "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

set PYTHONIOENCODING=utf-8
"%PY%" "%~dp0query.py" %*
