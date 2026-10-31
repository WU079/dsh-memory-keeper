@echo off
rem Diffuse-activation recall over the memory graph.
rem Usage: q.cmd "some topic"   /   q.cmd --stats
setlocal
set "PY=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=python"
set PYTHONIOENCODING=utf-8
"%PY%" "%~dp0query.py" %*
