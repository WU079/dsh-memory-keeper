@echo off
rem Suggest [[memory keys]] for a piece of text you are about to save.
rem Usage: suggest.cmd "text here"   /   suggest.cmd --file draft.md   /   suggest.cmd --keys
setlocal
set "PY=python"
if defined DSH_HOME if exist "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PY=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

set PYTHONIOENCODING=utf-8
"%PY%" "%~dp0suggest_links.py" %*
